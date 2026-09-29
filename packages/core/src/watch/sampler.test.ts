import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEV_ERROR_CODES, safeParseJson, VetError, type NormalizedTrace } from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createSampler, hashToUnit } from './sampler.ts';
import type { InclusionRecord } from './types.ts';

let dir: string;
let inclusionPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vet-sampler-'));
  inclusionPath = join(dir, 'watch', 'inclusion.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function trace(
  traceId: string,
  overrides: Partial<NormalizedTrace['completeness']> = {},
): NormalizedTrace {
  return {
    traceId,
    spans: [],
    messages: [],
    dialect: 'openai',
    completeness: {
      contentCaptured: true,
      truncated: false,
      missingParents: false,
      ...overrides,
    },
  };
}

async function lines(file: string): Promise<InclusionRecord[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const parsed = safeParseJson<InclusionRecord>(l, {});
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    });
}

describe('hashToUnit', () => {
  test('vector: matches sha256 big-endian first-8-bytes / 2^64, computed independently from node:crypto', () => {
    const traceId = '0123456789abcdef0123456789abcdef';
    const digest = createHash('sha256').update(traceId).digest();
    const expected = Number(digest.readBigUInt64BE(0)) / 2 ** 64;
    expect(hashToUnit(traceId)).toBe(expected);
  });

  test('is within [0, 1)', () => {
    for (const id of ['a', 'b', 'trace-0', 'trace-9999']) {
      const u = hashToUnit(id);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

describe('createSampler', () => {
  test('sampleRate outside [0,1] throws VetError WATCH_CONFIG at factory time', () => {
    expect(() => createSampler({ sampleRate: 1.5, inclusionPath })).toThrow(
      expect.objectContaining({ code: CEV_ERROR_CODES.WATCH_CONFIG }),
    );
    expect(() => createSampler({ sampleRate: -0.1, inclusionPath })).toThrow(
      expect.objectContaining({ code: CEV_ERROR_CODES.WATCH_CONFIG }),
    );
    expect(VetError.isInstance(new VetError(CEV_ERROR_CODES.WATCH_CONFIG, 'x'))).toBe(true);
  });

  test('rate band: ~10% of 4,000 synthetic ids sampled, and each appended record carries inclusionProbability 0.05', async () => {
    const sampler = createSampler({ sampleRate: 0.1, upstreamSampleRate: 0.5, inclusionPath });
    let sampledCount = 0;
    // Binomial(4000, 0.1): sd = sqrt(4000*0.1*0.9) = 19, so 400 +/- 64 is +/-3.37 sd, as tight as 1000 +/- 100 at N=10,000.
    for (let i = 0; i < 4000; i += 1) {
      const { sampled } = sampler.decide(trace(`trace-${i}`));
      if (sampled) sampledCount += 1;
    }
    expect(sampledCount).toBeGreaterThanOrEqual(336);
    expect(sampledCount).toBeLessThanOrEqual(464);

    const records = await lines(inclusionPath);
    expect(records).toHaveLength(4000);
    for (const record of records) {
      expect(record.inclusionProbability).toBe(0.05);
      expect(record.evaluatorRate).toBe(0.1);
      expect(record.upstreamRate).toBe(0.5);
    }
  });

  test('determinism: the same trace id gets the same decision across two independent sampler instances', () => {
    const pathA = join(dir, 'a', 'inclusion.jsonl');
    const pathB = join(dir, 'b', 'inclusion.jsonl');
    const samplerA = createSampler({ sampleRate: 0.3, inclusionPath: pathA });
    const samplerB = createSampler({ sampleRate: 0.3, inclusionPath: pathB });
    for (let i = 0; i < 200; i += 1) {
      const id = `trace-${i}`;
      expect(samplerA.decide(trace(id)).sampled).toBe(samplerB.decide(trace(id)).sampled);
    }
  });

  test('same id decided twice by the same sampler yields the same decision', () => {
    const sampler = createSampler({ sampleRate: 0.3, inclusionPath });
    const first = sampler.decide(trace('stable-id'));
    const second = sampler.decide(trace('stable-id'));
    expect(second.sampled).toBe(first.sampled);
  });

  test("upstreamSampleRate omitted -> upstreamRate and inclusionProbability are 'unknown'", () => {
    const sampler = createSampler({ sampleRate: 0.5, inclusionPath });
    const { record } = sampler.decide(trace('t-unknown'));
    expect(record.upstreamRate).toBe('unknown');
    expect(record.inclusionProbability).toBe('unknown');
  });

  test("a trace with completeness.missingParents=true is 'filtered:incomplete', never sampled", () => {
    const sampler = createSampler({ sampleRate: 1, inclusionPath });
    const { sampled, record } = sampler.decide(
      trace('t-missing-parents', { missingParents: true }),
    );
    expect(sampled).toBe(false);
    expect(record.reason).toBe('filtered:incomplete');
  });

  test("a trace with completeness.contentCaptured=false is 'filtered:no_content', never sampled", () => {
    const sampler = createSampler({ sampleRate: 1, inclusionPath });
    const { sampled, record } = sampler.decide(trace('t-no-content', { contentCaptured: false }));
    expect(sampled).toBe(false);
    expect(record.reason).toBe('filtered:no_content');
  });

  test('each decide() appends exactly one InclusionRecord line synchronously', async () => {
    const sampler = createSampler({ sampleRate: 0.5, inclusionPath });
    sampler.decide(trace('t-1'));
    sampler.decide(trace('t-2'));
    const records = await lines(inclusionPath);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ traceId: 't-1' });
    expect(records[1]).toMatchObject({ traceId: 't-2' });
  });

  test('inclusionPath directory missing is created', async () => {
    const nested = join(dir, 'does', 'not', 'exist', 'yet', 'inclusion.jsonl');
    const sampler = createSampler({ sampleRate: 0.5, inclusionPath: nested });
    sampler.decide(trace('t-nested'));
    const records = await lines(nested);
    expect(records).toHaveLength(1);
  });
});
