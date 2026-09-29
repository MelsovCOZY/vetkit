// Near-duplicate case clusters (MinHash over word 5-grams + LSH banding, confirmed by normalised
// edit similarity) and cluster-robust standard errors. Pure functions; the only side effect is the
// optional injected `emit`. See arXiv 2107.06499.
import type { Case } from '@vetkit/spec';

/** Edit similarity is computed on at most this many characters per side. */
const EDIT_CAP = 8000;
const ROWS_PER_BAND = 4;
const Z95 = 1.96;

export interface NearDuplicateEvent {
  readonly type: 'cases.near_duplicates';
  readonly level: 'warn';
  readonly clusters: number;
  readonly pairs: number;
}

export interface NearDuplicateOptions {
  /** Shingle size in words (characters for texts under `k` words). Default 5. */
  readonly k?: number;
  /** MinHash permutations; split into bands of 4 rows. Default 128 (32 bands × 4 rows). */
  readonly perms?: number;
  /** A candidate pair is confirmed when normalised edit similarity is strictly above this. Default 0.8. */
  readonly editSimilarity?: number;
  readonly seed?: number;
  /** Warn-only report sink; called exactly once per call. */
  readonly emit?: (event: NearDuplicateEvent) => void;
}

export interface NearDuplicateResult {
  readonly clusters: readonly { readonly id: string; readonly caseIds: readonly string[] }[];
  readonly pairs: readonly {
    readonly a: string;
    readonly b: string;
    readonly similarity: number;
  }[];
  readonly diagnostics: readonly {
    readonly caseId: string;
    readonly code: 'truncated_for_edit_similarity';
  }[];
}

export interface ClusteredSEResult {
  /** Cluster-robust (CR1) SE of the mean; null when it is undefined. */
  readonly se: number | null;
  readonly reason?: 'single_cluster';
  readonly n: number;
  readonly nClusters: number;
}

export interface PairedClusteredDiffResult {
  readonly meanDiff: number | null;
  readonly se: number | null;
  readonly ci95: readonly [number, number] | null;
  readonly reason?: 'single_cluster';
  readonly nPairs: number;
  readonly nClusters: number;
}

function normalise(text: string): string {
  return text.normalize('NFKC').toLowerCase().replaceAll(/\s+/gu, ' ').trim();
}

function shingles(text: string, k: number): Set<string> {
  const out = new Set<string>();
  const words = text.length === 0 ? [] : text.split(' ');
  if (words.length >= k) {
    for (let i = 0; i + k <= words.length; i += 1) out.add(words.slice(i, i + k).join(' '));
  } else if (text.length > 0) {
    // UTF-16 code units: stable and cheap; grapheme accuracy does not matter for hashing.
    if (text.length <= k) out.add(text);
    for (let i = 0; i + k <= text.length; i += 1) out.add(text.slice(i, i + k));
  }
  return out;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function fmix32(value: number): number {
  let h = value;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function signature(hashes: readonly number[], coeffs: readonly (readonly [number, number])[]) {
  return coeffs.map(([a, b]) => {
    let min = 0xffffffff;
    for (const h of hashes) {
      const v = fmix32((Math.imul(h, a) + b) >>> 0);
      if (v < min) min = v;
    }
    return min;
  });
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, sub);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

class UnionFind {
  readonly #parent: number[];
  constructor(size: number) {
    this.#parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    let root = i;
    while (this.#parent[root] !== root) root = this.#parent[root] ?? root;
    let node = i;
    while (node !== root) {
      const next = this.#parent[node] ?? root;
      this.#parent[node] = root;
      node = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    // Lower index wins so roots are deterministic (first case in input order).
    if (ra < rb) this.#parent[rb] = ra;
    else if (rb < ra) this.#parent[ra] = rb;
  }
}

/**
 * Finds near-duplicate cases by `input.state`. Reports only: never deletes or rewrites a case,
 * and emits exactly one warn-level `cases.near_duplicates` event.
 */
export function nearDuplicateClusters(
  cases: readonly Case[],
  options: NearDuplicateOptions = {},
): NearDuplicateResult {
  const { k = 5, perms = 128, editSimilarity: threshold = 0.8, seed = 0, emit } = options;
  const rand = mulberry32(seed);
  const coeffs = Array.from({ length: perms }, () => [rand() | 1, rand()] as const);
  const texts = cases.map((c) => normalise(c.input.state));

  const buckets = new Map<string, number[]>();
  texts.forEach((text, index) => {
    const hashes = [...shingles(text, k)].map(fnv1a);
    if (hashes.length === 0) return;
    const sig = signature(hashes, coeffs);
    for (let band = 0; band * ROWS_PER_BAND < perms; band += 1) {
      const rows = sig.slice(band * ROWS_PER_BAND, (band + 1) * ROWS_PER_BAND);
      const key = `${band}:${rows.join(',')}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    }
  });

  const candidates = new Set<number>();
  for (const bucket of buckets.values()) {
    for (let x = 0; x < bucket.length; x += 1) {
      for (let y = x + 1; y < bucket.length; y += 1) {
        candidates.add((bucket[x] ?? 0) * cases.length + (bucket[y] ?? 0));
      }
    }
  }

  const truncated = new Set<number>();
  const uf = new UnionFind(cases.length);
  const confirmed: { i: number; j: number; similarity: number }[] = [];
  for (const code of [...candidates].toSorted((x, y) => x - y)) {
    const i = Math.floor(code / cases.length);
    const j = code % cases.length;
    const a = texts[i] ?? '';
    const b = texts[j] ?? '';
    if (a.length > EDIT_CAP) truncated.add(i);
    if (b.length > EDIT_CAP) truncated.add(j);
    const similarity = editSimilarity(a.slice(0, EDIT_CAP), b.slice(0, EDIT_CAP));
    if (similarity > threshold) {
      confirmed.push({ i, j, similarity });
      uf.union(i, j);
    }
  }

  // Walk cases in input order so cluster order and member order follow the input.
  const paired = new Set(confirmed.flatMap(({ i, j }) => [i, j]));
  const groups = new Map<number, string[]>();
  cases.forEach((c, index) => {
    if (!paired.has(index)) return;
    const root = uf.find(index);
    const members = groups.get(root);
    if (members) members.push(c.id);
    else groups.set(root, [c.id]);
  });
  const clusters = [...groups.values()].map((caseIds, n) => ({ id: `nd-${n + 1}`, caseIds }));

  const result: NearDuplicateResult = {
    clusters,
    pairs: confirmed.map(({ i, j, similarity }) => ({
      a: cases[i]?.id ?? '',
      b: cases[j]?.id ?? '',
      similarity,
    })),
    diagnostics: [...truncated]
      .toSorted((x, y) => x - y)
      .map((index) => ({
        caseId: cases[index]?.id ?? '',
        code: 'truncated_for_edit_similarity' as const,
      })),
  };
  emit?.({
    type: 'cases.near_duplicates',
    level: 'warn',
    clusters: clusters.length,
    pairs: result.pairs.length,
  });
  return result;
}

/**
 * Maps each case id to a cluster id, unioning cases that share `Case.cluster`, share `traceId`
 * or fall in one near-duplicate cluster. The cluster id is the first member's case id.
 */
export function clusterKeys(
  cases: readonly Case[],
  nearDuplicates: NearDuplicateResult = nearDuplicateClusters(cases),
): Map<string, string> {
  const uf = new UnionFind(cases.length);
  const indexById = new Map(cases.map((c, i) => [c.id, i]));
  const firstByLabel = new Map<string, number>();
  const link = (label: string, index: number): void => {
    const first = firstByLabel.get(label);
    if (first === undefined) firstByLabel.set(label, index);
    else uf.union(first, index);
  };
  cases.forEach((c, index) => {
    if (c.cluster !== undefined) link(`cluster:${c.cluster}`, index);
    if (c.traceId !== undefined) link(`trace:${c.traceId}`, index);
  });
  for (const cluster of nearDuplicates.clusters) {
    const [head, ...rest] = cluster.caseIds.map((id) => indexById.get(id));
    for (const other of rest) {
      if (head !== undefined && other !== undefined) uf.union(head, other);
    }
  }
  return new Map(cases.map((c, index) => [c.id, cases[uf.find(index)]?.id ?? c.id]));
}

/**
 * Cluster-robust (CR1) SE of the mean: sqrt(G/(G−1) · Σ_g (Σ_{i∈g} (y_i − ȳ))² / n²).
 * Equals the naive s/√n when every cluster has size 1; null with reason single_cluster when G < 2.
 */
export function clusteredSE(
  values: readonly number[],
  clusterIds: readonly string[],
): ClusteredSEResult {
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const residualSums = new Map<string, number>();
  values.forEach((v, i) => {
    const id = clusterIds[i] ?? '';
    residualSums.set(id, (residualSums.get(id) ?? 0) + (v - mean));
  });
  const g = residualSums.size;
  if (g < 2) return { se: null, reason: 'single_cluster', n, nClusters: g };
  let meat = 0;
  for (const sum of residualSums.values()) meat += sum * sum;
  return { se: Math.sqrt(((g / (g - 1)) * meat) / (n * n)), n, nClusters: g };
}

/**
 * Paired per-case differences a − b with a clustered SE. Pairs by case id, ignores ids missing
 * from either side; an id absent from `clusterIds` is its own cluster.
 */
export function pairedClusteredDiff(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
  clusterIds: ReadonlyMap<string, string>,
): PairedClusteredDiffResult {
  const diffs: number[] = [];
  const ids: string[] = [];
  for (const [id, av] of a) {
    const bv = b.get(id);
    if (bv === undefined) continue;
    diffs.push(av - bv);
    ids.push(clusterIds.get(id) ?? `case:${id}`);
  }
  const nPairs = diffs.length;
  const meanDiff = nPairs === 0 ? null : diffs.reduce((sum, d) => sum + d, 0) / nPairs;
  const { se, reason, nClusters } = clusteredSE(diffs, ids);
  const ci95 =
    se === null || meanDiff === null ? null : ([meanDiff - Z95 * se, meanDiff + Z95 * se] as const);
  return reason === undefined
    ? { meanDiff, se, ci95, nPairs, nClusters }
    : { meanDiff, se, ci95, reason, nPairs, nClusters };
}
