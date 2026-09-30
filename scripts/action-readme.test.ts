import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(ROOT, 'action/README.md'), 'utf8');
const MARKETPLACE = readFileSync(join(ROOT, 'docs/listings/marketplace.md'), 'utf8');
const ACTION_TEXT = readFileSync(join(ROOT, 'action.yml'), 'utf8');

const USES = 'MelsovCOZY/vetkit@v0';
// The icons GitHub accepts for `branding.icon` that this action could reasonably use, and the
// nine colors GitHub accepts.
const ALLOWED_ICONS = ['check-circle', 'check-square', 'check', 'shield', 'activity', 'zap'];
const ALLOWED_COLORS = [
  'white',
  'black',
  'yellow',
  'blue',
  'green',
  'orange',
  'red',
  'purple',
  'gray-dark',
];

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Workflow {
  on?: unknown;
  permissions?: Record<string, string>;
  jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }>;
}

interface ActionDoc {
  inputs: Record<string, { default?: string }>;
  outputs: Record<string, unknown>;
  branding?: { icon?: string; color?: string };
}

function firstYamlBlock(markdown: string): string {
  const match = /```yaml\n([\s\S]*?)```/.exec(markdown);
  if (match?.[1] === undefined) throw new Error('no yaml block');
  return match[1];
}

const workflowText = firstYamlBlock(README);
const workflow: Workflow = parse(workflowText);
const action: ActionDoc = parse(ACTION_TEXT);
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const vetkitIndex = steps.findIndex((s) => s.uses === USES);
const vetkitStep = steps[vetkitIndex];

describe('action/README.md workflow', () => {
  it('the first fenced yaml block is a valid workflow that uses MelsovCOZY/vetkit@v0', () => {
    expect(vetkitStep).toBeDefined();
    expect(README).not.toContain('@v1');
  });

  it('the workflow passes the judge key through env, not with:', () => {
    const env = { ...vetkitStep?.env };
    expect(env['OPENROUTER_API_KEY']).toBe('${{ secrets.OPENROUTER_API_KEY }}');
    const secretish = Object.keys(vetkitStep?.with ?? {}).filter(
      (name) => /key|token|secret/i.test(name) && name !== 'github-token',
    );
    expect(secretish).toEqual([]);
  });

  it('the workflow grants pull-requests: write and contents: read only', () => {
    const job = Object.values(workflow.jobs)[0];
    const permissions = workflow.permissions ?? job?.permissions;
    expect(permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
  });

  it('the workflow triggers on pull_request, never pull_request_target', () => {
    expect(workflowText).toMatch(/^on:\s*pull_request\s*$/m);
    expect(workflowText).not.toContain('pull_request_target');
  });

  it('the workflow checks out and installs the project before the vetkit step', () => {
    const before = steps.slice(0, vetkitIndex);
    expect(before.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(true);
    expect(
      before.some((s) =>
        /npm ci|npm install|pnpm install|bun install|yarn install/.test(s.run ?? ''),
      ),
    ).toBe(true);
  });

  it('the workflow sets no version: (the project vet is the default)', () => {
    expect(vetkitStep?.with?.['version']).toBeUndefined();
    expect(workflowText).not.toMatch(/npx -y vet/);
  });

  it('the marketplace listing snippet is the same workflow', () => {
    expect(firstYamlBlock(MARKETPLACE).trim()).toBe(workflowText.trim());
  });
});

describe('action/README.md against action.yml', () => {
  const rows = README.split('\n').filter((line) => line.startsWith('|'));

  it('every action.yml input appears in the README inputs table with its default', () => {
    for (const [name, input] of Object.entries(action.inputs)) {
      const row = rows.find((line) => line.includes(`\`${name}\``));
      expect(row, `no table row for input ${name}`).toBeDefined();
      const shown = input.default === '' ? "`''`" : `\`${String(input.default)}\``;
      expect(row, `default of ${name}`).toContain(shown);
    }
  });

  it('every action.yml output appears in the README', () => {
    for (const name of Object.keys(action.outputs)) expect(README).toContain(`\`${name}\``);
  });

  it('action.yml has a branding block with an allowed icon and color', () => {
    expect(ALLOWED_ICONS).toContain(action.branding?.icon);
    expect(ALLOWED_COLORS).toContain(action.branding?.color);
  });
});
