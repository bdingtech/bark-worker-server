import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type RsbuildConfig } from '@rsbuild/core';
import fs from 'fs-extra';
import { edgeFunctionRelativePath } from './src/entry/edgeone-layout';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defines: Record<string, string> = {
  'process.env.ENTRY': JSON.stringify(process.env.ENTRY),
};

const config: RsbuildConfig = {
  output: {
    target: 'web',
    module: true,
    distPath: {
      root: 'dist',
      js: '.',
    },
    filename: {
      js: '[name].js',
    },
    cleanDistPath: true,
    polyfill: 'off',
    sourceMap: false,
    minify: false,
    externals: ['node:process'],
  },
  performance: {
    chunkSplit: {
      strategy: 'all-in-one',
    },
  },
  source: {
    entry: {
      handler: {
        import: `./src/entry/${process.env.ENTRY}.ts`,
        html: false,
      },
    },
    define: defines,
  },
  tools: {
    rspack: {
      target: 'es2020',
      output: {
        asyncChunks: false,
        library: {
          type: 'module',
        },
      },
      experiments: {
        outputModule: true,
      },
    },
  },
};

if (process.env.ENTRY === 'node') {
  config.output!.target = 'node';
}

if (process.env.ENTRY === 'esa') {
  [
    'URL_PREFIX',
    'MAX_BATCH_PUSH_COUNT',
    'DB_NAME',
    'ALLOW_NEW_DEVICE',
    'ALLOW_QUERY_NUMS',
    'BASIC_AUTH',
    'APNS_URL',
  ].forEach((key) => {
    defines[`process.env.${key}`] = process.env[key]
      ? JSON.stringify(process.env[key])
      : 'undefined';
  });
}

if (process.env.ENTRY === 'edgeone') {
  const edgeFunctionPath = edgeFunctionRelativePath(process.env.URL_PREFIX);

  config.plugins = [
    {
      name: 'edgeone-move-handler',
      setup(api) {
        api.onAfterBuild(async () => {
          const cwd = process.cwd();
          const dist = path.join(__dirname, 'dist');
          const target = path.join(cwd, edgeFunctionPath);
          await fs.ensureDir(path.dirname(target));
          if (await fs.pathExists(target)) {
            await fs.remove(target);
          }
          console.log(`Move handler.js to ${target}`);
          await fs.move(path.join(dist, 'handler.js'), target);
        });
      },
    },
  ];
}

// Docs: https://rsbuild.rs/config/
export default defineConfig(config);
