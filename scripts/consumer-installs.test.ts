// The consumer installs the scripts make (release smoke, examples runner, README snippet runner,
// package manager matrix) must not depend on which vitest release is the newest one on the
// registry: npm 10 crashes in its resolver on an exact vitest spec older than the newest release
// unless the same version is also forced through `overrides`. Every generated manifest therefore
// carries a vitest override equal to the version this repo is built with, read from the root
// package.json, and any direct vitest spec agrees with it (npm rejects an override that
// conflicts with a direct spec).
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoVitestVersion, scratchManifest } from './readme-snippets.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = (name: string): string => readFileSync(join(ROOT, 'scripts', name), 'utf8');

/** A version no vitest release has, so a passing test proves the value came from the fake root. */
const FAKE_VERSION = '9.8.7';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

function readManifest(file: string): Manifest {
  const manifest: Manifest = JSON.parse(readFileSync(file, 'utf8'));
  return manifest;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'vetkit-consumer-installs-'));
}

/** A repo root whose package.json names FAKE_VERSION as its vitest. */
function fakeRoot(): string {
  const dir = scratch();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fake-root', devDependencies: { vitest: FAKE_VERSION } }),
  );
  return dir;
}

/** A tarball directory holding one packed package, `@vetkit/fake`; returns [dir, tarball]. */
function fakeTarballs(): [string, string] {
  const dir = scratch();
  const source = join(scratch(), 'package');
  mkdirSync(source);
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: '@vetkit/fake', version: '0.0.0' }),
  );
  const tarball = join(dir, 'vetkit-fake-0.0.0.tgz');
  const packed = spawnSync('tar', ['-czf', tarball, '-C', dirname(source), 'package']);
  expect(packed.status).toBe(0);
  return [dir, tarball];
}

/** The text of a top-level `name() { ... }` function of a bash script. */
function bashFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  expect(start, `${name}() in the script`).toBeGreaterThan(-1);
  return source.slice(start + 1, source.indexOf('\n}\n', start) + 2);
}

function bash(code: string, env: Record<string, string>): void {
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', code], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

/** The command of the script's EXIT trap: the quoted command, or the body of the function it names. */
function exitTrap(source: string): string {
  const traps = source.match(/^\s*trap .* EXIT$/gm) ?? [];
  expect(traps).toHaveLength(1);
  const trap = traps[0] ?? '';
  const name = /^\s*trap (\w+) EXIT$/.exec(trap)?.[1];
  return name === undefined ? trap : bashFunction(source, name);
}

describe('scripts never pin a vitest version of their own', () => {
  it.each(['smoke-release.sh', 'examples-run.sh', 'consumer-matrix.sh', 'readme-snippets.ts'])(
    '%s holds no vitest version literal and does not skip peer resolution',
    (name) => {
      const lines = script(name).split('\n');
      const literal = /vitest["']?\s*[@:=]\s*["']?[\^~]?\d/;
      expect(lines.filter((line) => literal.test(line))).toEqual([]);
      expect(lines.filter((line) => line.includes('--legacy-peer-deps'))).toEqual([]);
    },
  );
});

describe('smoke-release.sh consumer manifest', () => {
  it('forces the root package.json vitest version through overrides and the direct spec', () => {
    const source = script('smoke-release.sh');
    const call = /^write_manifest "\$APP" .*$/m.exec(source)?.[0];
    expect(call).toBeDefined();
    const root = fakeRoot();
    const [tarballs, tarball] = fakeTarballs();
    const app = scratch();
    bash(`${bashFunction(source, 'write_manifest')}\n${call ?? ''}\n`, {
      ROOT: root,
      CLONE: root,
      TARBALLS: tarballs,
      APP: app,
    });
    const manifest = readManifest(join(app, 'package.json'));
    expect(manifest.overrides?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.devDependencies?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.dependencies?.['@vetkit/fake']).toBe(`file:${tarball}`);
    expect(manifest.overrides?.['@vetkit/fake']).toBe(`file:${tarball}`);
  });
});

describe('examples-run.sh example manifest', () => {
  const source = script('examples-run.sh');

  function rewritten(example: string): Manifest {
    const dir = scratch();
    copyFileSync(join(ROOT, 'examples', example, 'package.json'), join(dir, 'package.json'));
    const packages = join(scratch(), 'packages.json');
    writeFileSync(
      packages,
      JSON.stringify({
        packages: { vetkit: '/t/vetkit.tgz', '@vetkit/scorers': '/t/scorers.tgz' },
      }),
    );
    bash(
      `${bashFunction(source, 'write_example_manifest')}\nwrite_example_manifest "$DIR" "$NAME"\n`,
      {
        ROOT: fakeRoot(),
        MANIFEST: packages,
        DIR: dir,
        NAME: example,
      },
    );
    return readManifest(join(dir, 'package.json'));
  }

  it('rewrites the direct vitest spec of the vitest example to the overridden root version', () => {
    const manifest = rewritten('vitest');
    expect(manifest.overrides?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.devDependencies?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.dependencies?.['@vetkit/scorers']).toBe('file:/t/scorers.tgz');
    expect(manifest.overrides?.['@vetkit/scorers']).toBe('file:/t/scorers.tgz');
  });

  it('overrides vitest for an example without a vitest dependency and adds no direct one', () => {
    const manifest = rewritten('jsonl');
    expect(manifest.overrides?.['vitest']).toBe(FAKE_VERSION);
    for (const field of DEP_FIELDS) expect(manifest[field]?.['vitest']).toBeUndefined();
    expect(manifest.dependencies?.['vetkit']).toBe('file:/t/vetkit.tgz');
  });
});

// Runs the real script with an `npm` that does nothing and exits with the given code, and a
// private TMPDIR; returns the exit status and whatever the script left behind in TMPDIR.
function runWithNpm(exitCode: number): { status: number | null; left: string[] } {
  const [tarballs] = fakeTarballs();
  const shim = scratch();
  writeFileSync(join(shim, 'npm'), `#!/bin/sh\nexit ${String(exitCode)}\n`);
  chmodSync(join(shim, 'npm'), 0o755);
  const temp = scratch();
  const result = spawnSync('bash', [join(ROOT, 'scripts', 'examples-run.sh'), tarballs], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${shim}:${process.env['PATH'] ?? ''}`, TMPDIR: temp },
  });
  return { status: result.status, left: readdirSync(temp) };
}

describe('examples-run.sh scratch cleanup', () => {
  it('leaves nothing in the temp dir when an example fails', () => {
    const { status, left } = runWithNpm(1);
    expect(status).toBe(1);
    expect(left).toEqual([]);
  });

  it('leaves nothing in the temp dir when every example passes', () => {
    const { status, left } = runWithNpm(0);
    expect(status).toBe(0);
    expect(left).toEqual([]);
  });
});

describe.each(['examples-run.sh', 'consumer-matrix.sh'])('%s EXIT trap', (name) => {
  it('removes every directory the script makes with mktemp -d', () => {
    const source = script(name);
    const made = [...source.matchAll(/^\s*(?:local )?(\w+)="\$\(mktemp -d[^)]*\)"$/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(made.length).toBeGreaterThan(0);
    const trap = exitTrap(source);
    expect(trap).toContain('rm -rf');
    for (const variable of made) expect(trap).toContain(`"$${variable}"`);
  });
});

describe('consumer-matrix.sh consumer manifest', () => {
  it('overrides vitest with the root package.json version for npm and adds no direct one', () => {
    const packages = join(scratch(), 'packages.json');
    writeFileSync(
      packages,
      JSON.stringify({ packages: { '@vetkit/fake': '/t/fake.tgz' }, specifiers: [], version: '0' }),
    );
    const out = scratch();
    bash(
      `${bashFunction(script('consumer-matrix.sh'), 'write_consumer_manifest')}\nwrite_consumer_manifest npm "$OUT"\n`,
      { ROOT: fakeRoot(), MANIFEST: packages, OUT: out },
    );
    const manifest = readManifest(join(out, 'package.json'));
    expect(manifest.overrides?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.overrides?.['@vetkit/fake']).toBe('file:/t/fake.tgz');
    expect(manifest.dependencies?.['@vetkit/fake']).toBe('file:/t/fake.tgz');
    for (const field of DEP_FIELDS) expect(manifest[field]?.['vitest']).toBeUndefined();
  });
});

describe('readme-snippets scratch manifest', () => {
  it('repoVitestVersion reads devDependencies.vitest of the given root package.json', () => {
    expect(repoVitestVersion(fakeRoot())).toBe(FAKE_VERSION);
  });

  it('repoVitestVersion defaults to this repo, whose vitest is an exact version', () => {
    const root = readManifest(join(ROOT, 'package.json'));
    expect(repoVitestVersion()).toBe(root.devDependencies?.['vitest']);
    expect(repoVitestVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('installs the given vitest version directly and through overrides next to the tarballs', () => {
    const manifest: Manifest = scratchManifest({}, { '@vetkit/fake': '/t/fake.tgz' }, FAKE_VERSION);
    expect(manifest.dependencies?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.dependencies?.['@vetkit/fake']).toBe('file:/t/fake.tgz');
    expect(manifest.dependencies?.['promptfoo']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.overrides).toEqual({
      '@vetkit/fake': 'file:/t/fake.tgz',
      vitest: FAKE_VERSION,
    });
  });

  it('rewrites every direct vitest spec of an example to the overridden version', () => {
    const example = readManifest(join(ROOT, 'examples', 'vitest', 'package.json'));
    const manifest: Manifest = scratchManifest(
      example,
      { '@vetkit/scorers': '/t/scorers.tgz' },
      FAKE_VERSION,
    );
    expect(manifest.overrides?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.dependencies?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.devDependencies?.['vitest']).toBe(FAKE_VERSION);
    expect(manifest.devDependencies?.['typescript']).toBe(example.devDependencies?.['typescript']);
    expect(manifest.dependencies?.['@vetkit/scorers']).toBe('file:/t/scorers.tgz');
  });
});

describe('examples/vitest/package.json', () => {
  it('declares vitest with the caret range the packages declare as their optional peer', () => {
    const example = readManifest(join(ROOT, 'examples', 'vitest', 'package.json'));
    const scorers = readManifest(join(ROOT, 'packages', 'scorers', 'package.json'));
    expect(example.devDependencies?.['vitest']).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(example.devDependencies?.['vitest']).toBe(scorers.peerDependencies?.['vitest']);
  });
});
