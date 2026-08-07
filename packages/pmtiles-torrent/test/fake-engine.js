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
 * Configuration for the fake engine.
 * @typedef {object} FakeEngineOptions
 * @property {number} pieceLength - Torrent piece length.
 * @property {number} [fileOffset] - Bytes preceding the archive in the torrent.
 * @property {number} [trailingBytes] - Bytes following the archive in the torrent.
 * @property {number} [delayMs] - Delay before a read resolves. Ignored when manual is set.
 * @property {boolean} [manual] - Hold every read open until flush() is called.
 * @property {string} [infoHash] - Infohash to report.
 */

/**
 * An in-memory TorrentEngine over a byte array, with controllable timing so the
 * source's concurrency and cancellation behaviour is testable without a swarm.
 */
export class FakeEngine {
  #data;
  #info;
  #options;
  #waiters = [];

  /**
   * Creates a fake engine.
   * @param {Uint8Array} data - The archive contents.
   * @param {FakeEngineOptions} options - Torrent geometry and timing.
   */
  constructor(data, options) {
    this.key = 'torrent:fake';
    this.reads = [];
    this.hints = [];
    this.unhints = [];
    this.aborted = 0;
    this.destroyed = false;

    this.#data = data;
    this.#options = options;
    const fileOffset = options.fileOffset ?? 0;
    const total = fileOffset + data.byteLength + (options.trailingBytes ?? 0);
    this.#info = {
      infoHash: options.infoHash ?? 'a'.repeat(40),
      pieceLength: options.pieceLength,
      numPieces: Math.ceil(total / options.pieceLength),
      fileLength: data.byteLength,
      fileOffset,
      name: 'fake.pmtiles',
    };
  }

  /**
   * How many reads are currently blocked.
   * @returns {number} - Pending read count.
   */
  get pendingReads() {
    return this.#waiters.length;
  }

  /**
   * Reports torrent metadata.
   * @returns {Promise<object>} - The metadata.
   */
  async ready() {
    return this.#info;
  }

  /**
   * Reads a byte range, recording the call.
   * @param {number} offset - Byte offset into the archive.
   * @param {number} length - Number of bytes.
   * @param {object} [options] - Signal and priority.
   * @returns {Promise<Uint8Array>} - The requested bytes.
   */
  async readRange(offset, length, options = {}) {
    this.reads.push({ offset, length, priority: options.priority });
    await this.#gate(options.signal);
    if (offset < 0 || offset + length > this.#info.fileLength) {
      throw new RangeError(
        `fake engine read out of bounds: ${offset}+${length} of ${this.#info.fileLength}`,
      );
    }
    return this.#data.slice(offset, offset + length);
  }

  /**
   * Records a prefetch hint.
   * @param {number} offset - Byte offset.
   * @param {number} length - Number of bytes.
   * @param {string} priority - Requested priority.
   * @returns {void}
   */
  hint(offset, length, priority) {
    this.hints.push({ offset, length, priority });
  }

  /**
   * Records a withdrawn hint.
   * @param {number} offset - Byte offset.
   * @param {number} length - Number of bytes.
   * @returns {void}
   */
  unhint(offset, length) {
    this.unhints.push({ offset, length });
  }

  /**
   * Marks the engine destroyed and releases blocked reads.
   * @returns {void}
   */
  destroy() {
    this.destroyed = true;
    this.flush();
  }

  /**
   * Releases every read currently waiting.
   * @returns {void}
   */
  flush() {
    const waiting = [...this.#waiters];
    this.#waiters.length = 0;
    for (const release of waiting) release();
  }

  /**
   * Blocks until released, either by the timer or by flush().
   * @param {AbortSignal} [signal] - Cancels the wait.
   * @returns {Promise<void>} - Resolves when released.
   */
  #gate(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        this.aborted++;
        reject(abortError());
        return;
      }

      let timer;
      /**
       * Detaches listeners and timers.
       * @returns {void}
       */
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(release);
        if (index >= 0) this.#waiters.splice(index, 1);
      };
      /**
       * Completes the wait successfully.
       * @returns {void}
       */
      const release = () => {
        cleanup();
        resolve();
      };
      /**
       * Fails the wait on abort.
       * @returns {void}
       */
      const onAbort = () => {
        this.aborted++;
        cleanup();
        reject(abortError());
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (this.#options.manual) {
        this.#waiters.push(release);
      } else {
        timer = setTimeout(release, this.#options.delayMs ?? 0);
      }
    });
  }
}

/**
 * Deterministic filler so assembled ranges can be checked byte for byte.
 * @param {number} length - How many bytes.
 * @returns {Uint8Array} - The filled array.
 */
export function ramp(length) {
  const out = new Uint8Array(length);
  // eslint-disable-next-line security/detect-object-injection -- i is a loop counter over a typed array
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out;
}
