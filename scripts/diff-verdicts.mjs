#!/usr/bin/env node
// diff-verdicts.mjs (bead mol-aq4.3): diffs `vet run --json`'s per-case/criterion `pass` verdicts
// against the vitest JSON reporter's output for the same emitted tests, keying on the
// `${caseId} · ${criterionId}` name @vetkit/export-vitest's emitTestFile embeds in every test
// (contract aq4.3 #2; vitest reporter docs https://vitest.dev/guide/reporters#json-reporter).
// A skipped vitest test (an uncalibrated lock, or an incomplete trace) is not a verdict
// disagreement (JEV brief §2 "keep judge failed separate from incorrect") and is excluded from
// the diff. Plain Node ESM, no dependencies, so CI can run it without the workspace built.
import { readFileSync } from 'node:fs';

const NAME_SEPARATOR = ' · ';

function parseKey(fullName) {
  const nameOnly = fullName.slice(fullName.lastIndexOf(' > ') + 3);
  const withoutReason = nameOnly.replace(/\s*\([^)]*\)\s*$/, '');
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
      const key = parseKey(result.fullName);
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

const differences = countDifferences(runPath, vitestPath);
console.log(`differences: ${differences}`);
process.exit(differences === 0 ? 0 : 1);
