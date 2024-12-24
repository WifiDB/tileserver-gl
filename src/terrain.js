import { contours } from 'd3-contour';
import { range, min, max } from 'd3-array';
import sharp from 'sharp';
import vtpbf from 'vt-pbf';

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
 * Takes GeoJSON features and creates a Mapbox Vector Tile.
 * @param {object[]} geojsonFeatures - An array of GeoJSON features.
 * @returns  - A buffer containing the MVT data.
 */
export function serializeMVT(geojsonFeatures) {
  return vtpbf.fromGeojsonVt(
    geojsonFeatures
      ? {
          type: 'FeatureCollection',
          features: geojsonFeatures,
        }
      : { type: 'FeatureCollection', features: [] },
    {
      layerName: 'contours',
    },
  );
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
  return geojsonFeatures;
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
