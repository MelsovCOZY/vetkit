import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
