import { PieceCache } from './cache.js';
import { HEADER_SIZE, readLayout } from './layout.js';

/**
 * A torrent is content-addressed and immutable, so a range read can be cached
 * forever. This is the one place where the torrent transport is strictly better
 * behaved than an HTTP origin.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Floor for the piece cache, used when the piece length is small. */
const MIN_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_CACHE_PIECES = 8;
/**
 * Leaf directories are hydrated only while idle, so this can be generous —
 * it never competes with a request.
 */
const DEFAULT_MAX_LEAF_PREFETCH_BYTES = 256 * 1024 * 1024;
/** How long the source must be idle before background hydration resumes. */
const DEFAULT_HYDRATE_IDLE_MS = 2000;

/**
 * Tuning for a torrent-backed source.
 * @typedef {object} TorrentSourceOptions
 * @property {number} [cacheBytes] - Explicit byte budget for the piece cache. Zero disables caching and relies entirely on the engine's own store. Leave unset to size the cache from the torrent's piece length; a fixed byte budget is a trap with large pieces, since 64 MiB holds only four 16 MiB pieces.
 * @property {number} [cachePieces] - How many pieces the cache should hold when cacheBytes is not given. The effective budget is max(64 MiB, cachePieces * pieceLength). Default 8.
 * @property {boolean} [prefetchDirectories] - Prioritise the root directory, JSON metadata and leaf directories once the header is read. Default true.
 * @property {number} [maxLeafPrefetchBytes] - Upper bound on the leaf-directory region to hydrate in the background. Default 256 MiB.
 * @property {number} [hydrateIdleMs] - How long no read must be in flight before background hydration resumes. Default 2000.
 * @property {string} [key] - Overrides the value returned by getKey().
 */

/**
 * Counters describing what the source has done.
 * @typedef {object} TorrentSourceStats
 * @property {number} cacheHits - Piece reads served from cache.
 * @property {number} cacheMisses - Piece reads that had to go to the engine.
 * @property {number} bytesFetched - Bytes read from the engine, i.e. whole pieces.
 * @property {number} bytesServed - Bytes handed back to PMTiles.
 * @property {number} cancelled - Piece reads cancelled because every waiter went away.
 * @property {number} cachedPieces - Pieces currently resident.
 * @property {number} cachedBytes - Bytes currently resident.
 * @property {number} cacheBudget - Current cache budget, only final once metadata has arrived.
 * @property {boolean} hydrating - Whether background hydration is currently running.
 */

/**
 * Builds an AbortError.
 * @returns {Error} - An error whose name is AbortError.
 */
function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * A PMTiles Source backed by a BitTorrent swarm.
 *
 * PMTiles reads an archive as a series of byte ranges, and BitTorrent serves
 * data as fixed-size verified pieces. This class is the mapping between the
 * two: it expands each requested range to the pieces covering it, fetches those
 * pieces (in parallel, deduplicated across concurrent requests), caches them,
 * and slices the requested bytes back out.
 *
 * Because PMTiles clusters tiles in Hilbert order, a piece fetched for one tile
 * usually contains spatial neighbours — so the read amplification inherent to
 * piece-granular transport doubles as useful prefetch.
 */
export class TorrentSource {
  #engine;
  #options;
  #cache;
  #pending = new Map();
  #initPromise;
  #info;
  #layoutRead = false;
  /** Regions to fetch in the background while nothing is being requested. */
  #hydrationRegions = [];
  #hydrationActive = false;
  #idleTimer;
  #destroyed = false;
  #stats = {
    cacheHits: 0,
    cacheMisses: 0,
    bytesFetched: 0,
    bytesServed: 0,
    cancelled: 0,
  };

  /**
   * Creates a torrent-backed source.
   * @param {import('./types.js').TorrentEngine} engine - The BitTorrent client abstraction.
   * @param {TorrentSourceOptions} [options] - Tuning.
   */
  constructor(engine, options = {}) {
    this.#engine = engine;
    this.#options = {
      cacheBytes: options.cacheBytes,
      cachePieces: options.cachePieces ?? DEFAULT_CACHE_PIECES,
      prefetchDirectories: options.prefetchDirectories ?? true,
      maxLeafPrefetchBytes:
        options.maxLeafPrefetchBytes ?? DEFAULT_MAX_LEAF_PREFETCH_BYTES,
      hydrateIdleMs: options.hydrateIdleMs ?? DEFAULT_HYDRATE_IDLE_MS,
      key: options.key,
    };
    // Provisional until metadata arrives and the piece length is known.
    this.#cache = new PieceCache(this.#options.cacheBytes ?? MIN_CACHE_BYTES);
  }

  /**
   * The underlying engine, for seeding stats or swarm introspection.
   * @returns {import('./types.js').TorrentEngine} - The engine.
   */
  get engine() {
    return this.#engine;
  }

  /**
   * Counters describing cache and fetch behaviour.
   * @returns {TorrentSourceStats} - A snapshot.
   */
  get stats() {
    return {
      ...this.#stats,
      cachedPieces: this.#cache.size,
      cachedBytes: this.#cache.byteLength,
      cacheBudget: this.#cache.maxBytes,
      hydrating: this.#hydrationActive,
    };
  }

  /**
   * A unique key for this archive, available before metadata arrives.
   * @returns {string} - The source key.
   */
  getKey() {
    return this.#options.key ?? this.#engine.key;
  }

  /**
   * Resolves torrent metadata without reading any archive bytes. Useful if you
   * want to fail fast at startup rather than on the first tile request.
   * @returns {Promise<import('./types.js').TorrentInfo>} - The torrent metadata.
   */
  async ready() {
    return this.#init();
  }

  /**
   * Reads a byte range out of the archive.
   *
   * The etag argument is accepted for interface compatibility and ignored: an
   * infohash is a content hash, so the bytes behind a given key can never
   * change. PMTiles' ETag-mismatch retry path is structurally unreachable here.
   * @param {number} offset - Byte offset into the archive.
   * @param {number} length - Number of bytes wanted.
   * @param {AbortSignal} [signal] - Cancels the read.
   * @param {string} [_etag] - Ignored; see above.
   * @returns {Promise<object>} - A PMTiles RangeResponse.
   */
  async getBytes(offset, length, signal, _etag) {
    if (signal?.aborted) throw abortError();
    const info = await this.#init();

    if (offset < 0 || length < 0) {
      throw new RangeError(`invalid range: offset ${offset}, length ${length}`);
    }
    if (offset >= info.fileLength) {
      throw new RangeError(
        `offset ${offset} is past the end of the archive (${info.fileLength} bytes)`,
      );
    }

    // PMTiles speculatively over-reads (16 KiB for the header, for instance),
    // which would run off the end of a small archive. HTTP sources get this for
    // free from the server; here we clamp.
    const wanted = Math.min(length, info.fileLength - offset);
    if (wanted === 0) {
      return {
        data: new ArrayBuffer(0),
        etag: info.infoHash,
        cacheControl: IMMUTABLE,
      };
    }

    const firstPiece = this.#pieceIndexOf(offset);
    const lastPiece = this.#pieceIndexOf(offset + wanted - 1);

    const indices = [];
    for (let i = firstPiece; i <= lastPiece; i++) indices.push(i);

    // Fetch every covering piece concurrently. Serialising these was the single
    // biggest latency cost in the original implementation: a range spanning
    // three pieces paid three sequential swarm round-trips.
    const pieces = await Promise.all(
      indices.map((index) => this.#getPiece(index, signal)),
    );

    const out = new Uint8Array(wanted);
    let written = 0;
    for (let n = 0; n < indices.length; n++) {
      // eslint-disable-next-line security/detect-object-injection -- n indexes arrays we just built
      const piece = pieces[n];
      // eslint-disable-next-line security/detect-object-injection -- n indexes arrays we just built
      const pieceStart = this.#pieceFileRange(indices[n]).start;
      const from = Math.max(0, offset - pieceStart);
      const to = Math.min(piece.byteLength, offset + wanted - pieceStart);
      out.set(piece.subarray(from, to), written);
      written += to - from;
    }

    if (written !== wanted) {
      throw new Error(
        `short read: assembled ${written} of ${wanted} bytes at offset ${offset}`,
      );
    }
    this.#stats.bytesServed += written;

    if (!this.#layoutRead && offset === 0 && written >= HEADER_SIZE) {
      this.#layoutRead = true;
      this.#prefetchDirectories(out);
    }

    // `out` owns its buffer exactly, so handing over .buffer is safe. Buffer
    // pooling is why a Buffer-based implementation has to slice defensively.
    return {
      data: out.buffer,
      etag: info.infoHash,
      cacheControl: IMMUTABLE,
    };
  }

  /**
   * Releases the cache, cancels in-flight reads and destroys the engine.
   * @returns {Promise<void>} - Resolves once the engine has been destroyed.
   */
  async destroy() {
    this.#destroyed = true;
    this.#suspendHydration();
    this.#hydrationRegions = [];
    this.#cache.clear();
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear();
    this.#initPromise = undefined;
    this.#info = undefined;
    this.#layoutRead = false;
    await this.#engine.destroy();
  }

  /**
   * Resolves and validates torrent metadata, once.
   * @returns {Promise<import('./types.js').TorrentInfo>} - The torrent metadata.
   */
  #init() {
    if (!this.#initPromise) {
      this.#initPromise = this.#engine.ready().then((info) => {
        if (!(info.pieceLength > 0)) {
          throw new Error(
            `engine reported invalid piece length ${info.pieceLength}`,
          );
        }
        if (!(info.fileLength > 0)) {
          throw new Error(
            `engine reported empty archive (${info.fileLength} bytes)`,
          );
        }
        // Size the cache in pieces now that the piece length is known. Torrents
        // of large archives are routinely cut at 16 MiB per piece, where a
        // fixed byte budget holds too few pieces to be useful.
        if (this.#options.cacheBytes === undefined) {
          this.#cache.resize(
            Math.max(
              MIN_CACHE_BYTES,
              this.#options.cachePieces * info.pieceLength,
            ),
          );
        }
        this.#info = info;
        return info;
      });
    }
    return this.#initPromise;
  }

  /**
   * Maps a file-relative offset to the torrent piece containing it.
   * @param {number} fileOffset - Byte offset into the archive.
   * @returns {number} - The piece index.
   */
  #pieceIndexOf(fileOffset) {
    const info = this.#info;
    return Math.floor((info.fileOffset + fileOffset) / info.pieceLength);
  }

  /**
   * The portion of a piece that lies inside the archive file, as inclusive
   * file-relative bounds. Pieces at either end of the file may be clipped when
   * the torrent holds more than one file.
   * @param {number} index - The piece index.
   * @returns {{start: number, end: number}} - Inclusive file-relative bounds.
   */
  #pieceFileRange(index) {
    const info = this.#info;
    const globalStart = index * info.pieceLength;
    const globalEnd = globalStart + info.pieceLength - 1;
    return {
      start: Math.max(0, globalStart - info.fileOffset),
      end: Math.min(info.fileLength - 1, globalEnd - info.fileOffset),
    };
  }

  /**
   * Fetches one piece, sharing in-flight work between concurrent callers.
   *
   * Cancellation is reference counted: an aborted request stops waiting
   * immediately, but the underlying fetch is only cancelled once every waiter
   * has gone. Forwarding a caller's signal straight through would let one
   * abandoned tile request kill a piece another request is still waiting on.
   * @param {number} index - The piece index.
   * @param {AbortSignal} [signal] - Cancels this caller's interest.
   * @returns {Promise<Uint8Array>} - The piece contents.
   */
  #getPiece(index, signal) {
    const cached = this.#cache.get(index);
    if (cached !== undefined) {
      this.#stats.cacheHits++;
      return Promise.resolve(cached);
    }
    this.#stats.cacheMisses++;

    let entry = this.#pending.get(index);
    if (entry === undefined) {
      const created = {
        controller: new AbortController(),
        waiters: 0,
        settled: false,
        promise: undefined,
      };
      created.promise = this.#fetchPiece(index, created.controller.signal);
      // Registered before any waiter's callbacks, so `settled` is already true
      // by the time they run. Without it, the last waiter detaching after a
      // successful fetch would look identical to the last waiter giving up.
      created.promise.then(
        () => {
          created.settled = true;
        },
        () => {
          created.settled = true;
        },
      );
      // Waiters may all detach before this settles; keep Node quiet about it.
      created.promise.catch(() => {});
      created.promise
        .finally(() => {
          if (this.#pending.get(index) === created) this.#pending.delete(index);
          // Once nothing is outstanding, start counting down to hydration.
          this.#scheduleHydration();
        })
        .catch(() => {});
      this.#pending.set(index, created);
      entry = created;
      // A real request needs the bandwidth now; get hydration out of the way.
      this.#suspendHydration();
    }

    const pending = entry;
    pending.waiters++;

    return new Promise((resolve, reject) => {
      let detached = false;
      /**
       * Drops this caller's interest, cancelling the fetch if it was the last.
       * @returns {boolean} - True if already detached.
       */
      const detach = () => {
        if (detached) return true;
        detached = true;
        pending.waiters--;
        if (
          pending.waiters === 0 &&
          !pending.settled &&
          !pending.controller.signal.aborted
        ) {
          this.#stats.cancelled++;
          pending.controller.abort();
        }
        signal?.removeEventListener('abort', onAbort);
        return false;
      };
      /**
       * Rejects this caller when its signal fires.
       * @returns {void}
       */
      const onAbort = () => {
        if (!detach()) reject(abortError());
      };

      if (signal?.aborted) {
        detach();
        reject(abortError());
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      pending.promise.then(
        (value) => {
          detach();
          resolve(value);
        },
        (error) => {
          detach();
          reject(error);
        },
      );
    });
  }

  /**
   * Reads one whole piece from the engine and caches it.
   * @param {number} index - The piece index.
   * @param {AbortSignal} signal - Cancels the read.
   * @returns {Promise<Uint8Array>} - The piece contents.
   */
  async #fetchPiece(index, signal) {
    const { start, end } = this.#pieceFileRange(index);
    const length = end - start + 1;
    const bytes = await this.#engine.readRange(start, length, {
      signal,
      priority: 'critical',
    });
    if (bytes.byteLength !== length) {
      throw new Error(
        `engine returned ${bytes.byteLength} bytes for piece ${index}, expected ${length}`,
      );
    }
    this.#stats.bytesFetched += bytes.byteLength;
    this.#cache.set(index, bytes);
    return bytes;
  }

  /**
   * Tells the engine which regions matter before anything asks for them.
   *
   * Every tile lookup is gated on a directory read, so the root directory is
   * worth treating as critical even though nothing is blocked on it yet.
   * @param {Uint8Array} header - The start of the archive.
   * @returns {void}
   */
  #prefetchDirectories(header) {
    if (!this.#options.prefetchDirectories) return;
    const hint = this.#engine.hint?.bind(this.#engine);
    if (!hint) return;

    const layout = readLayout(header);
    if (!layout) return;

    const info = this.#info;
    /**
     * Is this section entirely inside the archive?
     * @param {number} offset - Section offset.
     * @param {number} length - Section length.
     * @returns {boolean} - True if in bounds and non-empty.
     */
    const inBounds = (offset, length) =>
      length > 0 && offset >= 0 && offset + length <= info.fileLength;

    // The root directory and metadata are small and needed immediately, so
    // they are worth fetching eagerly.
    if (inBounds(layout.rootDirectoryOffset, layout.rootDirectoryLength)) {
      hint(layout.rootDirectoryOffset, layout.rootDirectoryLength, 'critical');
    }
    if (inBounds(layout.jsonMetadataOffset, layout.jsonMetadataLength)) {
      hint(layout.jsonMetadataOffset, layout.jsonMetadataLength, 'high');
    }

    // Leaf directories are a different matter. Every tile lookup in a new
    // region needs one, so having them locally is a large win — but the
    // section runs to hundreds of megabytes, and fetching it eagerly starves
    // the very requests it is meant to accelerate. Measured on a 72 GiB
    // archive against a single peer, eager prefetch took a cold tile from 34s
    // to 138s. So it is queued for hydration while nothing is being read.
    if (
      inBounds(layout.leafDirectoryOffset, layout.leafDirectoryLength) &&
      layout.leafDirectoryLength <= this.#options.maxLeafPrefetchBytes
    ) {
      this.#hydrationRegions.push({
        offset: layout.leafDirectoryOffset,
        length: layout.leafDirectoryLength,
      });
      this.#scheduleHydration();
    }
  }

  /**
   * Stops background hydration because a request needs the bandwidth. Called
   * whenever a piece fetch starts.
   * @returns {void}
   */
  #suspendHydration() {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (!this.#hydrationActive) return;
    this.#hydrationActive = false;
    const unhint = this.#engine.unhint?.bind(this.#engine);
    if (!unhint) return;
    for (const region of this.#hydrationRegions) {
      unhint(region.offset, region.length);
    }
  }

  /**
   * Arms background hydration to resume once the source has been idle for
   * `hydrateIdleMs`. A request arriving in the meantime disarms it again.
   * @returns {void}
   */
  #scheduleHydration() {
    if (this.#destroyed) return;
    if (this.#hydrationActive || this.#hydrationRegions.length === 0) return;
    // Pointless without a way to call the hydration off again.
    if (!this.#engine.hint || !this.#engine.unhint) return;
    if (this.#pending.size > 0) return;
    if (this.#idleTimer !== undefined) return;

    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#destroyed || this.#pending.size > 0) return;
      this.#hydrationActive = true;
      const hint = this.#engine.hint.bind(this.#engine);
      for (const region of this.#hydrationRegions) {
        hint(region.offset, region.length, 'normal');
      }
    }, this.#options.hydrateIdleMs);
    // Do not hold the process open just to hydrate.
    this.#idleTimer.unref?.();
  }
}
