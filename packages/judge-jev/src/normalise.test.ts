import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { safeParseJson, VetError, type Question } from '@vetkit/spec';
import { normalise } from './normalise.ts';

// Loads a JSON fixture from this package's own fixtures/ directory. safeParseJson is the
// one JSON.parse chokepoint (packages/spec/src/json.ts); an empty schema `{}`
// matches any JSON value, so this is parsing, not validation — normalise() does its
// own schema validation on the value this returns.
function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const text = readFileSync(path, 'utf8');
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected an object');
  }
  // Guarded by the typeof/null check above; mirrors the trusted-boundary cast
  // pattern in packages/spec/src/json.ts.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Record<string, unknown>;
}

// Deep-clones a loaded fixture and deletes one nested field, so a test can assert
// normalise()'s fallback behaviour (confidence lift, legend fill) without mutating
// the fixture other tests read.
function withFieldDeleted(root: unknown, path: readonly [string, string, string]): unknown {
  const clone = structuredClone(root);
  const [outerKey, midKey, leafKey] = path;
  const outer = asMutableRecord(clone);
  const mid = asMutableRecord(outer[outerKey]);
  const leaf = asMutableRecord(mid[midKey]);
  delete leaf[leafKey];
  return clone;
}

function catchVetError(fn: () => unknown): VetError {
  try {
    fn();
  } catch (err) {
    if (VetError.isInstance(err)) return err;
    throw err;
  }
  throw new Error('expected normalise() to throw');
}

function probabilitySum(probabilities: Record<string, number>): number {
  return Object.values(probabilities).reduce((sum, value) => sum + value, 0);
}

// Mirrors the gateway request fixture's `questions` map, translated into the IR
// `Question` shape (noul -> boolean); this is what `requested.questions` carries in a
// real call.
const REQUESTED_QUESTIONS: Record<string, Question> = {
  promised_refund: {
    type: 'boolean',
    instructions: 'Did the assistant promise or issue a refund?',
  },
  tone: {
    type: 'choice',
    instructions: "What is the assistant's tone?",
    criteria: {
      helpful: 'Polite and solves the problem',
      rude: 'Dismissive or insulting',
      neutral: 'Neither warm nor rude',
    },
  },
  quality: {
    type: 'score',
    instructions: 'Rate the overall answer quality.',
    criteria: ['Wrong or harmful', 'Poor', 'Acceptable', 'Good', 'Excellent'],
  },
};

const REQUESTED = { model: 'typesafe-ai/jev', questions: REQUESTED_QUESTIONS };

describe('normalise() — run1 fixture (vercel preset)', () => {
  const run1 = loadFixture('2026-09-25-gateway-systemone-response-run1.json');
  const response = normalise(run1, REQUESTED, 'vercel');

  test('promised_refund (noul) becomes a boolean answer with the noul value as probability', () => {
    expect(response.answers['promised_refund']).toEqual({ type: 'boolean', probability: 0.98 });
  });

  test('tone (choice) keeps its inline confidence and probabilities sum to 1±0.01', () => {
    const tone = response.answers['tone'];
    expect(tone?.type).toBe('choice');
    if (tone?.type !== 'choice') throw new Error('expected a choice answer');
    expect(tone.confidence).toBe(0.96);
    expect(probabilitySum(tone.probabilities)).toBeCloseTo(1, 1);
  });

  test('quality (score) keeps its inline confidence and legend keys 0..4', () => {
    const quality = response.answers['quality'];
    expect(quality?.type).toBe('score');
    if (quality?.type !== 'score') throw new Error('expected a score answer');
    expect(quality.confidence).toBe(0.26);
    expect(Object.keys(quality.legend).toSorted()).toEqual(['0', '1', '2', '3', '4']);
  });

  test('model carries requested/resolved/transport/pinned/provider from the vercel preset and finalProvider', () => {
    expect(response.model).toMatchObject({
      requested: 'typesafe-ai/jev',
      resolved: 'typesafe-ai/jev',
      transport: 'vercel',
      pinned: false,
      provider: 'typesafe-ai',
    });
  });

  test('provider comes from provider_metadata.gateway.routing.finalProvider, not resolvedProvider', () => {
    // This fixture's own resolvedProvider is "digitalocean" while finalProvider is
    // "typesafe-ai" — asserting the field name, not just a value,
    // so a future fixture edit that removes the disagreement doesn't silently pass.
    const rawGateway = asMutableRecord(
      asMutableRecord(asMutableRecord(run1)['provider_metadata'])['gateway'],
    );
    const rawRouting = asMutableRecord(rawGateway['routing']);
    expect(rawRouting['resolvedProvider']).not.toBe(rawRouting['finalProvider']);
    expect(response.model.provider).toBe(rawRouting['finalProvider']);
  });

  test('model carries credentialType from the successful provider attempt (run1: "system")', () => {
    expect(response.model).toMatchObject({ credentialType: 'system' });
  });
});

describe('normalise() — run2 fixture', () => {
  test('loads run2 and keeps its own per-fixture confidence values', () => {
    const run2 = loadFixture('2026-09-25-gateway-systemone-response-run2.json');
    const response = normalise(run2, REQUESTED, 'vercel');

    const tone = response.answers['tone'];
    const quality = response.answers['quality'];
    if (tone?.type !== 'choice' || quality?.type !== 'score') {
      throw new Error('expected choice and score answers');
    }
    expect(tone.confidence).toBe(0.97);
    expect(quality.confidence).toBe(0.01);
  });
});

describe('normalise() — confidence lift', () => {
  test('lifts a missing inline confidence from provider_metadata.typesafe.confidence', () => {
    const run1 = loadFixture('2026-09-25-gateway-systemone-response-run1.json');
    const withoutInlineConfidence = withFieldDeleted(run1, ['answers', 'tone', 'confidence']);

    const response = normalise(withoutInlineConfidence, REQUESTED, 'vercel');

    const tone = response.answers['tone'];
    if (tone?.type !== 'choice') throw new Error('expected a choice answer');
    expect(tone.confidence).toBe(0.96);
  });
});

describe('normalise() — legend fill', () => {
  test('fills a missing legend from the requested score question criteria (index -> text)', () => {
    const run1 = loadFixture('2026-09-25-gateway-systemone-response-run1.json');
    const withoutLegend = withFieldDeleted(run1, ['answers', 'quality', 'legend']);

    const response = normalise(withoutLegend, REQUESTED, 'vercel');

    const quality = response.answers['quality'];
    if (quality?.type !== 'score') throw new Error('expected a score answer');
    expect(quality.legend).toEqual({
      '0': 'Wrong or harmful',
      '1': 'Poor',
      '2': 'Acceptable',
      '3': 'Good',
      '4': 'Excellent',
    });
  });
});

describe('normalise() — TypeSafe-direct style response (synthetic)', () => {
  test('normalises with pinned:true and provider undefined when provider_metadata is absent', () => {
    const typesafeDirectRaw = {
      model: 'jev-1.13.0',
      answers: {
        promised_refund: { type: 'noul', noul: 0.91 },
        tone: {
          type: 'choice',
          choice: 'helpful',
          confidence: 0.9,
          probabilities: { helpful: 0.9, neutral: 0.1 },
        },
      },
      usage: { input_tokens: 50, output_tokens: 12 },
    };

    const response = normalise(typesafeDirectRaw, REQUESTED, 'typesafe');

    expect(response.model.pinned).toBe(true);
    expect(response.model.provider).toBeUndefined();
    expect(response.model.resolved).toBe('jev-1.13.0');
  });

  test('credentialType is undefined when provider_metadata is absent', () => {
    const typesafeDirectRaw = {
      model: 'jev-1.13.0',
      answers: {
        promised_refund: { type: 'noul', noul: 0.91 },
      },
      usage: { input_tokens: 50, output_tokens: 12 },
    };

    const response = normalise(typesafeDirectRaw, REQUESTED, 'typesafe');

    expect(response.model.credentialType).toBeUndefined();
  });
});

describe('normalise() — bad shapes', () => {
  test('a response missing "answers" throws VetError JUDGE_BAD_RESPONSE', () => {
    const err = catchVetError(() => normalise({ model: 'x' }, REQUESTED, 'vercel'));
    expect(err.code).toBe('JUDGE_BAD_RESPONSE');
  });

  test('a choice answer missing "probabilities" throws VetError JUDGE_BAD_RESPONSE', () => {
    const badRaw = {
      model: 'x',
      answers: { tone: { type: 'choice', choice: 'helpful', confidence: 0.9 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const err = catchVetError(() => normalise(badRaw, REQUESTED, 'vercel'));
    expect(err.code).toBe('JUDGE_BAD_RESPONSE');
  });
});

function gatewayBody(routing: unknown, model?: string): Record<string, unknown> {
  return {
    ...(model === undefined ? {} : { model }),
    answers: { promised_refund: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 1, output_tokens: 1 },
    provider_metadata: { gateway: { routing } },
  };
}

describe('normalise() — served model id (model.resolved)', () => {
  test('resolved is routing.canonicalSlug when it differs from the echoed model', () => {
    const body = gatewayBody({ canonicalSlug: 'typesafe-ai/jev-1.13-20260917' }, 'typesafe-ai/jev');
    const response = normalise(body, REQUESTED, 'vercel');
    expect(response.model.resolved).toBe('typesafe-ai/jev-1.13-20260917');
    expect(response.model.requested).toBe('typesafe-ai/jev');
  });

  test('resolved falls back to the wire model without routing metadata', () => {
    const body = {
      model: 'typesafe/jev-1.13-20260917',
      answers: { promised_refund: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    expect(normalise(body, REQUESTED, 'openrouter').model.resolved).toBe(
      'typesafe/jev-1.13-20260917',
    );
  });

  test('resolved falls back to the requested model when the body has neither', () => {
    const body = gatewayBody({ finalProvider: 'typesafe-ai' });
    expect(normalise(body, REQUESTED, 'vercel').model.resolved).toBe('typesafe-ai/jev');
  });

  test('an empty-string canonicalSlug is ignored', () => {
    const body = gatewayBody({ canonicalSlug: '' }, 'typesafe-ai/jev-echo');
    expect(normalise(body, REQUESTED, 'vercel').model.resolved).toBe('typesafe-ai/jev-echo');
  });

  test('the per-attempt modelAttempts canonicalSlug is not consulted', () => {
    const body = gatewayBody(
      { modelAttempts: [{ canonicalSlug: 'other/model' }] },
      'typesafe-ai/jev-echo',
    );
    expect(normalise(body, REQUESTED, 'vercel').model.resolved).toBe('typesafe-ai/jev-echo');
  });

  test('the run1 gateway fixture resolves to its canonicalSlug', () => {
    const run1 = loadFixture('2026-09-25-gateway-systemone-response-run1.json');
    const routing = asMutableRecord(
      asMutableRecord(asMutableRecord(run1)['provider_metadata'])['gateway'],
    )['routing'];
    const slug = asMutableRecord(routing)['canonicalSlug'];
    expect(slug).toBe('typesafe-ai/jev');
    expect(normalise(run1, REQUESTED, 'vercel').model.resolved).toBe(slug);
  });
});
