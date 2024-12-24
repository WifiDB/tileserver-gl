import path from 'path';
import fsPromises from 'fs/promises';
import clone from 'clone';
import { combine } from '@jsse/pbfont';
import { existsP } from './promises.js';
import { getPMtilesTile } from './pmtiles_adapter.js';

/**
 * Restrict user input to an allowed set of options.
 * @param {string[]} opts - The allowed options.
 * @param {object} [options] - Optional parameters.
 * @param {any} [options.defaultValue] - The default value.
 * @returns {Function} A function that validates a value against allowed options.
 */
export function allowedOptions(opts, { defaultValue } = {}) {
  const values = Object.fromEntries(opts.map((key) => [key, key]));
  return (value) => values[value] || defaultValue;
}

/**
 * Replace local:// urls with public http(s):// urls
 * @param {object} req - Express request
 * @param {string} url - The URL to be fixed
 * @param {string} publicUrl - Public URL to replace local:// with
 * @returns {string} A url with the `local://` replaced.
 */
export function fixUrl(req, url, publicUrl) {
  if (!url || typeof url !== 'string' || !url.startsWith('local://')) {
    return url;
  }

  const queryParams = [];
  if (req.query?.key) {
    queryParams.unshift(`key=${encodeURIComponent(req.query.key)}`);
  }

  const query = queryParams.length ? `?${queryParams.join('&')}` : '';
  return url.replace('local://', getPublicUrl(publicUrl, req)) + query;
}

/**
 * Generate new URL object
 * @param {object} req - Express request
 * @returns {URL} object
 */
const getUrlObject = (req) => {
  const urlObject = new URL(`${req.protocol}://${req.headers.host}/`);
  urlObject.hostname = req.hostname;

  const xForwardedPath = req.get('X-Forwarded-Path');
  if (xForwardedPath) {
    urlObject.pathname = path.posix.join(xForwardedPath, urlObject.pathname);
  }
  return urlObject;
};

/**
 * Gets a public URL string
 * @param {string} publicUrl - The public URL.
 * @param {object} req - Express request
 * @returns {string} A public url
 */
export function getPublicUrl(publicUrl, req) {
  if (publicUrl) {
    return publicUrl;
  }
  return getUrlObject(req).toString();
}

/**
 * Gets an array of tile URLs
 * @param {object} req - Express request
 * @param {string[] | string} domains - The domains to use
 * @param {string} path - The path.
 * @param {number} tileSize - The tile size.
 * @param {string} format - The format to use.
 * @param {string} publicUrl - The public url to use.
 * @param {string[]} aliases - An array of format aliases
 * @returns {string[]} Array of tile URLs
 */
export function getTileUrls(
  req,
  domains,
  path,
  tileSize,
  format,
  publicUrl,
  aliases,
) {
  const urlObject = getUrlObject(req);
  let finalDomains = domains;
  if (finalDomains) {
    if (typeof finalDomains === 'string' && finalDomains.length > 0) {
      finalDomains = finalDomains.split(',');
    }
    const hostParts = urlObject.host.split('.');
    const relativeSubdomainsUsable =
      hostParts.length > 1 &&
      !/^([0-9]{1,3}\.){3}[0-9]{1,3}(\:[0-9]+)?$/.test(urlObject.host);
    const newDomains = [];
    for (const domain of finalDomains) {
      if (domain.indexOf('*') !== -1) {
        if (relativeSubdomainsUsable) {
          const newParts = hostParts.slice(1);
          newParts.unshift(domain.replace('*', hostParts[0]));
          newDomains.push(newParts.join('.'));
        }
      } else {
        newDomains.push(domain);
      }
    }
    finalDomains = newDomains;
  }
  if (!finalDomains || finalDomains.length === 0) {
    finalDomains = [urlObject.host];
  }

  const queryParams = [];
  if (req.query?.key) {
    queryParams.push(`key=${encodeURIComponent(req.query.key)}`);
  }
  if (req.query?.style) {
    queryParams.push(`style=${encodeURIComponent(req.query.style)}`);
  }
  const query = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';

  let finalFormat = format;
  if (aliases?.[format]) {
    finalFormat = aliases[format];
  }

  let tileParams = `{z}/{x}/{y}`;
  if (tileSize && ['png', 'jpg', 'jpeg', 'webp'].includes(finalFormat)) {
    tileParams = `${tileSize}/{z}/{x}/{y}`;
  }

  const formatString = finalFormat ? `.${finalFormat}` : '';

  const uris = [];
  if (!publicUrl) {
    const xForwardedPath = `${req.get('X-Forwarded-Path') ? '/' + req.get('X-Forwarded-Path') : ''}`;
    for (const domain of finalDomains) {
      uris.push(
        `${req.protocol}://${domain}${xForwardedPath}/${path}/${tileParams}${formatString}${query}`,
      );
    }
  } else {
    uris.push(`${publicUrl}${path}/${tileParams}${formatString}${query}`);
  }
  return uris;
}

/**
 * Fix the center of a tileJSON if it doesn't exist
 * @param {object} tileJSON - The tileJSON
 */
export const fixTileJSONCenter = (tileJSON) => {
  if (tileJSON.bounds && !tileJSON.center) {
    const fitWidth = 1024;
    const tiles = fitWidth / 256;
    tileJSON.center = [
      (tileJSON.bounds[0] + tileJSON.bounds[2]) / 2,
      (tileJSON.bounds[1] + tileJSON.bounds[3]) / 2,
      Math.round(
        -Math.log((tileJSON.bounds[2] - tileJSON.bounds[0]) / 360 / tiles) /
          Math.LN2,
      ),
    ];
  }
};

/**
 * Get a font PBF from a file or fallback to other fonts
 * @param {object} allowedFonts - The allowed fonts.
 * @param {string} fontPath - The path to the fonts.
 * @param {string} name - The font name.
 * @param {string} range - The unicode range
 * @param {object} fallbacks - Fallbacks for the font.
 * @returns {Promise<Buffer>} the buffer of the requested font
 */
const getFontPbf = async (allowedFonts, fontPath, name, range, fallbacks) => {
  if (!allowedFonts || (allowedFonts[name] && fallbacks)) {
    const filename = path.join(fontPath, name, `${range}.pbf`);
    const currentFallbacks = fallbacks
      ? clone(fallbacks)
      : allowedFonts
        ? clone(allowedFonts)
        : {};
    if (currentFallbacks) {
      delete currentFallbacks[name];
    }

    try {
      const data = await fsPromises.readFile(filename);
      return data;
    } catch (err) {
      console.error(`ERROR: Font not found: ${name}`);
      if (currentFallbacks && Object.keys(currentFallbacks).length) {
        let fallbackName;
        let fontStyle = name.split(' ').pop();
        if (['Regular', 'Bold', 'Italic'].indexOf(fontStyle) < 0) {
          fontStyle = 'Regular';
        }
        fallbackName = `Noto Sans ${fontStyle}`;
        if (!currentFallbacks[fallbackName]) {
          fallbackName = `Open Sans ${fontStyle}`;
          if (!currentFallbacks[fallbackName]) {
            fallbackName = Object.keys(currentFallbacks)[0];
          }
        }

        console.error(`ERROR: Trying to use ${fallbackName} as a fallback`);
        delete currentFallbacks[fallbackName];

        return await getFontPbf(
          null,
          fontPath,
          fallbackName,
          range,
          currentFallbacks,
        );
      } else {
        throw new Error(`Font load error: ${name}`);
      }
    }
  } else {
    throw new Error(`Font not allowed: ${name}`);
  }
};

/**
 * Get a combined PBF for an array of fonts
 * @param {object} allowedFonts - The allowed fonts.
 * @param {string} fontPath - The path to the fonts.
 * @param {string} names - The comma seperated names of the fonts.
 * @param {string} range - The unicode range
 * @param {object} fallbacks - Fallbacks for the font.
 * @returns {Promise<Buffer>} a buffer of the fonts
 */
export async function getFontsPbf(
  allowedFonts,
  fontPath,
  names,
  range,
  fallbacks,
) {
  const fonts = names.split(',');
  const queue = fonts.map((font) =>
    getFontPbf(
      allowedFonts,
      fontPath,
      font,
      range,
      clone(allowedFonts || fallbacks),
    ),
  );
  const combined = combine(await Promise.all(queue), names);
  return Buffer.from(combined.buffer, 0, combined.buffer.length);
}

/**
 * Lists all fonts at a given path
 * @param {string} fontPath - The font path.
 * @returns {Promise<object>} An object of all fonts in the directory.
 */
export async function listFonts(fontPath) {
  const existingFonts = {};
  const files = await fsPromises.readdir(fontPath);
  for (const file of files) {
    const stats = await fsPromises.stat(path.join(fontPath, file));
    if (
      stats.isDirectory() &&
      (await existsP(path.join(fontPath, file, '0-255.pbf')))
    ) {
      existingFonts[path.basename(file)] = true;
    }
  }
  return existingFonts;
}

/**
 * Checks if a string is a valid http URL.
 * @param {string} string - String to check.
 * @returns {boolean} - True if valid, false if not.
 */
export const isValidHttpUrl = (string) => {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
};

/**
 * Fetches tile data from either a pmtiles or mbtiles source
 * @param {string} source - The source to use.
 * @param {'pmtiles' | 'mbtiles'} sourceType - The type of source.
 * @param {number} z - The z value of the tile
 * @param {number} x - The x value of the tile
 * @param {number} y - The y value of the tile
 * @returns {Promise<Buffer>} the buffer of the requested tile
 */
export async function fetchTileData(source, sourceType, z, x, y) {
  if (sourceType === 'pmtiles') {
    const tileinfo = await getPMtilesTile(source, z, x, y);
    return tileinfo?.data;
  } else if (sourceType === 'mbtiles') {
    return new Promise((resolve, reject) => {
      source.getTile(z, x, y, (err, tileData) => {
        if (err) {
          return /does not exist/.test(err.message)
            ? resolve(null)
            : reject(err);
        }
        resolve(tileData);
      });
    });
  }
  return null;
}
