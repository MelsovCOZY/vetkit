import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/repo-metadata.sh');
const DESCRIPTION = (
  JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
    description: string;
  }
).description;

function shim(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'repo-metadata-'));
  const log = join(dir, 'gh.log');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
  chmodSync(gh, 0o755);
  return { dir, log };
}

function run(args: string[], pathPrefix: string): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${pathPrefix}:${process.env['PATH'] ?? ''}` },
    timeout: 20_000,
  });
}

function topics(stdout: string): string[] {
  return [...stdout.matchAll(/--add-topic\s+(\S+)/g)].map((m) => m[1] as string);
}

describe('scripts/repo-metadata.sh', () => {
  it('--dry-run prints the gh repo edit command with the package description and the Pages homepage', () => {
    const { dir } = shim();
    const out = String(run(['--dry-run'], dir).stdout);
    expect(out).toContain('gh repo edit MelsovCOZY/vetkit --description');
    expect(out).toContain(DESCRIPTION.replaceAll(' ', '\\ '));
    expect(out).toContain('--homepage https://melsovcozy.github.io/vetkit/');
    expect(out).not.toContain('--visibility');
    expect(out).toContain(
      'gh repo view MelsovCOZY/vetkit --json description,homepageUrl,repositoryTopics',
    );
  });

  it('--dry-run calls gh zero times', () => {
    const { dir, log } = shim();
    const result = run(['--dry-run'], dir);
    expect(result.status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it('topics are lowercase-hyphen and between 8 and 20', () => {
    const { dir } = shim();
    const list = topics(String(run(['--dry-run'], dir).stdout));
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(list.length).toBeLessThanOrEqual(20);
    for (const topic of list) expect(topic).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const wanted of [
      'llm-evals',
      'evals',
      'llm-evaluation',
      'typescript',
      'cli',
      'github-action',
      'opentelemetry',
      'ci',
    ]) {
      expect(list).toContain(wanted);
    }
  });

  it('prints the manual social-preview step', () => {
    const { dir } = shim();
    expect(String(run(['--dry-run'], dir).stdout)).toContain(
      'manual step: upload assets/social-preview.png in Settings -> General -> Social preview (GitHub has no API for it)',
    );
  });

  it('without --dry-run it calls gh repo edit once and gh repo view once', () => {
    const { dir, log } = shim();
    const result = run([], dir);
    expect(result.status).toBe(0);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.filter((c) => c.startsWith('repo edit MelsovCOZY/vetkit'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('repo view MelsovCOZY/vetkit'))).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('exits 1 naming gh when gh is not on PATH', () => {
    const empty = mkdtempSync(join(tmpdir(), 'repo-metadata-empty-'));
    const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
    const node = process.execPath;
    const bin = mkdtempSync(join(tmpdir(), 'repo-metadata-bin-'));
    for (const [name, target] of [
      ['bash', bash],
      ['node', node],
    ] as const) {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${target}" "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const result = spawnSync(bash, [SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${empty}` },
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gh');
  });
});
