'use strict';

import path from 'path';
import fsPromises from 'fs/promises';
import fs, { existsSync } from 'node:fs';
import clone from 'clone';
import glyphCompose from '@mapbox/glyph-pbf-composite';

/**
 * Generate new URL object
 * @param req
 * @params {object} req - Express request
 * @returns {URL} object
 */
const getUrlObject = (req) => {
  const urlObject = new URL(`${req.protocol}://${req.headers.host}/`);
  // support overriding hostname by sending X-Forwarded-Host http header
  urlObject.hostname = req.hostname;
  return urlObject;
};

export const getPublicUrl = (publicUrl, req) => {
  if (publicUrl) {
    return publicUrl;
  }
  return getUrlObject(req).toString();
};

export const getTileUrls = (
  req,
  domains,
  path,
  tileSize,
  format,
  publicUrl,
  aliases,
) => {
  const urlObject = getUrlObject(req);
  if (domains) {
    if (domains.constructor === String && domains.length > 0) {
      domains = domains.split(',');
    }
    const hostParts = urlObject.host.split('.');
    const relativeSubdomainsUsable =
      hostParts.length > 1 &&
      !/^([0-9]{1,3}\.){3}[0-9]{1,3}(\:[0-9]+)?$/.test(urlObject.host);
    const newDomains = [];
    for (const domain of domains) {
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
    domains = newDomains;
  }
  if (!domains || domains.length == 0) {
    domains = [urlObject.host];
  }

  const queryParams = [];
  if (req.query.key) {
    queryParams.push(`key=${encodeURIComponent(req.query.key)}`);
  }
  if (req.query.style) {
    queryParams.push(`style=${encodeURIComponent(req.query.style)}`);
  }
  const query = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';

  if (aliases && aliases[format]) {
    format = aliases[format];
  }

  let tileParams = '{z}/{x}/{y}';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(format)) {
    if (tileSize) {
      tileParams = '{tileSize}/{z}/{x}/{y}';
    }
  }

  const uris = [];
  if (!publicUrl) {
    for (const domain of domains) {
      uris.push(
        `${req.protocol}://${domain}/${path}/${tileParams}.${format}${query}`,
      );
    }
  } else {
    uris.push(`${publicUrl}${path}/${tileParams}.${format}${query}`);
  }

  return uris;
};

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

const getFontPbf = (allowedFonts, fontPath, name, range, fallbacks) =>
  new Promise((resolve, reject) => {
    if (!allowedFonts || (allowedFonts[name] && fallbacks)) {
      const filename = path.join(fontPath, name, `${range}.pbf`);
      if (!fallbacks) {
        fallbacks = clone(allowedFonts || {});
      }
      delete fallbacks[name];
      fs.readFile(filename, (err, data) => {
        if (err) {
          console.error(`ERROR: Font not found: ${name}`);
          if (fallbacks && Object.keys(fallbacks).length) {
            let fallbackName;

            let fontStyle = name.split(' ').pop();
            if (['Regular', 'Bold', 'Italic'].indexOf(fontStyle) < 0) {
              fontStyle = 'Regular';
            }
            fallbackName = `Noto Sans ${fontStyle}`;
            if (!fallbacks[fallbackName]) {
              fallbackName = `Open Sans ${fontStyle}`;
              if (!fallbacks[fallbackName]) {
                fallbackName = Object.keys(fallbacks)[0];
              }
            }

            console.error(`ERROR: Trying to use ${fallbackName} as a fallback`);
            delete fallbacks[fallbackName];
            getFontPbf(null, fontPath, fallbackName, range, fallbacks).then(
              resolve,
              reject,
            );
          } else {
            reject(`Font load error: ${name}`);
          }
        } else {
          resolve(data);
        }
      });
    } else {
      reject(`Font not allowed: ${name}`);
    }
  });

export const getFontsPbf = async (
  allowedFonts,
  fontPath,
  names,
  range,
  fallbacks,
) => {
  const fonts = names.split(',');
  const queue = [];
  for (const font of fonts) {
    queue.push(
      getFontPbf(
        allowedFonts,
        fontPath,
        font,
        range,
        clone(allowedFonts || fallbacks),
      ),
    );
  }

  const values = await Promise.all(queue);
  return glyphCompose.combine(values);
};

export const listFonts = async (fontPath) => {
  const existingFonts = {};

  const files = await fsPromises.readdir(fontPath);
  for (const file of files) {
    const stats = await fsPromises.stat(path.join(fontPath, file));
    if (
      stats.isDirectory() &&
      existsSync(path.join(fontPath, file, '0-255.pbf'))
    ) {
      existingFonts[path.basename(file)] = true;
    }
  }

  return existingFonts;
};

export const isValidHttpUrl = (string) => {
  let url;

  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }

  return url.protocol === 'http:' || url.protocol === 'https:';
};
