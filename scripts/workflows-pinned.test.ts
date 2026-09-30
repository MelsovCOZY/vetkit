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
interface WorkflowDoc {
  permissions?: Record<string, string> | string;
  concurrency?: { group?: string; 'cancel-in-progress'?: string };
}

interface ScorecardJob {
  if?: string;
  permissions?: Record<string, string>;
  steps?: { uses?: string; with?: Record<string, unknown> }[];
}

interface ScorecardDoc {
  on: {
    schedule?: { cron: string }[];
    push?: { branches?: string[] };
    branch_protection_rule?: unknown;
  };
  permissions?: unknown;
  jobs: Record<string, ScorecardJob>;
}

const readWorkflow = (file: string): WorkflowDoc & { on?: unknown } =>
  parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'));
const readScorecard = (): ScorecardDoc =>
  parse(readFileSync(join(WORKFLOWS_DIR, 'scorecard.yml'), 'utf8'));

const triggersOf = (doc: { on?: unknown }): string[] => {
  const on = doc.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return on && typeof on === 'object' ? Object.keys(on) : [];
};

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
    const doc: WorkflowDoc = parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'));
    expect(doc.permissions).toBeDefined();
    expect(typeof doc.permissions === 'object' ? doc.permissions['contents'] : undefined).toBe(
      'read',
    );
  });

  it('scorecard.yml runs weekly, on push to master and on branch protection changes', () => {
    const doc = readScorecard();
    const on = doc.on;
    expect(on.schedule?.[0]?.cron).toMatch(/^\S+ \S+ \S+ \S+ [0-6*]$/);
    expect(on.push?.branches).toEqual(['master']);
    expect(on).toHaveProperty('branch_protection_rule');
    expect(doc.permissions).toEqual({ contents: 'read' });
  });

  it('scorecard.yml publishes results and uploads SARIF', () => {
    const doc = readScorecard();
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []);
    const uses = (prefix: string) => steps.find((st) => st.uses?.startsWith(prefix));
    expect(uses('actions/checkout@')?.with?.['persist-credentials']).toBe(false);
    expect(uses('ossf/scorecard-action@')?.with).toMatchObject({
      results_file: 'results.sarif',
      results_format: 'sarif',
      publish_results: true,
    });
    expect(uses('github/codeql-action/upload-sarif@')?.with?.['sarif_file']).toBe('results.sarif');
    const text = readFileSync(join(WORKFLOWS_DIR, 'scorecard.yml'), 'utf8');
    expect(text).toMatch(/ossf\/scorecard-action@[0-9a-f]{40} # v2\.4\.4/);
    expect(text).toMatch(/only (runs )?(once|when|after)[\s\S]{0,60}public/i);
    expect(text).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
  });

  it('scorecard.yml job is skipped while the repository is private', () => {
    const doc = readScorecard();
    const jobs = Object.values(doc.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.if).toBe('github.event.repository.private == false');
    expect(jobs[0]?.permissions).toEqual({ 'security-events': 'write', 'id-token': 'write' });
  });

  it('no workflow uses pull_request_target', () => {
    for (const file of workflowFiles) {
      expect(triggersOf(readWorkflow(file)), file).not.toContain('pull_request_target');
    }
  });

  it('pkg-pr-new is pinned to an exact version', () => {
    const text = readFileSync(join(WORKFLOWS_DIR, 'pkg-pr-new.yml'), 'utf8');
    expect(text).toMatch(/pkg-pr-new@\d+\.\d+\.\d+ publish/);
  });

  it('ci.yml cancels superseded pull_request runs only', () => {
    const doc: WorkflowDoc = parse(readFileSync(join(WORKFLOWS_DIR, 'ci.yml'), 'utf8'));
    expect(doc.concurrency?.group).toBe('${{ github.workflow }}-${{ github.ref }}');
    expect(doc.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });
});

// Audit rules (see the Nx s1ngularity chain: pull_request_target + title injection + write token).
// Only `github.event.` and `inputs.` expressions are treated as attacker-controlled; github.ref_name,
// github.event_name and steps.*.outputs.* from our own scripts are trusted. env: values are allowed.
const INJECTION = /\$\{\{\s*(github\.event\.|inputs\.)/;

function auditRunScript(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) => (INJECTION.test(line) ? [`line ${i + 1}: ${line.trim()}`] : []));
}

interface AuditStep {
  run?: string;
}
interface AuditDoc {
  on?: unknown;
  permissions?: string | Record<string, unknown> | null;
  jobs?: Record<
    string,
    { permissions?: string | Record<string, unknown> | null; steps?: AuditStep[] }
  >;
  runs?: { steps?: AuditStep[] };
}

const parseAudit = (file: string): { doc: AuditDoc; text: string } => {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return { doc: parse(text), text };
};

// file:job -> the exact set of write permission keys that job may hold.
// A listed job that does not exist yet (release.yml:action-tag) is not an error.
const WRITE_ALLOWLIST: Record<string, string[]> = {
  'release.yml:version': ['contents', 'pull-requests'],
  'release.yml:publish': ['id-token'],
  'release.yml:action-tag': ['contents'],
  'action-selftest.yml:selftest': ['pull-requests'],
  'scorecard.yml:analysis': ['security-events', 'id-token'],
  'pages.yml:deploy': ['pages', 'id-token'],
};

describe('workflow security audit', () => {
  it.each(workflowFiles)('%s never triggers on pull_request_target', (file) => {
    const { doc } = parseAudit(join('.github/workflows', file));
    expect(triggersOf(doc), file).not.toContain('pull_request_target');
  });

  it.each(allFiles)(
    '%s never interpolates github.event.* or inputs.* inside a run: script',
    (file) => {
      const { doc, text } = parseAudit(file);
      const steps = [
        ...Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []),
        ...(doc.runs?.steps ?? []),
      ];
      for (const step of steps) {
        if (!step.run) continue;
        const first = step.run.split('\n')[0]?.trim() ?? '';
        const startLine = text.split('\n').findIndex((l) => l.includes(first)) + 1;
        expect(auditRunScript(step.run), `${file} (run block at line ${startLine})`).toEqual([]);
      }
    },
  );

  it.each(workflowFiles)('%s declares only contents: read at the top level', (file) => {
    const { doc } = parseAudit(join('.github/workflows', file));
    const perms = doc.permissions;
    if (typeof perms !== 'object' || perms === null) {
      expect.fail(`${file} top-level permissions must be a map, got ${String(perms)}`);
    }
    expect(
      Object.entries(perms).filter(([k, v]) => !(k === 'contents' && v === 'read')),
      file,
    ).toEqual([]);
  });

  it('job-level write permissions are limited to the allowlist', () => {
    for (const file of workflowFiles) {
      const { doc } = parseAudit(join('.github/workflows', file));
      for (const [job, def] of Object.entries(doc.jobs ?? {})) {
        const id = `${file}:${job}`;
        const perms = def.permissions;
        if (perms === undefined || perms === null) continue;
        if (typeof perms === 'string') {
          expect(perms, `${id} string permissions`).toBe('read-all');
          continue;
        }
        const writes = Object.entries(perms)
          .filter(([, v]) => v === 'write')
          .map(([k]) => k)
          .toSorted();
        expect(writes, `${id} write permissions`).toEqual((WRITE_ALLOWLIST[id] ?? []).toSorted());
      }
    }
  });

  it('the audit catches an injected title', () => {
    const found = auditRunScript('run: echo ${{ github.event.pull_request.title }}');
    expect(found).toHaveLength(1);
    expect(auditRunScript('run: echo "$TITLE" ${{ github.ref_name }}')).toEqual([]);
  });
});
