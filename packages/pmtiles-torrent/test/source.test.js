import assert from 'node:assert';
import { describe, it } from 'node:test';
import { PieceCache } from '../src/cache.js';
import { isTorrentFile, isTorrentId, torrentDisplayName } from '../src/id.js';
import { readLayout } from '../src/layout.js';
import { TorrentSource } from '../src/source.js';
import { FakeEngine, ramp } from './fake-engine.js';

/**
 * Views a range response as bytes.
 * @param {object} response - A PMTiles RangeResponse.
 * @returns {Uint8Array} - The data.
 */
const bytesOf = (response) => new Uint8Array(response.data);

describe('TorrentSource range assembly', () => {
  it('stitches a range that spans several pieces', async () => {
    const data = ramp(1000);
    const engine = new FakeEngine(data, { pieceLength: 100 });
    const source = new TorrentSource(engine);

    const got = bytesOf(await source.getBytes(250, 300));

    assert.deepStrictEqual(got, data.slice(250, 550));
    assert.deepStrictEqual(
      engine.reads.map((r) => r.offset),
      [200, 300, 400, 500],
    );
    // Every read is a whole piece, never the raw request.
    assert.ok(engine.reads.every((r) => r.length === 100));
  });

  it('serves a range that sits inside a single piece', async () => {
    const data = ramp(1000);
    const engine = new FakeEngine(data, { pieceLength: 256 });
    const source = new TorrentSource(engine);

    const got = bytesOf(await source.getBytes(10, 5));

    assert.deepStrictEqual(got, data.slice(10, 15));
    assert.strictEqual(engine.reads.length, 1);
  });

  it('clamps an over-read at the end of the archive', async () => {
    // PMTiles asks for 16 KiB of header regardless of archive size.
    const data = ramp(500);
    const engine = new FakeEngine(data, { pieceLength: 256 });
    const source = new TorrentSource(engine);

    const got = bytesOf(await source.getBytes(0, 16384));

    assert.strictEqual(got.byteLength, 500);
    assert.deepStrictEqual(got, data);
  });

  it('clips pieces to the file when the torrent holds other files', async () => {
    const data = ramp(1000);
    const engine = new FakeEngine(data, {
      pieceLength: 256,
      fileOffset: 100,
      trailingBytes: 300,
    });
    const source = new TorrentSource(engine);

    // Archive byte 0 lives at torrent byte 100, i.e. inside piece 0, whose
    // in-file portion is only 156 bytes long.
    const got = bytesOf(await source.getBytes(0, 200));
    assert.deepStrictEqual(got, data.slice(0, 200));
    assert.deepStrictEqual(
      engine.reads.map((r) => [r.offset, r.length]),
      [
        [0, 156],
        [156, 256],
      ],
    );

    // The last piece is clipped by the file's end, not the torrent's.
    const tail = bytesOf(await source.getBytes(950, 50));
    assert.deepStrictEqual(tail, data.slice(950, 1000));
    const last = engine.reads.at(-1);
    assert.strictEqual(last.offset + last.length, 1000);
  });

  it('returns an exactly sized buffer', async () => {
    const engine = new FakeEngine(ramp(1000), { pieceLength: 256 });
    const source = new TorrentSource(engine);

    const response = await source.getBytes(300, 7);

    // PMTiles reads from byte 0 of whatever ArrayBuffer it gets back.
    assert.strictEqual(response.data.byteLength, 7);
  });

  it('rejects an offset past the end of the archive', async () => {
    const engine = new FakeEngine(ramp(100), { pieceLength: 64 });
    const source = new TorrentSource(engine);

    await assert.rejects(() => source.getBytes(100, 10), RangeError);
  });

  it('reports the infohash as an immutable ETag', async () => {
    const engine = new FakeEngine(ramp(100), {
      pieceLength: 64,
      infoHash: 'deadbeef'.repeat(5),
    });
    const source = new TorrentSource(engine);

    const response = await source.getBytes(0, 10);

    assert.strictEqual(response.etag, 'deadbeef'.repeat(5));
    assert.match(response.cacheControl ?? '', /immutable/);
    assert.strictEqual(source.getKey(), 'torrent:fake');
  });
});

describe('TorrentSource caching and deduplication', () => {
  it('serves a repeat read from cache without touching the engine', async () => {
    const engine = new FakeEngine(ramp(1000), { pieceLength: 256 });
    const source = new TorrentSource(engine);

    await source.getBytes(0, 100);
    const readsAfterFirst = engine.reads.length;
    const got = bytesOf(await source.getBytes(50, 100));

    assert.strictEqual(engine.reads.length, readsAfterFirst);
    assert.deepStrictEqual(got, ramp(1000).slice(50, 150));
    assert.strictEqual(source.stats.cacheHits, 1);
  });

  it('collapses concurrent requests for the same piece into one read', async () => {
    const engine = new FakeEngine(ramp(1000), {
      pieceLength: 256,
      manual: true,
    });
    const source = new TorrentSource(engine);

    const all = Promise.all([
      source.getBytes(0, 10),
      source.getBytes(20, 10),
      source.getBytes(100, 10),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(engine.reads.length, 1);
    engine.flush();
    await all;
  });

  it('fetches the pieces covering one range in parallel', async () => {
    const engine = new FakeEngine(ramp(1000), {
      pieceLength: 100,
      manual: true,
    });
    const source = new TorrentSource(engine);

    // Bytes 50..399, i.e. pieces 0 through 3.
    const pending = source.getBytes(50, 350);
    await new Promise((resolve) => setImmediate(resolve));

    // All four covering pieces are in flight before any of them resolves.
    assert.strictEqual(engine.reads.length, 4);
    engine.flush();
    assert.strictEqual((await pending).data.byteLength, 350);
  });

  it('evicts by byte budget', async () => {
    const engine = new FakeEngine(ramp(1000), { pieceLength: 100 });
    const source = new TorrentSource(engine, { cacheBytes: 250 });

    await source.getBytes(0, 300); // pieces 0,1,2 — 300 bytes, over budget
    assert.ok(source.stats.cachedBytes <= 250);
    assert.strictEqual(source.stats.cachedPieces, 2);
  });

  it('sizes the default cache from the piece length', async () => {
    const MiB = 1024 * 1024;

    // Large pieces: a fixed 64 MiB budget would hold only four of these.
    const big = new TorrentSource(
      new FakeEngine(ramp(1000), { pieceLength: 16 * MiB }),
    );
    await big.ready();
    assert.strictEqual(big.stats.cacheBudget, 8 * 16 * MiB);

    // Small pieces: the floor applies instead.
    const small = new TorrentSource(
      new FakeEngine(ramp(1000), { pieceLength: 256 * 1024 }),
    );
    await small.ready();
    assert.strictEqual(small.stats.cacheBudget, 64 * MiB);

    // An explicit budget is honoured verbatim.
    const fixed = new TorrentSource(
      new FakeEngine(ramp(1000), { pieceLength: 16 * MiB }),
      { cacheBytes: 32 * MiB },
    );
    await fixed.ready();
    assert.strictEqual(fixed.stats.cacheBudget, 32 * MiB);

    // As is a piece count.
    const counted = new TorrentSource(
      new FakeEngine(ramp(1000), { pieceLength: 16 * MiB }),
      { cachePieces: 24 },
    );
    await counted.ready();
    assert.strictEqual(counted.stats.cacheBudget, 24 * 16 * MiB);
  });

  it('can run with caching disabled', async () => {
    const engine = new FakeEngine(ramp(1000), { pieceLength: 100 });
    const source = new TorrentSource(engine, { cacheBytes: 0 });

    await source.getBytes(0, 10);
    await source.getBytes(0, 10);

    assert.strictEqual(engine.reads.length, 2);
    assert.strictEqual(source.stats.cachedPieces, 0);
  });
});

describe('TorrentSource cancellation', () => {
  it('rejects the caller and cancels the fetch when nobody is left waiting', async () => {
    const engine = new FakeEngine(ramp(1000), {
      pieceLength: 256,
      manual: true,
    });
    const source = new TorrentSource(engine);
    const controller = new AbortController();

    const pending = source.getBytes(0, 10, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await assert.rejects(pending, (error) => error.name === 'AbortError');
    assert.strictEqual(engine.aborted, 1);
    assert.strictEqual(source.stats.cancelled, 1);
  });

  it('keeps a shared fetch alive when only one waiter aborts', async () => {
    const engine = new FakeEngine(ramp(1000), {
      pieceLength: 256,
      manual: true,
    });
    const source = new TorrentSource(engine);
    const controller = new AbortController();

    const abandoned = source.getBytes(0, 10, controller.signal);
    const kept = source.getBytes(20, 10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(engine.reads.length, 1);

    controller.abort();
    await assert.rejects(abandoned, (error) => error.name === 'AbortError');

    // The underlying read was never cancelled, so the second caller still wins.
    assert.strictEqual(engine.aborted, 0);
    engine.flush();
    assert.deepStrictEqual(bytesOf(await kept), ramp(1000).slice(20, 30));
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const engine = new FakeEngine(ramp(100), { pieceLength: 64 });
    const source = new TorrentSource(engine);

    await assert.rejects(
      source.getBytes(0, 10, AbortSignal.abort()),
      (error) => error.name === 'AbortError',
    );
    assert.strictEqual(engine.reads.length, 0);
  });
});

describe('directory prefetch', () => {
  /**
   * Builds a v3 header with the section offsets we care about.
   * @param {object} sections - Root, metadata and leaf offset/length pairs.
   * @returns {Uint8Array} - A 127-byte header.
   */
  function header(sections) {
    const bytes = new Uint8Array(127);
    bytes.set(new TextEncoder().encode('PMTiles'), 0);
    bytes[7] = 3;
    const view = new DataView(bytes.buffer);
    /**
     * Writes a little-endian uint64.
     * @param {number} offset - Field offset.
     * @param {number} value - Value to write.
     * @returns {void}
     */
    const put = (offset, value) => {
      view.setUint32(offset, value >>> 0, true);
      view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true);
    };
    put(8, sections.root[0]);
    put(16, sections.root[1]);
    put(24, sections.metadata[0]);
    put(32, sections.metadata[1]);
    put(40, sections.leaf[0]);
    put(48, sections.leaf[1]);
    return bytes;
  }

  /**
   * Builds a fake archive with a real header at the front.
   * @param {object} sections - Section offsets.
   * @param {number} length - Total archive length.
   * @returns {Uint8Array} - The archive bytes.
   */
  function archive(sections, length) {
    const data = ramp(length);
    data.set(header(sections), 0);
    return data;
  }

  it('hints the directory sections after the header is read', async () => {
    const data = archive(
      { root: [127, 200], metadata: [327, 100], leaf: [427, 500] },
      2000,
    );
    const engine = new FakeEngine(data, { pieceLength: 512 });
    const source = new TorrentSource(engine);

    await source.getBytes(0, 16384);

    // Root and metadata are small and fetched eagerly; the leaf section is
    // queued for idle hydration instead of competing with the read.
    assert.deepStrictEqual(engine.hints, [
      { offset: 127, length: 200, priority: 'critical' },
      { offset: 327, length: 100, priority: 'high' },
    ]);
  });

  it('skips leaf directories larger than the prefetch budget', async () => {
    const data = archive(
      { root: [127, 200], metadata: [327, 100], leaf: [427, 1500] },
      2000,
    );
    const engine = new FakeEngine(data, { pieceLength: 512 });
    const source = new TorrentSource(engine, { maxLeafPrefetchBytes: 1000 });

    await source.getBytes(0, 16384);

    assert.deepStrictEqual(
      engine.hints.map((h) => h.offset),
      [127, 327],
    );
  });

  it('hints only once, and not at all when disabled', async () => {
    const data = archive(
      { root: [127, 200], metadata: [327, 100], leaf: [427, 500] },
      2000,
    );
    const off = new FakeEngine(data, { pieceLength: 512 });
    await new TorrentSource(off, { prefetchDirectories: false }).getBytes(
      0,
      200,
    );
    assert.strictEqual(off.hints.length, 0);

    const on = new FakeEngine(data, { pieceLength: 512 });
    const source = new TorrentSource(on);
    await source.getBytes(0, 200);
    await source.getBytes(0, 200);
    assert.strictEqual(on.hints.length, 2);
  });

  it('ignores archives that are not PMTiles v3', async () => {
    const engine = new FakeEngine(ramp(2000), { pieceLength: 512 });
    const source = new TorrentSource(engine);

    await source.getBytes(0, 200);

    assert.strictEqual(engine.hints.length, 0);
  });
});

describe('helpers', () => {
  it('recognises torrent identifiers', () => {
    assert.ok(
      isTorrentId(`magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=x.pmtiles`),
    );
    assert.ok(isTorrentId('a'.repeat(40)));
    assert.ok(isTorrentId('/data/planet.pmtiles.torrent'));
    assert.ok(isTorrentId('C:\\maps\\planet.pmtiles.TORRENT'));
    assert.ok(!isTorrentId('https://example.com/x.pmtiles'));
    assert.ok(!isTorrentId('/data/x.pmtiles'));
    assert.ok(!isTorrentId('s3://bucket/x.pmtiles'));
  });

  it('distinguishes .torrent files from other identifiers', () => {
    assert.ok(isTorrentFile('/data/planet.pmtiles.torrent'));
    assert.ok(!isTorrentFile(`magnet:?xt=urn:btih:${'a'.repeat(40)}`));
    assert.ok(!isTorrentFile('/data/x.pmtiles'));
  });

  it('reads the archive name a torrent advertises', () => {
    assert.strictEqual(
      torrentDisplayName(
        'magnet:?xt=urn:btih:5e1c143c400d15aaacfb1c748d4ab6d1b46c5df5&dn=planetiler-openmaptiles-latest.pmtiles&tr=udp%3a%2f%2ftracker.example%3a1337',
      ),
      'planetiler-openmaptiles-latest.pmtiles',
    );
    assert.strictEqual(
      torrentDisplayName('C:\\maps\\planet.pmtiles.torrent'),
      'planet.pmtiles',
    );
    assert.strictEqual(
      torrentDisplayName('/data/planet.pmtiles.torrent'),
      'planet.pmtiles',
    );
    // Percent-encoded display names are decoded.
    assert.strictEqual(
      torrentDisplayName(
        `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=my%20map.pmtiles`,
      ),
      'my map.pmtiles',
    );
    assert.strictEqual(
      torrentDisplayName(`magnet:?xt=urn:btih:${'a'.repeat(40)}`),
      null,
    );
  });

  it('rejects a truncated header', () => {
    assert.strictEqual(readLayout(new Uint8Array(10)), null);
  });

  it('keeps the most recently used entries', () => {
    const cache = new PieceCache(200);
    cache.set(1, new Uint8Array(100));
    cache.set(2, new Uint8Array(100));
    cache.get(1); // 1 is now newer than 2
    cache.set(3, new Uint8Array(100));

    assert.ok(cache.get(1));
    assert.strictEqual(cache.get(2), undefined);
    assert.ok(cache.get(3));
  });

  it('skips pieces larger than the whole budget', () => {
    const cache = new PieceCache(50);
    cache.set(1, new Uint8Array(100));
    assert.strictEqual(cache.size, 0);
  });
});

describe('stats', () => {
  it('does not count a completed fetch as a cancellation', async () => {
    const engine = new FakeEngine(ramp(1000), { pieceLength: 100 });
    const source = new TorrentSource(engine);

    await source.getBytes(0, 250);

    assert.strictEqual(source.stats.cancelled, 0);
    assert.strictEqual(source.stats.cacheMisses, 3);
  });
});

describe('idle hydration', () => {
  /**
   * Builds an archive whose header points at the given sections.
   * @param {number} leafOffset - Leaf directory offset.
   * @param {number} leafLength - Leaf directory length.
   * @param {number} total - Archive length.
   * @returns {Uint8Array} - The archive bytes.
   */
  function archiveWithLeaf(leafOffset, leafLength, total) {
    const data = ramp(total);
    data.set(new TextEncoder().encode('PMTiles'), 0);
    data[7] = 3;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    /**
     * Writes a little-endian uint64.
     * @param {number} at - Field offset.
     * @param {number} value - Value to write.
     * @returns {void}
     */
    const put = (at, value) => {
      view.setUint32(at, value >>> 0, true);
      view.setUint32(at + 4, Math.floor(value / 2 ** 32), true);
    };
    put(8, 127); // root directory
    put(16, 50);
    put(24, 177); // metadata
    put(32, 50);
    put(40, leafOffset);
    put(48, leafLength);
    return data;
  }

  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('does not hydrate leaf directories eagerly', async () => {
    const engine = new FakeEngine(archiveWithLeaf(1000, 500, 2000), {
      pieceLength: 512,
    });
    const source = new TorrentSource(engine, { hydrateIdleMs: 10000 });

    await source.getBytes(0, 200);

    // Root and metadata only — the leaf section must not compete with reads.
    assert.deepStrictEqual(
      engine.hints.map((h) => h.offset),
      [127, 177],
    );
    assert.strictEqual(source.stats.hydrating, false);
    await source.destroy();
  });

  it('hydrates leaf directories once idle', async () => {
    const engine = new FakeEngine(archiveWithLeaf(1000, 500, 2000), {
      pieceLength: 512,
    });
    const source = new TorrentSource(engine, { hydrateIdleMs: 20 });

    await source.getBytes(0, 200);
    await settle(80);

    assert.deepStrictEqual(engine.hints.at(-1), {
      offset: 1000,
      length: 500,
      priority: 'normal',
    });
    assert.strictEqual(source.stats.hydrating, true);
    await source.destroy();
  });

  it('yields to a request that arrives mid-hydration', async () => {
    const engine = new FakeEngine(archiveWithLeaf(1000, 500, 2000), {
      pieceLength: 512,
    });
    const source = new TorrentSource(engine, { hydrateIdleMs: 20 });

    await source.getBytes(0, 200);
    await settle(80);
    assert.strictEqual(source.stats.hydrating, true);

    // A tile request must claw the bandwidth back immediately.
    await source.getBytes(1600, 100);

    assert.deepStrictEqual(engine.unhints, [{ offset: 1000, length: 500 }]);
    await source.destroy();
  });

  it('stops hydrating when destroyed', async () => {
    const engine = new FakeEngine(archiveWithLeaf(1000, 500, 2000), {
      pieceLength: 512,
    });
    const source = new TorrentSource(engine, { hydrateIdleMs: 20 });

    await source.getBytes(0, 200);
    await source.destroy();
    await settle(80);

    assert.strictEqual(source.stats.hydrating, false);
  });

  it('skips a leaf section larger than the hydration budget', async () => {
    const engine = new FakeEngine(archiveWithLeaf(1000, 900, 2000), {
      pieceLength: 512,
    });
    const source = new TorrentSource(engine, {
      hydrateIdleMs: 20,
      maxLeafPrefetchBytes: 500,
    });

    await source.getBytes(0, 200);
    await settle(80);

    assert.deepStrictEqual(
      engine.hints.map((h) => h.offset),
      [127, 177],
    );
    await source.destroy();
  });
});
