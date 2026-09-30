import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// This is a script, not packages/*/src: the repo-wide "raw JSON.parse is banned,
// use safeParseJson" rule applies only to packages/*/src.
// tsconfig.base.json documents the isolatedDeclarations requirement with a JSONC comment,
// so reads here strip comments by hand before JSON.parse.
function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        result += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += c;
      if (c === '\\') {
        result += next;
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    result += c;
  }
  return result;
}

interface Jsonc {
  extends?: string;
  files?: unknown;
  include?: unknown;
  compilerOptions?: Record<string, unknown>;
  references?: Array<{ path: string }>;
}

function readJsonc(filePath: string): Jsonc {
  return JSON.parse(stripJsonComments(readFileSync(filePath, 'utf8')));
}

const rootDir = path.resolve(import.meta.dirname, '..');
const tscBin = path.join(rootDir, 'node_modules/.bin/tsc');

const base = readJsonc(path.join(rootDir, 'tsconfig.base.json'));
const baseOptions = base.compilerOptions ?? {};

describe('tsconfig.base.json compiler flags', () => {
  test.each([
    ['module', 'node20'],
    ['target', 'es2023'],
    ['strict', true],
    ['verbatimModuleSyntax', true],
    ['isolatedModules', true],
    ['erasableSyntaxOnly', true],
    ['isolatedDeclarations', true],
    ['rewriteRelativeImportExtensions', true],
    ['noUncheckedIndexedAccess', true],
    ['exactOptionalPropertyTypes', true],
    ['declaration', true],
    ['declarationMap', false],
  ])('sets %s to %j', (flag, expected) => {
    expect(baseOptions[flag]).toBe(expected);
  });

  test('sets types to exactly [node]', () => {
    expect(baseOptions.types).toEqual(['node']);
  });

  test('sets customConditions to exactly [@vetkit/source]', () => {
    expect(baseOptions.customConditions).toEqual(['@vetkit/source']);
  });
});

const packagesDir = path.join(rootDir, 'packages');
const packageFolders = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

const packageInfo = packageFolders.map((folder) => {
  const pkgJson: {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = JSON.parse(readFileSync(path.join(packagesDir, folder, 'package.json'), 'utf8'));
  return {
    folder,
    name: pkgJson.name,
    dependencies: pkgJson.dependencies ?? {},
    devDependencies: pkgJson.devDependencies ?? {},
  };
});

function expectedReferencePaths(folder: string): string[] {
  const info = packageInfo.find((p) => p.folder === folder);
  if (!info) throw new Error(`no package.json found for packages/${folder}`);
  const depNames = [...Object.keys(info.dependencies), ...Object.keys(info.devDependencies)];
  const workspaceDeps = depNames.filter((key) => packageInfo.some((p) => p.name === key));
  return workspaceDeps
    .map((depName) => {
      const target = packageInfo.find((p) => p.name === depName);
      if (!target) {
        throw new Error(`no package provides "${depName}" (dependency of ${folder})`);
      }
      return `../${target.folder}`;
    })
    .toSorted();
}

describe('root tsconfig.json solution file', () => {
  const root = readJsonc(path.join(rootDir, 'tsconfig.json'));

  test('has an empty files list', () => {
    expect(root.files).toEqual([]);
  });

  test('references every package under packages/*', () => {
    const actual = (root.references ?? []).map((r) => r.path).toSorted();
    const expected = packageFolders.map((folder) => `./packages/${folder}`).toSorted();
    expect(actual).toEqual(expected);
  });
});

describe.each(packageFolders)('packages/%s/tsconfig.json', (folder) => {
  const tsconfig = readJsonc(path.join(packagesDir, folder, 'tsconfig.json'));
  const compilerOptions = tsconfig.compilerOptions ?? {};

  test('extends the base config', () => {
    expect(tsconfig.extends).toBe('../../tsconfig.base.json');
  });

  test('sets rootDir to src and outDir to dist', () => {
    expect(compilerOptions.rootDir).toBe('src');
    expect(compilerOptions.outDir).toBe('dist');
  });

  test('includes only src', () => {
    expect([['src'], ['src/**/*.ts', 'src/**/*.json']]).toContainEqual(tsconfig.include);
  });

  test("references match this package's workspace dependencies", () => {
    const actual = (tsconfig.references ?? []).map((r) => r.path).toSorted();
    expect(actual).toEqual(expectedReferencePaths(folder));
  });
});

describe('bun run typecheck on the empty packages', () => {
  test('tsc -p tsconfig.json --noEmit exits 0', () => {
    const result = spawnSync(tscBin, ['-p', path.join(rootDir, 'tsconfig.json'), '--noEmit'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  }, 30_000);

  test('tsc -b --dry exits 0 across the whole reference graph', () => {
    const result = spawnSync(tscBin, ['-b', path.join(rootDir, 'tsconfig.json'), '--dry'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  }, 30_000);
});

describe('tsconfig-bad fixtures', () => {
  test('erasableSyntaxOnly rejects an enum with TS1294', () => {
    const result = spawnSync(
      tscBin,
      [
        '--noEmit',
        '-p',
        path.join(rootDir, 'scripts/fixtures/tsconfig-bad/erasable-syntax/tsconfig.json'),
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('TS1294');
  }, 30_000);

  test('a relative import without an extension fails with TS2835', () => {
    const result = spawnSync(
      tscBin,
      [
        '--noEmit',
        '-p',
        path.join(rootDir, 'scripts/fixtures/tsconfig-bad/missing-import-extension/tsconfig.json'),
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('TS2835');
  }, 30_000);
});

describe('bun run typecheck catches a planted type error', () => {
  test('a type error in packages/spec/src fails the typecheck script with TS2322', () => {
    const plantedFile = path.join(packagesDir, 'spec/src/__tmp_te.ts');
    writeFileSync(plantedFile, 'export const x: number = "s";\n');
    try {
      const result = spawnSync('bun', ['run', 'typecheck'], {
        cwd: rootDir,
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('TS2322');
    } finally {
      rmSync(plantedFile, { force: true });
    }
  }, 30_000);
});

const rootPackageJson: { scripts: Record<string, string> } = JSON.parse(
  readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
);
const typecheckScript: string = rootPackageJson.scripts.typecheck ?? '';

// The unbuilt-tree tests below need to delete packages/*/dist and plant files inside
// packages/*/src to exercise a from-scratch typecheck, but scripts/**/*.test.ts and
// packages/cli/src/program.test.ts run as concurrent vitest projects — the latter spawns
// packages/cli/dist/bin.js, so deleting or rewriting the real tree here would race it.
// Instead these tests copy just the files `tsc -b` needs (tsconfig.base.json, the root
// solution tsconfig, and each package's package.json/tsconfig.json/src) into a throwaway
// temp directory, with the repo's node_modules symlinked in for resolution, and run the
// same command the "typecheck" script runs (read from package.json, not hard-coded)
// there. The real packages/*/dist and packages/*/src are never touched.
function createIsolatedWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vetkit-typecheck-'));
  cpSync(path.join(rootDir, 'tsconfig.base.json'), path.join(dir, 'tsconfig.base.json'));
  cpSync(path.join(rootDir, 'tsconfig.json'), path.join(dir, 'tsconfig.json'));
  symlinkSync(path.join(rootDir, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  // The typecheck script also builds the scripts/ + spike/ project (scripts/tsconfig.json),
  // which needs its sources, the vitest.config.ts they import and the root package.json
  // (type: module) that makes them ES modules.
  cpSync(path.join(rootDir, 'package.json'), path.join(dir, 'package.json'));
  cpSync(path.join(rootDir, 'vitest.config.ts'), path.join(dir, 'vitest.config.ts'));
  cpSync(path.join(rootDir, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  cpSync(path.join(rootDir, 'spike'), path.join(dir, 'spike'), {
    recursive: true,
    filter: (source) => !source.startsWith(path.join(rootDir, 'spike', 'data')),
  });
  const tempPackagesDir = path.join(dir, 'packages');
  mkdirSync(tempPackagesDir);
  for (const folder of packageFolders) {
    const srcPkgDir = path.join(packagesDir, folder);
    const destPkgDir = path.join(tempPackagesDir, folder);
    mkdirSync(destPkgDir);
    cpSync(path.join(srcPkgDir, 'package.json'), path.join(destPkgDir, 'package.json'));
    cpSync(path.join(srcPkgDir, 'tsconfig.json'), path.join(destPkgDir, 'tsconfig.json'));
    cpSync(path.join(srcPkgDir, 'src'), path.join(destPkgDir, 'src'), { recursive: true });
    const pkgNodeModules = path.join(srcPkgDir, 'node_modules');
    if (existsSync(pkgNodeModules)) {
      symlinkSync(pkgNodeModules, path.join(destPkgDir, 'node_modules'), 'dir');
    }
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runTypecheckIn(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const [command = '', ...args] = typecheckScript.split(' ');
  const resolvedCommand = command === 'tsc' ? tscBin : command;
  return spawnSync(resolvedCommand, args, { cwd, encoding: 'utf8' });
}

// The temp type is reachable via "@vetkit/spec" only by temporarily re-exporting it
// from that public entry, the same way a real consumer would import a type; never
// via a package.json edit.
// This plants into the isolated temp copy of the workspace, never the real
// packages/spec/src or packages/core/src.
function plantCrossPackageFiles(dir: string, value: string): void {
  const specIndexPath = path.join(dir, 'packages/spec/src/index.ts');
  const originalIndex = readFileSync(specIndexPath, 'utf8');
  writeFileSync(
    path.join(dir, 'packages/spec/src/__tmp_cross_type.ts'),
    'export type TmpCrossType = { value: number };\n',
  );
  writeFileSync(specIndexPath, `${originalIndex}export * from "./__tmp_cross_type.ts";\n`);
  writeFileSync(
    path.join(dir, 'packages/core/src/__tmp_cross_use.ts'),
    `import type { TmpCrossType } from "@vetkit/spec";\nexport const tmpCrossUse: TmpCrossType = ${value};\n`,
  );
}

describe('bun run typecheck on an unbuilt tree reports cross-package errors correctly', () => {
  test('a type error in packages/core/src via an @vetkit/spec import is TS2322, not TS6305', () => {
    const { dir, cleanup } = createIsolatedWorkspace();
    try {
      plantCrossPackageFiles(dir, '{ value: "not a number" }');
      const result = runTypecheckIn(dir);
      const output = result.stdout + result.stderr;
      expect(result.status).not.toBe(0);
      expect(output).toContain('TS2322');
      expect(output).not.toContain('TS6305');
    } finally {
      cleanup();
    }
  }, 30_000);

  test('a correct cross-package import typechecks with exit 0', () => {
    const { dir, cleanup } = createIsolatedWorkspace();
    try {
      plantCrossPackageFiles(dir, '{ value: 1 }');
      const result = runTypecheckIn(dir);
      expect(result.status).toBe(0);
    } finally {
      cleanup();
    }
  }, 30_000);
});

describe('bun run typecheck leaves no build output behind', () => {
  test('a clean typecheck run creates no packages/*/dist and writes no .js into any package src', () => {
    const { dir, cleanup } = createIsolatedWorkspace();
    try {
      const result = runTypecheckIn(dir);
      expect(result.status).toBe(0);
      for (const folder of packageFolders) {
        const pkgDir = path.join(dir, 'packages', folder);
        expect(existsSync(path.join(pkgDir, 'dist'))).toBe(false);
        const srcEntries = readdirSync(path.join(pkgDir, 'src'));
        expect(srcEntries.some((entry) => entry.endsWith('.js'))).toBe(false);
      }
    } finally {
      cleanup();
    }
  }, 30_000);
});
