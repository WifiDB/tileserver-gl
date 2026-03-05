import fs from 'node:fs';
import { PMTiles, FetchSource, EtagMismatch } from 'pmtiles';
import { isValidHttpUrl, isS3Url, magnetTester } from './utils.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import WebTorrent from 'webtorrent';

/**
 * S3 Source for PMTiles
 * Supports:
 * - AWS S3: s3://bucket-name/path/to/file.pmtiles
 * - S3-compatible with endpoint: s3://endpoint-url/bucket/path/to/file.pmtiles
 */
class S3Source {
  /**
   * Creates an S3Source instance.
   * @param {string} s3Url - The S3 URL in one of the supported formats.
   * @param {string} [s3Profile] - Optional AWS credential profile name from config.
   * @param {boolean} [configRequestPayer] - Optional flag from config for requester pays buckets.
   * @param {string} [configRegion] - Optional AWS region from config.
   * @param {string} [s3UrlFormat] - Optional S3 URL format from config: 'aws' or 'custom'.
   * @param {number} [verbose] - Verbosity level (1-3). 1=important, 2=detailed, 3=debug/all requests.
   */
  constructor(
    s3Url,
    s3Profile,
    configRequestPayer,
    configRegion,
    s3UrlFormat,
    verbose = false,
  ) {
    const parsed = this.parseS3Url(s3Url, s3UrlFormat);
    this.bucket = parsed.bucket;
    this.key = parsed.key;
    this.endpoint = parsed.endpoint;
    this.url = s3Url;
    this.verbose = verbose;

    // Apply configuration precedence: Config > URL > Default
    // Using || for strings (empty string = not set)
    // Using ?? for booleans (false is valid value)
    const profile = s3Profile || parsed.profile;
    this.requestPayer = configRequestPayer ?? parsed.requestPayer;
    this.region = configRegion || parsed.region;

    // Log precedence decisions for debugging
    if (verbose >= 3) {
      console.log(`S3 config precedence for ${s3Url}:`);
      console.log(
        `  Profile: ${s3Profile ? 'config' : parsed.profile ? 'url' : 'default'} = ${profile || 'none'}`,
      );
      console.log(
        `  Region: ${configRegion ? 'config' : parsed.region !== (process.env.AWS_REGION || 'us-east-1') ? 'url' : 'env/default'} = ${this.region}`,
      );
      console.log(
        `  RequestPayer: ${configRequestPayer !== undefined ? 'config' : parsed.requestPayer ? 'url' : 'default'} = ${this.requestPayer}`,
      );
    }

    // Create S3 client
    this.s3Client = this.createS3Client(
      parsed.endpoint,
      this.region,
      profile,
      this.verbose,
    );
  }

  /**
   * Parses various S3 URL formats into bucket, key, endpoint, region, and profile.
   * @param {string} url - The S3 URL to parse.
   * @param {string} [s3UrlFormat] - Optional format override: 'aws' or 'custom'.
   * @returns {object} - An object containing bucket, key, endpoint, region, and profile.
   * @throws {Error} - Throws an error if the URL format is invalid.
   */
  parseS3Url(url, s3UrlFormat) {
    // Validate s3UrlFormat if provided
    if (s3UrlFormat && s3UrlFormat !== 'aws' && s3UrlFormat !== 'custom') {
      console.warn(
        `Invalid s3UrlFormat: "${s3UrlFormat}". Must be "aws" or "custom". Using auto-detection.`,
      );
      s3UrlFormat = undefined;
    }

    let region = process.env.AWS_REGION || 'us-east-1';
    let profile = null;
    let requestPayer = false;

    // Parse URL parameters
    const [cleanUrl, queryString] = url.split('?');
    if (queryString) {
      const params = new URLSearchParams(queryString);
      // URL parameters override defaults
      profile = params.get('profile') ?? profile;
      region = params.get('region') ?? region;
      s3UrlFormat = s3UrlFormat ?? params.get('s3UrlFormat'); // Config overrides URL

      const payerVal = params.get('requestPayer');
      requestPayer = payerVal === 'true' || payerVal === '1';
    }

    // Helper to build result object
    const buildResult = (endpoint, bucket, key) => ({
      endpoint: endpoint ? `https://${endpoint}` : null,
      bucket,
      key,
      region,
      profile,
      requestPayer,
    });

    // Define patterns based on format
    const patterns = {
      customWithDot: /^s3:\/\/([^/]*\.[^/]+)\/([^/]+)\/(.+)$/, // Auto-detect: requires dot
      customForced: /^s3:\/\/([^/]+)\/([^/]+)\/(.+)$/, // Explicit: no dot required
      aws: /^s3:\/\/([^/]+)\/(.+)$/,
    };

    // Match based on s3UrlFormat or auto-detect
    let match;

    if (s3UrlFormat === 'custom') {
      match = cleanUrl.match(patterns.customForced);
      if (match) return buildResult(match[1], match[2], match[3]);
    } else if (s3UrlFormat === 'aws') {
      match = cleanUrl.match(patterns.aws);
      if (match) return buildResult(null, match[1], match[2]);
    } else {
      // Auto-detection: try custom (with dot) first, then AWS
      match = cleanUrl.match(patterns.customWithDot);
      if (match) return buildResult(match[1], match[2], match[3]);

      match = cleanUrl.match(patterns.aws);
      if (match) return buildResult(null, match[1], match[2]);
    }

    throw new Error(
      `Invalid S3 URL format: ${url}\n` +
        `Expected formats:\n` +
        `  AWS S3: s3://bucket-name/path/to/file.pmtiles\n` +
        `  Custom endpoint: s3://endpoint.com/bucket/path/to/file.pmtiles\n` +
        `Use s3UrlFormat parameter to override auto-detection if needed.`,
    );
  }

  /**
   * Creates an S3 client with optional custom endpoint and AWS profile support.
   * @param {string|null} endpoint - The custom endpoint URL, or null for default AWS S3.
   * @param {string} region - The AWS region.
   * @param {string} [profile] - Optional AWS credential profile name.
   * @param {number} [verbose] - Verbosity level (1-3). 1=important, 2=detailed, 3=debug/all requests.
   * @returns {S3Client} - Configured S3Client instance.
   */
  createS3Client(endpoint, region, profile, verbose) {
    const config = {
      region: region,
      requestHandler: {
        connectionTimeout: 5000,
        socketTimeout: 5000,
      },
      forcePathStyle: !!endpoint,
    };

    if (endpoint) {
      config.endpoint = endpoint;
      if (verbose >= 2) {
        console.log(`Using custom S3 endpoint: ${endpoint}`);
      }
    }

    if (profile) {
      config.credentials = fromIni({ profile });
      if (verbose >= 2) {
        console.log(`Using AWS profile: ${profile}`);
      }
    }

    return new S3Client(config);
  }
  /**
   * Returns the unique key for this S3 source.
   * @returns {string} - The S3 URL.
   */
  getKey() {
    return this.url;
  }

  /**
   * Fetches a byte range from the S3 object.
   * @param {number} offset - The starting byte offset.
   * @param {number} length - The number of bytes to fetch.
   * @param {AbortSignal} [signal] - Optional abort signal for cancelling the request.
   * @param {string} [etag] - Optional ETag for conditional requests.
   * @returns {Promise<object>} - A promise that resolves to an object containing data, etag, expires, and cacheControl.
   * @throws {EtagMismatch} - Throws if ETag doesn't match.
   * @throws {Error} - Throws on S3 errors like NoSuchKey, AccessDenied, NoSuchBucket.
   */
  async getBytes(offset, length, signal, etag) {
    try {
      const commandParams = {
        Bucket: this.bucket,
        Key: this.key,
        Range: `bytes=${offset}-${offset + length - 1}`,
        IfMatch: etag,
      };

      if (this.requestPayer) {
        commandParams.RequestPayer = 'requester';
      }

      const command = new GetObjectCommand(commandParams);

      const response = await this.s3Client.send(command, {
        abortSignal: signal,
      });

      const arr = await response.Body.transformToByteArray();

      if (!arr) {
        throw new Error('Failed to read S3 response body');
      }

      return {
        data: arr.buffer,
        etag: response.ETag,
        expires: response.Expires?.toISOString(),
        cacheControl: response.CacheControl,
      };
    } catch (error) {
      // Handle AWS SDK errors
      if (error.name === 'PreconditionFailed') {
        throw new EtagMismatch();
      }

      if (error.name === 'NoSuchKey') {
        throw new Error(`PMTiles file not found: ${this.bucket}/${this.key}`);
      }

      if (error.name === 'AccessDenied') {
        throw new Error(
          `Access denied: ${this.bucket}/${this.key}. Check credentials and bucket permissions.`,
        );
      }

      if (error.name === 'NoSuchBucket') {
        throw new Error(
          `Bucket not found: ${this.bucket}. Check bucket name and endpoint.`,
        );
      }

      console.error(`S3 error for ${this.bucket}/${this.key}:`, error.message);
      throw error;
    }
  }
}

/**
 * Local file source for PMTiles using Node.js file descriptors.
 */
class PMTilesFileSource {
  /**
   * Creates a PMTilesFileSource instance.
   * @param {number} fd - The file descriptor for the opened PMTiles file.
   */
  constructor(fd) {
    this.fd = fd;
  }

  /**
   * Returns the unique key for this file source.
   * @returns {number} - The file descriptor.
   */
  getKey() {
    return this.fd;
  }

  /**
   * Reads a byte range from the local file.
   * @param {number} offset - The starting byte offset.
   * @param {number} length - The number of bytes to read.
   * @returns {Promise<object>} - A promise that resolves to an object containing the data as an ArrayBuffer.
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
 * Reads bytes from a file descriptor into a buffer.
 * @param {number} fd - The file descriptor.
 * @param {Buffer} buffer - The buffer to read data into.
 * @param {number} offset - The file offset to start reading from.
 * @returns {Promise<void>} - A promise that resolves when the read operation completes.
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
 * Represents a PMTiles source that reads from a BitTorrent torrent via WebTorrent.
 * Uses lazy initialization — the WebTorrent client and torrent are not loaded
 * until the first call to getBytes(), keeping openPMtiles() synchronous.
 */
class PMTilesWebTorrentSource {
  /**
   * @param {string} torrentIdentifier - Magnet URI or info hash
   * @param {number} timeoutMs - Timeout for downloading data in milliseconds (default 300000)
   * @param {number} maxConns - Maximum number of peer connections (default 20)
   */
  constructor(torrentIdentifier, timeoutMs = 300000, maxConns = 20) {
    this.torrentIdentifier = torrentIdentifier;
    this.timeoutMs = timeoutMs;
    this.maxConns = maxConns;
    this.client = null;
    this.torrent = null;
    this.pieceSize = null;
    this.lastPieceLength = null;
    // Cache of fully downloaded pieces: pieceIndex -> Buffer
    this.downloadedPieces = new Map();
    // In-flight piece downloads: pieceIndex -> Promise<Buffer>
    this._pendingPieces = new Map();
    // Single lazily-created init promise — all concurrent callers share it
    this._initPromise = null;
  }

  /**
   * Returns the key of this source (the torrent identifier).
   * @returns {string}
   */
  getKey() {
    return this.torrentIdentifier;
  }

  /**
   * Ensures the WebTorrent client is initialised, creating the promise once.
   * @returns {Promise<void>}
   */
  _ensureInit() {
    if (!this._initPromise) {
      this._initPromise = this._doInit();
    }
    return this._initPromise;
  }

  /**
   * Performs the actual WebTorrent initialisation.
   * Creates the client, adds the torrent, and warms up by fetching piece 0
   * (which contains the PMTiles file header).
   * @returns {Promise<void>}
   */
  async _doInit() {
    this.client = new WebTorrent({
      utp: true,
      dht: false,
      tracker: {
        udp: false,
        http: false,
      },
      torrentPort: 0,
      maxConns: this.maxConns,
    });

    await new Promise((resolve, reject) => {
      try {
        this.client.add(this.torrentIdentifier, (torrent) => {
          this.torrent = torrent;
          this.pieceSize = torrent.pieceLength;
          this.lastPieceLength = torrent.lastPieceLength;
          console.log('Torrent loaded:', torrent.name);

          const onReady = async () => {
            torrent.removeListener('ready', onReady);
            try {
              if (this.torrent.files && this.torrent.files.length > 0) {
                // Warm up: fetch piece 0 so the PMTiles header is ready immediately
                await this._getPiece(0);
                resolve();
              } else {
                reject(new Error('Torrent has no files'));
              }
            } catch (err) {
              reject(err);
            }
          };

          if (torrent.ready) {
            onReady();
          } else {
            torrent.on('ready', onReady);
          }

          const onError = (err) => {
            torrent.removeListener('error', onError);
            this.destroy();
            reject(err);
          };
          torrent.on('error', onError);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Asynchronously gets a byte range of the torrent file.
   * @param {number} offset - Byte offset
   * @param {number} length - Number of bytes to read
   * @returns {Promise<{data: ArrayBuffer}>}
   */
  async getBytes(offset, length) {
    await this._ensureInit();

    if (!this.pieceSize) {
      throw new Error('Piece size is not available');
    }

    const startPieceIndex = Math.floor(offset / this.pieceSize);
    const endPieceIndex = Math.floor((offset + length - 1) / this.pieceSize);

    const combinedBuffer = Buffer.allocUnsafe(length);
    let combinedOffset = 0;

    for (let i = startPieceIndex; i <= endPieceIndex; i++) {
      const pieceBuffer = await this._getPiece(i);
      if (!pieceBuffer) {
        throw new Error(`Piece ${i} could not be retrieved`);
      }

      let chunkOffset = 0;
      if (i === startPieceIndex) {
        chunkOffset = offset % this.pieceSize;
      }

      let bytesToCopy = pieceBuffer.length - chunkOffset;
      if (i === endPieceIndex) {
        bytesToCopy = Math.min(
          bytesToCopy,
          offset + length - (i * this.pieceSize + chunkOffset),
        );
      }

      pieceBuffer.copy(
        combinedBuffer,
        combinedOffset,
        chunkOffset,
        chunkOffset + bytesToCopy,
      );
      combinedOffset += bytesToCopy;
    }

    // Slice to a self-contained ArrayBuffer. Buffer.allocUnsafe may share
    // an underlying pool whose .buffer covers the full 8 KB slab — PMTiles
    // reads from byte 0 of whatever ArrayBuffer we return, so without slicing
    // it would read unrelated memory for small allocations.
    return {
      data: combinedBuffer.buffer.slice(
        combinedBuffer.byteOffset,
        combinedBuffer.byteOffset + combinedBuffer.byteLength,
      ),
    };
  }

  /**
   * Fetches a single piece from the torrent, with caching and in-flight deduplication.
   * @param {number} pieceIndex
   * @returns {Promise<Buffer>}
   */
  async _getPiece(pieceIndex) {
    // Return immediately from completed-piece cache
    if (this.downloadedPieces.has(pieceIndex)) {
      return this.downloadedPieces.get(pieceIndex);
    }

    // If a download is already in-flight, reuse it to avoid duplicate fetches
    // and potential race conditions.
    if (this._pendingPieces.has(pieceIndex)) {
      return this._pendingPieces.get(pieceIndex);
    }

    const file = this.torrent.files[0];
    if (!file) {
      throw new Error('_getPiece: no file available in torrent');
    }

    const start = pieceIndex * this.pieceSize;
    const isLastPiece =
      pieceIndex === Math.floor((file.length - 1) / this.pieceSize);

    // WebTorrent's blob() follows Node.js stream conventions where `end` is
    // inclusive, so subtract 1 to avoid pulling one byte from the next piece.
    const end = isLastPiece
      ? start + this.lastPieceLength - 1
      : (pieceIndex + 1) * this.pieceSize - 1;

    const piecePromise = (async () => {
      try {
        const blob = await file.blob({ start, end });
        const arrayBuffer = await blob.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);
        this.downloadedPieces.set(pieceIndex, buf);
        return buf;
      } catch (err) {
        console.error('Error getting piece', pieceIndex, err);
        throw err;
      } finally {
        this._pendingPieces.delete(pieceIndex);
      }
    })();

    this._pendingPieces.set(pieceIndex, piecePromise);
    return piecePromise;
  }

  /**
   * Destroys the WebTorrent client and releases all resources.
   */
  destroy() {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.torrent = null;
    this.downloadedPieces.clear();
    this._pendingPieces.clear();
    this._initPromise = null;
  }
}

// Cache for PMTiles objects to avoid creating multiple instances for the same URL
const pmtilesCache = new Map();

/**
 * Opens a PMTiles file from local filesystem, HTTP URL, or S3 URL.
 * Uses caching to avoid creating multiple PMTiles instances for the same file.
 * @param {string} filePath - The path to the PMTiles file.
 * @param {string} [s3Profile] - Optional AWS credential profile name.
 * @param {boolean} [requestPayer] - Optional flag for requester pays buckets.
 * @param {string} [s3Region] - Optional AWS region.
 * @param {string} [s3UrlFormat] - Optional S3 URL format: 'aws' or 'custom'.
 * @param {number} [verbose] - Verbosity level (1-3). 1=important, 2=detailed, 3=debug/all requests.
 * @returns {PMTiles} - A PMTiles instance.
 */
export function openPMtiles(
  filePath,
  s3Profile,
  requestPayer,
  s3Region,
  s3UrlFormat,
  verbose = 0,
) {
  // Create a cache key that includes all parameters that affect the source
  const cacheKey = JSON.stringify({
    filePath,
    s3Profile,
    requestPayer,
    s3Region,
    s3UrlFormat,
  });

  // Check if we already have a PMTiles object for this configuration
  if (pmtilesCache.has(cacheKey)) {
    if (verbose >= 2) {
      console.log(`Using cached PMTiles instance for: ${filePath}`);
    }
    return pmtilesCache.get(cacheKey);
  }

  let pmtiles = undefined;

  if (magnetTester.test(filePath)) {
    if (verbose >= 2) {
      console.log(`Opening PMTiles from torrent: ${filePath}`);
    }
    // PMTilesWebTorrentSource uses lazy initialisation — the WebTorrent client
    // is not started until the first getBytes() call, so this stays synchronous.
    const source = new PMTilesWebTorrentSource(filePath);
    pmtiles = new PMTiles(source);
  } else if (isS3Url(filePath)) {
    if (verbose >= 2) {
      console.log(`Opening PMTiles from S3: ${filePath}`);
    }
    const source = new S3Source(
      filePath,
      s3Profile,
      requestPayer,
      s3Region,
      s3UrlFormat,
      verbose,
    );
    pmtiles = new PMTiles(source);
  } else if (isValidHttpUrl(filePath)) {
    if (verbose >= 2) {
      console.log(`Opening PMTiles from HTTP: ${filePath}`);
    }
    const source = new FetchSource(filePath);
    pmtiles = new PMTiles(source);
  } else {
    if (verbose >= 2) {
      console.log(`Opening PMTiles from local file: ${filePath}`);
    }

    const fd = fs.openSync(filePath, 'r');
    const source = new PMTilesFileSource(fd);
    pmtiles = new PMTiles(source);
  }

  // Cache the PMTiles object
  pmtilesCache.set(cacheKey, pmtiles);

  return pmtiles;
}

/**
 * Retrieves metadata and header information from a PMTiles archive with retry logic for rate limiting.
 * @param {PMTiles} pmtiles - The PMTiles instance.
 * @param {string} inputFile - The input file path (used for error messages).
 * @param {number} [maxRetries] - Maximum number of retry attempts for rate-limited requests.
 * @returns {Promise<object>} - A promise that resolves to a metadata object containing format, bounds, zoom levels, and center.
 * @throws {Error} - Throws an error if metadata cannot be retrieved after all retry attempts.
 */
export async function getPMtilesInfo(pmtiles, inputFile, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const header = await pmtiles.getHeader();
      const metadata = await pmtiles.getMetadata();

      metadata['format'] = getPmtilesTileType(header.tileType).type;
      metadata['minzoom'] = header.minZoom;
      metadata['maxzoom'] = header.maxZoom;

      // Check if bounds are defined (handles null, undefined, but allows 0)
      const hasBounds =
        typeof header.minLon === 'number' &&
        typeof header.minLat === 'number' &&
        typeof header.maxLon === 'number' &&
        typeof header.maxLat === 'number' &&
        !(
          header.minLon === 0 &&
          header.minLat === 0 &&
          header.maxLon === 0 &&
          header.maxLat === 0
        );

      if (hasBounds) {
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
    } catch (error) {
      lastError = error;

      if (
        error.message &&
        error.message.includes('429') &&
        attempt < maxRetries - 1
      ) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(
          `Rate limited fetching metadata, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // If not a 429 or last retry, throw immediately
      if (!error.message?.includes('429') || attempt === maxRetries - 1) {
        const errorMessage = `${error.message} for file: ${inputFile}`;
        throw new Error(errorMessage);
      }
    }
  }

  // This should never be reached, but just in case
  throw new Error(
    `Failed to get PMTiles info after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`,
  );
}

/**
 * Fetches a tile from a PMTiles archive with retry logic for rate limiting and error handling.
 * @param {PMTiles} pmtiles - The PMTiles instance.
 * @param {number} z - The zoom level.
 * @param {number} x - The x coordinate of the tile.
 * @param {number} y - The y coordinate of the tile.
 * @param {number} [maxRetries] - Maximum number of retry attempts for rate-limited requests.
 * @returns {Promise<object>} - A promise that resolves to an object with data (Buffer or undefined) and header (content-type).
 */
export async function getPMtilesTile(pmtiles, z, x, y, maxRetries = 3) {
  const header = await pmtiles.getHeader();
  const tileType = getPmtilesTileType(header.tileType);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let zxyTile = await pmtiles.getZxy(z, x, y);

      if (zxyTile && zxyTile.data) {
        zxyTile = Buffer.from(zxyTile.data);
      } else {
        zxyTile = undefined;
      }

      return { data: zxyTile, header: tileType.header };
    } catch (error) {
      if (
        error.message &&
        error.message.includes('429') &&
        attempt < maxRetries - 1
      ) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(
          `Rate limited for tile ${z}/${x}/${y}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (error.message && error.message.includes('Bad response code:')) {
        console.error(`HTTP error for tile ${z}/${x}/${y}: ${error.message}`);
        return { data: undefined, header: tileType.header };
      }

      throw error;
    }
  }

  console.error(
    `Failed to fetch tile ${z}/${x}/${y} after ${maxRetries} attempts`,
  );
  return { data: undefined, header: tileType.header };
}

/**
 * Maps PMTiles tile type number to tile format string and Content-Type header.
 * @param {number} typenum - The PMTiles tile type number (0=Unknown, 1=MVT/PBF, 2=PNG, 3=JPEG, 4=WebP, 5=AVIF).
 * @returns {object} - An object containing type (string) and header (object with Content-Type).
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
 * For torrent-backed sources this destroys the WebTorrent client.
 * @param {PMTiles} pmtiles - The PMTiles instance to close.
 */
export function closePMTiles(pmtiles) {
  if (pmtiles && pmtiles._source && typeof pmtiles._source.destroy === 'function') {
    pmtiles._source.destroy();
  }
}