'use strict';

import fs from 'node:fs';
import path from 'path';
import zlib from 'zlib';

import clone from 'clone';
import express from 'express';
import MBTiles from '@mapbox/mbtiles';
import PMTiles from 'pmtiles';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

import { getTileUrls, fixTileJSONCenter, GetPMtilesInfo, GetPMtilesTile } from './utils.js';

export const serve_data = {
  init: (options, repo) => {
    const app = express().disable('x-powered-by');

    app.get(
      '/:id/:z(\\d+)/:x(\\d+)/:y(\\d+).:format([\\w.]+)',
      async (req, res, next) => {
        const item = repo[req.params.id];
        console.log(item);
        if (!item) {
          return res.sendStatus(404);
        }
        const tileJSONFormat = item.tileJSON.format;
        const tileJSONExtension = item.tileJSON.extension;
        const z = req.params.z | 0;
        const x = req.params.x | 0;
        const y = req.params.y | 0;
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
          0 ||
          x < 0 ||
          y < 0 ||
          z > item.tileJSON.maxzoom ||
          x >= Math.pow(2, z) ||
          y >= Math.pow(2, z)
        ) {
          return res.status(404).send('Out of bounds');
        }
        if (tileJSONExtension === 'pmtiles') {
          let isGzipped;
          let tileinfo = await GetPMtilesTile(item.source, z, x, y);
          let data = tileinfo.data
          let headers = tileinfo.header
          console.log(data)
          console.log(headers)
          if (data == undefined) {
            return res.status(404).send('Not found');
          } else {
            if (tileJSONFormat === 'pbf') {
              isGzipped =
                data.slice(0, 2).indexOf(Buffer.from([0x1f, 0x8b])) === 0;
              if (options.dataDecoratorFunc) {
                if (isGzipped) {
                  data = zlib.unzipSync(data);
                  isGzipped = false;
                }
                data = options.dataDecoratorFunc(id, 'data', data, z, x, y);
              }
            }
            if (format === 'pbf') {
              headers['Content-Type'] = 'application/x-protobuf';
            } else if (format === 'geojson') {
              headers['Content-Type'] = 'application/json';

              if (isGzipped) {
                data = zlib.unzipSync(data);
                isGzipped = false;
              }

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
              data = zlib.gzipSync(data);
              isGzipped = true;
            }

            return res.status(200).send(data);
          }

        } else {
        item.source.getTile(z, x, y, (err, data, headers) => {
          let isGzipped;
          if (err) {
            if (/does not exist/.test(err.message)) {
              return res.status(204).send();
            } else {
              return res
                .status(500)
                .header('Content-Type', 'text/plain')
                .send(err.message);
            }
          } else {
            if (data == null) {
              return res.status(404).send('Not found');
            } else {
              if (tileJSONFormat === 'pbf') {
                isGzipped =
                  data.slice(0, 2).indexOf(Buffer.from([0x1f, 0x8b])) === 0;
                if (options.dataDecoratorFunc) {
                  if (isGzipped) {
                    data = zlib.unzipSync(data);
                    isGzipped = false;
                  }
                  data = options.dataDecoratorFunc(id, 'data', data, z, x, y);
                }
              }
              if (format === 'pbf') {
                headers['Content-Type'] = 'application/x-protobuf';
              } else if (format === 'geojson') {
                headers['Content-Type'] = 'application/json';

                if (isGzipped) {
                  data = zlib.unzipSync(data);
                  isGzipped = false;
                }

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
                data = zlib.gzipSync(data);
                isGzipped = true;
              }

              return res.status(200).send(data);
            }
          }
          
        });
      }
      },
    );

    app.get('/:id.json', (req, res, next) => {
      const item = repo[req.params.id];
      if (!item) {
        return res.sendStatus(404);
      }
      const info = clone(item.tileJSON);
      info.tiles = getTileUrls(
        req,
        info.tiles,
        `data/${req.params.id}`,
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
  add: async (options, repo, params, id, publicUrl) => {
    const mbtilesFile = path.resolve(options.paths.mbtiles, params.mbtiles);
    let tileJSON = {
      tiles: params.domains || options.domains,
    };

    const mbtilesFileStats = fs.statSync(mbtilesFile);
    if (!mbtilesFileStats.isFile() || mbtilesFileStats.size === 0) {
      throw Error(`Not valid MBTiles file: ${mbtilesFile}`);
    }

    const extension = mbtilesFile.split('.').pop().toLowerCase();
    let source;
    if (extension === 'pmtiles') {
      const info = await GetPMtilesInfo(mbtilesFile);
      const metadata = info.metadata;
      source = mbtilesFile;

      tileJSON['name'] = id;
      tileJSON['format'] = 'pbf';
      tileJSON['extension'] = 'pmtiles';
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
    } else {
      const sourceInfoPromise = new Promise((resolve, reject) => {
        source = new MBTiles(mbtilesFile + '?mode=ro', (err) => {
          if (err) {
            reject(err);
            return;
          }
          source.getInfo((err, info) => {
            if (err) {
              reject(err);
              return;
            }
            tileJSON['name'] = id;
            tileJSON['format'] = 'pbf';
            tileJSON['extension'] = 'mbtiles';

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
            resolve();
          });
        });
      });

      await sourceInfoPromise;
    }

    console.log(tileJSON);

    repo[id] = {
      tileJSON,
      publicUrl,
      source,
    };
  },
};
