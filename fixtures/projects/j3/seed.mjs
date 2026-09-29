// Seed generator for the J3 journey fixtures. Never a shipped path.
// Rebuilds fixtures/projects/j3/evals/cases/j3.jsonl, fixtures/labels/*.csv and
// fixtures/gauntlet-fail/{cases,labels}/ from the JS spike corpus (spike/data/traces.jsonl):
//   pass = a question with its own (correct) answer; fail = the same question with the answer
//   to a different question of the same language. Labels are therefore synthetic ground truth.
// The set is picked so the seeded 50/50 held-out split (packages/core splitByHash, seed 0) has
// HELD_PER_CLASS pass and fail cases, clearing the 30/30 class floor with margin.
// Usage: bun run build && bun fixtures/projects/j3/seed.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitByHash } from '../../../packages/core/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const HELD_PER_CLASS = 32;
const TRAIN_PER_CLASS = 18;
const THIN_FAILS = 16;
const LABELED_AT = '2026-09-29T00:00:00.000Z';
const HEADER = 'case_id,criterion_id,label,labeler,labeled_at';

const norm = (s) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\[\d+\]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const rows = readFileSync(join(ROOT, 'spike/data/traces.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

// One correct (question, answer) per answerable question, first variant in file order.
const byQuestion = new Map();
for (const r of rows) {
  if (r.unanswerable || byQuestion.has(r.question)) continue;
  if (norm(r.answer).includes(norm(r.reference))) byQuestion.set(r.question, r);
}
const good = [...byQuestion.values()].toSorted((a, b) => (a.question < b.question ? -1 : 1));
const slug = (i) => `q${String(i).padStart(3, '0')}`;

const candidates = [];
good.forEach((r, i) => {
  const same = good.filter((o, j) => j !== i && o.lang === r.lang);
  const other = same[i % same.length];
  const mk = (kind, answer) => ({
    id: `j3-${kind}-${slug(i)}`,
    label: kind === 'p' ? 'pass' : 'fail',
    cluster: slug(i),
    input: { state: `Question: ${r.question}\nAnswer: ${answer}`, answer },
    expected: { value: r.reference, source: 'user' },
  });
  candidates.push(mk('p', r.answer), mk('f', other.answer));
});

const pick = (label) => {
  const all = candidates.filter((c) => c.label === label);
  const { train, heldOut } = splitByHash(
    all.map((c) => c.id),
    0,
  );
  const byId = new Map(all.map((c) => [c.id, c]));
  return [...heldOut.slice(0, HELD_PER_CLASS), ...train.slice(0, TRAIN_PER_CLASS)].map((id) =>
    byId.get(id),
  );
};
const passes = pick('pass');
const fails = pick('fail');
if (
  passes.length < HELD_PER_CLASS + TRAIN_PER_CLASS ||
  fails.length < HELD_PER_CLASS + TRAIN_PER_CLASS
) {
  throw new Error('not enough candidates for the requested split');
}
const chosen = [...passes, ...fails].toSorted((a, b) => (a.id < b.id ? -1 : 1));

const caseLine = (c, withExpected) =>
  JSON.stringify({
    id: c.id,
    input: c.input,
    provenance: null,
    tags: ['j3-gate-seed'],
    ...(withExpected ? { expected: c.expected } : {}),
    cluster: c.cluster,
  });
const csv = (criterion, list) =>
  `${HEADER}\n${list.map((c) => `${c.id},${criterion},${c.label},gate-seed,${LABELED_AT}`).join('\n')}\n`;

writeFileSync(
  join(ROOT, 'fixtures/projects/j3/evals/cases/j3.jsonl'),
  `${chosen.map((c) => caseLine(c, true)).join('\n')}\n`,
);
writeFileSync(join(ROOT, 'fixtures/labels/answer_correct.csv'), csv('answer_correct', chosen));
writeFileSync(join(ROOT, 'fixtures/labels/answer_quality.csv'), csv('answer_quality', chosen));

// gauntlet-fail: the same cases without `expected` (needs_reference must find it missing).
writeFileSync(
  join(ROOT, 'fixtures/gauntlet-fail/cases/gf.jsonl'),
  `${chosen.map((c) => caseLine(c, false)).join('\n')}\n`,
);
for (const id of ['polarity_flip', 'persuasive_constant', 'needs_reference']) {
  writeFileSync(join(ROOT, `fixtures/gauntlet-fail/labels/${id}.csv`), csv(id, chosen));
}
// thin-class: every case is labelled, but only THIN_FAILS of the fails are `fail`; the rest are
// `unknown` (excluded from fitting, counted toward the 100-label budget), so held-out fails stay
// far below the 30 floor. It labels the same ids, so it lives in fixtures/labels/ and imports
// into both projects.
let seen = 0;
const thin = chosen.map((c) =>
  c.label === 'fail' && (seen += 1) > THIN_FAILS ? { ...c, label: 'unknown' } : c,
);
writeFileSync(join(ROOT, 'fixtures/labels/thin-class.csv'), csv('thin_class', thin));

const held = new Set(
  splitByHash(
    chosen.map((c) => c.id),
    0,
  ).heldOut,
);
const count = (label) => chosen.filter((c) => c.label === label && held.has(c.id)).length;
console.log(
  `cases=${chosen.length} heldOutPass=${count('pass')} heldOutFail=${count('fail')} thin=${thin.length} thinFails=${thin.filter((c) => c.label === 'fail').length}`,
);
