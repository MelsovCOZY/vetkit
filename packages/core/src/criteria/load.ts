// Loads the developer's hand-written criteria.yaml into validated Criterion[].
// Failures are data, never throws. YAML goes through
// yaml@2, then the spec validator (validateJson + criterionSchema), never a copy of
// the schema. wordingHash is computed here and is the only wording hash the cache and
// the lock use; any value written in the YAML is overwritten.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import {
  CEV_ERROR_CODES,
  criterionSchema,
  validateJson,
  type CevErrorCode,
  type Criterion,
} from '@vetkit/spec';
import { checkSchemaVersion } from '../schema-version.ts';

export interface CriteriaIssue {
  readonly code: CevErrorCode;
  /** JSON Pointer into the parsed document, e.g. `/criteria/0/escape`. */
  readonly path: string;
  readonly message: string;
  /** The other location of a duplicate id. */
  readonly relatedPath?: string;
}

export type LoadCriteriaResult =
  | { readonly ok: true; readonly criteria: Criterion[] }
  | { readonly ok: false; readonly issues: CriteriaIssue[] };

export type WordingFields = Pick<Criterion, 'type' | 'instructions' | 'criteria' | 'escape'>;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normaliseText(value: unknown): unknown {
  return typeof value === 'string' ? value.replaceAll('\r\n', '\n').trim() : value;
}

function normaliseCriteria(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => normaliseText(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normaliseText(v)]));
  }
  return value;
}

// Fixed key order, absent fields dropped by JSON.stringify, strings LF-normalised and
// trimmed, criteria map order kept (option order is part of the wording Jev sees).
function hashWording(fields: Json): string {
  const subset = {
    type: fields['type'],
    instructions: normaliseText(fields['instructions']),
    criteria: normaliseCriteria(fields['criteria']),
    escape: normaliseText(fields['escape']),
  };
  return createHash('sha256').update(JSON.stringify(subset)).digest('hex');
}

export function computeWordingHash(fields: WordingFields): string {
  return hashWording({ ...fields });
}

function pointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

interface AjvError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly params: Json;
  readonly message?: string;
}

function isAjvError(value: unknown): value is AjvError {
  return (
    isRecord(value) &&
    typeof value['instancePath'] === 'string' &&
    typeof value['schemaPath'] === 'string' &&
    typeof value['keyword'] === 'string' &&
    isRecord(value['params'])
  );
}

// The criterion schema is a oneOf over `type`; ajv reports every failed branch, so only
// the branch whose `type` const matches the value is relevant to the developer.
function branchIndexFor(type: unknown): number {
  const branches: unknown = criterionSchema['oneOf'];
  if (!Array.isArray(branches)) return -1;
  return branches.findIndex((branch: unknown) => {
    if (!isRecord(branch) || !isRecord(branch['properties'])) return false;
    const typeRule = branch['properties']['type'];
    return isRecord(typeRule) && typeRule['const'] === type;
  });
}

function errorPath(error: AjvError): string {
  const { missingProperty, additionalProperty } = error.params;
  if (error.keyword === 'required' && typeof missingProperty === 'string') {
    return `${error.instancePath}/${pointerToken(missingProperty)}`;
  }
  if (error.keyword === 'additionalProperties' && typeof additionalProperty === 'string') {
    return `${error.instancePath}/${pointerToken(additionalProperty)}`;
  }
  return error.instancePath;
}

function schemaIssues(base: string, item: Json, cause: unknown): CriteriaIssue[] {
  const errors = Array.isArray(cause) ? cause.filter((e: unknown) => isAjvError(e)) : [];
  const branch = branchIndexFor(item['type']);
  const prefix = `#/oneOf/${branch}/`;
  const inBranch = errors.filter((e) => e.schemaPath.startsWith(prefix));
  const relevant = inBranch.length > 0 ? inBranch : errors.filter((e) => e.keyword !== 'oneOf');
  const chosen = relevant.length > 0 ? relevant : errors;
  if (chosen.length === 0) {
    return [{ code: CEV_ERROR_CODES.CRITERIA_INVALID, path: base, message: 'invalid criterion' }];
  }
  return chosen.map((error) => {
    const message = error.message ?? 'invalid value';
    return {
      code: CEV_ERROR_CODES.CRITERIA_INVALID,
      path: `${base}${errorPath(error)}`,
      message:
        error.keyword === 'not'
          ? `field not allowed for a ${String(item['type'])} criterion (${message})`
          : message,
    };
  });
}

function passWhenIssues(base: string, criterion: Criterion): CriteriaIssue[] {
  if (criterion.type !== 'choice' || criterion.passWhen === undefined) return [];
  const keys = isRecord(criterion.criteria) ? criterion.criteria : {};
  return criterion.passWhen.flatMap((value, index) =>
    Object.hasOwn(keys, value)
      ? []
      : [
          {
            code: CEV_ERROR_CODES.CRITERIA_INVALID,
            path: `${base}/passWhen/${index}`,
            message: `criterion '${criterion.id}': passWhen value '${value}' is not a key of its criteria map`,
          },
        ],
  );
}

function fail(code: CevErrorCode, path: string, message: string): LoadCriteriaResult {
  return { ok: false, issues: [{ code, path, message }] };
}

export async function loadCriteria(file: string): Promise<LoadCriteriaResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    return fail(CEV_ERROR_CODES.E_IO, '', `cannot read ${file}: ${String(cause)}`);
  }

  let root: unknown;
  try {
    const doc = parseDocument(text);
    const [first] = doc.errors;
    if (first !== undefined) {
      return fail(CEV_ERROR_CODES.CRITERIA_INVALID, '', `invalid YAML: ${first.message}`);
    }
    root = doc.toJS();
  } catch (cause) {
    return fail(CEV_ERROR_CODES.CRITERIA_INVALID, '', `invalid YAML: ${String(cause)}`);
  }

  if (!isRecord(root) || !Array.isArray(root['criteria'])) {
    return fail(
      CEV_ERROR_CODES.CRITERIA_INVALID,
      '/criteria',
      'expected a top-level criteria list',
    );
  }
  const version = checkSchemaVersion('criteria', root['schemaVersion']);
  if (!version.ok) return fail(CEV_ERROR_CODES.CRITERIA_INVALID, '/schemaVersion', version.message);
  const items: unknown[] = root['criteria'];

  const issues: CriteriaIssue[] = [];
  const criteria: Criterion[] = [];
  const firstById = new Map<string, string>();

  for (const [index, item] of items.entries()) {
    const base = `/criteria/${index}`;
    if (!isRecord(item)) {
      issues.push({
        code: CEV_ERROR_CODES.CRITERIA_INVALID,
        path: base,
        message: 'must be an object',
      });
      continue;
    }

    // Deduped after parse, so anchors/aliases cannot smuggle a second copy of an id.
    const id = item['id'];
    if (typeof id === 'string') {
      const idPath = `${base}/id`;
      const firstPath = firstById.get(id);
      if (firstPath === undefined) {
        firstById.set(id, idPath);
      } else {
        issues.push({
          code: CEV_ERROR_CODES.CRITERIA_INVALID,
          path: idPath,
          relatedPath: firstPath,
          message: `duplicate criterion id '${id}' (first defined at ${firstPath})`,
        });
      }
    }

    // A fresh object per entry: aliases share one parsed object.
    const candidate = { ...item, wordingHash: hashWording(item) };
    const result = validateJson<Criterion>(candidate, criterionSchema);
    if (!result.ok) {
      issues.push(...schemaIssues(base, item, result.error.cause));
      continue;
    }
    const passWhen = passWhenIssues(base, result.value);
    if (passWhen.length > 0) {
      issues.push(...passWhen);
      continue;
    }
    criteria.push(result.value);
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, criteria };
}
