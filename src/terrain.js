import { contours } from 'd3-contour';
import { range, min, max } from 'd3-array';
import sharp from 'sharp';
import encodeVectorTile, { GeomType } from './vtpbf.js';
import { fetchTileData } from './utils.js';

/**
 * Processes image data from a blob.
 * @param  blob - The image data as a Blob.
 * @returns {Promise<any>} - A Promise that resolves with the processed image data.
 */
export async function getImageData(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const image = sharp(Buffer.from(buffer));
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (error) {
    console.error('Error processing image:', error);
    throw error;
  }
}

/**
 *
 * @param z
 * @param x
 * @param y
 */
function tileToBBox(z, x, y) {
  const scale = Math.pow(2, z);
  const minX = x / scale;
  const minY = y / scale;
  const maxX = (x + 1) / scale;
  const maxY = (y + 1) / scale;

  return [minX, minY, maxX, maxY];
}

/**
 *
 * @param coords
 * @param extent
 * @param sourceMinX
 * @param sourceMinY
 * @param sourceMaxX
 * @param sourceMaxY
 */
function transformCoords(
  coords,
  extent,
  sourceMinX,
  sourceMinY,
  sourceMaxX,
  sourceMaxY,
) {
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const transformedX = coords[0];
    const transformedY = coords[1];
    const scaledX =
      ((transformedX - sourceMinX) / (sourceMaxX - sourceMinX)) * extent;
    const scaledY =
      ((transformedY - sourceMinY) / (sourceMaxY - sourceMinY)) * extent;

    const clippedX = Math.min(Math.max(scaledX, 0), extent);
    const clippedY = Math.min(Math.max(scaledY, 0), extent);

    return [clippedX, clippedY];
  } else if (Array.isArray(coords)) {
    return coords.map((coord) =>
      transformCoords(
        coord,
        extent,
        sourceMinX,
        sourceMinY,
        sourceMaxX,
        sourceMaxY,
      ),
    );
  } else {
    console.warn('Invalid Coordinate:', coords);
    return NaN;
  }
}

/**
 *
 * @param source
 * @param sourceType
 * @param z
 * @param x
 * @param y
 * @param encoding
 */
export async function combineTiles(source, sourceType, z, x, y, encoding) {
  const neighbors = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let data;
      try {
        data = await fetchTileData(source, sourceType, z, x + dx, y + dy);
      } catch (error) {
        console.error('Error during fetchTileData', error);
        neighbors.push(null);
        continue;
      }
      if (data == null) {
        neighbors.push(null);
        continue;
      }
      let imageData;
      try {
        imageData = await getImageData(new Blob([data]));
      } catch (error) {
        console.error('Error during getImageData', error);
        neighbors.push(null);
        continue;
      }
      const { width, height, data: imagePixelData } = imageData;
      let heightValues;
      try {
        heightValues = extractHeightValues(imagePixelData, encoding);
      } catch (error) {
        console.error('Error during extractHeightValues', error);
        neighbors.push(null);
        continue;
      }
      neighbors.push({
        width,
        height,
        get: (x, y) => {
          return heightValues[y * width + x];
        },
      });
    }
  }
  const mainTile = neighbors[4];
  if (!mainTile) {
    return undefined;
  }
  const width = mainTile.width;
  const height = mainTile.height;

  return {
    width,
    height,
    get: (x, y) => {
      let gridIdx = 0;
      if (y < 0) {
        y += height;
      } else if (y < height) {
        gridIdx += 3;
      } else {
        y -= height;
        gridIdx += 6;
      }
      if (x < 0) {
        x += width;
      } else if (x < width) {
        gridIdx += 1;
      } else {
        x -= width;
        gridIdx += 2;
      }
      const grid = neighbors[gridIdx];
      return grid ? grid.get(x, y) : NaN;
    },
  };
}

/**
 *
 * @param geojson
 * @param z
 * @param x
 * @param y
 * @param extent
 */
export async function serializeMVT(geojson, z, x, y, extent) {
  try {
    if (!geojson || !geojson.features || geojson.features.length === 0) {
      console.error('Error: geojson or geojson.features is empty:', geojson);
      return null;
    }
    const [sourceMinX, sourceMinY, sourceMaxX, sourceMaxY] = tileToBBox(
      z,
      x,
      y,
    );
    // Convert GeoJSON FeatureCollection to the Tile structure expected by the encoder
    const tile = {
      layers: {
        contour: {
          features: geojson.features.map((feature) => {
            let geomType;
            if (feature.geometry.type === 'MultiPolygon') {
              geomType = GeomType.POLYGON;
            } else if (feature.geometry.type === 'Point') {
              geomType = GeomType.POINT;
            } else if (feature.geometry.type === 'LineString') {
              geomType = GeomType.LINESTRING;
            } else {
              geomType = GeomType.UNKNOWN; // Handle unknown types, log for visibility.
              console.warn(
                'Unknown geometry type in GeoJSON:',
                feature.geometry.type,
              );
            }

            const transformedGeometry = transformCoords(
              feature.geometry.coordinates,
              extent,
              sourceMinX,
              sourceMinY,
              sourceMaxX,
              sourceMaxY,
            );

            return {
              type: geomType,
              properties: feature.properties,
              geometry: transformedGeometry,
            };
          }),
          extent: extent,
        },
      },
      extent: extent,
    };

    const buffer = encodeVectorTile(tile);
    return buffer;
  } catch (error) {
    console.error('Error in serializeMVT', error);
    throw error;
  }
}

/**
 * Generates geojson from height values
 * @param {number[]} heightValues - the array of height values
 * @param {number} width - the width of the image
 * @param {number} height - the height of the image
 * @param {number} step - the contour step value
 * @returns {Promise<object>} - The geojson object
 */
export async function generateGeoJSON(heightValues, width, height, step) {
  const thresholds = range(min(heightValues) + step, max(heightValues), step);

  const contoursGenerator = contours()
    .size([width, height])
    .thresholds(thresholds);
  const contourPolygons = contoursGenerator(heightValues);
  const geojsonFeatures = contourPolygons.map((d) => {
    return {
      type: 'Feature',
      geometry: d,
      properties: { elevation: d.value },
    };
  });
  return {
    type: 'FeatureCollection',
    features: geojsonFeatures,
  };
}

/**
 * Converts RGB values to height
 * @param {number} r - Red value.
 * @param {number} g - Green value.
 * @param {number} b - Blue value.
 * @param {'terrarium' | 'mapbox'} [encoding] - The encoding to use.
 * @returns {number} the decoded height.
 */
export function terrainrgb2height(r, g, b, encoding = 'mapbox') {
  if (encoding === 'terrarium') {
    return r * 256 + g + b - 32768;
  }
  // mapbox
  return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

/**
 * Extracts an array of height values from image pixel data
 * @param {Uint8ClampedArray} imagePixelData - The image pixel data.
 * @param {'terrarium' | 'mapbox'} encoding - The encoding type to use.
 * @returns {number[]} - An array of decoded height values.
 */
export function extractHeightValues(imagePixelData, encoding) {
  const heightValues = [];
  for (let i = 0; i < imagePixelData.length / 4; i++) {
    const height = terrainrgb2height(
      imagePixelData[i * 4],
      imagePixelData[i * 4 + 1],
      imagePixelData[i * 4 + 2],
      encoding,
    );
    heightValues.push(height);
  }
  return heightValues;
}
