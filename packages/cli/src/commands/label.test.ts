import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { VetError } from '@vetkit/spec';
import { Command } from 'commander';
import { describe, expect, test } from 'vitest';
import { handleError } from '../errors.ts';
import { registerLabel, type LabelDeps } from './label.ts';

const HEADER = 'case_id,criterion_id,label,labeler,labeled_at';

const CRITERIA_YAML = `criteria:
  - id: tone
    type: boolean
    instructions: Is the reply polite?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
`;

function caseLine(id: string, state: string): string {
  return JSON.stringify({ id, input: { state }, provenance: null, tags: [] });
}

interface Project {
  readonly root: string;
  readonly cases: string;
  readonly criteria: string;
  readonly labels: string;
}

async function project(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-label-'));
  const cases = join(root, 'evals', 'cases');
  await mkdir(cases, { recursive: true });
  await writeFile(
    join(cases, 'cases.jsonl'),
    `${caseLine('case-1', 'User: hi')}\n${caseLine('case-2', 'User: bye')}\n`,
  );
  const criteria = join(root, 'evals', 'criteria.yaml');
  await writeFile(criteria, CRITERIA_YAML);
  return { root, cases, criteria, labels: join(root, 'evals', 'labels') };
}

async function runLabel(p: Project, args: readonly string[], deps: LabelDeps = {}): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerLabel(program, deps);
  await program.parseAsync([
    'node',
    'vet',
    'label',
    '--cases',
    p.cases,
    '--criteria',
    p.criteria,
    '--labels',
    p.labels,
    ...args,
  ]);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the command to reject');
}

// The CLI-wide exit mapping: what `vet` would exit with for this error.
function exitCodeOf(error: unknown): number {
  const sink = { write: () => true };
  let code = -1;
  try {
    handleError(error, {
      json: false,
      verbose: false,
      strict: false,
      stdout: sink,
      stderr: sink,
      exit: (c: number) => {
        code = c;
        throw new Error('exit');
      },
    });
  } catch {
    // unwound by the exit double above
  }
  return code;
}

describe('vet label --from', () => {
  test('valid files are copied to evals/labels/<criterion_id>.csv and the command succeeds', async () => {
    const p = await project();
    const from = join(p.root, 'incoming');
    await mkdir(from);
    await writeFile(
      join(from, 'batch.csv'),
      `${HEADER}\ncase-1,tone,pass,"Doe, Jane",2026-09-28\ncase-2,tone,unknown,bob,2026-09-28\n`,
    );

    await runLabel(p, ['--from', from], { stderr: { write: () => true } });

    const written = readFileSync(join(p.labels, 'tone.csv'), 'utf8').split(/\r?\n/);
    expect(written[0]).toBe(HEADER);
    expect(written).toContain('case-1,tone,pass,"Doe, Jane",2026-09-28');
    expect(written).toContain('case-2,tone,unknown,bob,2026-09-28');
  });

  test('a malformed row rejects with LABELS_INVALID naming file:line, exits 2, writes nothing', async () => {
    const p = await project();
    const file = join(p.root, 'bad.csv');
    await writeFile(file, `${HEADER}\ncase-1,tone,pass,bob,2026-09-28\ncase-2,tone,maybe,bob,x\n`);

    const error = await rejection(runLabel(p, ['--from', file]));

    expect(VetError.isInstance(error)).toBe(true);
    if (!VetError.isInstance(error)) return;
    expect(error.code).toBe('LABELS_INVALID');
    expect(error.message).toContain(`${file}:3`);
    expect(exitCodeOf(error)).toBe(2);
    expect(existsSync(join(p.labels, 'tone.csv'))).toBe(false);
  });

  test('a case id missing from evals/cases/ rejects with LABELS_INVALID naming the id', async () => {
    const p = await project();
    const file = join(p.root, 'ghost.csv');
    await writeFile(file, `${HEADER}\nghost,tone,pass,bob,2026-09-28\n`);

    const error = await rejection(runLabel(p, ['--from', file]));

    expect(VetError.isInstance(error)).toBe(true);
    if (!VetError.isInstance(error)) return;
    expect(error.code).toBe('LABELS_INVALID');
    expect(error.message).toContain('ghost');
    expect(error.message).toContain(`${file}:2`);
  });
});

// A scripted terminal: input claims to be a TTY and answers each prompt with the next
// key once that prompt's progress marker (`(n/total)`) has been rendered.
function scriptedTty(keys: readonly string[], total: number) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => input,
  });
  const output = new PassThrough();
  let text = '';
  let answered = 0;
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString();
    const next = keys[answered];
    if (next !== undefined && text.includes(`(${answered + 1}/${total})`)) {
      answered += 1;
      setTimeout(() => input.write(next), 5);
    }
  });
  return { input, output, text: () => text };
}

describe('vet label --tty', () => {
  test('p/f keys append one row per unlabeled (case, criterion) pair and print state and instructions', async () => {
    const p = await project();
    const tty = scriptedTty(['p', 'f'], 2);

    await runLabel(p, ['--tty', '--labeler', 'alice'], {
      input: tty.input,
      output: tty.output,
      now: () => new Date('2026-09-28T12:00:00.000Z'),
    });

    const lines = readFileSync(join(p.labels, 'tone.csv'), 'utf8').trim().split(/\r?\n/);
    expect(lines).toEqual([
      HEADER,
      'case-1,tone,pass,alice,2026-09-28T12:00:00.000Z',
      'case-2,tone,fail,alice,2026-09-28T12:00:00.000Z',
    ]);
    expect(tty.text()).toContain('User: hi');
    expect(tty.text()).toContain('Is the reply polite?');
  });

  test('already-labeled pairs are skipped and q saves and exits', async () => {
    const p = await project();
    await mkdir(p.labels, { recursive: true });
    await writeFile(join(p.labels, 'tone.csv'), `${HEADER}\ncase-1,tone,unknown,bob,2026-09-27\n`);
    const tty = scriptedTty(['q'], 1);

    await runLabel(p, ['--tty', '--labeler', 'alice'], { input: tty.input, output: tty.output });

    const lines = readFileSync(join(p.labels, 'tone.csv'), 'utf8').trim().split(/\r?\n/);
    expect(lines).toEqual([HEADER, 'case-1,tone,unknown,bob,2026-09-27']);
    expect(tty.text()).toContain('User: bye');
    expect(tty.text()).not.toContain('User: hi');
  });

  test('stdin not a TTY rejects immediately with NOT_INTERACTIVE, exit 2, no prompt', async () => {
    const p = await project();
    const input = Object.assign(new PassThrough(), { isTTY: false });
    input.end();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => (text += chunk.toString()));

    const error = await rejection(runLabel(p, ['--tty'], { input, output }));

    expect(VetError.isInstance(error)).toBe(true);
    if (!VetError.isInstance(error)) return;
    expect(error.code).toBe('NOT_INTERACTIVE');
    expect(exitCodeOf(error)).toBe(2);
    expect(text).toBe('');
    expect(existsSync(join(p.labels, 'tone.csv'))).toBe(false);
  });
});
