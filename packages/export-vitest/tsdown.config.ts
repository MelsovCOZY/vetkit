import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  unbundle: true,
  dts: true,
  publint: true,
  // package.json has "type": "module", so plain .js/.d.ts is already ESM;
  // tsdown's fixedExtension default (true on platform 'node') would emit .mjs/.d.mts,
  // which does not match the exports map's ./dist/index.js and ./dist/index.d.ts.
  fixedExtension: false,
  // emit-scorer.ts loads scorer.ts.tmpl via a URL relative to its own (built) module
  // location, so the template must land next to it at dist/templates/scorer.ts.tmpl —
  // otherwise the built CLI's `vet export --to vitest` throws ENOENT.
  copy: [{ from: 'src/templates/scorer.ts.tmpl', to: 'dist/templates' }],
});
