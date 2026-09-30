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

// The criterion schema is a oneOf over `type`: the branch whose `type` const matches the
// value is the one the developer meant (-1 when `type` is missing or not a known type).
function typeBranches(): unknown[] {
  const branches: unknown = criterionSchema['oneOf'];
  return Array.isArray(branches) ? branches : [];
}

function branchIndexFor(type: unknown): number {
  return typeBranches().findIndex((branch: unknown) => {
    if (!isRecord(branch) || !isRecord(branch['properties'])) return false;
    const typeRule = branch['properties']['type'];
    return isRecord(typeRule) && typeRule['const'] === type;
  });
}

// Fields a type branch settles by itself: the ones it gives a schema of its own and the
// ones it forbids (`not: { anyOf: [{ required: [field] }] }`). The rule shared by all
// types can only repeat the branch there, or describe the shape of a field it forbids.
function settledFields(branch: unknown): Set<string> {
  const fields = new Set<string>();
  if (!isRecord(branch)) return fields;
  if (isRecord(branch['properties'])) {
    for (const [field, rule] of Object.entries(branch['properties'])) {
      if (rule !== true) fields.add(field);
    }
  }
  const forbidden: unknown = isRecord(branch['not']) ? branch['not']['anyOf'] : undefined;
  for (const rule of Array.isArray(forbidden) ? forbidden : []) {
    const required: unknown = isRecord(rule) ? rule['required'] : undefined;
    for (const field of Array.isArray(required) ? required : []) {
      if (typeof field === 'string') fields.add(field);
    }
  }
  return fields;
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

const TYPE_BRANCHES = '#/oneOf/';

// A nested oneOf (the `criteria` map-or-list, the `grader` kinds) fails with errors from
// every alternative. An alternative that rejects the value outright (wrong JSON type, or a
// different `kind` constant) is not the one the developer wrote, so its errors are dropped
// unless every alternative rejects it that way.
function otherAlternatives(errors: readonly AjvError[]): Set<AjvError> {
  const dropped = new Set<AjvError>();
  for (const wrapper of errors) {
    if (wrapper.keyword !== 'oneOf' || wrapper.schemaPath === '#/oneOf') continue;
    const alternatives = new Map<string, AjvError[]>();
    for (const error of errors) {
      if (!error.schemaPath.startsWith(`${wrapper.schemaPath}/`)) continue;
      const index = error.schemaPath.slice(wrapper.schemaPath.length + 1).split('/', 1)[0] ?? '';
      alternatives.set(index, [...(alternatives.get(index) ?? []), error]);
    }
    const rejected = [...alternatives.values()].filter((group) =>
      group.some(
        (e) =>
          e.keyword === 'const' ||
          (e.keyword === 'type' && e.instancePath === wrapper.instancePath),
      ),
    );
    if (rejected.length === alternatives.size) continue;
    for (const error of rejected.flat()) dropped.add(error);
  }
  return dropped;
}

const SHARED_FIELD = /^#\/properties\/([^/]+)\//;

// Every error is collected, so ajv also reports the type branches the criterion did not
// pick, and a wrapper line ("must match exactly one schema in oneOf", 'must match "then"
// schema') per failed combinator. Neither is something to act on: only the branch whose
// `type` const matches, plus the rules shared by all types, reach the developer.
function actionable(errors: readonly AjvError[], type: unknown): AjvError[] {
  const index = branchIndexFor(type);
  const own = `${TYPE_BRANCHES}${index}/`;
  const settled = settledFields(typeBranches()[index]);
  const other = otherAlternatives(errors);
  return errors.filter(
    (e) =>
      (!e.schemaPath.startsWith(TYPE_BRANCHES) || e.schemaPath.startsWith(own)) &&
      !settled.has(SHARED_FIELD.exec(e.schemaPath)?.[1] ?? '') &&
      e.keyword !== 'oneOf' &&
      e.keyword !== 'if' &&
      !other.has(e),
  );
}

function schemaIssues(base: string, item: Json, cause: unknown): CriteriaIssue[] {
  const errors = Array.isArray(cause) ? cause.filter((e: unknown) => isAjvError(e)) : [];
  const relevant = actionable(errors, item['type']);
  const chosen = relevant.length > 0 ? relevant : errors;
  if (chosen.length === 0) {
    return [{ code: CEV_ERROR_CODES.CRITERIA_INVALID, path: base, message: 'invalid criterion' }];
  }
  const seen = new Set<string>();
  return chosen.flatMap((error) => {
    const message = error.message ?? 'invalid value';
    const issue = {
      code: CEV_ERROR_CODES.CRITERIA_INVALID,
      path: `${base}${errorPath(error)}`,
      message:
        error.keyword === 'not'
          ? `field not allowed for a ${String(item['type'])} criterion (${message})`
          : message,
    };
    // Alternatives of a nested oneOf can each raise the same line (an unknown grader kind
    // fails the `kind` constant of every known kind).
    const line = `${issue.path}\n${issue.message}`;
    if (seen.has(line)) return [];
    seen.add(line);
    return [issue];
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
    const result = validateJson<Criterion>(candidate, criterionSchema, { allErrors: true });
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
