# Third-party notices

`pmtiles-torrent` is licensed BSD-3-Clause (see [LICENSE](LICENSE)). This file records the
third-party work it derives from, redistributes, or interoperates with.

## PMTiles — BSD-3-Clause (reference implementation), CC0-1.0 (specification)

> Copyright 2021 and later, Protomaps LLC and contributors
> https://github.com/protomaps/PMTiles

Used in three ways:

1. **`src/layout.ts`** parses the PMTiles v3 header. The field offsets come from the
   specification (`spec/v3/spec.md`, CC0-1.0). The little-endian uint64 read follows the
   approach used by `getUint64` in the PMTiles JavaScript reference implementation
   (`js/src/index.ts`, BSD-3-Clause).

2. **`test/data/test_fixture_1.pmtiles`** is redistributed verbatim from
   `js/test/data/test_fixture_1.pmtiles` in the PMTiles repository, covered by the `js/**`
   annotation in that project's `REUSE.toml` (BSD-3-Clause, Protomaps LLC and contributors).
   See [test/data/README.md](test/data/README.md).

3. The `Source` and `RangeResponse` **interfaces** are consumed from the `pmtiles` npm package
   as a types-only peer dependency. No implementation code is copied.

BSD-3-Clause is compatible with this project's license; the notices above satisfy its
attribution requirement.

## WebTorrent — MIT

> Copyright (c) Feross Aboukhadijeh and WebTorrent, LLC
> https://github.com/webtorrent/webtorrent

`src/engines/webtorrent.ts` is an adapter written against WebTorrent's public API. The
`interface WtClient` / `WtTorrent` / `WtFile` declarations describe that public API so the
package can compile without `@types/webtorrent`; they are descriptions of an interface, not
copied implementation. WebTorrent itself is an optional peer dependency and is never bundled.

## qBittorrent — GPL-2.0-or-later

> https://github.com/qbittorrent/qBittorrent

**No qBittorrent code is used in this project.** It was read only to establish two facts stated
in the README: that its BitTorrent v2 support comes from libtorrent (`LIBTORRENT_VERSION_NUM >=
20100`), and that it exposes file-level priorities rather than the piece-level primitives
(`set_piece_deadline`, `read_piece`) that random-access reads require. qBittorrent is GPL-2.0+,
which is not compatible with redistribution under this project's BSD-3-Clause license, so code
must not be copied from it.

The same caution applies to libtorrent-rasterbar itself if a libtorrent-backed engine is added
later: libtorrent is BSD-3-Clause and therefore fine to link and derive from, but it must be
pulled in directly rather than by way of any GPL client.
