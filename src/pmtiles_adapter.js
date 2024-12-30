import fs from 'node:fs';
import { PMTiles, FetchSource } from 'pmtiles';
import WebTorrent from 'webtorrent';

const httpTester = /^https?:\/\//i;
const magnetTester = /^magnet:\?xt=urn:btih:[\w\d]+(&[\w\d]+(=[\w\d%.:\/_-]+)*)*$/i; // Improved regex

/**
 * Represents a PMTiles source that reads from a local file descriptor.
 */
class PMTilesFileSource {
  /**
   * Constructor for PMTilesFileSource.
   * @param {number} fd - File descriptor
   */
  constructor(fd) {
    this.fd = fd;
  }
  /**
   * Returns the key of this source (the file descriptor).
   * @returns {number} - File descriptor
   */
  getKey() {
    return this.fd;
  }
  /**
   * Asynchronously gets a byte range of the file.
   * @param {number} offset - Byte offset
   * @param {number} length - Number of bytes to read
   * @returns {Promise<{data: ArrayBuffer}>} - Promise resolving to an object with the data
   */
  async getBytes(offset, length) {
    const buffer = Buffer.alloc(length);
    await readFileBytes(this.fd, buffer, offset);
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    return { data: ab };
  }
}

/**
 * Asynchronously reads a byte range from a file descriptor.
 * @param {number} fd - File descriptor
 * @param {Buffer} buffer - Buffer to write to
 * @param {number} offset - Byte offset to start reading from
 * @returns {Promise<void>} - Promise that resolves when reading is done.
 */
async function readFileBytes(fd, buffer, offset) {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, buffer.length, offset, (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}

/**
 * Represents a PMTiles source that reads from a BitTorrent torrent.
 */
class PMTilesWebTorrentSource {
  /**
   * Constructor for PMTilesWebTorrentSource
   * @param {string} torrentIdentifier - Magnet URI or info hash
   */
  constructor(torrentIdentifier) {
    this.torrentIdentifier = torrentIdentifier;
    this.client = new WebTorrent();
    this.torrent = null;
    this.pieceSize = null;
    this.downloadedPieces = new Map(); // Map to store downloaded piece data
  }

  /**
   * Initializes WebTorrent client and loads the torrent.
   * @returns {Promise<void>} Promise that resolves when loading is done.
   */
  async init() {
    return new Promise((resolve, reject) => {
      this.client.add(this.torrentIdentifier, (torrent) => {
        this.torrent = torrent;
        this.pieceSize = torrent.pieceLength;
        console.log('Torrent loaded', torrent.name);
        resolve();
      });
    });
  }

  /**
   * Returns the key of this source (the torrent identifier).
   * @returns {string} - Magnet URI or info hash
   */
  getKey() {
    return this.torrentIdentifier;
  }

  /**
   * Asynchronously gets a byte range of the torrent file.
   * @param {number} offset - Byte offset
   * @param {number} length - Number of bytes to read
   * @returns {Promise<{data: ArrayBuffer}>} - Promise resolving to an object with the data
   */
  async getBytes(offset, length) {
    if (!this.torrent) {
      await this.init();
    }
    if (!this.pieceSize) {
      throw new Error('Piece size is not available');
    }
    const startPieceIndex = Math.floor(offset / this.pieceSize);
    const endPieceIndex = Math.floor((offset + length - 1) / this.pieceSize);

    const dataChunks = [];

    for (let i = startPieceIndex; i <= endPieceIndex; i++) {
      let pieceBuffer = await this._getPiece(i);
      if (pieceBuffer) {
        let chunkOffset = 0;
        if (i == startPieceIndex) {
          chunkOffset = offset % this.pieceSize;
        }
        let chunkLength = pieceBuffer.length;
        if (i == endPieceIndex) {
          chunkLength = (offset + length - 1) % this.pieceSize;
          if (chunkLength == 0) {
            chunkLength = pieceBuffer.length;
          } else {
            chunkLength += 1;
          }
        }

        dataChunks.push(pieceBuffer.slice(chunkOffset, chunkLength));
      } else {
        throw new Error(`Piece ${i} could not be retrieved`);
      }
    }

    const combinedBuffer = new Uint8Array(length);
    let offsetInCombined = 0;
    for (const chunk of dataChunks) {
      combinedBuffer.set(chunk, offsetInCombined);
      offsetInCombined += chunk.length;
    }

    return { data: combinedBuffer.buffer };
  }

  /**
   * Asynchronously gets a single piece of a torrent.
   * @param {number} pieceIndex - Piece index
   * @returns {Promise<Buffer>} Promise that resolves to the piece data buffer.
   */
  async _getPiece(pieceIndex) {
    if (this.downloadedPieces.has(pieceIndex)) {
      return this.downloadedPieces.get(pieceIndex);
    }

    return new Promise(async (resolve, reject) => {
      this.torrent.files[0].getPiece(pieceIndex, (err, pieceBuffer) => {
        if (err) {
          return reject(err);
        }
        this.downloadedPieces.set(pieceIndex, pieceBuffer);
        resolve(pieceBuffer);
      });
    });
  }

  /**
   * Destroys the WebTorrent client and cleans up resources
   */
  destroy() {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }
}

/**
 * Opens a PMTiles file from a path, URL, or magnet URI
 * @param {string} FilePath - File path, URL, or magnet URI for a pmtiles file
 * @returns {PMTiles} PMTiles object for handling data
 */
export function openPMtiles(FilePath) {
  let pmtiles = undefined;
  let source = undefined;
  if (magnetTester.test(FilePath)) {
    source = new PMTilesWebTorrentSource(FilePath);
  } else if (httpTester.test(FilePath)) {
    source = new FetchSource(FilePath);
  } else {
    const fd = fs.openSync(FilePath, 'r');
    source = new PMTilesFileSource(fd);
  }
  pmtiles = new PMTiles(source);
  // Add the source to PMTiles for cleanup
  pmtiles._source = source;
  return pmtiles;
}

/**
 * Retrieves metadata and header information from the PMTiles.
 * @param {PMTiles} pmtiles - PMTiles object
 * @returns {Promise<object>} - Promise that resolves to metadata object
 */
export async function getPMtilesInfo(pmtiles) {
  const header = await pmtiles.getHeader();
  const metadata = await pmtiles.getMetadata();

  //Add missing metadata from header
  metadata['format'] = getPmtilesTileType(header.tileType).type;
  metadata['minzoom'] = header.minZoom;
  metadata['maxzoom'] = header.maxZoom;

  if (header.minLon && header.minLat && header.maxLon && header.maxLat) {
    metadata['bounds'] = [
      header.minLon,
      header.minLat,
      header.maxLon,
      header.maxLat,
    ];
  } else {
    metadata['bounds'] = [-180, -85.05112877980659, 180, 85.0511287798066];
  }

  if (header.centerZoom) {
    metadata['center'] = [
      header.centerLon,
      header.centerLat,
      header.centerZoom,
    ];
  } else {
    metadata['center'] = [
      header.centerLon,
      header.centerLat,
      parseInt(metadata['maxzoom']) / 2,
    ];
  }

  return metadata;
}

/**
 * Retrieves a tile from the PMTiles.
 * @param {PMTiles} pmtiles - PMTiles object
 * @param {number} z - Zoom level
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {Promise<{data: Buffer | undefined, header: object}>} Promise that resolves to object containing data and headers
 */
export async function getPMtilesTile(pmtiles, z, x, y) {
  const header = await pmtiles.getHeader();
  const tileType = getPmtilesTileType(header.tileType);
  let zxyTile = await pmtiles.getZxy(z, x, y);
  if (zxyTile && zxyTile.data) {
    zxyTile = Buffer.from(zxyTile.data);
  } else {
    zxyTile = undefined;
  }
  return { data: zxyTile, header: tileType.header };
}

/**
 * Retrieves the tile type information from a number.
 * @param {number} typenum - Type number of pmtiles
 * @returns {{type: string, header: object}} Object containing the tile type and header info
 */
function getPmtilesTileType(typenum) {
  let head = {};
  let tileType;
  switch (typenum) {
    case 0:
      tileType = 'Unknown';
      break;
    case 1:
      tileType = 'pbf';
      head['Content-Type'] = 'application/x-protobuf';
      break;
    case 2:
      tileType = 'png';
      head['Content-Type'] = 'image/png';
      break;
    case 3:
      tileType = 'jpeg';
      head['Content-Type'] = 'image/jpeg';
      break;
    case 4:
      tileType = 'webp';
      head['Content-Type'] = 'image/webp';
      break;
    case 5:
      tileType = 'avif';
      head['Content-Type'] = 'image/avif';
      break;
  }
  return { type: tileType, header: head };
}

/**
 * Closes and cleans up resources associated with a PMTiles object.
 * @param {PMTiles} pmtiles - PMTiles object
 */
export function closePMTiles(pmtiles) {
  if (pmtiles._source && typeof pmtiles._source.destroy === 'function') {
    pmtiles._source.destroy();
  }
}

/**
 * Checks if a given string is a valid web-based PMTiles source identifier (HTTP URL or magnet URI).
 * @param {string} source - The string to validate.
 * @returns {boolean} - True if the string is a valid web-based PMTiles source, false otherwise.
 */
export function isValidWebPMtiles(source) {
  console.log(source);
  if (typeof source !== 'string') {
    return false; // Handle non-string inputs
  }
  console.log(httpTester.test(source));
  console.log(magnetTester.test(source));

  return httpTester.test(source) || magnetTester.test(source);
}
