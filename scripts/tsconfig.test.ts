import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// NOTE: this is a script, not packages/*/src — the repo-wide "raw JSON.parse is banned,
// use safeParseJson" rule applies only to packages/*/src (see docs/contracts/j0.md).
// tsconfig.base.json documents the isolatedDeclarations requirement with a JSONC comment,
// so reads here strip comments by hand before JSON.parse.
function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        result += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += c;
      if (c === "\\") {
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
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    result += c;
  }
  return result;
}

function readJsonc(filePath: string): Record<string, unknown> {
  return JSON.parse(stripJsonComments(readFileSync(filePath, "utf8")));
}

const rootDir = path.resolve(import.meta.dirname, "..");
const tscBin = path.join(rootDir, "node_modules/.bin/tsc");

const base = readJsonc(path.join(rootDir, "tsconfig.base.json"));
const baseOptions = base.compilerOptions as Record<string, unknown>;

describe("tsconfig.base.json compiler flags", () => {
  test.each([
    ["module", "node20"],
    ["target", "es2023"],
    ["strict", true],
    ["verbatimModuleSyntax", true],
    ["isolatedModules", true],
    ["erasableSyntaxOnly", true],
    ["isolatedDeclarations", true],
    ["rewriteRelativeImportExtensions", true],
    ["noUncheckedIndexedAccess", true],
    ["exactOptionalPropertyTypes", true],
    ["declaration", true],
    ["declarationMap", true],
  ])("sets %s to %j", (flag, expected) => {
    expect(baseOptions[flag]).toBe(expected);
  });

  test("sets types to exactly [node]", () => {
    expect(baseOptions.types).toEqual(["node"]);
  });

  test("sets customConditions to exactly [@vetkit/source]", () => {
    expect(baseOptions.customConditions).toEqual(["@vetkit/source"]);
  });
});

const packagesDir = path.join(rootDir, "packages");
const packageFolders = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const packageInfo = packageFolders.map((folder) => {
  const pkgJson = JSON.parse(
    readFileSync(path.join(packagesDir, folder, "package.json"), "utf8"),
  ) as { name: string; dependencies?: Record<string, string> };
  return { folder, name: pkgJson.name, dependencies: pkgJson.dependencies ?? {} };
});

function expectedReferencePaths(folder: string): string[] {
  const info = packageInfo.find((p) => p.folder === folder);
  if (!info) throw new Error(`no package.json found for packages/${folder}`);
  const vetkitDeps = Object.keys(info.dependencies).filter((key) =>
    key.startsWith("@vetkit/"),
  );
  return vetkitDeps
    .map((depName) => {
      const target = packageInfo.find((p) => p.name === depName);
      if (!target) {
        throw new Error(`no package provides "${depName}" (dependency of ${folder})`);
      }
      return `../${target.folder}`;
    })
    .sort();
}

describe("root tsconfig.json solution file", () => {
  const root = readJsonc(path.join(rootDir, "tsconfig.json"));

  test("has an empty files list", () => {
    expect(root.files).toEqual([]);
  });

  test("references every package under packages/*", () => {
    const actual = ((root.references ?? []) as Array<{ path: string }>)
      .map((r) => r.path)
      .sort();
    const expected = packageFolders.map((folder) => `./packages/${folder}`).sort();
    expect(actual).toEqual(expected);
  });
});

describe.each(packageFolders)("packages/%s/tsconfig.json", (folder) => {
  const tsconfig = readJsonc(path.join(packagesDir, folder, "tsconfig.json"));
  const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;

  test("extends the base config", () => {
    expect(tsconfig.extends).toBe("../../tsconfig.base.json");
  });

  test("sets rootDir to src and outDir to dist", () => {
    expect(compilerOptions.rootDir).toBe("src");
    expect(compilerOptions.outDir).toBe("dist");
  });

  test("includes only src", () => {
    expect(tsconfig.include).toEqual(["src"]);
  });

  test("references match this package's @vetkit/* dependencies", () => {
    const actual = ((tsconfig.references ?? []) as Array<{ path: string }>)
      .map((r) => r.path)
      .sort();
    expect(actual).toEqual(expectedReferencePaths(folder));
  });
});

describe("bun run typecheck on the empty packages", () => {
  test("tsc -p tsconfig.json --noEmit exits 0", () => {
    const result = spawnSync(
      tscBin,
      ["-p", path.join(rootDir, "tsconfig.json"), "--noEmit"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  });

  test("tsc -b --dry exits 0 across the whole reference graph", () => {
    const result = spawnSync(
      tscBin,
      ["-b", path.join(rootDir, "tsconfig.json"), "--dry"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  });
});

describe("tsconfig-bad fixtures", () => {
  test("erasableSyntaxOnly rejects an enum with TS1294", () => {
    const result = spawnSync(
      tscBin,
      [
        "--noEmit",
        "-p",
        path.join(rootDir, "scripts/fixtures/tsconfig-bad/erasable-syntax/tsconfig.json"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("TS1294");
  });

  test("a relative import without an extension fails with TS2835", () => {
    const result = spawnSync(
      tscBin,
      [
        "--noEmit",
        "-p",
        path.join(
          rootDir,
          "scripts/fixtures/tsconfig-bad/missing-import-extension/tsconfig.json",
        ),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("TS2835");
  });
});

describe("bun run typecheck catches a planted type error", () => {
  test("a type error in packages/spec/src fails the typecheck script with TS2322", () => {
    const plantedFile = path.join(packagesDir, "spec/src/__tmp_te.ts");
    writeFileSync(plantedFile, 'export const x: number = "s";\n');
    try {
      const result = spawnSync("bun", ["run", "typecheck"], {
        cwd: rootDir,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("TS2322");
    } finally {
      rmSync(plantedFile, { force: true });
    }
  });
});

describe("bun run typecheck on an unbuilt tree reports cross-package errors correctly", () => {
  const specIndexPath = path.join(packagesDir, "spec/src/index.ts");
  const specTypeFile = path.join(packagesDir, "spec/src/__tmp_cross_type.ts");
  const coreUseFile = path.join(packagesDir, "core/src/__tmp_cross_use.ts");

  // Removes any dist/ and *.tsbuildinfo left by a previous build so each test starts
  // from the "no packages/*/dist" precondition the acceptance criteria requires.
  function clearBuildArtifacts(): void {
    for (const folder of packageFolders) {
      rmSync(path.join(packagesDir, folder, "dist"), { recursive: true, force: true });
      rmSync(path.join(packagesDir, folder, "tsconfig.tsbuildinfo"), { force: true });
    }
  }

  // packages/spec/src/index.ts is currently a placeholder with no exports (real exports
  // land in mol-fou.8), so the temp type is reachable via "@vetkit/spec" only by
  // temporarily re-exporting it from that public entry, the same way a real consumer
  // would import a type — never via a package.json edit (out of scope for this bead).
  function plantCrossPackageFiles(value: string): string {
    clearBuildArtifacts();
    const originalIndex = readFileSync(specIndexPath, "utf8");
    writeFileSync(specTypeFile, "export type TmpCrossType = { value: number };\n");
    writeFileSync(specIndexPath, `${originalIndex}export * from "./__tmp_cross_type.ts";\n`);
    writeFileSync(
      coreUseFile,
      `import type { TmpCrossType } from "@vetkit/spec";\nexport const tmpCrossUse: TmpCrossType = ${value};\n`,
    );
    return originalIndex;
  }

  function cleanup(originalIndex: string): void {
    writeFileSync(specIndexPath, originalIndex);
    rmSync(specTypeFile, { force: true });
    rmSync(coreUseFile, { force: true });
    clearBuildArtifacts();
  }

  test("a type error in packages/core/src via an @vetkit/spec import is TS2322, not TS6305", () => {
    const originalIndex = plantCrossPackageFiles('{ value: "not a number" }');
    try {
      const result = spawnSync("bun", ["run", "typecheck"], {
        cwd: rootDir,
        encoding: "utf8",
      });
      const output = result.stdout + result.stderr;
      expect(result.status).not.toBe(0);
      expect(output).toContain("TS2322");
      expect(output).not.toContain("TS6305");
    } finally {
      cleanup(originalIndex);
    }
  });

  test("a correct cross-package import typechecks with exit 0", () => {
    const originalIndex = plantCrossPackageFiles("{ value: 1 }");
    try {
      const result = spawnSync("bun", ["run", "typecheck"], {
        cwd: rootDir,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    } finally {
      cleanup(originalIndex);
    }
  });
});

describe("bun run typecheck leaves no build output behind", () => {
  function clearBuildArtifacts(): void {
    for (const folder of packageFolders) {
      rmSync(path.join(packagesDir, folder, "dist"), { recursive: true, force: true });
      rmSync(path.join(packagesDir, folder, "tsconfig.tsbuildinfo"), { force: true });
    }
  }

  test("a clean typecheck run creates no packages/*/dist and writes no .js into any package src", () => {
    clearBuildArtifacts();
    try {
      const result = spawnSync("bun", ["run", "typecheck"], {
        cwd: rootDir,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      for (const folder of packageFolders) {
        expect(existsSync(path.join(packagesDir, folder, "dist"))).toBe(false);
        const srcEntries = readdirSync(path.join(packagesDir, folder, "src"));
        expect(srcEntries.some((entry) => entry.endsWith(".js"))).toBe(false);
      }
    } finally {
      clearBuildArtifacts();
    }
  });
});
