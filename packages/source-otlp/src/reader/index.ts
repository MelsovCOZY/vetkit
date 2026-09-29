// OTLP/JSON reader: parses an ExportTraceServiceRequest through the safeParseJson chokepoint
// against otlp.schema.json, normalises ids to hex (base64 accepted, the encoding recorded per
// span), 64-bit nanos to decimal strings and AnyValue attributes to plain JSON. Plain JSON
// only, no OTel SDK dependency.

import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { CEV_ERROR_CODES, safeParseJson } from '@vetkit/spec';
import { flattenAttributes, type AnyValue, type RawKeyValue } from './anyvalue.ts';
import { otlpSchema } from './otlp.schema.ts';

export type { AnyValue } from './anyvalue.ts';

export type IdEncoding = 'hex' | 'base64';

export interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes: Record<string, AnyValue>;
  droppedAttributesCount: number;
}

export interface OtlpLink {
  traceId: string;
  spanId: string;
  attributes: Record<string, AnyValue>;
  droppedAttributesCount: number;
}

export interface OtlpStatus {
  code: number;
  message?: string;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AnyValue>;
  events: OtlpEvent[];
  links: OtlpLink[];
  droppedAttributesCount: number;
  droppedEventsCount: number;
  status: OtlpStatus;
  // 'base64' when any of this span's ids arrived base64-encoded and were rewritten to hex.
  idEncoding: IdEncoding;
}

export interface OtlpResource {
  attributes: Record<string, AnyValue>;
  schemaUrl?: string;
}

export interface OtlpScopeSpans {
  scope?: { name?: string; version?: string };
  schemaUrl?: string;
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

export interface OtlpDecodeError {
  field: 'traceId' | 'spanId' | 'parentSpanId' | 'links.traceId' | 'links.spanId';
  value: string;
  detail: string;
}

export type ReadOtlpResult =
  | { resourceSpans: OtlpResourceSpans[]; decodeErrors: OtlpDecodeError[]; warnings: string[] }
  | { error: typeof CEV_ERROR_CODES.OTLP_PARSE; detail: string };

export interface OtlpFileResult {
  file: string;
  results: ReadOtlpResult[];
}

// Wire shapes as validated by otlp.schema.json.
type Uint64 = string | number;
interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number | string;
  startTimeUnixNano: Uint64;
  endTimeUnixNano?: Uint64;
  attributes?: RawKeyValue[];
  droppedAttributesCount?: number;
  events?: {
    timeUnixNano?: Uint64;
    name?: string;
    attributes?: RawKeyValue[];
    droppedAttributesCount?: number;
  }[];
  droppedEventsCount?: number;
  links?: {
    traceId: string;
    spanId: string;
    attributes?: RawKeyValue[];
    droppedAttributesCount?: number;
  }[];
  status?: { code?: number | string; message?: string };
}
interface RawRequest {
  resourceSpans: {
    resource?: { attributes?: RawKeyValue[] };
    schemaUrl?: string;
    scopeSpans?: {
      scope?: { name?: string; version?: string };
      schemaUrl?: string;
      spans?: RawSpan[];
    }[];
  }[];
}

const SPAN_KINDS: Readonly<Record<string, number>> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};
const STATUS_CODES: Readonly<Record<string, number>> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

const HEX = /^[0-9a-fA-F]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

class IdError extends Error {}

// traceId is 16 bytes, spanId 8. Length disambiguates: a 16-char hex spanId is also valid
// base64, but it would decode to 12 bytes, not 8.
function normaliseId(value: string, bytes: number, seen: { base64: boolean }): string {
  if (value.length === bytes * 2 && HEX.test(value)) return value;
  if (BASE64.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === bytes) {
      seen.base64 = true;
      return decoded.toString('hex');
    }
  }
  throw new IdError(`not a ${bytes}-byte hex or base64 id`);
}

function nanos(value: Uint64): string {
  return BigInt(value).toString();
}

function enumCode(
  value: number | string | undefined,
  table: Readonly<Record<string, number>>,
): number {
  if (value === undefined) return 0;
  return typeof value === 'number' ? value : (table[value] ?? 0);
}

function convertSpan(
  raw: RawSpan,
  decodeErrors: OtlpDecodeError[],
  warnings: string[],
): OtlpSpan | undefined {
  const seen = { base64: false };
  let field: OtlpDecodeError['field'] = 'traceId';
  let value = raw.traceId;
  try {
    const traceId = normaliseId(raw.traceId, 16, seen);
    field = 'spanId';
    value = raw.spanId;
    const spanId = normaliseId(raw.spanId, 8, seen);
    let parentSpanId: string | undefined;
    if (raw.parentSpanId !== undefined && raw.parentSpanId !== '') {
      field = 'parentSpanId';
      value = raw.parentSpanId;
      parentSpanId = normaliseId(raw.parentSpanId, 8, seen);
    }
    const links: OtlpLink[] = [];
    for (const link of raw.links ?? []) {
      field = 'links.traceId';
      value = link.traceId;
      const linkTraceId = normaliseId(link.traceId, 16, seen);
      field = 'links.spanId';
      value = link.spanId;
      links.push({
        traceId: linkTraceId,
        spanId: normaliseId(link.spanId, 8, seen),
        attributes: flattenAttributes(link.attributes, warnings),
        droppedAttributesCount: link.droppedAttributesCount ?? 0,
      });
    }
    const start = nanos(raw.startTimeUnixNano);
    const status: OtlpStatus = { code: enumCode(raw.status?.code, STATUS_CODES) };
    if (raw.status?.message !== undefined) status.message = raw.status.message;
    return {
      traceId,
      spanId,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      name: raw.name,
      kind: enumCode(raw.kind, SPAN_KINDS),
      startTimeUnixNano: start,
      // A span without an end time is read as zero-length rather than rejected.
      endTimeUnixNano: raw.endTimeUnixNano === undefined ? start : nanos(raw.endTimeUnixNano),
      attributes: flattenAttributes(raw.attributes, warnings),
      events: (raw.events ?? []).map((e) => ({
        timeUnixNano: e.timeUnixNano === undefined ? '0' : nanos(e.timeUnixNano),
        name: e.name ?? '',
        attributes: flattenAttributes(e.attributes, warnings),
        droppedAttributesCount: e.droppedAttributesCount ?? 0,
      })),
      links,
      droppedAttributesCount: raw.droppedAttributesCount ?? 0,
      droppedEventsCount: raw.droppedEventsCount ?? 0,
      status,
      idEncoding: seen.base64 ? 'base64' : 'hex',
    };
  } catch (err) {
    if (!(err instanceof IdError)) throw err;
    decodeErrors.push({ field, value, detail: err.message });
    return undefined;
  }
}

function schemaDetail(cause: unknown): string {
  if (Array.isArray(cause)) {
    const first: unknown = cause[0];
    if (typeof first === 'object' && first !== null) {
      const path = 'instancePath' in first ? String(first.instancePath) : '';
      const message = 'message' in first ? String(first.message) : 'invalid';
      return `not an ExportTraceServiceRequest: ${path === '' ? '/' : path} ${message}`;
    }
  }
  return 'not an ExportTraceServiceRequest';
}

export function readOtlpJson(text: string): ReadOtlpResult {
  const parsed = safeParseJson<RawRequest>(text, otlpSchema);
  if (!parsed.ok) {
    const detail =
      parsed.error.code === CEV_ERROR_CODES.E_SCHEMA_INVALID
        ? schemaDetail(parsed.error.cause)
        : `not an ExportTraceServiceRequest: ${parsed.error.message}`;
    return { error: CEV_ERROR_CODES.OTLP_PARSE, detail };
  }
  const decodeErrors: OtlpDecodeError[] = [];
  const warnings: string[] = [];
  const resourceSpans = parsed.value.resourceSpans.map((rs): OtlpResourceSpans => {
    const resource: OtlpResource = {
      attributes: flattenAttributes(rs.resource?.attributes, warnings),
    };
    if (rs.schemaUrl !== undefined) resource.schemaUrl = rs.schemaUrl;
    return {
      resource,
      scopeSpans: (rs.scopeSpans ?? []).map((ss): OtlpScopeSpans => {
        const spans: OtlpSpan[] = [];
        for (const raw of ss.spans ?? []) {
          const span = convertSpan(raw, decodeErrors, warnings);
          if (span !== undefined) spans.push(span);
        }
        return {
          ...(ss.scope === undefined ? {} : { scope: ss.scope }),
          ...(ss.schemaUrl === undefined ? {} : { schemaUrl: ss.schemaUrl }),
          spans,
        };
      }),
    };
  });
  return { resourceSpans, decodeErrors, warnings };
}

// Every top-level *.json (one request) and *.jsonl (one request per non-blank line) file in
// name order, one yielded result per file.
export async function* readOtlpDir(dir: string): AsyncGenerator<OtlpFileResult> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && (extname(e.name) === '.json' || extname(e.name) === '.jsonl'))
    .map((e) => e.name)
    .toSorted();
  for (const name of names) {
    const file = join(dir, name);
    const text = await readFile(file, 'utf8');
    const results =
      extname(name) === '.jsonl'
        ? text
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => readOtlpJson(line))
        : [readOtlpJson(text)];
    yield { file, results };
  }
}
