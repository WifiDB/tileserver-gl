/**
 * Minimal PMTiles v3 header parsing — just the section offsets.
 *
 * This deliberately does not use the pmtiles package's bytesToHeader: we only
 * want the byte ranges of the directory sections so we can prioritise them in
 * the swarm, and we want that to work even for archives whose header we would
 * otherwise reject. Keeping it here also keeps pmtiles a types-only dependency.
 *
 * Field offsets are from the PMTiles v3 specification (CC0-1.0):
 * https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 * The uint64 read below follows getUint64 in the PMTiles JavaScript reference
 * implementation, Copyright 2021 and later, Protomaps LLC and contributors,
 * BSD-3-Clause. See NOTICE.md.
 */

/** Fixed size of the v3 header, in bytes. */
export const HEADER_SIZE = 127;

const MAGIC = 'PMTiles';

/**
 * Byte ranges of an archive's structural sections.
 * @typedef {object} ArchiveLayout
 * @property {number} specVersion - PMTiles spec version.
 * @property {number} rootDirectoryOffset - Offset of the root directory.
 * @property {number} rootDirectoryLength - Length of the root directory.
 * @property {number} jsonMetadataOffset - Offset of the JSON metadata.
 * @property {number} jsonMetadataLength - Length of the JSON metadata.
 * @property {number} leafDirectoryOffset - Offset of the leaf directory section.
 * @property {number} leafDirectoryLength - Length of the leaf directory section.
 * @property {number} tileDataOffset - Offset of the tile data section.
 * @property {number} tileDataLength - Length of the tile data section.
 */

/**
 * Reads a little-endian uint64 as a JS number, which is safe below 2^53 bytes.
 * @param {DataView} view - View over the header bytes.
 * @param {number} offset - Byte offset of the field.
 * @returns {number} - The decoded value.
 */
function getUint64(view, offset) {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 2 ** 32 + low;
}

/**
 * Parses the section offsets out of the first HEADER_SIZE bytes of an archive.
 * Returns null for anything that is not a v3 PMTiles header, since the only
 * consumer is an optimisation that can be skipped.
 * @param {Uint8Array} bytes - The start of the archive.
 * @returns {ArchiveLayout | null} - The layout, or null if not a v3 header.
 */
export function readLayout(bytes) {
  if (bytes.byteLength < HEADER_SIZE) return null;

  for (let i = 0; i < MAGIC.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i is a loop counter over a constant
    if (bytes[i] !== MAGIC.charCodeAt(i)) return null;
  }

  const specVersion = bytes[7];
  if (specVersion !== 3) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    specVersion,
    rootDirectoryOffset: getUint64(view, 8),
    rootDirectoryLength: getUint64(view, 16),
    jsonMetadataOffset: getUint64(view, 24),
    jsonMetadataLength: getUint64(view, 32),
    leafDirectoryOffset: getUint64(view, 40),
    leafDirectoryLength: getUint64(view, 48),
    tileDataOffset: getUint64(view, 56),
    tileDataLength: getUint64(view, 64),
  };
}
