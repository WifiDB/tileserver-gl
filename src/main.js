#!/usr/bin/env node

'use strict';

import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import request from 'request';
import { server } from './server.js';
import MBTiles from '@mapbox/mbtiles';
import { GetPMtilesInfo } from './pmtiles_adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(
  fs.readFileSync(__dirname + '/../package.json', 'utf8'),
);

const args = process.argv;
if (args.length >= 3 && args[2][0] !== '-') {
  args.splice(2, 0, '--mbtiles');
}

import { program } from 'commander';
program
  .description('tileserver-gl startup options')
  .usage('tileserver-gl [mbtiles] [options]')
  .option(
    '--file <file>',
    'MBTiles or PMTiles file\n' +
      '\t                  ignored if the configuration file is also specified',
  )
  .option(
    '--mbtiles <file>',
    '(DEPRECIATED) MBTiles file (uses demo configuration);\n' +
      '\t                  ignored if file is also specified' +
      '\t                  ignored if the configuration file is also specified',
  )
  .option(
    '-c, --config <file>',
    'Configuration file [config.json]',
    'config.json',
  )
  .option('-b, --bind <address>', 'Bind address')
  .option('-p, --port <port>', 'Port [8080]', 8080, parseInt)
  .option('-C|--no-cors', 'Disable Cross-origin resource sharing headers')
  .option(
    '-u|--public_url <url>',
    'Enable exposing the server on subpaths, not necessarily the root of the domain',
  )
  .option('-V, --verbose', 'More verbose output')
  .option('-s, --silent', 'Less verbose output')
  .option('-l|--log_file <file>', 'output log file (defaults to standard out)')
  .option(
    '-f|--log_format <format>',
    'define the log format:  https://github.com/expressjs/morgan#morganformat-options',
  )
  .version(packageJson.version, '-v, --version');
program.parse(process.argv);
const opts = program.opts();

console.log(`Starting ${packageJson.name} v${packageJson.version}`);

const startServer = (configPath, config) => {
  let publicUrl = opts.public_url;
  if (publicUrl && publicUrl.lastIndexOf('/') !== publicUrl.length - 1) {
    publicUrl += '/';
  }
  return server({
    configPath: configPath,
    config: config,
    bind: opts.bind,
    port: opts.port,
    cors: opts.cors,
    verbose: opts.verbose,
    silent: opts.silent,
    logFile: opts.log_file,
    logFormat: opts.log_format,
    publicUrl: publicUrl,
  });
};

const startWithInputFile = async (inputfile) => {
  console.log(`[INFO] Automatically creating config file for ${inputfile}`);
  console.log(`[INFO] Only a basic preview style will be used.`);
  console.log(
    `[INFO] See documentation to learn how to create config.json file.`,
  );

  inputfile = path.resolve(process.cwd(), inputfile);

  const inputfileStats = fs.statSync(inputfile);
  if (!inputfileStats.isFile() || inputfileStats.size === 0) {
    console.log(`ERROR: Not a valid input file: ${inputfile}`);
    process.exit(1);
  }

  const styleDir = path.resolve(
    __dirname,
    '../node_modules/tileserver-gl-styles/',
  );

  const config = {
    options: {
      paths: {
        root: styleDir,
        fonts: 'fonts',
        styles: 'styles',
        mbtiles: path.dirname(inputfile),
      },
    },
    styles: {},
    data: {},
  };

  const extension = inputfile.split('.').pop().toLowerCase();
  if (extension === 'pmtiles') {
    const info = await GetPMtilesInfo(inputfile);
    const metadata = info.metadata;

    if (
      metadata.format === 'pbf' &&
      metadata.name.toLowerCase().indexOf('openmaptiles') > -1
    ) {
      config['data'][`v3`] = {
        mbtiles: path.basename(inputfile),
      };

      const styles = fs.readdirSync(path.resolve(styleDir, 'styles'));
      for (const styleName of styles) {
        const styleFileRel = styleName + '/style.json';
        const styleFile = path.resolve(styleDir, 'styles', styleFileRel);
        if (fs.existsSync(styleFile)) {
          config['styles'][styleName] = {
            style: styleFileRel,
            tilejson: {
              bounds: metadata.bounds,
            },
          };
        }
      }
    } else {
      console.log(
        `WARN: PMTiles not in "openmaptiles" format. Serving raw data only...`,
      );
      config['data'][(metadata.id || 'mbtiles').replace(/[?/:]/g, '_')] = {
        mbtiles: path.basename(inputfile),
      };
    }

    if (opts.verbose) {
      console.log(JSON.stringify(config, undefined, 2));
    } else {
      console.log('Run with --verbose to see the config file here.');
    }

    return startServer(null, config);
  } else {
    const instance = new MBTiles(inputfile + '?mode=ro', (err) => {
      if (err) {
        console.log('ERROR: Unable to open MBTiles.');
        console.log(`Make sure ${path.basename(inputfile)} is valid MBTiles.`);
        process.exit(1);
      }

      instance.getInfo((err, info) => {
        if (err || !info) {
          console.log('ERROR: Metadata missing in the MBTiles.');
          console.log(
            `Make sure ${path.basename(inputfile)} is valid MBTiles.`,
          );
          process.exit(1);
        }
        const bounds = info.bounds;

        if (
          info.format === 'pbf' &&
          info.name.toLowerCase().indexOf('openmaptiles') > -1
        ) {
          config['data'][`v3`] = {
            mbtiles: path.basename(inputfile),
          };

          const styles = fs.readdirSync(path.resolve(styleDir, 'styles'));
          for (const styleName of styles) {
            const styleFileRel = styleName + '/style.json';
            const styleFile = path.resolve(styleDir, 'styles', styleFileRel);
            if (fs.existsSync(styleFile)) {
              config['styles'][styleName] = {
                style: styleFileRel,
                tilejson: {
                  bounds: bounds,
                },
              };
            }
          }
        } else {
          console.log(
            `WARN: MBTiles not in "openmaptiles" format. Serving raw data only...`,
          );
          config['data'][(info.id || 'mbtiles').replace(/[?/:]/g, '_')] = {
            mbtiles: path.basename(inputfile),
          };
        }

        if (opts.verbose) {
          console.log(JSON.stringify(config, undefined, 2));
        } else {
          console.log('Run with --verbose to see the config file here.');
        }

        return startServer(null, config);
      });
    });
  }
};

fs.stat(path.resolve(opts.config), (err, stats) => {
  if (err || !stats.isFile() || stats.size === 0) {
    let inputfile;
    if (opts.file) {
      inputfile = opts.file;
    } else if (opts.mbtiles) {
      inputfile = opts.mbtiles;
    }

    if (inputfile) {
      return startWithInputFile(inputfile);
    } else {
      // try to find in the cwd
      const files = fs.readdirSync(process.cwd());
      for (const filename of files) {
        if (filename.endsWith('.mbtiles') || filename.endsWith('.pmtiles')) {
          const InputFilesStats = fs.statSync(filename);
          if (InputFilesStats.isFile() && InputFilesStats.size > 0) {
            inputfile = filename;
            break;
          }
        }
      }
      if (inputfile) {
        console.log(`No input file specified, using ${inputfile}`);
        return startWithInputFile(inputfile);
      } else {
        const url =
          'https://github.com/maptiler/tileserver-gl/releases/download/v1.3.0/zurich_switzerland.mbtiles';
        const filename = 'zurich_switzerland.mbtiles';
        const stream = fs.createWriteStream(filename);
        console.log(`No input file found`);
        console.log(`[DEMO] Downloading sample data (${filename}) from ${url}`);
        stream.on('finish', () => startWithInputFile(filename));
        return request.get(url).pipe(stream);
      }
    }
  } else {
    console.log(`Using specified config file from ${opts.config}`);
    return startServer(opts.config, null);
  }
});
