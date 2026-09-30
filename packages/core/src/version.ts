// The `@vetkit/core` package version, read once. It is part of the verdict cache key, so a new
// release never serves a judgment made under older judging semantics. `unbundle: true` keeps dist
// at the same depth as src, so `../package.json` is core's own package.json from both.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const CORE_VERSION: string = require('../package.json').version;
