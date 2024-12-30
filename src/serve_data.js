'use strict';

import fsp from 'node:fs/promises';
import path from 'path';

import clone from 'clone';
import express from 'express';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

import {
  fixTileJSONCenter,
  getTileUrls,
  isValidHttpUrl,
  fetchTileData,
} from './utils.js';
import {
  getPMtilesInfo,
  isValidWebPMtiles,
  openPMtiles,
} from './pmtiles_adapter.js';
import { gunzipP, gzipP } from './promises.js';
import { openMbTilesWrapper } from './mbtiles_wrapper.js';

export const serve_data = {
  /**
   * Initializes the serve_data module.
   * @param {object} options Configuration options.
   * @param {object} repo Repository object.
   * @returns {express.Application} The initialized Express application.
   */
  init: function (options, repo) {
    const app = express().disable('x-powered-by');

    app.get('/:id/:z/:x/:y.:format', async (req, res) => {
      const item = repo[req.params.id];
      if (!item) {
        return res.sendStatus(404);
      }
      const tileJSONFormat = item.tileJSON.format;
      const z = parseInt(req.params.z, 10);
      const x = parseInt(req.params.x, 10);
      const y = parseInt(req.params.y, 10);
      if (isNaN(z) || isNaN(x) || isNaN(y)) {
        return res.status(404).send('Invalid Tile');
      }

      let format = req.params.format;
      if (format === options.pbfAlias) {
        format = 'pbf';
      }
      if (
        format !== tileJSONFormat &&
        !(format === 'geojson' && tileJSONFormat === 'pbf')
      ) {
        return res.status(404).send('Invalid format');
      }
      if (
        z < item.tileJSON.minzoom ||
        x < 0 ||
        y < 0 ||
        z > item.tileJSON.maxzoom ||
        x >= Math.pow(2, z) ||
        y >= Math.pow(2, z)
      ) {
        return res.status(404).send('Out of bounds');
      }

      const fetchTile = await fetchTileData(
        item.source,
        item.sourceType,
        z,
        x,
        y,
      );
      if (fetchTile == null) return res.status(204).send();

      let data = fetchTile.data;
      let headers = fetchTile.headers;
      let isGzipped = data.slice(0, 2).indexOf(Buffer.from([0x1f, 0x8b])) === 0;

      if (tileJSONFormat === 'pbf') {
        if (options.dataDecoratorFunc) {
          if (isGzipped) {
            data = await gunzipP(data);
            isGzipped = false;
          }
          data = options.dataDecoratorFunc(id, 'data', data, z, x, y);
        }
      }

      if (format === 'pbf') {
        headers['Content-Type'] = 'application/x-protobuf';
      } else if (format === 'geojson') {
        headers['Content-Type'] = 'application/json';
        const tile = new VectorTile(new Pbf(data));
        const geojson = {
          type: 'FeatureCollection',
          features: [],
        };
        for (const layerName in tile.layers) {
          const layer = tile.layers[layerName];
          for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            const featureGeoJSON = feature.toGeoJSON(x, y, z);
            featureGeoJSON.properties.layer = layerName;
            geojson.features.push(featureGeoJSON);
          }
        }
        data = JSON.stringify(geojson);
      }
      delete headers['ETag']; // do not trust the tile ETag -- regenerate
      headers['Content-Encoding'] = 'gzip';
      res.set(headers);

      if (!isGzipped) {
        data = await gzipP(data);
      }

      return res.status(200).send(data);
    });

    app.get('/:id.json', (req, res) => {
      const item = repo[req.params.id];
      if (!item) {
        return res.sendStatus(404);
      }
      const tileSize = undefined;
      const info = clone(item.tileJSON);
      info.tiles = getTileUrls(
        req,
        info.tiles,
        `data/${req.params.id}`,
        tileSize,
        info.format,
        item.publicUrl,
        {
          pbf: options.pbfAlias,
        },
      );
      return res.send(info);
    });

    return app;
  },
  /**
   * Adds a new data source to the repository.
   * @param {object} options Configuration options.
   * @param {object} repo Repository object.
   * @param {object} params Parameters object.
   * @param {string} id ID of the data source.
   * @param {object} programOpts - An object containing the program options
   * @returns {Promise<void>}
   */
  add: async function (options, repo, params, id, programOpts) {
    const { publicUrl } = programOpts;
    let inputFile;
    let inputType;
    if (params.pmtiles) {
      inputType = 'pmtiles';
      if (isValidWebPMtiles(params.pmtiles)) {
        inputFile = params.pmtiles;
      } else {
        inputFile = path.resolve(options.paths.pmtiles, params.pmtiles);
      }
    } else if (params.mbtiles) {
      inputType = 'mbtiles';
      if (isValidWebPMtiles(params.mbtiles)) {
        console.log(
          `ERROR: MBTiles does not support web based files. "${params.mbtiles}" is not a valid data file.`,
        );
        process.exit(1);
      } else {
        inputFile = path.resolve(options.paths.mbtiles, params.mbtiles);
      }
    }

    let tileJSON = {
      tiles: params.domains || options.domains,
    };

    if (!isValidWebPMtiles(inputFile)) {
      const inputFileStats = await fsp.stat(inputFile);
      if (!inputFileStats.isFile() || inputFileStats.size === 0) {
        throw Error(`Not valid input file: "${inputFile}"`);
      }
    }

    let source;
    let sourceType;
    if (inputType === 'pmtiles') {
      source = openPMtiles(inputFile);
      sourceType = 'pmtiles';
      const metadata = await getPMtilesInfo(source);

      tileJSON['name'] = id;
      tileJSON['format'] = 'pbf';
      Object.assign(tileJSON, metadata);

      tileJSON['tilejson'] = '2.0.0';
      delete tileJSON['filesize'];
      delete tileJSON['mtime'];
      delete tileJSON['scheme'];

      Object.assign(tileJSON, params.tilejson || {});
      fixTileJSONCenter(tileJSON);

      if (options.dataDecoratorFunc) {
        tileJSON = options.dataDecoratorFunc(id, 'tilejson', tileJSON);
      }
    } else if (inputType === 'mbtiles') {
      sourceType = 'mbtiles';
      const mbw = await openMbTilesWrapper(inputFile);
      const info = await mbw.getInfo();
      source = mbw.getMbTiles();
      tileJSON['name'] = id;
      tileJSON['format'] = 'pbf';

      Object.assign(tileJSON, info);

      tileJSON['tilejson'] = '2.0.0';
      delete tileJSON['filesize'];
      delete tileJSON['mtime'];
      delete tileJSON['scheme'];

      Object.assign(tileJSON, params.tilejson || {});
      fixTileJSONCenter(tileJSON);

      if (options.dataDecoratorFunc) {
        tileJSON = options.dataDecoratorFunc(id, 'tilejson', tileJSON);
      }
    }

    repo[id] = {
      tileJSON,
      publicUrl,
      source,
      sourceType,
    };
  },
};
