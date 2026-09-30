import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');
const LEFTHOOK_PATH = join(ROOT, 'lefthook.yml');

const NODE_MATRIX = [22, 24, 26];

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  'runs-on'?: string;
  needs?: string;
  strategy?: { matrix?: { node?: number[] } };
  steps: WorkflowStep[];
}

interface WorkflowDoc {
  on: { pull_request?: null; push?: { branches?: string[] } };
  jobs: Record<string, WorkflowJob>;
}

interface LefthookCommand {
  glob?: string;
  run: string;
}

interface LefthookDoc {
  'pre-commit'?: {
    parallel?: boolean;
    commands?: Record<string, LefthookCommand>;
  };
  'commit-msg'?: unknown;
}

interface PackageJson {
  scripts?: Record<string, string>;
}

function readWorkflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

function readWorkflowDoc(): WorkflowDoc {
  const doc: WorkflowDoc = parse(readWorkflowText());
  return doc;
}

function readLefthookDoc(): LefthookDoc {
  const doc: LefthookDoc = parse(readFileSync(LEFTHOOK_PATH, 'utf8'));
  return doc;
}

function runStepsOf(job: WorkflowJob): string[] {
  return job.steps.filter((step) => typeof step.run === 'string').map((step) => step.run ?? '');
}

describe('.github/workflows/ci.yml', () => {
  it('triggers on pull_request and on push to master', () => {
    const doc = readWorkflowDoc();
    expect(doc.on).toHaveProperty('pull_request');
    expect(doc.on.push?.branches).toEqual(['master']);
  });

  it('check-build-pack runs on the pinned ubuntu-24.04 image with a Node 22/24/26 matrix', () => {
    const job = readWorkflowDoc().jobs['check-build-pack'];
    expect(job?.['runs-on']).toBe('ubuntu-24.04');
    expect(job?.strategy?.matrix?.node).toEqual(NODE_MATRIX);
  });

  it('check-build-pack pins Bun via oven-sh/setup-bun and sets up Node from the matrix', () => {
    const steps = readWorkflowDoc().jobs['check-build-pack']?.steps ?? [];
    const bunStep = steps.find((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
    expect(bunStep?.with?.['bun-version']).toBe('1.4.2');

    const nodeStep = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(nodeStep?.with?.['node-version']).toBe('${{ matrix.node }}');
  });

  it('check-build-pack runs install, codegen-diff, check, build, pack in that order', () => {
    const job = readWorkflowDoc().jobs['check-build-pack'];
    expect(job && runStepsOf(job)).toEqual([
      'bun install --frozen-lockfile',
      'bun run codegen && git diff --exit-code',
      'bun run check',
      'bun run build',
      'bun run pack',
      'bun scripts/release-check.ts dist-tarballs',
    ]);
  });

  it('check-build-pack uploads dist-tarballs as an artifact', () => {
    const steps = readWorkflowDoc().jobs['check-build-pack']?.steps ?? [];
    const uploadStep = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(uploadStep?.with?.path).toBe('dist-tarballs');
  });

  it('consumer-matrix needs check-build-pack and runs on a Node 22/24/26 matrix', () => {
    const job = readWorkflowDoc().jobs['consumer-matrix'];
    expect(job?.needs).toBe('check-build-pack');
    expect(job?.strategy?.matrix?.node).toEqual(NODE_MATRIX);
  });

  it('consumer-matrix downloads dist-tarballs and runs scripts/consumer-matrix.sh', () => {
    const job = readWorkflowDoc().jobs['consumer-matrix'];
    const steps = job?.steps ?? [];
    const downloadStep = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(downloadStep?.with?.path).toBe('dist-tarballs');

    expect(job && runStepsOf(job)).toContainEqual(
      expect.stringContaining('scripts/consumer-matrix.sh dist-tarballs'),
    );
  });

  it('never runs `bun test` and never installs @types/bun', () => {
    const text = readWorkflowText();
    expect(text).not.toMatch(/\bbun test\b/);
    expect(text).not.toContain('@types/bun');
  });

  it('uses setup-bun (not a manual Bun install)', () => {
    expect(readWorkflowText()).toContain('setup-bun');
  });
});

describe('lefthook.yml', () => {
  it('runs oxlint and oxfmt --check on staged files in pre-commit, in parallel', () => {
    const doc = readLefthookDoc();
    expect(doc['pre-commit']?.parallel).toBe(true);

    const commands = doc['pre-commit']?.commands;
    expect(commands?.oxlint?.run).toContain('oxlint');
    expect(commands?.oxlint?.run).toContain('{staged_files}');
    expect(commands?.oxfmt?.run).toContain('oxfmt --check');
    expect(commands?.oxfmt?.run).toContain('{staged_files}');
  });

  it('has no commit-msg hook', () => {
    expect(readLefthookDoc()['commit-msg']).toBeUndefined();
  });
});

describe('package.json hooks:install script', () => {
  it('runs the lefthook install script', () => {
    const pkg: PackageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts?.['hooks:install']).toBe('bun scripts/install-hooks.ts');
  });
});

const WORKFLOWS_DIR = join(ROOT, '.github/workflows');
const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));

// Latest major of each action (all run on node24; v4 of these targets the deprecated node20).
const MIN_NODE24_MAJOR: Record<string, number> = {
  'actions/checkout': 7,
  'actions/setup-node': 7,
  'actions/upload-artifact': 7,
  'actions/download-artifact': 8,
  'actions/cache': 6,
  // Docker action: no Node runtime, so its first major is the floor.
  'actions/jekyll-build-pages': 1,
  // Composite: v5 is the first to wrap upload-artifact v7 (node24); v4 wraps v4 (node20).
  'actions/upload-pages-artifact': 5,
  'actions/configure-pages': 6,
  'actions/deploy-pages': 5,
};

// Syntax dash (the /bin/sh of Ubuntu runners) rejects or mis-handles.
const BASH_ONLY: [string, RegExp][] = [
  ['set -o pipefail / set -eo pipefail', /\bset\s+-[a-z]*o\s+pipefail|\bpipefail\b/],
  ['shopt', /\bshopt\b/],
  ['[[ ]]', /\[\[/],
  ['array assignment', /\w=\(/],
  ['${#arr[@]} / ${arr[@]}', /\$\{#?\w+\[[@*]\]\}/],
  ['process substitution', /<\(/],
  ["$'..' quoting", /\$'/],
];

function scriptsRunViaSh(): string[] {
  const pkg: PackageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const texts = [
    ...Object.values(pkg.scripts ?? {}),
    ...workflowFiles.flatMap((f) => {
      const doc: WorkflowDoc = parse(readFileSync(join(WORKFLOWS_DIR, f), 'utf8'));
      return Object.values(doc.jobs).flatMap((job) => runStepsOf(job));
    }),
  ];
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/(?:^|[\s;&|])sh\s+(scripts\/[\w./-]+\.sh)/g)) {
      found.add(m[1] ?? '');
    }
  }
  return [...found];
}

describe('scripts invoked via sh are POSIX', () => {
  it('finds at least the ban-raw-json-parse script run via sh', () => {
    expect(scriptsRunViaSh()).toContain('scripts/ban-raw-json-parse.sh');
  });

  it.each(scriptsRunViaSh())('%s uses no bash-only syntax and has an sh shebang', (path) => {
    const text = readFileSync(join(ROOT, path), 'utf8');
    expect(text.split('\n')[0]).not.toMatch(/bash/);
    const code = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const [label, re] of BASH_ONLY) {
      expect(code, label).not.toMatch(re);
    }
  });
});

describe('every workflow', () => {
  it.each(workflowFiles)('%s pins ubuntu-24.04 and never uses ubuntu-latest', (file) => {
    const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
    expect(text).not.toMatch(/ubuntu-latest/);
    expect(text).toMatch(/runs-on:\s*ubuntu-24\.04/);
  });

  it.each([...workflowFiles.map((f) => join('.github/workflows', f)), 'action.yml'])(
    '%s uses the latest major of every actions/* action, cache/restore and cache/save included',
    (file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const uses = [
        ...text.matchAll(/uses:\s*(actions\/[\w-]+)(?:\/[\w-]+)?@[0-9a-f]{40}\s+#\s*v(\d+)\./g),
      ];
      for (const m of uses) {
        const min = MIN_NODE24_MAJOR[m[1] ?? ''];
        expect(min, `unknown action ${m[1]}`).toBeDefined();
        expect(Number(m[2]), `${m[1]}@v${m[2]}`).toBeGreaterThanOrEqual(min ?? 0);
      }
    },
  );
});

describe('.github/workflows/release.yml publish job', () => {
  interface ReleaseDoc {
    on: { push?: { branches?: string[] } };
    jobs: Record<string, WorkflowJob & { if?: string }>;
  }
  const doc: ReleaseDoc = parse(readFileSync(join(WORKFLOWS_DIR, 'release.yml'), 'utf8'));
  const publish = doc.jobs.publish;

  it('builds before it packs (publint needs dist/ to exist)', () => {
    const runs = publish ? runStepsOf(publish) : [];
    const buildIdx = runs.indexOf('bun run build');
    const packIdx = runs.indexOf('bun run pack');
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(packIdx).toBeGreaterThan(buildIdx);
  });

  it('is opt-in: publishing needs the RELEASE_PUBLISH repository variable set to true', () => {
    expect(publish?.if).toContain("vars.RELEASE_PUBLISH == 'true'");
    expect(publish?.if).toContain("github.ref == 'refs/heads/master'");
  });
});
