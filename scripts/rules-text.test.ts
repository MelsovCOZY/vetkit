import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');

const ENV_RULE =
  'Libraries (@vetkit/*) read process.env only and never read files; the vetkit CLI seeds process.env from ./.env and ./.env.local next to the resolved config (existing env wins) and never logs their values';

describe('project rules text', () => {
  it.each([
    ['CLAUDE.md', claude],
    ['CONTRIBUTING.md', contributing],
  ])('%s states the amended env rule verbatim', (_name, text) => {
    expect(text.replaceAll(/\s+/g, ' ')).toContain(ENV_RULE);
  });

  it('CLAUDE.md no longer says no code exists', () => {
    expect(claude).not.toContain('No code exists yet');
    expect(claude).not.toContain('Do not read keys from anywhere but env vars');
  });

  it('CONTRIBUTING publish-job Node version matches release.yml', () => {
    const version = /node-version:\s*(\S+)/.exec(release)?.[1];
    expect(version).toBeDefined();
    const flat = contributing.replaceAll(/\s+/g, ' ');
    expect(flat).toContain(`publish job runs on Node ${version}`);
    expect(flat).not.toContain('runs on Node 24');
  });

  it('CLAUDE.md.bak is not tracked', () => {
    const r = spawnSync('git', ['ls-files', '--', 'CLAUDE.md.bak'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('CONTRIBUTING has a Repo layout for contributors section naming internal material', () => {
    expect(contributing).toContain('## Repo layout for contributors');
    const body = contributing.split('## Repo layout for contributors')[1] ?? '';
    for (const name of [
      'AGENTS.md',
      '.agents/',
      '.claude/',
      'spike/',
      'fixtures/',
      'docs/contracts/',
    ]) {
      expect(body).toContain(name);
    }
  });
});
