import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = join(ROOT, '.github/workflows');
const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));
const actionFiles = ['.github/workflows', '.'].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => /^action\.ya?ml$/.test(f))
    .map((f) => join(dir, f)),
);
const allFiles = [...workflowFiles.map((f) => join('.github/workflows', f)), ...actionFiles];

describe('workflow supply-chain hardening', () => {
  it.each(allFiles)(
    '%s pins every remote uses: to a 40-char SHA with a version comment',
    (file) => {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      for (const line of lines) {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!m || m[1]?.startsWith('./')) continue;
        expect(m[1], line).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(m[2], line).toMatch(/^\s+#\s*v\d+\.\d+\.\d+\s*$/);
      }
    },
  );

  it.each(workflowFiles)('%s declares a top-level permissions block', (file) => {
    const doc = parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as {
      permissions?: Record<string, string>;
    };
    expect(doc.permissions).toBeDefined();
    expect(doc.permissions?.['contents']).toBe('read');
  });

  it('pkg-pr-new is pinned to an exact version', () => {
    const text = readFileSync(join(WORKFLOWS_DIR, 'pkg-pr-new.yml'), 'utf8');
    expect(text).toMatch(/pkg-pr-new@\d+\.\d+\.\d+ publish/);
  });

  it('ci.yml cancels superseded pull_request runs only', () => {
    const doc = parse(readFileSync(join(WORKFLOWS_DIR, 'ci.yml'), 'utf8')) as {
      concurrency?: { group?: string; 'cancel-in-progress'?: string };
    };
    expect(doc.concurrency?.group).toBe('${{ github.workflow }}-${{ github.ref }}');
    expect(doc.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });
});
