import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRIBUTING_PATH = join(ROOT, 'CONTRIBUTING.md');
const PACKAGE_JSON_PATH = join(ROOT, 'package.json');

const contributing = readFileSync(CONTRIBUTING_PATH, 'utf8');

interface RootPackageJson {
  scripts?: Record<string, string>;
}

function readPackageJson(path: string): RootPackageJson {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Returns the text between `## <heading>` and the next `## ` heading (or EOF).
function sectionBody(markdown: string, heading: string): string {
  const start = new RegExp(`^## ${heading}$`, 'm').exec(markdown);
  if (!start) throw new Error(`Missing heading: ## ${heading}`);
  const rest = markdown.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

const REQUIRED_HEADINGS = [
  'Setup',
  'Scripts',
  'Hooks',
  'Release chain',
  'Recovery runbook',
  'Never run',
  'Keeping an eval suite fresh',
];

describe('CONTRIBUTING.md', () => {
  it.each(REQUIRED_HEADINGS)('has a "%s" heading', (heading) => {
    expect(contributing).toContain(`## ${heading}`);
  });

  it('mentions the Bun and Node version floors', () => {
    expect(contributing).toContain('1.4');
    expect(contributing).toContain('>=22.12');
  });

  it('documents skipping lefthook hooks with LEFTHOOK=0', () => {
    const hooks = sectionBody(contributing, 'Hooks');
    expect(hooks).toContain('LEFTHOOK=0');
  });

  it("keeps 'bun publish' and 'changeset publish' confined to the 'Never run' section", () => {
    const neverRun = sectionBody(contributing, 'Never run');
    for (const forbidden of ['bun publish', 'changeset publish']) {
      const totalCount = contributing.split(forbidden).length - 1;
      const neverRunCount = neverRun.split(forbidden).length - 1;
      expect(neverRunCount).toBeGreaterThan(0);
      expect(totalCount).toBe(neverRunCount);
    }
  });

  it('has no drift between `bun run <script>` mentions and package.json scripts', () => {
    const pkg = readPackageJson(PACKAGE_JSON_PATH);
    const scriptNames = new Set(Object.keys(pkg.scripts ?? {}));
    const mentioned = [...contributing.matchAll(/bun run ([a-zA-Z0-9:_-]+)/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);

    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) {
      expect(scriptNames.has(name), `"bun run ${name}" is not a package.json script`).toBe(true);
    }
  });

  it('documents the eval-suite refresh cadence', () => {
    const body = sectionBody(contributing, 'Keeping an eval suite fresh');
    for (const needle of ['100', '2–4 weeks', '10–20', 'vet validate']) {
      expect(body).toContain(needle);
    }
  });

  it('documents recovery for a half-drained outbox, a stale lock, a corrupt cache and an interrupted watch', () => {
    const runbook = sectionBody(contributing, 'Recovery runbook');
    expect(runbook).toContain('.vet/outbox');
    expect(runbook).toContain('criteria.lock.json');
    expect(runbook).toContain('.vet/cache');
    expect(runbook).toContain('vet watch');
  });
});
