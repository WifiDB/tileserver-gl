/** Magnet URI carrying a v1 (btih) or v2 (btmh) topic. */
const MAGNET = /^magnet:\?.*xt=urn:bt[im]h:[a-z0-9]+/i;

/** Bare 40-char hex or 32-char base32 v1 infohash. */
const INFOHASH = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;

/**
 * Does this look like a torrent identifier rather than a plain archive?
 *
 * Intended for adapters that dispatch on an archive location string, so a
 * magnet URI, a bare infohash and a path to a .torrent file all route to a
 * torrent source.
 * @param {string} value - The candidate string.
 * @returns {boolean} - True if it names a torrent.
 */
export function isTorrentId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    MAGNET.test(trimmed) || INFOHASH.test(trimmed) || isTorrentFile(trimmed)
  );
}

/**
 * Is this a path or URL pointing at a .torrent metainfo file?
 *
 * A .torrent avoids the BEP 9 metadata exchange a magnet needs, so it connects
 * to peers noticeably faster — worth preferring when you have one.
 * @param {string} value - The candidate string.
 * @returns {boolean} - True if it ends in .torrent.
 */
export function isTorrentFile(value) {
  if (typeof value !== 'string') return false;
  return value.trim().split('?')[0].toLowerCase().endsWith('.torrent');
}

/**
 * The archive filename a torrent identifier refers to, if it advertises one:
 * the `dn` parameter of a magnet URI, or the .torrent filename with its
 * extension stripped. Used to work out whether the payload is a PMTiles
 * archive before any metadata has been fetched.
 * @param {string} value - A magnet URI or .torrent path.
 * @returns {string | null} - The advertised name, or null.
 */
export function torrentDisplayName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();

  if (isTorrentFile(trimmed)) {
    const base = trimmed.split('?')[0].split(/[\\/]/).pop();
    return base.slice(0, -'.torrent'.length) || null;
  }

  const dn = /[?&]dn=([^&]*)/.exec(trimmed);
  if (!dn) return null;
  try {
    return decodeURIComponent(dn[1]) || null;
  } catch {
    return dn[1] || null;
  }
}
