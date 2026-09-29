import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Installs lefthook's hooks into the repo in the current directory. A maintainer
// checkout that carries the tracker's local directory keeps its hook chain untouched.

const lefthook = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  'lefthook',
);
const LOCAL_DIR = '.beads';

function git(...args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

if (existsSync(LOCAL_DIR)) {
  console.log(`${LOCAL_DIR}/ present: keeping its hook chain, not installing lefthook hooks.`);
  process.exit(0);
}

if (git('config', '--local', '--get', 'core.hooksPath').startsWith(LOCAL_DIR)) {
  git('config', '--local', '--unset', 'core.hooksPath');
}

const run = spawnSync(lefthook, ['install'], { stdio: 'inherit' });
process.exit(run.status ?? 1);
