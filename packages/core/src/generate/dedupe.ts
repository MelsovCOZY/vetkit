// Criteria dedupe: a deterministic similarity pre-filter picks the candidate pairs worth
// asking about, then Jev answers one choice question per candidate in each similar group
// ("which earlier criterion does this duplicate, or none"), always with the escape 'none'.
// Jev never writes text: a duplicate is dropped and its trace ids merge into the survivor.
import type { Answer, Criterion, JudgeV1, Question } from '@vetkit/spec';
import type { Events } from '../events.ts';

/** Word-5-gram shingle Jaccard at or above this qualifies a pair. */
export const SHINGLE_JACCARD_MIN = 0.5;
/** Normalised edit similarity above this qualifies a pair. */
export const EDIT_SIMILARITY_MIN = 0.8;
/** A duplicate is removed when Jev's probability for it is at least this. */
export const DUPLICATE_PROBABILITY_MIN = 0.8;
/** Candidates per Jev request (choice questions allow ≤255 options). */
export const MAX_GROUP_SIZE = 50;

const NONE = 'none';
const NONE_TEXT = 'None: it asks something different from every earlier criterion listed.';

export interface DedupeCriteriaInput {
  readonly judge: JudgeV1;
  readonly candidates: readonly Criterion[];
  readonly signal?: AbortSignal;
  readonly events?: Events;
}

export interface DuplicateRecord {
  readonly id: string;
  readonly duplicateOf: string;
  readonly probability: number;
}

export interface DedupeCriteriaResult {
  readonly kept: Criterion[];
  readonly duplicates: DuplicateRecord[];
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}

function shingles(text: string): Set<string> {
  const words = text.split(' ').filter((w) => w !== '');
  if (words.length < 5) return new Set([words.join(' ')]);
  const out = new Set<string>();
  for (let i = 0; i + 5 <= words.length; i += 1) out.add(words.slice(i, i + 5).join(' '));
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const s of a) if (b.has(s)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return 1 - (prev[b.length] ?? longest) / longest;
}

/** Connected components (size ≥ 2) of the similarity graph within each channel, in input order. */
function similarGroups(candidates: readonly Criterion[]): number[][] {
  const texts = candidates.map((c) => normalise(c.instructions));
  const grams = texts.map((t) => shingles(t));
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (candidates[i]?.channel !== candidates[j]?.channel) continue;
      const a = texts[i] ?? '';
      const b = texts[j] ?? '';
      const similar =
        jaccard(grams[i] ?? new Set(), grams[j] ?? new Set()) >= SHINGLE_JACCARD_MIN ||
        editSimilarity(a, b) > EDIT_SIMILARITY_MIN;
      if (similar) parent[Math.max(find(i), find(j))] = Math.min(find(i), find(j));
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i += 1) {
    const root = find(i);
    byRoot.set(root, [...(byRoot.get(root) ?? []), i]);
  }
  return [...byRoot.values()].filter((g) => g.length >= 2);
}

/** Groups packed into requests of at most MAX_GROUP_SIZE candidates; big groups are split. */
function batches(groups: readonly number[][]): number[][][] {
  const chunks = groups.flatMap((g) => {
    const out: number[][] = [];
    for (let i = 0; i < g.length; i += MAX_GROUP_SIZE) out.push(g.slice(i, i + MAX_GROUP_SIZE));
    return out.filter((c) => c.length >= 2);
  });
  const out: number[][][] = [];
  let current: number[][] = [];
  let size = 0;
  for (const chunk of chunks) {
    if (size + chunk.length > MAX_GROUP_SIZE && current.length > 0) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(chunk);
    size += chunk.length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function duplicateProbability(answer: Answer | undefined): { choice: string; p: number } {
  if (answer?.type !== 'choice') return { choice: NONE, p: 0 };
  return { choice: answer.choice, p: answer.probabilities[answer.choice] ?? answer.confidence };
}

export async function dedupeCriteria(input: DedupeCriteriaInput): Promise<DedupeCriteriaResult> {
  const { judge, candidates, signal, events } = input;
  const duplicateOf = new Map<string, DuplicateRecord>();

  for (const batch of batches(similarGroups(candidates))) {
    const members = batch.flat().flatMap((i) => candidates[i] ?? []);
    const state = [
      'Candidate evaluation criteria:',
      ...members.map((c) => `- [${c.id}] ${c.instructions}`),
    ].join('\n');
    const questions: Record<string, Question> = {};
    const options = new Map<string, ReadonlySet<string>>();
    for (const chunk of batch) {
      const group = chunk.flatMap((i) => candidates[i] ?? []);
      for (const [p, c] of group.entries()) {
        if (p === 0 || c.id === NONE) continue;
        const earlier = group.slice(0, p).filter((e) => e.id !== NONE);
        options.set(c.id, new Set(earlier.map((e) => e.id)));
        questions[c.id] = {
          type: 'choice',
          instructions: `Which earlier criterion listed does criterion [${c.id}] duplicate, asking the same question in other words, or none?`,
          criteria: {
            ...Object.fromEntries(earlier.map((e) => [e.id, e.instructions])),
            [NONE]: NONE_TEXT,
          },
        };
      }
    }
    if (options.size === 0) continue;
    const res = await judge.doJudge({
      state,
      questions,
      ...(signal === undefined ? {} : { signal }),
    });
    for (const [id, earlier] of options) {
      const { choice, p } = duplicateProbability(res.answers[id]);
      if (!earlier.has(choice)) continue;
      if (p >= DUPLICATE_PROBABILITY_MIN)
        duplicateOf.set(id, { id, duplicateOf: choice, probability: p });
    }
  }

  // Resolve chains to the surviving criterion and merge trace ids into it.
  const root = (id: string): string => {
    let at = id;
    for (let rec = duplicateOf.get(at); rec !== undefined; rec = duplicateOf.get(at))
      at = rec.duplicateOf;
    return at;
  };
  const merged = new Map<string, string[]>();
  for (const c of candidates) {
    const r = root(c.id);
    merged.set(r, [...(merged.get(r) ?? []), ...c.provenance.traceIds]);
  }
  const kept = candidates
    .filter((c) => !duplicateOf.has(c.id))
    .map((c) => ({
      ...c,
      provenance: {
        ...c.provenance,
        traceIds: [...new Set(merged.get(c.id) ?? c.provenance.traceIds)],
      },
    }));
  const duplicates = [...duplicateOf.values()];
  if (duplicates.length > 0) {
    events?.diag('info', 'DUPLICATE_CRITERION', 'merged candidates Jev judged duplicate', {
      removed: duplicates.length,
    });
  }
  return { kept, duplicates };
}
