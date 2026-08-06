import fs from 'node:fs';
import { PMTiles, FetchSource, EtagMismatch } from 'pmtiles';
import { isValidHttpUrl, isS3Url, magnetTester } from './utils.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import WebTorrent from 'webtorrent';
import { TorrentSource } from 'pmtiles-torrent';
import { WebTorrentEngine } from 'pmtiles-torrent/webtorrent';

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

  /**
   * Closes the underlying file descriptor.
   * @returns {void}
   */
  destroy() {
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
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
 * Torrent-backed PMTiles sources.
 *
 * The byte-range-to-piece mapping, piece cache, request deduplication and
 * directory prefetch all live in the `pmtiles-torrent` package. This module
 * only wires it up and owns the process's single WebTorrent client.
 */

/** The one WebTorrent client shared by every torrent-backed archive. */
let torrentClient = null;

/**
 * Reads a non-negative integer from the environment.
 * @param {string} name - Environment variable name.
 * @param {number} fallback - Value to use when unset or unparseable.
 * @returns {number} - The configured value.
 */
function envInt(name, fallback) {
  // eslint-disable-next-line security/detect-object-injection -- name is a string literal at every call site
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Lazily creates the WebTorrent client shared by every torrent-backed archive:
 * one peer pool, one listening port, one DHT node for the whole process.
 *
 * Set PMTILES_TORRENT_PATH to the directory holding your archives. WebTorrent
 * verifies whatever is already on disk at that path, so pointing it at complete
 * files makes the tile server seed them immediately rather than re-download
 * them — and makes partial downloads survive a restart.
 * @returns {object} - The shared WebTorrent client.
 */
function getTorrentClient() {
  if (!torrentClient) {
    torrentClient = new WebTorrent({
      maxConns: envInt('PMTILES_TORRENT_MAX_CONNS', 50),
      torrentPort: envInt('PMTILES_TORRENT_PORT', 0),
    });
    torrentClient.on('error', (err) => {
      console.error(`WebTorrent client error: ${err.message}`);
    });
  }
  return torrentClient;
}

/**
 * Creates a PMTiles source that reads byte ranges out of a BitTorrent swarm.
 *
 * Nothing is downloaded and no client is started until PMTiles asks for its
 * first byte range, which keeps openPMtiles() synchronous.
 * @param {string} torrentIdentifier - Magnet URI or info hash.
 * @returns {object} - A PMTiles Source backed by the torrent.
 */
function createTorrentSource(torrentIdentifier) {
  const engine = new WebTorrentEngine(torrentIdentifier, {
    // Passed as a factory so no torrent client is started unless an archive
    // actually needs one.
    client: getTorrentClient,
    path: process.env.PMTILES_TORRENT_PATH || undefined,
    readyTimeoutMs: envInt('PMTILES_TORRENT_READY_TIMEOUT_MS', 120000),
  });

  return new TorrentSource(engine, {
    // The budget is cachePieces * pieceLength, so the default is 128 MiB per
    // archive against the 16 MiB pieces that large archives are usually cut
    // with. Raise it on a dedicated server; every extra piece is another
    // pieceLength of resident memory per archive.
    cachePieces: envInt('PMTILES_TORRENT_CACHE_PIECES', 8),
    // Leaf directories gate every tile lookup, so a long-lived server is
    // usually better off pulling the whole section once. Planet-scale archives
    // can exceed this, in which case each new leaf directory costs a blocking
    // fetch instead.
    maxLeafPrefetchBytes:
      envInt('PMTILES_TORRENT_LEAF_PREFETCH_MB', 64) * 1024 * 1024,
  });
}

/**
 * Shuts down the shared WebTorrent client, announcing 'stopped' to trackers.
 * Safe to call when no torrent-backed archive was ever opened.
 * @returns {Promise<void>} - Resolves once the client has been destroyed.
 */
export async function destroyTorrentClient() {
  if (!torrentClient) return;
  const client = torrentClient;
  torrentClient = null;
  await new Promise((resolve) => client.destroy(() => resolve()));
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
    // Lazily initialised — the WebTorrent client is not started until the
    // first getBytes() call, so this stays synchronous.
    const source = createTorrentSource(filePath);
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
 * Closes and cleans up resources associated with a PMTiles object: the file
 * descriptor for local archives, or the torrent for swarm-backed ones. The
 * shared WebTorrent client outlives individual archives — see
 * {@link destroyTorrentClient}.
 * @param {PMTiles} pmtiles - The PMTiles instance to close.
 * @returns {Promise<void>} - Resolves once the source has been released.
 */
export async function closePMTiles(pmtiles) {
  if (!pmtiles) return;

  // Drop it from the instance cache first, so a later openPMtiles() for the
  // same file cannot hand back a source that is being torn down.
  for (const [key, cached] of pmtilesCache) {
    if (cached === pmtiles) pmtilesCache.delete(key);
  }

  // The public field is `source`; the previous `_source` never existed on the
  // PMTiles class, so this function used to do nothing at all.
  const source = pmtiles.source;
  if (source && typeof source.destroy === 'function') {
    await source.destroy();
  }
}
