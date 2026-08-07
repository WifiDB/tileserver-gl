/**
 * Shared type definitions. This module has no runtime exports; it exists so the
 * typedefs below can be referenced from the rest of the package.
 */

/**
 * Fetch priority for a byte range.
 *
 * Engines map these onto whatever their BitTorrent implementation offers.
 * 'critical' means a request is blocked on this right now, 'high' means we will
 * almost certainly need it shortly (directories, metadata), 'normal' means
 * fetch it when there is nothing better to do.
 * @typedef {'critical' | 'high' | 'normal'} Priority
 */

/**
 * Everything the piece-mapping layer needs to know about a torrent.
 *
 * Note the split between file-relative and torrent-global coordinates: all
 * offsets passed to and from an engine are relative to the archive file, while
 * pieceLength and numPieces describe the torrent's global byte space.
 * fileOffset bridges the two, so a PMTiles archive packed alongside other files
 * in a multi-file torrent works without special cases.
 * @typedef {object} TorrentInfo
 * @property {string} infoHash - Hex infohash, which doubles as the archive's ETag.
 * @property {number} pieceLength - Piece length in bytes, from the torrent's info dictionary.
 * @property {number} numPieces - Total number of pieces in the torrent.
 * @property {number} fileLength - Length of the PMTiles archive itself, in bytes.
 * @property {number} fileOffset - Byte offset of the archive within the torrent's global byte space.
 * @property {string} [name] - Display name of the file, for logging.
 */

/**
 * Options for a single range read.
 * @typedef {object} ReadRangeOptions
 * @property {AbortSignal} [signal] - Cancels the read.
 * @property {Priority} [priority] - How urgently the bytes are needed.
 */

/**
 * The BitTorrent client abstraction.
 *
 * Deliberately tiny: read a byte range, optionally with priority and
 * cancellation. Everything PMTiles-specific — piece alignment, caching,
 * directory prefetch — lives above this line, so porting to another BitTorrent
 * implementation (or another language) only means reimplementing this.
 * @typedef {object} TorrentEngine
 * @property {string} key - A stable identifier available synchronously, before ready() resolves. PMTiles calls Source.getKey() without awaiting anything, so this cannot be derived from torrent metadata.
 * @property {() => Promise<TorrentInfo>} ready - Resolves once torrent metadata is available. Must be idempotent.
 * @property {(offset: number, length: number, options?: ReadRangeOptions) => Promise<Uint8Array>} readRange - Reads length bytes starting at offset bytes into the archive file. Must resolve with exactly length bytes or reject.
 * @property {(offset: number, length: number, priority: Priority) => void} [hint] - Non-blocking request to start fetching a range in the background. Engines that cannot express priority may omit it.
 * @property {(offset: number, length: number) => void} [unhint] - Withdraws a previous hint so the range stops competing for bandwidth. Background hydration is only attempted when an engine provides both hint and unhint.
 * @property {() => void | Promise<void>} destroy - Releases the engine's resources.
 */

export {};
