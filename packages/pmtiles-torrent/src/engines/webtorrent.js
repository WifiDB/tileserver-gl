/**
 * A TorrentEngine backed by WebTorrent.
 *
 * Written against WebTorrent's public API (MIT, Copyright (c) Feross
 * Aboukhadijeh and WebTorrent, LLC — https://github.com/webtorrent/webtorrent).
 * No WebTorrent implementation code is copied here. See NOTICE.md.
 */

/**
 * Options for the WebTorrent engine.
 * @typedef {object} WebTorrentEngineOptions
 * @property {object | (() => object | Promise<object>)} [client] - Reuse an existing WebTorrent client, or a factory called on first read. Strongly recommended when serving more than one archive: one client means one peer pool, one port, one DHT node. When supplied, destroy() removes only this torrent and leaves the client running.
 * @property {object} [clientOptions] - Options passed to new WebTorrent() when this engine creates the client.
 * @property {string} [path] - Download path for the chunk store. Persist this to keep seeding across restarts.
 * @property {string[]} [announce] - Extra tracker announce URLs.
 * @property {string} [filePath] - Select a specific file in a multi-file torrent by its path. Without it the engine picks the largest .pmtiles file, falling back to the largest file.
 * @property {number} [readyTimeoutMs] - How long to wait for torrent metadata. Default 60s.
 */

/** @type {Record<import('../types.js').Priority, number>} */
const PRIORITY_VALUES = {
  critical: 10,
  high: 5,
  normal: 0,
};

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
 * Rejects as soon as a signal aborts, rather than waiting for the promise.
 * @template T
 * @param {Promise<T>} promise - The promise to race.
 * @param {AbortSignal} [signal] - The signal to watch.
 * @returns {Promise<T>} - The promise result, or a rejection on abort.
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    /**
     * Rejects the race.
     * @returns {void}
     */
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Pulls an infohash out of a magnet URI so getKey() works before metadata
 * arrives.
 * @param {unknown} torrentId - Magnet URI, infohash, or anything else.
 * @returns {string} - A stable key.
 */
function deriveKey(torrentId) {
  if (typeof torrentId !== 'string') return 'torrent:unknown';
  const magnet = /xt=urn:bt[im]h:([a-z0-9]+)/i.exec(torrentId);
  if (magnet) return `torrent:${magnet[1].toLowerCase()}`;
  if (/^[a-f0-9]{40}$/i.test(torrentId)) {
    return `torrent:${torrentId.toLowerCase()}`;
  }
  return `torrent:${torrentId}`;
}

/**
 * Chooses which file in the torrent is the PMTiles archive.
 * @param {object} torrent - The WebTorrent torrent.
 * @param {string} [filePath] - Explicit path or name to select.
 * @returns {object} - The chosen file.
 */
function pickFile(torrent, filePath) {
  if (torrent.files.length === 0) throw new Error('torrent contains no files');

  if (filePath) {
    const match = torrent.files.find(
      (file) => file.path === filePath || file.name === filePath,
    );
    if (!match) {
      throw new Error(
        `no file "${filePath}" in torrent (has: ${torrent.files
          .map((f) => f.path)
          .join(', ')})`,
      );
    }
    return match;
  }

  const byLength = [...torrent.files].sort((a, b) => b.length - a.length);
  return byLength.find((file) => file.name.endsWith('.pmtiles')) ?? byLength[0];
}

/**
 * Loads WebTorrent lazily, so it stays a genuinely optional dependency.
 * @returns {Promise<new (opts?: object) => object>} - The WebTorrent constructor.
 */
async function loadWebTorrent() {
  try {
    // Indirect specifier on purpose: it stops bundlers from pulling a
    // Node-flavoured torrent client into builds that never use it.
    const specifier = 'webtorrent';
    const mod = await import(specifier);
    const ctor = mod.default ?? mod;
    if (typeof ctor !== 'function') {
      throw new Error('webtorrent module did not export a constructor');
    }
    return ctor;
  } catch (error) {
    throw new Error(
      "WebTorrentEngine requires the optional peer dependency 'webtorrent'. " +
        'Install it, or pass an existing client via options.client. ' +
        `(${error.message})`,
      { cause: error },
    );
  }
}

/**
 * A TorrentEngine backed by WebTorrent.
 *
 * Works in Node and in the browser, and is the only engine that can bridge the
 * two: browser peers speak WebRTC and conventional clients speak TCP/uTP, so a
 * WebTorrent-based server is what lets one swarm serve both.
 *
 * Note this is a BitTorrent v1 engine — WebTorrent does not implement BEP 52,
 * so v2 merkle verification and btmh magnets need a different engine.
 * @implements {import('../types.js').TorrentEngine}
 */
export class WebTorrentEngine {
  #torrentId;
  #options;
  #client;
  #torrent;
  #file;
  #ownsClient = false;
  #readyPromise;
  #destroyed = false;

  /**
   * Creates a WebTorrent-backed engine.
   * @param {unknown} torrentId - Magnet URI, infohash, .torrent buffer or path.
   * @param {WebTorrentEngineOptions} [options] - Client and selection options.
   */
  constructor(torrentId, options = {}) {
    this.#torrentId = torrentId;
    this.#options = options;
    /** @type {string} */
    this.key = deriveKey(torrentId);
  }

  /**
   * The underlying torrent, once metadata has arrived. For swarm stats.
   * @returns {object | undefined} - The WebTorrent torrent.
   */
  get torrent() {
    return this.#torrent;
  }

  /**
   * Resolves torrent metadata, starting the client on first call.
   * @returns {Promise<import('../types.js').TorrentInfo>} - The metadata.
   */
  ready() {
    if (!this.#readyPromise) this.#readyPromise = this.#start();
    return this.#readyPromise;
  }

  /**
   * Reads a byte range out of the archive file.
   * @param {number} offset - Byte offset into the file.
   * @param {number} length - Number of bytes to read.
   * @param {import('../types.js').ReadRangeOptions} [options] - Signal and priority.
   * @returns {Promise<Uint8Array>} - Exactly length bytes.
   */
  async readRange(offset, length, options = {}) {
    await this.ready();
    const file = this.#file;
    const { signal } = options;
    if (signal?.aborted) throw abortError();

    const end = offset + length - 1;
    // WebTorrent's iterator selects the range at elevated priority and marks
    // pieces critical as it advances, which is exactly the behaviour we want
    // for a blocking read. Driving next() by hand (rather than for await) is
    // what lets an abort interrupt a stalled fetch instead of waiting for the
    // next chunk to arrive.
    const iterator = file[Symbol.asyncIterator]({ start: offset, end });

    const out = new Uint8Array(length);
    let written = 0;
    try {
      while (written < length) {
        const result = await raceAbort(
          Promise.resolve(iterator.next()),
          signal,
        );
        if (result.done) break;
        const chunk = result.value;
        const take = Math.min(chunk.byteLength, length - written);
        out.set(chunk.subarray(0, take), written);
        written += take;
      }
    } finally {
      // Releases the iterator's piece selection whether we finished or bailed.
      try {
        await iterator.return?.();
      } catch {
        /* the read already failed; nothing useful to do here */
      }
    }

    if (written < length) {
      throw new Error(
        `short read from torrent: got ${written} of ${length} bytes at offset ${offset}`,
      );
    }
    return out;
  }

  /**
   * Marks a range for background download at the given priority.
   * @param {number} offset - Byte offset into the file.
   * @param {number} length - Number of bytes.
   * @param {import('../types.js').Priority} priority - How urgently.
   * @returns {void}
   */
  hint(offset, length, priority) {
    const torrent = this.#torrent;
    const file = this.#file;
    if (!torrent || !file || torrent.destroyed || length <= 0) return;

    const first = Math.floor((file.offset + offset) / torrent.pieceLength);
    const last = Math.floor(
      (file.offset + offset + length - 1) / torrent.pieceLength,
    );
    // eslint-disable-next-line security/detect-object-injection -- priority is a checked union of literals
    torrent.select(first, last, PRIORITY_VALUES[priority]);
    if (priority === 'critical') torrent.critical(first, last);
  }

  /**
   * Releases the torrent, and the client if this engine created it.
   * @returns {Promise<void>} - Resolves once torn down.
   */
  async destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;

    const torrent = this.#torrent;
    const client = this.#client;
    this.#torrent = undefined;
    this.#file = undefined;
    this.#client = undefined;
    this.#readyPromise = undefined;

    if (this.#ownsClient && client) {
      await new Promise((resolve) => client.destroy(() => resolve()));
      return;
    }
    // Shared client: drop our torrent but leave the client (and its other
    // torrents) alone. Keep the store so we can resume seeding later.
    if (torrent && !torrent.destroyed) torrent.destroy({ destroyStore: false });
  }

  /**
   * Adds the torrent and waits for metadata.
   * @returns {Promise<import('../types.js').TorrentInfo>} - The metadata.
   */
  async #start() {
    if (this.#destroyed) throw new Error('engine is destroyed');

    const provided = this.#options.client;
    let client;
    if (provided) {
      client = typeof provided === 'function' ? await provided() : provided;
    } else {
      const WebTorrent = await loadWebTorrent();
      client = new WebTorrent(this.#options.clientOptions ?? {});
      this.#ownsClient = true;
    }
    this.#client = client;

    const addOptions = {
      // Without this WebTorrent selects every piece and starts downloading the
      // whole archive. We want on-demand ranges only — the point of the
      // exercise is serving a 700 GiB map without holding 700 GiB.
      deselect: true,
    };
    if (this.#options.path) addOptions.path = this.#options.path;
    if (this.#options.announce) addOptions.announce = this.#options.announce;

    const timeoutMs = this.#options.readyTimeoutMs ?? 60000;
    const torrent = await new Promise((resolve, reject) => {
      let settled = false;
      /**
       * Runs the first settlement only, clearing the timer.
       * @param {() => void} fn - The settle action.
       * @returns {void}
       */
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for torrent metadata (${this.key})`,
            ),
          ),
        );
      }, timeoutMs);

      let added;
      try {
        added = client.add(this.#torrentId, addOptions, (t) =>
          finish(() => resolve(t)),
        );
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      added.once('error', (error) => finish(() => reject(error)));
    });

    this.#torrent = torrent;
    const file = pickFile(torrent, this.#options.filePath);
    this.#file = file;

    return {
      infoHash: torrent.infoHash,
      pieceLength: torrent.pieceLength,
      numPieces: torrent.pieces.length,
      fileLength: file.length,
      fileOffset: file.offset,
      name: file.name,
    };
  }
}
