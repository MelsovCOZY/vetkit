import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkVersionSync, findForbiddenStrings } from "./pack.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

const packageNames = existsSync(PACKAGES_DIR)
  ? readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];

describe("packages/*/tsdown.config.ts", () => {
  it.each(packageNames)("%s exports the shared build shape", async (name) => {
    const configPath = join(PACKAGES_DIR, name, "tsdown.config.ts");
    const mod = await import(pathToFileURL(configPath).href);
    const config = mod.default;

    expect(config.entry).toContain("src/index.ts");
    expect(config.format).toEqual(["esm"]);
    expect(config.platform).toBe("node");
    expect(config.unbundle).toBe(true);
    expect(config.dts).toBe(true);
    expect(config.publint).toBe(true);
  });
});

describe("checkVersionSync", () => {
  const lockText = `{
    "workspaces": {
      "packages/foo": {
        "name": "@vetkit/foo",
        "version": "1.2.3",
        "dependencies": {}
      }
    }
  }`;

  it("returns undefined when the manifest version matches bun.lock", () => {
    const mismatch = checkVersionSync({ name: "@vetkit/foo", version: "1.2.3" }, lockText);
    expect(mismatch).toBeUndefined();
  });

  it("returns the mismatch when a temp copy of the manifest has a patched version", () => {
    const dir = mkdtempSync(join(tmpdir(), "vetkit-manifest-"));
    const manifestPath = join(dir, "package.json");
    writeFileSync(manifestPath, JSON.stringify({ name: "@vetkit/foo", version: "9.9.9" }));

    const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    const mismatch = checkVersionSync(pkg, lockText);

    rmSync(dir, { recursive: true, force: true });

    expect(mismatch).toEqual({
      packageName: "@vetkit/foo",
      manifestVersion: "9.9.9",
      lockVersion: "1.2.3",
    });
  });
});

describe("findForbiddenStrings", () => {
  it("rejects a planted workspace: string in a packed-and-extracted tarball", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "vetkit-fixture-"));
    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "vetkit-pack-fixture", version: "0.0.0", files: ["dist"] }),
    );
    mkdirSync(join(fixtureDir, "dist"));
    writeFileSync(join(fixtureDir, "dist", "index.js"), 'export const dep = "workspace:^";\n');

    const tarballDir = mkdtempSync(join(tmpdir(), "vetkit-tarballs-"));
    const packOut = spawnSync("bun", ["pm", "pack", "--quiet", "--destination", tarballDir], {
      cwd: fixtureDir,
      encoding: "utf8",
    });
    const tgzPath = packOut.stdout.trim();

    const extractDir = mkdtempSync(join(tmpdir(), "vetkit-extract-"));
    spawnSync("tar", ["-xzf", tgzPath, "-C", extractDir]);

    const matches = findForbiddenStrings(join(extractDir, "package"));

    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(tarballDir, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.join("\n")).toMatch(/workspace:/);
  });

  it("finds nothing in a clean extracted package", () => {
    const dir = mkdtempSync(join(tmpdir(), "vetkit-clean-"));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.js"), "export const ok = 1;\n");

    const matches = findForbiddenStrings(dir);
    rmSync(dir, { recursive: true, force: true });

    expect(matches).toEqual([]);
  });
});
