// parseIr(text, schema) wraps safeParseJson (packages/spec/src/json.ts) and remaps its
// ParseResult<T> = {ok:true;value}|{ok:false;error:VetError} into a plain, dependency-free
// discriminated shape: {ok:true;value:T}|{ok:false;issues:Array<{path;message}>}. This is
// the shape the J1 contract's acceptance criteria describe as "safeParseJson(text, schema)
// returns a discriminated {ok:true,value}|{ok:false,issues[]}"; json.ts's actual
// safeParseJson returns {ok:false,error:VetError} instead (error.cause is either an ajv
// ErrorObject[] on a schema-validation failure, or the JSON.parse exception on a parse
// failure), so this file is the one place that mapping happens. json.ts itself is
// untouched — parseIr never throws, exactly like the function it wraps.
import type { ErrorObject } from 'ajv/dist/2020.js';
import { safeParseJson, type JsonSchema } from '../src/json.ts';

export interface ParseIrIssue {
  readonly path: string;
  readonly message: string;
}

export type ParseIrResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: ParseIrIssue[] };

function isAjvErrors(cause: unknown): cause is ErrorObject[] {
  return Array.isArray(cause);
}

function toIssues(cause: unknown): ParseIrIssue[] {
  if (isAjvErrors(cause)) {
    return cause.map((error) => ({
      path: error.instancePath.length > 0 ? error.instancePath : '/',
      message: error.message ?? 'invalid',
    }));
  }
  const message = cause instanceof Error ? cause.message : 'invalid JSON';
  return [{ path: '/', message }];
}

export function parseIr<T>(text: string, schema: JsonSchema): ParseIrResult<T> {
  const result = safeParseJson<T>(text, schema);
  if (result.ok) {
    return { ok: true, value: result.value };
  }
  return { ok: false, issues: toIssues(result.error.cause) };
}
