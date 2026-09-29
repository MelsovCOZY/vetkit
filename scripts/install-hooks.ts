import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Installs lefthook's hooks into the repo in the current directory. A checkout that
// carries the tracker's local directory has core.hooksPath pointing at the tracker's hook
// files, so `lefthook install` would displace them; instead a marked block that runs
// lefthook is appended to those files. The tracker preserves content outside its own
// markers when it reinstalls, so the block survives; a rerun of this script is a no-op.
// Local hooks are advisory (CI is the gate): lefthook runs and prints, but its exit code
// never fails the commit, and a missing bun warns and continues. A hand-written advisory
// tail from before this script managed the block is replaced, so lefthook runs once.

const lefthook = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  'lefthook',
);
const LOCAL_DIR = '.beads';
const HOOKS = ['pre-commit', 'commit-msg'];
const BEGIN = '# --- BEGIN LEFTHOOK CHAIN (scripts/install-hooks.ts) ---';
const END = '# --- END LEFTHOOK CHAIN ---';
const OLD_TAIL = '# Advisory only (root DECISION';

function git(...args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function chainBlock(hook: string): string {
  return `${BEGIN}
if command -v bun >/dev/null 2>&1; then
  bun x lefthook run ${hook} --no-auto-install "$@" || true
else
  echo >&2 "lefthook: bun not found, skipping ${hook}"
fi
${END}
`;
}

function withBlock(existing: string, hook: string): string {
  const block = chainBlock(hook);
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END, start);
  if (start !== -1 && end !== -1) {
    return existing.slice(0, start) + block + existing.slice(end + END.length + 1);
  }
  const tail = existing.indexOf(OLD_TAIL);
  const base = tail === -1 ? existing : existing.slice(0, tail);
  const sep = base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
  return base + sep + block;
}

function chain(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const hook of HOOKS) {
    const file = join(dir, hook);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '#!/usr/bin/env sh\n';
    writeFileSync(file, withBlock(existing, hook));
    chmodSync(file, 0o755);
  }
}

const hooksPath = git('config', '--local', '--get', 'core.hooksPath');

if (existsSync(LOCAL_DIR) && hooksPath !== '') {
  chain(git('rev-parse', '--path-format=absolute', '--git-path', 'hooks'));
  console.log(`${LOCAL_DIR}/ present: chained lefthook into the hooks in ${hooksPath}.`);
  process.exit(0);
}

if (hooksPath.startsWith(LOCAL_DIR)) {
  git('config', '--local', '--unset', 'core.hooksPath');
}

const run = spawnSync(lefthook, ['install'], { stdio: 'inherit' });
process.exit(run.status ?? 1);
