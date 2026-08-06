/** Magnet URI carrying a v1 (btih) or v2 (btmh) topic. */
const MAGNET = /^magnet:\?.*xt=urn:bt[im]h:[a-z0-9]+/i;

/** Bare 40-char hex or 32-char base32 v1 infohash. */
const INFOHASH = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;

/**
 * Does this look like a torrent identifier rather than a path or URL?
 *
 * Intended for adapters that dispatch on an archive location string, so
 * magnet:?xt=... and a bare infohash both route to a torrent source.
 * @param {string} value - The candidate string.
 * @returns {boolean} - True if it names a torrent.
 */
export function isTorrentId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return MAGNET.test(trimmed) || INFOHASH.test(trimmed);
}
