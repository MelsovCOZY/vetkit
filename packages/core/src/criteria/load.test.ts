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

const VALID_BOOLEAN = [
  '  - id: answers-question',
  '    type: boolean',
  '    instructions: Does the reply answer the question?',
  '    escape: The reply is empty.',
  '    polarity: pass_when_true',
  '    channel: outcome',
  '    provenance: { traceIds: [] }',
];

// Second criterion has no `escape`, no `instructions` and a channel outside the enum.
const THREE_ISSUES_IN_SECOND = [
  'criteria:',
  ...VALID_BOOLEAN,
  '  - id: brief',
  '    type: boolean',
  '    polarity: pass_when_true',
  '    channel: nonsense',
  '    provenance: { traceIds: [] }',
  '',
].join('\n');

const WRAPPER_MESSAGE = /oneOf|anyOf|"then"/;

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

  test('a criterion with several schema issues reports each one under its own pointer', async () => {
    const result = await loadCriteria(await tempFile('criteria.yaml', THREE_ISSUES_IN_SECOND));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain('/criteria/1/escape');
    expect(paths).toContain('/criteria/1/instructions');
    expect(paths).toContain('/criteria/1/channel');
    expect(result.issues.every((i) => i.code === 'CRITERIA_INVALID')).toBe(true);
  });

  test('several issues in one criterion add no other-type, wrapper or duplicate lines', async () => {
    const result = await loadCriteria(await tempFile('criteria.yaml', THREE_ISSUES_IN_SECOND));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    // A boolean criterion takes neither `criteria` nor `passWhen`, and its `type` is valid.
    expect(paths).not.toContain('/criteria/1/type');
    expect(paths).not.toContain('/criteria/1/criteria');
    expect(paths).not.toContain('/criteria/1/passWhen');
    expect(paths).not.toContain('/criteria/1');
    expect(result.issues.filter((i) => WRAPPER_MESSAGE.test(i.message))).toEqual([]);
    const lines = result.issues.map((i) => `${i.path}: ${i.message}`);
    expect(new Set(lines).size).toBe(lines.length);
  });

  test('a criterion with one schema issue still reports exactly that issue', async () => {
    const result = await loadCriteria(fixture('missing-escape.yaml'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(['/criteria/0/escape']);
  });

  test('a criterion without a type reports the missing type once next to its other issues', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: brief',
        '    instructions: Is the reply brief?',
        '    escape: The reply is empty.',
        '    polarity: pass_when_true',
        '    channel: nonsense',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths.filter((p) => p === '/criteria/0/type')).toHaveLength(1);
    expect(paths).toContain('/criteria/0/channel');
    // No type was chosen, so no type branch's requirements apply yet.
    expect(paths).not.toContain('/criteria/0/criteria');
    expect(paths).not.toContain('/criteria/0/passWhen');
    expect(paths).not.toContain('/criteria/0');
  });

  test('a wrongly typed option in a choice criterion is reported once, next to its other issues', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: tone',
        '    type: choice',
        '    instructions: Which tone does the reply take?',
        '    criteria:',
        '      polite: 1',
        '      rude: The reply is insulting.',
        '    passWhen: [polite]',
        '    escape: The reply has no tone.',
        '    polarity: pass_when_true',
        '    channel: nonsense',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths.filter((p) => p === '/criteria/0/criteria/polite')).toHaveLength(1);
    expect(paths).toContain('/criteria/0/channel');
    // The map itself is fine: only the list form of `criteria` would object to it.
    expect(paths).not.toContain('/criteria/0/criteria');
    expect(result.issues.filter((i) => WRAPPER_MESSAGE.test(i.message))).toEqual([]);
  });

  test('a code grader on a score criterion is reported next to its other issues, without a wrapper line', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: helpfulness',
        '    type: score',
        '    instructions: How helpful is the reply?',
        '    criteria: [not helpful, very helpful]',
        '    polarity: pass_when_true',
        '    channel: nonsense',
        '    grader: { kind: code, check: exact }',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain('/criteria/0/type');
    expect(paths).toContain('/criteria/0/channel');
    expect(paths).not.toContain('/criteria/0');
    expect(result.issues.filter((i) => WRAPPER_MESSAGE.test(i.message))).toEqual([]);
  });

  test('a field a boolean criterion does not take is reported as not allowed, without lines about its shape', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: brief',
        '    type: boolean',
        '    instructions: Is the reply brief?',
        '    escape: The reply is empty.',
        '    criteria: 5',
        '    polarity: pass_when_true',
        '    channel: nonsense',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: '/criteria/0',
        message: expect.stringContaining('not allowed'),
      }),
    );
    expect(paths).toContain('/criteria/0/channel');
    // Whether the forbidden value is a map or a list is beside the point.
    expect(paths).not.toContain('/criteria/0/criteria');
  });

  test('a code grader without a check reports the missing check, not the other grader kinds', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: brief',
        '    type: boolean',
        '    instructions: Is the reply brief?',
        '    escape: The reply is empty.',
        '    polarity: pass_when_true',
        '    channel: nonsense',
        '    grader: { kind: code }',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain('/criteria/0/grader/check');
    expect(paths).toContain('/criteria/0/channel');
    // `kind: code` is a valid kind; the judge and reference kinds have nothing to say here.
    expect(paths).not.toContain('/criteria/0/grader/kind');
    expect(result.issues.filter((i) => WRAPPER_MESSAGE.test(i.message))).toEqual([]);
  });

  test('an unknown grader kind is reported once, not once per known kind', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: brief',
        '    type: boolean',
        '    instructions: Is the reply brief?',
        '    escape: The reply is empty.',
        '    polarity: pass_when_true',
        '    channel: quality',
        '    grader: { kind: bogus }',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const lines = result.issues.map((i) => `${i.path}: ${i.message}`);
    expect(result.issues.map((i) => i.path)).toContain('/criteria/0/grader/kind');
    expect(new Set(lines).size).toBe(lines.length);
  });

  test("the not-allowed line names the field, not ajv's 'must NOT be valid'", async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: brief',
        '    type: boolean',
        '    instructions: Is the reply brief?',
        '    escape: The reply is empty.',
        '    criteria: 5',
        '    polarity: pass_when_true',
        '    channel: quality',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const notAllowed = result.issues.filter((i) => i.message.includes('not allowed'));
    expect(notAllowed).toHaveLength(1);
    expect(notAllowed[0]).toMatchObject({ path: '/criteria/0' });
    expect(notAllowed[0]?.message).toContain("'criteria'");
    expect(notAllowed[0]?.message).toContain('boolean');
    expect(notAllowed[0]?.message).not.toContain('must NOT be valid');
  });

  test('an unknown grader kind is one line naming the kinds it could have been', async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: brief',
        '    type: boolean',
        '    instructions: Is the reply brief?',
        '    escape: The reply is empty.',
        '    polarity: pass_when_true',
        '    channel: quality',
        '    grader: { kind: bogus }',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const kindLines = result.issues.filter((i) => i.path === '/criteria/0/grader/kind');
    expect(kindLines).toHaveLength(1);
    for (const kind of ['judge', 'reference', 'code']) {
      expect(kindLines[0]?.message).toContain(`"${kind}"`);
    }
  });

  test("an unknown grader kind prints no line about the code kind's check", async () => {
    const file = await tempFile(
      'criteria.yaml',
      [
        'criteria:',
        '  - id: brief',
        '    type: boolean',
        '    instructions: Is the reply brief?',
        '    escape: The reply is empty.',
        '    polarity: pass_when_true',
        '    channel: quality',
        '    grader: { kind: bogus }',
        '    provenance: { traceIds: [] }',
        '',
      ].join('\n'),
    );

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(['/criteria/0/grader/kind']);
  });

  test('a document without a top-level criteria list is CRITERIA_INVALID at /criteria', async () => {
    const file = await tempFile('criteria.yaml', 'other: 1\n');

    const result = await loadCriteria(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'CRITERIA_INVALID', path: '/criteria' });
  });
});
