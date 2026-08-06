/**
 * pmtiles-torrent — serve a PMTiles archive out of a BitTorrent swarm.
 *
 * The entry point is TorrentSource, which implements the Source interface from
 * the pmtiles package. Pair it with an engine — see pmtiles-torrent/webtorrent
 * for the bundled one — and hand it to PMTiles:
 *
 * ```js
 * import { PMTiles } from 'pmtiles';
 * import { TorrentSource } from 'pmtiles-torrent';
 * import { WebTorrentEngine } from 'pmtiles-torrent/webtorrent';
 *
 * const archive = new PMTiles(new TorrentSource(new WebTorrentEngine(magnet)));
 * const tile = await archive.getZxy(12, 1204, 1539);
 * ```
 *
 * The engine is injected rather than baked in so the piece-mapping logic can be
 * reused against a different BitTorrent implementation — a libtorrent daemon
 * for BitTorrent v2 support, say, which WebTorrent does not provide.
 */

export { PieceCache } from './cache.js';
export { isTorrentFile, isTorrentId, torrentDisplayName } from './id.js';
export { HEADER_SIZE, readLayout } from './layout.js';
export { TorrentSource } from './source.js';
