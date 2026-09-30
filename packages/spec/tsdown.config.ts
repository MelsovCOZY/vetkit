import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  unbundle: true,
  dts: true,
  publint: true,
  sourcemap: false,
  // package.json has "type": "module", so plain .js/.d.ts is already ESM;
  // tsdown's fixedExtension default (true on platform 'node') would emit .mjs/.d.mts,
  // which does not match the exports map's ./dist/index.js and ./dist/index.d.ts.
  fixedExtension: false,
});
