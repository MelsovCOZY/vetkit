#!/usr/bin/env node
// diff-verdicts.mjs: diffs `vet run --json`'s per-case/criterion `pass` verdicts
// against the vitest JSON reporter's output for the same emitted tests, keying on the
// `${caseId} · ${criterionId}` name @vetkit/export-vitest's emitTestFile embeds in every test
// (vitest reporter docs $1).
// A skipped vitest test (an uncalibrated lock, or an incomplete trace) is not a verdict
// disagreement (judge failures stay separate from incorrect answers) and is excluded from
// the diff. Plain Node ESM, no dependencies, so CI can run it without the workspace built.
import { readFileSync } from 'node:fs';

const NAME_SEPARATOR = ' · ';

// Real vitest 5 JSON reporter `assertionResults` entries carry `title` (the literal name
// passed to `test`/`test.skip`) and `ancestorTitles` (the enclosing `describe` names);
// `fullName` is only `[...ancestorTitles, title].join(' ')` -- space-joined, never ' > ' --
// so splitting fullName corrupts the id whenever a describe name shares no ' > ' boundary
// (cold gate evidence: parsed case id 'iteria.yaml s0'). emitTestFile puts the whole
// '<caseId> · <criterionId>' name in `title` alone, so `title` is enough on its own.
function parseKey(title) {
  const withoutReason = title.replace(/\s*\([^)]*\)\s*$/, '');
  const sep = withoutReason.indexOf(NAME_SEPARATOR);
  if (sep === -1) return undefined;
  return {
    caseId: withoutReason.slice(0, sep),
    criterionId: withoutReason.slice(sep + NAME_SEPARATOR.length),
  };
}

function keyOf(caseId, criterionId) {
  return `${caseId}${NAME_SEPARATOR}${criterionId}`;
}

function loadRunVerdicts(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const map = new Map();
  for (const v of data.results ?? []) {
    if (typeof v.pass === 'boolean') map.set(keyOf(v.caseId, v.criterionId), v.pass);
  }
  return map;
}

function loadVitestVerdicts(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const map = new Map();
  for (const suite of data.testResults ?? []) {
    for (const result of suite.assertionResults ?? []) {
      if (result.status !== 'passed' && result.status !== 'failed') continue;
      const key = parseKey(result.title);
      if (key === undefined) continue;
      map.set(keyOf(key.caseId, key.criterionId), result.status === 'passed');
    }
  }
  return map;
}

function countDifferences(runPath, vitestPath) {
  const run = loadRunVerdicts(runPath);
  const vitest = loadVitestVerdicts(vitestPath);
  const keys = new Set([...run.keys(), ...vitest.keys()]);
  if (keys.size === 0) {
    throw new Error('compared set is empty: no run and vitest verdicts share a key');
  }
  let differences = 0;
  for (const key of keys) {
    if (run.get(key) !== vitest.get(key)) differences += 1;
  }
  return differences;
}

const [, , runPath, vitestPath] = process.argv;
if (runPath === undefined || vitestPath === undefined) {
  console.error('usage: diff-verdicts.mjs <run.json> <vitest.json>');
  process.exit(2);
}

let differences;
try {
  differences = countDifferences(runPath, vitestPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
console.log(`differences: ${differences}`);
process.exit(differences === 0 ? 0 : 1);
