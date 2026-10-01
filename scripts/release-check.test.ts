import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  findNodeBinaries,
  inspectTarball,
  parseNpmQuery,
  relativeReadmeTargets,
} from './release-check.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const packageNames = existsSync(PACKAGES_DIR)
  ? readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .toSorted()
  : [];

const GOOD_MANIFEST = {
  name: 'release-check-fixture',
  version: '1.2.3',
  license: 'Apache-2.0',
  repository: { type: 'git', url: 'git+https://github.com/MelsovCOZY/vetkit.git' },
  files: ['dist'],
};

interface FixtureOptions {
  manifest?: Record<string, unknown>;
  omit?: string[];
  extraFiles?: Record<string, string>;
}

/** Packs a fixture package with `bun pm pack` (as pack.test.ts does) and returns the tgz path. */
function packFixture(options: FixtureOptions = {}): { tgz: string; cleanup: () => void } {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'vetkit-rc-fixture-'));
  const tarballDir = mkdtempSync(join(tmpdir(), 'vetkit-rc-tarballs-'));
  writeFileSync(
    join(fixtureDir, 'package.json'),
    JSON.stringify({ ...GOOD_MANIFEST, ...options.manifest }),
  );
  const files: Record<string, string> = {
    LICENSE: 'Apache License\n',
    'README.md': '# fixture\n',
    'dist/index.js': 'export const ok = 1;\n',
    ...options.extraFiles,
  };
  for (const name of options.omit ?? []) delete files[name];
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixtureDir, name)), { recursive: true });
    writeFileSync(join(fixtureDir, name), text);
  }
  const out = spawnSync('bun', ['pm', 'pack', '--quiet', '--destination', tarballDir], {
    cwd: fixtureDir,
    encoding: 'utf8',
  });
  return {
    tgz: out.stdout.trim(),
    cleanup: () => {
      rmSync(fixtureDir, { recursive: true, force: true });
      rmSync(tarballDir, { recursive: true, force: true });
    },
  };
}

function inspect(options: FixtureOptions): string[] {
  const { tgz, cleanup } = packFixture(options);
  try {
    return inspectTarball(tgz);
  } finally {
    cleanup();
  }
}

describe('inspectTarball', () => {
  it('flags a tarball with a .map file', () => {
    const findings = inspect({ extraFiles: { 'dist/index.js.map': '{}' } });
    expect(findings.join('\n')).toMatch(/\.map/);
  });

  it('flags a tarball without LICENSE', () => {
    const findings = inspect({ omit: ['LICENSE'] });
    expect(findings.join('\n')).toMatch(/package\/LICENSE/);
  });

  it('flags a tarball without README.md', () => {
    const findings = inspect({ omit: ['README.md'] });
    expect(findings.join('\n')).toMatch(/package\/README\.md/);
  });

  it('flags a packed manifest with a postinstall script', () => {
    const findings = inspect({ manifest: { scripts: { postinstall: 'node x.js' } } });
    expect(findings.join('\n')).toMatch(/postinstall/);
  });

  it('flags a wrong license or repository url', () => {
    const wrongLicense = inspect({ manifest: { license: 'MIT' } });
    expect(wrongLicense.join('\n')).toMatch(/license/);
    const wrongRepo = inspect({
      manifest: { repository: { type: 'git', url: 'git+https://github.com/other/repo.git' } },
    });
    expect(wrongRepo.join('\n')).toMatch(/repository/);
  });

  it('flags a packed README with a relative image or link target', () => {
    const readme = '# fixture\n\n![logo](assets/logo.png)\n\nSee [the guide](docs/ci-gate.md).\n';
    const findings = inspect({ extraFiles: { 'README.md': readme } });
    expect(findings.join('\n')).toMatch(/README\.md.*assets\/logo\.png/);
    expect(findings.join('\n')).toMatch(/README\.md.*docs\/ci-gate\.md/);
  });

  it('passes a packed README whose targets are absolute URLs', () => {
    const readme =
      '# fixture\n\n![logo](https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/logo.png)\n\nSee [the guide](https://github.com/MelsovCOZY/vetkit/blob/master/docs/ci-gate.md).\n';
    expect(inspect({ extraFiles: { 'README.md': readme } })).toEqual([]);
  });

  it('passes a clean tarball', () => {
    expect(inspect({})).toEqual([]);
  });
});

// npm renders a package README on its own: a relative image or link target is not rewritten to
// the repository, so it breaks on the package page.
describe('relativeReadmeTargets', () => {
  it('passes a README whose images and links are absolute URLs or in-page anchors', () => {
    const readme = [
      '<p align="center"><img src="https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/logo.png" alt="logo"></p>',
      '# fixture',
      'See [the docs](https://melsovcozy.github.io/vetkit/) and [usage](#usage).',
      '<a href="https://github.com/MelsovCOZY/vetkit">repo</a> and <mailto:x@example.com>',
      '```yaml',
      'value: file://vetkit.assert.ts',
      '[not a link](./inside-a-fence.md)',
      '```',
      'Inline code `](./also-not-a-link)` is ignored too.',
    ].join('\n');
    expect(relativeReadmeTargets(readme)).toEqual([]);
  });

  it('lists every relative image or link target, markdown and HTML', () => {
    const readme = [
      '![logo](assets/logo.png)',
      '[guide](docs/ci-gate.md "title")',
      '[here](./README.md) [up](../README.md)',
      '<img src="assets/logo.png" width="192">',
      '<a href="docs/sinks.md">sinks</a>',
    ].join('\n');
    expect(relativeReadmeTargets(readme)).toEqual([
      'assets/logo.png',
      'docs/ci-gate.md',
      './README.md',
      '../README.md',
      'assets/logo.png',
      'docs/sinks.md',
    ]);
  });
});

describe('manifests and READMEs as npm shows them', () => {
  const REPOSITORY_URL = 'git+https://github.com/MelsovCOZY/vetkit.git';
  const siblings = packageNames.filter((name) => name !== 'cli');

  // npm provenance compares the manifest URL with the signed source URL character for character.
  it.each(packageNames)('%s repository.url keeps the MelsovCOZY casing', (name) => {
    const manifest: { repository?: { url?: string } } = JSON.parse(
      readFileSync(join(PACKAGES_DIR, name, 'package.json'), 'utf8'),
    );
    expect(manifest.repository?.url).toBe(REPOSITORY_URL);
    expect(manifest.repository?.url).toContain('/MelsovCOZY/');
  });

  it.each(packageNames)('%s README has no relative image or link target', (name) => {
    const readme = readFileSync(join(PACKAGES_DIR, name, 'README.md'), 'utf8');
    expect(relativeReadmeTargets(readme)).toEqual([]);
  });

  it.each(siblings)('%s README has an install line and links to the repo and the site', (name) => {
    const readme = readFileSync(join(PACKAGES_DIR, name, 'README.md'), 'utf8');
    expect(readme).toMatch(/^npm i -D /m);
    expect(readme).toContain('https://github.com/MelsovCOZY/vetkit');
    expect(readme).toContain('https://melsovcozy.github.io/vetkit/');
    expect(readme).toMatch(/^```(sh|ts)\n/m);
  });
});

describe('parseNpmQuery', () => {
  it('parseNpmQuery returns the names of packages with install scripts', () => {
    const sample = JSON.stringify([
      {
        name: 'evil-dep',
        version: '1.0.0',
        scripts: { postinstall: 'node steal.js' },
        location: 'node_modules/evil-dep',
      },
      {
        name: '@scope/native',
        version: '2.0.0',
        scripts: { install: 'node-gyp rebuild' },
        location: 'node_modules/@scope/native',
      },
    ]);
    expect(parseNpmQuery(sample)).toEqual(['evil-dep', '@scope/native']);
    expect(parseNpmQuery('[]')).toEqual([]);
  });
});

describe('findNodeBinaries', () => {
  it('findNodeBinaries lists .node files under a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-rc-node-'));
    try {
      mkdirSync(join(dir, 'a', 'build'), { recursive: true });
      writeFileSync(join(dir, 'a', 'build', 'addon.node'), '');
      writeFileSync(join(dir, 'a', 'index.js'), '');
      writeFileSync(join(dir, 'top.node'), '');
      const found = findNodeBinaries(dir).toSorted();
      expect(found).toHaveLength(2);
      expect(found.some((p) => p.endsWith(join('a', 'build', 'addon.node')))).toBe(true);
      expect(found.some((p) => p.endsWith('top.node'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sourcemap-free build', () => {
  it.each(packageNames)('%s tsdown config disables sourcemaps', async (name) => {
    const configPath = join(PACKAGES_DIR, name, 'tsdown.config.ts');
    const mod = await import(pathToFileURL(configPath).href);
    expect(mod.default.sourcemap).toBe(false);
  });

  it('tsconfig.base.json disables declarationMap', () => {
    const text = readFileSync(join(ROOT, 'tsconfig.base.json'), 'utf8');
    expect(text).toMatch(/"declarationMap":\s*false/);
  });
});

describe('.github/workflows/ci.yml release check', () => {
  it('ci.yml runs the release check after Pack', () => {
    const doc: { jobs: Record<string, { steps: { name?: string; run?: string }[] }> } = parse(
      readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
    );
    const steps = doc.jobs['check-build-pack']?.steps ?? [];
    const packIdx = steps.findIndex((s) => s.run === 'bun run pack');
    const checkIdx = steps.findIndex((s) => s.run === 'bun scripts/release-check.ts dist-tarballs');
    expect(packIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBe(packIdx + 1);
    expect(steps[checkIdx]?.name).toBe('Release check');
  });
});
