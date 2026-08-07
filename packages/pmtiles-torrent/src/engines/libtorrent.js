import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A TorrentEngine backed by libtorrent, through a sidecar process.
 *
 * The WebTorrent engine works, but it reaches its limits exactly where this
 * use case cares most. libtorrent adds three things it cannot:
 *
 *   set_piece_deadline — promotes one piece to the front of the queue rather
 *     than waiting for the normal picker. That is precisely what an on-demand
 *     tile read wants, and WebTorrent only approximates it.
 *
 *   per-piece priorities — background hydration can sit at priority 1 and drop
 *     to 0 the instant a read arrives, rather than being selected and
 *     deselected wholesale.
 *
 *   BitTorrent v2 (BEP 52) — per-file merkle trees with 16 KiB leaf blocks, so
 *     a peer can verify a small block without the whole hash list. That is the
 *     right shape for random access, and WebTorrent does not implement it.
 *
 * It costs a child process and a libtorrent install
 * (apt install python3-libtorrent), so WebTorrent remains the default and the
 * only option in a browser. The protocol is line-delimited JSON, unchanged if
 * a native binding ever replaces the sidecar.
 */
export class LibtorrentEngine {
  /** @type {string} */
  key;

  #torrentId;
  #options;
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #buffer = '';
  #startPromise = null;
  #info = null;
  #version = null;

  /**
   * Creates the engine.
   * @param {string} torrentId - Magnet URI, infohash, or path to a .torrent file.
   * @param {object} options - Engine options.
   * @param {string} options.path - Directory holding (or to hold) the data.
   * @param {string} [options.resumeDir] - Where resume data is kept. Skips re-hashing the store on start.
   * @param {string} [options.python] - Python executable. Default 'python3'.
   * @param {string} [options.script] - Override the sidecar script path.
   * @param {string} [options.listen] - Listen interfaces, e.g. '0.0.0.0:6881'.
   * @param {number} [options.maxConnections] - Peer connection cap.
   * @param {number} [options.readyTimeoutMs] - How long to wait for metadata. Default 300s.
   * @param {number} [options.pieceTimeoutMs] - How long to wait for one piece. Default 120s.
   */
  constructor(torrentId, options = {}) {
    if (!options.path) {
      throw new Error('libtorrent engine requires a path for the data store');
    }
    this.#torrentId = torrentId;
    this.#options = {
      python: 'python3',
      readyTimeoutMs: 300000,
      pieceTimeoutMs: 120000,
      startTimeoutMs: 20000,
      ...options,
    };
    this.key = deriveKey(torrentId);
  }

  /** @returns {string | null} - libtorrent version, once started. */
  get version() {
    return this.#version;
  }

  /**
   * Adds the torrent and waits for its metadata.
   * @returns {Promise<import('../types.js').TorrentInfo>} - The torrent geometry.
   */
  ready() {
    if (!this.#startPromise) this.#startPromise = this.#start();
    return this.#startPromise;
  }

  /**
   * Reads a byte range.
   *
   * The source only ever asks for whole pieces clipped to the file, so this
   * maps the range onto a single piece and pulls it with a deadline. Reading a
   * range that straddles pieces would be a bug in the caller, and is reported
   * rather than silently stitched.
   * @param {number} offset - Byte offset into the archive file.
   * @param {number} length - Number of bytes.
   * @param {import('../types.js').ReadRangeOptions} [options] - Signal and priority.
   * @returns {Promise<Uint8Array>} - Exactly length bytes.
   */
  async readRange(offset, length, options = {}) {
    const info = await this.ready();
    if (options.signal?.aborted) throw abortError();

    const globalStart = info.fileOffset + offset;
    const first = Math.floor(globalStart / info.pieceLength);
    const last = Math.floor((globalStart + length - 1) / info.pieceLength);
    if (first !== last) {
      throw new Error(
        `readRange spans pieces ${first}-${last}; the source should request one piece at a time`,
      );
    }

    const piece = await this.#call(
      'read_piece',
      {
        infoHash: info.infoHash,
        piece: first,
        // A blocking read is the most urgent thing the session can be doing.
        deadlineMs: 0,
        timeoutMs: this.#options.pieceTimeoutMs,
      },
      this.#options.pieceTimeoutMs + 5000,
      options.signal,
    );

    const bytes = Buffer.from(piece.data, 'base64');
    // The piece may extend past the file at either end in a multi-file torrent.
    const within = globalStart - first * info.pieceLength;
    const slice = bytes.subarray(within, within + length);
    if (slice.length !== length) {
      throw new Error(
        `short read from libtorrent: got ${slice.length} of ${length} bytes at offset ${offset}`,
      );
    }
    return new Uint8Array(slice);
  }

  /**
   * Raises a range's priority so it downloads in the background.
   * @param {number} offset - Byte offset into the file.
   * @param {number} length - Number of bytes.
   * @param {import('../types.js').Priority} priority - How urgently.
   * @returns {void}
   */
  hint(offset, length, priority) {
    if (!this.#info || length <= 0) return;
    const { first, last } = this.#pieceRange(offset, length);
    // 7 is libtorrent's maximum; 1 is the lowest that still downloads. Anything
    // hydrated in the background belongs at 1 so a real read outranks it.
    const value = priority === 'critical' ? 7 : priority === 'high' ? 4 : 1;
    this.#call('set_priority', {
      infoHash: this.#info.infoHash,
      first,
      last,
      priority: value,
    }).catch((error) => {
      console.error(`[libtorrent] hint failed: ${error.message}`);
    });
  }

  /**
   * Drops a range back to priority 0, so it stops competing for bandwidth.
   * @param {number} offset - Byte offset into the file.
   * @param {number} length - Number of bytes.
   * @returns {void}
   */
  unhint(offset, length) {
    if (!this.#info || length <= 0) return;
    const { first, last } = this.#pieceRange(offset, length);
    this.#call('set_priority', {
      infoHash: this.#info.infoHash,
      first,
      last,
      priority: 0,
    }).catch((error) => {
      console.error(`[libtorrent] unhint failed: ${error.message}`);
    });
  }

  /**
   * Saves resume data and stops the sidecar.
   * @returns {Promise<void>} - Resolves once stopped.
   */
  async destroy() {
    if (!this.#child) return;
    await this.#call('shutdown', {}, 15000).catch(() => {});
    this.#child?.kill();
    this.#child = null;
    this.#startPromise = null;
    this.#info = null;
  }

  /**
   * Maps a file-relative byte range onto piece indices.
   * @param {number} offset - Byte offset into the file.
   * @param {number} length - Number of bytes.
   * @returns {{first: number, last: number}} - Inclusive piece range.
   */
  #pieceRange(offset, length) {
    const info = this.#info;
    const start = info.fileOffset + offset;
    return {
      first: Math.floor(start / info.pieceLength),
      last: Math.floor((start + length - 1) / info.pieceLength),
    };
  }

  /**
   * Spawns the sidecar, adds the torrent in cache mode, and reads its geometry.
   * @returns {Promise<import('../types.js').TorrentInfo>} - The torrent geometry.
   */
  async #start() {
    await this.#spawn();

    // The sidecar takes raw .torrent bytes or a magnet, so a path is read here
    // rather than teaching it about filesystems.
    let torrentFile;
    let magnet;
    if (
      typeof this.#torrentId === 'string' &&
      /\.torrent(\?|$)/i.test(this.#torrentId)
    ) {
      const fs = await import('node:fs/promises');
      torrentFile = (await fs.readFile(this.#torrentId)).toString('base64');
    } else if (this.#torrentId instanceof Uint8Array) {
      torrentFile = Buffer.from(this.#torrentId).toString('base64');
    } else {
      magnet = this.#torrentId;
    }

    // Cache mode: every file at priority 0, so joining costs nothing until a
    // read asks for a specific piece.
    const added = await this.#call(
      'add',
      {
        torrentFile,
        magnet,
        savePath: this.#options.path,
        mode: 'cache',
      },
      this.#options.readyTimeoutMs,
    );

    const info = await this.#call(
      'info',
      { infoHash: added.infoHash },
      this.#options.readyTimeoutMs,
    );

    this.#info = {
      infoHash: info.infoHash,
      pieceLength: info.pieceLength,
      numPieces: info.numPieces,
      fileLength: info.fileLength,
      fileOffset: info.fileOffset,
      name: info.name,
    };
    return this.#info;
  }

  /**
   * Starts the sidecar process and waits for its ready event.
   * @returns {Promise<void>} - Resolves once usable.
   */
  #spawn() {
    return new Promise((resolve, reject) => {
      const script =
        this.#options.script ??
        path.join(here, '..', '..', 'sidecar', 'libtorrent_sidecar.py');

      const child = spawn(this.#options.python, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SIDECAR_SETTINGS: JSON.stringify({
            listen: this.#options.listen,
            resumeDir: this.#options.resumeDir,
            maxConnections: this.#options.maxConnections,
          }),
        },
      });
      this.#child = child;

      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `libtorrent sidecar did not start within ${this.#options.startTimeoutMs}ms`,
          ),
        );
      }, this.#options.startTimeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.#buffer += chunk;
        let newline;
        while ((newline = this.#buffer.indexOf('\n')) >= 0) {
          const line = this.#buffer.slice(0, newline).trim();
          this.#buffer = this.#buffer.slice(newline + 1);
          if (!line) continue;

          let message;
          try {
            message = JSON.parse(line);
          } catch {
            console.error(`[libtorrent] unparseable output: ${line}`);
            continue;
          }
          if (message.event === 'ready') {
            clearTimeout(timer);
            this.#version = message.libtorrent;
            resolve();
            continue;
          }
          this.#settle(message);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text) => {
        for (const line of text.split('\n')) {
          if (line.trim()) console.error(`[libtorrent] ${line}`);
        }
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `could not start ${this.#options.python}: ${error.message}. ` +
              'Install python3 and libtorrent (apt install python3-libtorrent).',
            { cause: error },
          ),
        );
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        this.#child = null;
        const error = new Error(`libtorrent sidecar exited (code ${code})`);
        for (const waiter of this.#pending.values()) waiter.reject(error);
        this.#pending.clear();
        reject(error);
      });
    });
  }

  /**
   * Sends a request and waits for its reply.
   * @param {string} op - Operation name.
   * @param {object} params - Operation parameters.
   * @param {number} [timeoutMs] - How long to wait.
   * @param {AbortSignal} [signal] - Cancels the wait.
   * @returns {Promise<any>} - The result.
   */
  #call(op, params, timeoutMs = 60000, signal) {
    const child = this.#child;
    if (!child)
      return Promise.reject(new Error('libtorrent sidecar is not running'));

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`libtorrent ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      /**
       * Stops waiting when the caller loses interest.
       * @returns {void}
       */
      const onAbort = () => {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });

      child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  /**
   * Routes a reply to whoever is waiting for it.
   * @param {object} message - A decoded reply.
   * @returns {void}
   */
  #settle(message) {
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? 'unknown sidecar error'));
  }
}

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
 * A stable key available before metadata arrives.
 * @param {unknown} torrentId - Magnet URI, infohash or path.
 * @returns {string} - The key.
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
