import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { computeWordingHash, loadCriteria } from './load.ts';

const fixtures = fileURLToPath(new URL('../../../../fixtures/criteria/', import.meta.url));
const fixture = (name: string): string => join(fixtures, name);

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vetkit-criteria-'));
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

describe('loadCriteria', () => {
  test('loads a valid criteria.yaml into Criterion[]', async () => {
    const result = await loadCriteria(fixture('valid.yaml'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.criteria.map((c) => c.id)).toEqual(['answers-question', 'tone', 'helpfulness']);
    expect(result.criteria[1]).toMatchObject({
      type: 'choice',
      passWhen: ['polite', 'neutral'],
      channel: 'quality',
      provenance: { traceIds: ['trace-2', 'trace-3'], generator: 'hand-written' },
    });
  });

  test('computes wordingHash as sha256 over the normalised {type, instructions, criteria, escape}', async () => {
    const result = await loadCriteria(fixture('valid.yaml'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [boolean, choice, score] = result.criteria;
    expect(boolean?.wordingHash).toBe(
      sha256(
        JSON.stringify({
          type: 'boolean',
          instructions: "Does the reply directly answer the user's question?",
          escape: 'The reply is empty or not in a readable language.',
        }),
      ),
    );
    expect(choice?.wordingHash).toBe(
      sha256(
        JSON.stringify({
          type: 'choice',
          instructions: 'Which tone does the reply take?',
          criteria: {
            polite: 'The reply is courteous.',
            neutral: 'The reply is matter-of-fact.',
            rude: 'The reply is dismissive or insulting.',
          },
          escape: 'The reply has no discernible tone.',
        }),
      ),
    );
    expect(score?.wordingHash).toBe(
      sha256(
        JSON.stringify({
          type: 'score',
          instructions: 'How helpful is the reply?',
          criteria: ['not helpful', 'somewhat helpful', 'very helpful'],
        }),
      ),
    );
  });

  test('wordingHash ignores key order and fields outside the wording subset', () => {
    const a = computeWordingHash({
      type: 'boolean',
      instructions: 'Is it polite?',
      escape: 'No tone.',
    });
    const b = computeWordingHash({
      escape: 'No tone.',
      instructions: 'Is it polite?',
      type: 'boolean',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computeWordingHash({ type: 'boolean', instructions: 'Is it rude?', escape: 'No tone.' }),
    ).not.toBe(a);
  });

  test('a CRLF file loads with the same criteria and hashes as its LF twin', async () => {
    const lf = await readFile(fixture('valid.yaml'), 'utf8');
    const crlfFile = await tempFile('criteria.yaml', lf.replaceAll('\n', '\r\n'));

    const [fromLf, fromCrlf] = await Promise.all([
      loadCriteria(fixture('valid.yaml')),
      loadCriteria(crlfFile),
    ]);

    expect(fromCrlf.ok).toBe(true);
    if (!fromLf.ok || !fromCrlf.ok) return;
    expect(fromCrlf.criteria.map((c) => c.wordingHash)).toEqual(
      fromLf.criteria.map((c) => c.wordingHash),
    );
  });

  test('a criterion missing `escape` returns an issue at /criteria/0/escape', async () => {
    const result = await loadCriteria(fixture('missing-escape.yaml'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'CRITERIA_INVALID',
        path: '/criteria/0/escape',
        message: expect.any(String),
      }),
    );
  });

  test('an empty criteria list is ok with []', async () => {
    const result = await loadCriteria(fixture('empty.yaml'));

    expect(result).toEqual({ ok: true, criteria: [] });
  });

  test('duplicate criterion ids are a CRITERIA_INVALID issue naming both locations', async () => {
    const result = await loadCriteria(fixture('duplicate-id.yaml'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'CRITERIA_INVALID',
        path: '/criteria/1/id',
        relatedPath: '/criteria/0/id',
        message: expect.stringContaining('tone'),
      }),
    );
  });

  test('a passWhen value that is not a key of the criteria map is CRITERIA_INVALID naming the id and value', async () => {
    const result = await loadCriteria(fixture('bad-pass-when.yaml'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.path.startsWith('/criteria/0/passWhen'));
    expect(issue).toMatchObject({ code: 'CRITERIA_INVALID', path: '/criteria/0/passWhen/1' });
    expect(issue?.message).toContain('tone');
    expect(issue?.message).toContain('friendly');
  });

  test('a choice criterion without passWhen is CRITERIA_INVALID at /criteria/<i>/passWhen', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: answers-question',
        '    type: boolean',
        '    instructions: Does the reply answer the question?',
        '    escape: The reply is empty.',
        '    polarity: pass_when_true',
        '    channel: outcome',
        '    provenance: { traceIds: [] }',
        '  - id: tone',
        '    type: choice',
        '    instructions: Which tone does the reply take?',
        '    criteria:',
        '      polite: The reply is courteous.',
        '      rude: The reply is insulting.',
        '    escape: The reply has no tone.',
        '    polarity: pass_when_true',
        '    channel: quality',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'CRITERIA_INVALID', path: '/criteria/1/passWhen' }),
    );
  });

  test('a choice criterion with an empty passWhen is CRITERIA_INVALID at /criteria/0/passWhen', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: tone',
        '    type: choice',
        '    instructions: Which tone does the reply take?',
        '    criteria:',
        '      polite: The reply is courteous.',
        '      rude: The reply is insulting.',
        '    passWhen: []',
        '    escape: The reply has no tone.',
        '    polarity: pass_when_true',
        '    channel: quality',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'CRITERIA_INVALID', path: '/criteria/0/passWhen' }),
    );
  });

  test('a YAML anchor alias cannot smuggle a duplicate id past the uniqueness check', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - &base',
        '    id: tone',
        '    type: boolean',
        '    instructions: Is the reply polite?',
        '    escape: No tone.',
        '    polarity: pass_when_true',
        '    channel: quality',
        '    provenance: { traceIds: [] }',
        '  - *base',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'CRITERIA_INVALID', path: '/criteria/1/id' }),
    );
  });

  test('a missing file returns an issue instead of throwing', async () => {
    const result = await loadCriteria(fixture('does-not-exist.yaml'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'E_IO', path: '' });
  });

  test('malformed YAML returns a CRITERIA_INVALID issue instead of throwing', async () => {
    const file = await tempFile('criteria.yaml', 'criteria: [unclosed\n');

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'CRITERIA_INVALID' });
  });

  test('a document without a top-level criteria list is CRITERIA_INVALID at /criteria', async () => {
    const file = await tempFile('criteria.yaml', 'other: 1\n');

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'CRITERIA_INVALID', path: '/criteria' });
  });
});
