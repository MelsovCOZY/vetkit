import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { caseSchema, safeParseJson, type Case } from '@vetkit/spec';
import {
  clusterKeys,
  clusteredSE,
  nearDuplicateClusters,
  pairedClusteredDiff,
  type NearDuplicateEvent,
} from './clusters.ts';

// Fixture rows go through the safeParseJson chokepoint (raw JSON.parse is banned in packages/*/src).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const NEAR_DUPS_PATH = join(REPO_ROOT, 'fixtures', 'clusters', 'near-dups.jsonl');

function loadNearDups(): Case[] {
  return readFileSync(NEAR_DUPS_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const result = safeParseJson<Case>(line, caseSchema);
      if (!result.ok) throw new Error(`invalid fixture row: ${line}`);
      return result.value;
    });
}

function mkCase(id: string, state: string, extra: Partial<Case> = {}): Case {
  return { id, input: { state }, provenance: null, tags: [], ...extra };
}

function naiveSE(values: readonly number[]): number {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance / n);
}

const OPTS = { k: 5, perms: 128, editSimilarity: 0.8, seed: 42 } as const;

describe('nearDuplicateClusters', () => {
  test('near-dups fixture: two paraphrased pairs + 6 distinct cases → exactly 2 clusters', () => {
    const result = nearDuplicateClusters(loadNearDups(), OPTS);
    expect(result.clusters).toHaveLength(2);
    const memberSets = result.clusters.map((c) =>
      [...c.caseIds].toSorted((x, y) => x.localeCompare(y)),
    );
    expect(memberSets).toContainEqual(['pa-1', 'pa-2']);
    expect(memberSets).toContainEqual(['pb-1', 'pb-2']);
  });

  test('borderline pair (edit similarity ≈ 0.86) is found and reported with its similarity', () => {
    const result = nearDuplicateClusters(loadNearDups(), OPTS);
    const pair = result.pairs.find(
      (p) => (p.a === 'pb-1' && p.b === 'pb-2') || (p.a === 'pb-2' && p.b === 'pb-1'),
    );
    expect(pair).toBeDefined();
    expect(pair?.similarity).toBeGreaterThan(0.8);
    expect(pair?.similarity).toBeLessThan(0.9);
  });

  test('decoy pair sharing a long prefix (edit similarity ≈ 0.73) is never confirmed, across seeds', () => {
    const cases = loadNearDups();
    for (let seed = 0; seed < 25; seed += 1) {
      // Cluster count is not asserted here: LSH may miss a true pair under some seeds (~3% for
      // pa-1/pa-2 at word 5-gram Jaccard 0.57), which is the documented banding trade-off.
      const result = nearDuplicateClusters(cases, { ...OPTS, seed });
      for (const pair of result.pairs) {
        expect([pair.a, pair.b]).not.toContain('d-2');
        expect(pair.similarity).toBeGreaterThan(0.8);
      }
    }
  });

  test('deterministic under the seed', () => {
    const cases = loadNearDups();
    const first = nearDuplicateClusters(cases, OPTS);
    const second = nearDuplicateClusters(cases, OPTS);
    expect(second).toEqual(first);
  });

  test('never deletes or rewrites cases', () => {
    const cases = loadNearDups();
    const snapshot = structuredClone(cases);
    nearDuplicateClusters(cases, OPTS);
    expect(cases).toEqual(snapshot);
  });

  test('texts under 5 words use character 5-grams', () => {
    const cases = [mkCase('s-1', 'refund status please?'), mkCase('s-2', 'refund status please!')];
    const result = nearDuplicateClusters(cases, OPTS);
    expect(result.clusters).toHaveLength(1);
    expect([...(result.clusters[0]?.caseIds ?? [])].toSorted((x, y) => x.localeCompare(y))).toEqual(
      ['s-1', 's-2'],
    );
  });

  test('normalises text (NFKC, casefold, whitespace) before comparison', () => {
    const base = 'Please check the order status for account ninety one today';
    const cases = [mkCase('n-1', base), mkCase('n-2', `  ${base.toUpperCase()}\n\t`)];
    const result = nearDuplicateClusters(cases, OPTS);
    expect(result.pairs).toEqual([{ a: 'n-1', b: 'n-2', similarity: 1 }]);
  });

  test('empty case list → no clusters and no pairs', () => {
    const result = nearDuplicateClusters([], OPTS);
    expect(result.clusters).toEqual([]);
    expect(result.pairs).toEqual([]);
  });

  test('texts over 8k characters are compared on their first 8k with a diag note', () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(400);
    const cases = [mkCase('l-1', `${long} alpha`), mkCase('l-2', `${long} omega`)];
    const result = nearDuplicateClusters(cases, OPTS);
    expect(result.clusters).toHaveLength(1);
    expect(result.diagnostics).toContainEqual({
      caseId: 'l-1',
      code: 'truncated_for_edit_similarity',
    });
    expect(result.diagnostics).toContainEqual({
      caseId: 'l-2',
      code: 'truncated_for_edit_similarity',
    });
  });

  test('warn-only: emits exactly one cases.near_duplicates event with the cluster count', () => {
    const events: NearDuplicateEvent[] = [];
    const exitCodeBefore = process.exitCode;
    nearDuplicateClusters(loadNearDups(), { ...OPTS, emit: (event) => events.push(event) });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('cases.near_duplicates');
    expect(events[0]?.level).toBe('warn');
    expect(events[0]?.clusters).toBe(2);
    expect(process.exitCode).toBe(exitCodeBefore);
  });
});

describe('clusterKeys', () => {
  test('a case with neither traceId nor cluster nor near-duplicate is its own cluster', () => {
    const cases = [mkCase('a', 'alpha one two three four'), mkCase('b', 'beta')];
    const keys = clusterKeys(cases, { clusters: [], pairs: [], diagnostics: [] });
    expect(keys.get('a')).not.toBe(keys.get('b'));
    expect(keys.size).toBe(2);
  });

  test('union-find is transitive across Case.cluster, traceId and near-duplicate clusters', () => {
    const cases = [
      mkCase('c1', 'x', { cluster: 'seed-7' }),
      mkCase('c2', 'y', { cluster: 'seed-7', traceId: 't-1' }),
      mkCase('c3', 'z', { traceId: 't-1' }),
      mkCase('c4', 'w'),
      mkCase('c5', 'v'),
      mkCase('c6', 'u', { traceId: 'seed-7' }),
    ];
    const nearDups = {
      clusters: [{ id: 'nd-1', caseIds: ['c3', 'c4'] }],
      pairs: [{ a: 'c3', b: 'c4', similarity: 0.9 }],
      diagnostics: [],
    };
    const keys = clusterKeys(cases, nearDups);
    const k1 = keys.get('c1');
    expect(k1).toBeDefined();
    expect(keys.get('c2')).toBe(k1);
    expect(keys.get('c3')).toBe(k1);
    expect(keys.get('c4')).toBe(k1);
    expect(keys.get('c5')).not.toBe(k1);
    // A traceId equal to another case's cluster label is a different namespace.
    expect(keys.get('c6')).not.toBe(k1);
  });

  test('computes near-duplicate clusters itself when none are passed', () => {
    const keys = clusterKeys(loadNearDups());
    expect(keys.get('pa-1')).toBe(keys.get('pa-2'));
    expect(keys.get('pb-1')).toBe(keys.get('pb-2'));
    expect(keys.get('pa-1')).not.toBe(keys.get('pb-1'));
    expect(keys.get('d-1')).not.toBe(keys.get('d-2'));
  });
});

describe('clusteredSE', () => {
  test('equals the naive SE (within 1e-9) when every cluster has size 1', () => {
    const values = [0.2, 0.9, 0.4, 0.7, 0.1, 0.55];
    const ids = values.map((_, i) => `g${i}`);
    const result = clusteredSE(values, ids);
    expect(result.se).not.toBeNull();
    expect(Math.abs((result.se ?? Number.NaN) - naiveSE(values))).toBeLessThan(1e-9);
    expect(result.nClusters).toBe(6);
  });

  test('10-case fixture with one correlated cluster → clustered SE > naive SE (hand value 0.3)', () => {
    const values = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    const ids = ['A', 'A', 'A', 'A', 'A', 's6', 's7', 's8', 's9', 's10'];
    const result = clusteredSE(values, ids);
    expect(result.se).toBeCloseTo(0.3, 9);
    expect(result.se ?? 0).toBeGreaterThan(naiveSE(values));
    expect(result.nClusters).toBe(6);
  });

  test('a single cluster (G = 1) → se null with reason single_cluster', () => {
    const result = clusteredSE([1, 0, 1], ['A', 'A', 'A']);
    expect(result.se).toBeNull();
    expect(result.reason).toBe('single_cluster');
  });
});

describe('pairedClusteredDiff', () => {
  test('hand-computed 4-case, 2-cluster example; ids missing from either side are ignored', () => {
    const a = new Map([
      ['c1', 1],
      ['c2', 1],
      ['c3', 0],
      ['c4', 1],
      ['only-a', 1],
    ]);
    const b = new Map([
      ['c1', 0],
      ['c2', 0],
      ['c3', 0],
      ['c4', 0],
      ['only-b', 0],
    ]);
    const clusterIds = new Map([
      ['c1', 'g1'],
      ['c2', 'g1'],
      ['c3', 'g2'],
      ['c4', 'g2'],
    ]);
    const result = pairedClusteredDiff(a, b, clusterIds);
    // d = [1, 1, 0, 1], mean 0.75; residual sums per cluster 0.5 and -0.5;
    // V = G/(G-1) · Σ_g (Σ r)² / n² = 2 · 0.5 / 16 = 0.0625 → se 0.25.
    expect(result.nPairs).toBe(4);
    expect(result.nClusters).toBe(2);
    expect(result.meanDiff).toBeCloseTo(0.75, 12);
    expect(result.se).toBeCloseTo(0.25, 12);
    expect(result.ci95?.[0]).toBeCloseTo(0.75 - 1.96 * 0.25, 12);
    expect(result.ci95?.[1]).toBeCloseTo(0.75 + 1.96 * 0.25, 12);
  });
});
