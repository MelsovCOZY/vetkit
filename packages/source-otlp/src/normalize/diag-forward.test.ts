// normalizeTrace and otlpSource hand a dialect's extractMessages diags to the caller's onDiag.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { otlpSource } from '../index.ts';
import type { OtlpResource, OtlpSpan } from '../reader/index.ts';
import { buildSpanTree } from '../reader/tree.ts';
import type { DialectV1, OtlpDiag } from './dialect.ts';
import { normalizeTrace } from './index.ts';

const TRACE = '5b8efff798038103d269b633813fc60c';

function span(): OtlpSpan {
  return {
    traceId: TRACE,
    spanId: 'abcdef0123456789',
    name: 'chat',
    kind: 1,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
    attributes: {},
    events: [],
    links: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    status: { code: 0 },
    idEncoding: 'hex',
  };
}

const str = (stringValue: string) => ({ stringValue });

const resource: OtlpResource = { attributes: {} };

const noisyDialect: DialectV1 = {
  name: 'vercel',
  detect: () => true,
  isLlmSpan: () => true,
  extractMessages: (s, _tree, onDiag) => {
    onDiag?.({ code: 'unknown_role', level: 'warn', detail: `span ${s.spanId}: role "x"` });
    return [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }];
  },
  extractUsage: () => null,
  contentState: () => 'captured',
};

describe('normalizeTrace forwards extractMessages diags', () => {
  test('the diag reaches onDiag stamped with the trace id', () => {
    const diags: OtlpDiag[] = [];
    normalizeTrace(buildSpanTree([span()]), resource, [noisyDialect], (d) => diags.push(d));
    const forwarded = diags.filter((d) => d.code === 'unknown_role');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.traceId).toBe(TRACE);
    expect(forwarded[0]?.detail).toContain('abcdef0123456789');
  });

  test('a caller without onDiag is unaffected', () => {
    const trace = normalizeTrace(buildSpanTree([span()]), resource, [noisyDialect]);
    expect(trace.messages).toHaveLength(1);
  });
});

describe('otlpSource surfaces unknown-role diags', () => {
  test('a narrator role in a file yields one unknown_role diag on opts.onDiag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'otlp-diag-'));
    const file = join(dir, 'a.json');
    writeFileSync(
      file,
      JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: TRACE,
                    spanId: 'abcdef0123456789',
                    name: 'chat',
                    kind: 1,
                    startTimeUnixNano: '1700000000000000000',
                    endTimeUnixNano: '1700000001000000000',
                    attributes: [
                      { key: 'ai.operationId', value: str('ai.generateText.doGenerate') },
                      {
                        key: 'ai.prompt.messages',
                        value: str(JSON.stringify([{ role: 'narrator', content: 'hi' }])),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const diags: OtlpDiag[] = [];
    const source = otlpSource({ files: [file], onDiag: (d) => diags.push(d) });
    for await (const trace of source.doRead({})) expect(trace.messages[0]?.role).toBe('user');
    expect(diags.filter((d) => d.code === 'unknown_role')).toHaveLength(1);
  });
});
