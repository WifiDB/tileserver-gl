# pmtiles-torrent

Serve a [PMTiles](https://github.com/protomaps/PMTiles) archive out of a BitTorrent swarm.

PMTiles reads an archive as a series of byte ranges. BitTorrent serves data as fixed-size,
individually verified pieces. Those two facts line up well enough that a torrent can stand in
for an HTTP origin — and unlike an HTTP origin, every client that has downloaded part of the
archive is also serving it.

This package is the mapping between the two. It implements the `Source` interface from the
`pmtiles` package, so anything that accepts a `PMTiles` instance works unchanged: tileserver-gl,
the MapLibre `pmtiles://` protocol, the CLI.

```ts
import { PMTiles } from "pmtiles";
import { TorrentSource } from "pmtiles-torrent";
import { WebTorrentEngine } from "pmtiles-torrent/webtorrent";

const engine = new WebTorrentEngine(magnetUri, { path: "/var/lib/maps" });
const archive = new PMTiles(new TorrentSource(engine));

const tile = await archive.getZxy(12, 1204, 1539);
```

## Why this works

A PMTiles archive stores tiles in Hilbert order, so tiles that are near each other on the map are
near each other in the file. Piece-granular transport means fetching a 4 KB tile costs a whole
piece — but because of that clustering, the rest of the piece is mostly tiles you are about to
want. The read amplification doubles as prefetch.

Two other properties fall out of the transport for free:

- **The infohash is a content hash.** Range reads are returned with `etag: infoHash` and
  `cache-control: immutable`. The archive cannot change under you, so PMTiles' ETag-mismatch
  retry path is structurally unreachable — a class of bug that HTTP range sources have to handle.
- **Partial seeding is the default.** Every peer serves the pieces it holds. A client that has
  only ever loaded tiles for one city is already seeding that city.

## Install

```sh
npm install pmtiles-torrent pmtiles webtorrent
```

`pmtiles` is a peer dependency (used only for types at build time). `webtorrent` is an *optional*
peer dependency, needed only if you use the bundled engine.

## What the source does

- **Piece mapping.** Each requested range expands to the pieces covering it, clipped to the
  archive's bounds within the torrent — so an archive packed alongside other files in a
  multi-file torrent works without special cases.
- **Parallel piece fetch.** All pieces covering one range are fetched concurrently rather than
  in sequence. A range spanning three pieces costs one swarm round-trip, not three.
- **Deduplication.** Concurrent requests touching the same piece share one fetch.
- **Reference-counted cancellation.** An aborted request stops waiting immediately, but the
  underlying piece fetch is only cancelled once *every* waiter has gone — one abandoned tile
  request cannot kill a piece another request is still blocked on.
- **Piece-counted LRU cache.** Sized as `max(64 MiB, cachePieces * pieceLength)` once metadata
  arrives, defaulting to 8 pieces. A fixed byte budget is a trap here: 64 MiB holds four 16 MiB
  pieces, few enough that one leaf-directory read evicts the tile pieces fetched moments before.
  Set `cacheBytes` for an explicit budget, or `cacheBytes: 0` to rely entirely on the engine's
  own store.
- **Over-read clamping.** PMTiles speculatively reads 16 KiB for the header regardless of archive
  size. An HTTP server truncates that for you; here it is clamped explicitly.
- **Directory prefetch.** Once the header is read, the root directory is marked critical and the
  JSON metadata high priority. Both are small and needed immediately.
- **Idle-only leaf hydration.** Leaf directories gate every tile lookup in a new region, so
  having them locally is a large win — but fetching them eagerly starves the requests they exist
  to accelerate. Measured on a 72 GiB archive against a single peer, eager prefetch took a cold
  tile from 34.2s to **138.2s**. They are therefore queued at the lowest priority, started only
  after the source has been idle, and withdrawn the instant a read arrives. Engines opt in by
  implementing `unhint()`; hydration is skipped without it, since there would be no way to call
  it off.

```js
const source = new TorrentSource(engine, {
  cachePieces: 16,          // or cacheBytes for an explicit budget
  prefetchDirectories: true,
  maxLeafPrefetchBytes: 256 * 1024 * 1024,
  hydrateIdleMs: 2000,
});

source.stats; // cacheHits, cacheMisses, bytesFetched, bytesServed,
              // cancelled, cachedPieces, cachedBytes, cacheBudget, hydrating
```

## Resume data

WebTorrent rebuilds its bitfield by hashing the entire store on every start. On a 72 GiB archive
that measured **59.9 seconds**, and it scales with size — during which the torrent has not joined
the swarm at all, which looks from the outside like "no peers".

Passing `resumePath` persists the bitfield and hands it back next time, which measured **0.6
seconds** for the same archive:

```js
new WebTorrentEngine(torrentId, {
  path: '/mnt/maps/store',
  resumePath: '/mnt/maps/store',   // same directory is fine
});
```

A bitfield asserts pieces are present without re-hashing them, so a stale one would serve
unverified bytes. It is only trusted when the data file still has the exact size and modification
time recorded when it was written, and it is discarded if the torrent it names is not the one that
loaded. Written atomically, saved on shutdown and every 60s.

With startup under a second, expect to watch the swarm connect in real time — 10 to 20 seconds for
tracker announce and handshake. That wait always existed; it used to hide behind the hashing.

## Piece size matters more than anything else here

Read amplification is `pieceLength / bytesActuallyWanted`. Torrent-creation tools pick large
pieces because they assume you want the whole file — libtorrent's automatic sizing lands at the
top of its scale for multi-hundred-gigabyte inputs. At a 16 MiB piece length, a cold 4 KB vector
tile costs a 16 MiB download.

If you control torrent creation, pick the piece length deliberately:

| Piece length | Amplification for a 4 KB tile | Pieces in a 400 GiB archive | v1 hash list |
| ------------ | ----------------------------- | --------------------------- | ------------ |
| 16 MiB       | ~4000×                        | 25,600                      | 0.5 MB       |
| 4 MiB        | ~1000×                        | 102,400                     | 2 MB         |
| 1 MiB        | ~250×                         | 409,600                     | 8 MB         |

1–4 MiB is the usual sweet spot. Below that the metadata itself (which peers must transfer via
BEP 9 before any tile can be served) starts to dominate.

BitTorrent v2 (BEP 52) improves this considerably: per-file merkle trees with 16 KiB leaf blocks
let a peer verify a small block without holding the whole hash list. See the engine notes below.

### Working with existing 16 MiB torrents

Torrents cut by `mktorrent` or libtorrent's automatic sizing commonly land at 16 MiB — a 698 GiB
planet archive comes out as 44,673 pieces. They work, and the picture is better than the raw
amplification number suggests, but the tuning changes:

- **It is a latency problem, not a waste problem.** At ~30 KB per raster tile, one 16 MiB piece
  holds roughly 500 tiles, and Hilbert ordering makes those a contiguous block on the map —
  around 24 tiles on a side, some 14 km across at z16. The first tile in a new area pays for the
  whole piece (a few seconds on a typical swarm); the next several hundred tiles nearby are free.
  What matters is that the cache is large enough to keep that piece around long enough to collect
  the payoff, which is why the default is counted in pieces.
- **Raise `cachePieces` on a server.** The default of 8 is 128 MiB per archive at this piece
  size. Somewhere between 16 and 64 is reasonable if you are serving one or two large archives
  and have the RAM.
- **Leave `maxLeafPrefetchBytes` generous.** Since hydration is idle-only it never competes with
  a request, so the 256 MiB default is safe. Do not try to force leaf directories in eagerly —
  that was measured to make cold tiles four times worse, not better.

Recutting is worth it for archives you expect to be browsed interactively, but it is not free:
re-hashing 698 GiB from local disk costs no bandwidth, but the new infohash is a new swarm, and
peers on the old one do not follow. `mktorrent -l 22` gives 4 MiB pieces. Note that `mktorrent`
emits v1-only torrents (`Info Hash v2: N/A`); for a hybrid v1+v2 torrent use libtorrent's creator
or qBittorrent's own torrent-creation dialog, which exposes the torrent format.

## Engines

The BitTorrent client is injected rather than baked in. An engine is small:

```ts
interface TorrentEngine {
  readonly key: string;                     // available synchronously, before metadata
  ready(): Promise<TorrentInfo>;            // pieceLength, fileLength, fileOffset, infoHash
  readRange(offset, length, opts): Promise<Uint8Array>;
  hint?(offset, length, priority): void;    // optional background prioritisation
  destroy(): void | Promise<void>;
}
```

Everything PMTiles-specific lives above that line, so a new backend — or a port to another
language — only means reimplementing the engine.

### WebTorrentEngine (bundled)

```ts
new WebTorrentEngine(magnetUri, {
  client,        // reuse one client across archives: one peer pool, one port, one DHT node
  path,          // chunk store location; persist it to keep seeding across restarts
  filePath,      // pick a file inside a multi-file torrent
  announce,      // extra trackers
  readyTimeoutMs // default 60s
});
```

The torrent is added with `deselect: true`, so nothing downloads until a range is requested.
Without that, WebTorrent selects every piece and starts pulling the entire archive.

WebTorrent is the only engine that can bridge both halves of a swarm: browser peers speak WebRTC
and conventional clients speak TCP/uTP, and they cannot see each other directly. A
WebTorrent-based server is what lets one swarm serve both.

**This is a BitTorrent v1 engine.** WebTorrent does not implement BEP 52 — no merkle
verification, no `btmh` magnets. v2 support means an engine over libtorrent (which is where
qBittorrent's v2 support comes from; qBittorrent itself exposes only file-level priorities, not
the piece-level primitives — `set_piece_deadline`, `read_piece` — that random access needs).

## Development

This package lives inside the tileserver-gl-wdb repository and is consumed from it as a
`file:packages/pmtiles-torrent` dependency. It is plain ESM JavaScript with JSDoc types and has
no build step, so `npm ci --omit=dev` in the Docker image works without a toolchain.

```sh
npm test        # from this directory, or:
node --test packages/pmtiles-torrent/test/*.test.js   # from the repo root
```

Tests run against an in-memory engine with controllable timing, so concurrency and cancellation
behaviour is covered without a swarm, plus an end-to-end read of a real PMTiles archive.

## License and attribution

BSD-3-Clause — see [LICENSE](LICENSE).

Third-party work this project derives from or redistributes is recorded in [NOTICE.md](NOTICE.md):
PMTiles (BSD-3-Clause / CC0-1.0) for the v3 header layout and the test fixture, and WebTorrent
(MIT) for the API the bundled engine targets. No qBittorrent code is used — it is GPL-2.0+ and
incompatible with redistribution here.
