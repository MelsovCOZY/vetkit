// OpenAI strict-mode schema normalisation for the chat-completions dialect. The IR stays
// JSON Schema 2020-12; only the wire copy is rewritten, and a schema whose meaning the
// rewrite would change is rejected with GENERATOR_CAPABILITY instead.
import { VetError, type JsonSchema } from '@vetkit/spec';

type Json = Record<string, unknown>;

// Keywords OpenAI strict mode documents as unsupported. Source:
// https://developers.openai.com/api/docs/guides/structured-outputs ("Supported schemas").
// UNVERIFIED: the
// list was not re-read from the live page; reject only these and widen it once confirmed.
const UNSUPPORTED_KEYWORDS: readonly string[] = [
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'patternProperties',
  'unevaluatedProperties',
  'propertyNames',
  'unevaluatedItems',
  'contains',
  // Not in the documented list, but rewriting oneOf to anyOf changes its meaning.
  'oneOf',
];

const DEF_PREFIXES: readonly string[] = ['#/$defs/', '#/definitions/'];

function isRecord(x: unknown): x is Json {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function capability(message: string): VetError {
  return new VetError('GENERATOR_CAPABILITY', `OpenAI strict mode: ${message}`);
}

/** True when the schema already admits `null` (type, const, enum or an anyOf/oneOf branch). */
function allowsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return schema === true;
  const { type } = schema;
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  if (schema['const'] === null) return true;
  if (Array.isArray(schema['enum']) && schema['enum'].includes(null)) return true;
  for (const key of ['anyOf', 'oneOf']) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some(allowsNull)) return true;
  }
  return false;
}

function defName(ref: string): string | undefined {
  const prefix = DEF_PREFIXES.find((p) => ref.startsWith(p));
  if (prefix === undefined) return undefined;
  const first = ref.slice(prefix.length).split('/')[0] ?? '';
  return first.replaceAll('~1', '/').replaceAll('~0', '~');
}

// Collects every $ref under `node`, not descending into $defs/definitions blocks.
function collectRefs(node: unknown, acc: string[]): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
  } else if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') acc.push(value);
      else if (key !== '$defs' && key !== 'definitions') collectRefs(value, acc);
    }
  }
  return acc;
}

function assertNoRecursiveRef(root: Json): void {
  const defs: Json = {
    ...(isRecord(root['definitions']) ? root['definitions'] : {}),
    ...(isRecord(root['$defs']) ? root['$defs'] : {}),
  };
  const edges = new Map<string, string[]>();
  for (const [name, body] of Object.entries(defs)) edges.set(name, collectRefs(body, []));
  const allRefs = [collectRefs(root, []), ...edges.values()].flat();
  if (allRefs.includes('#')) throw capability('recursive "$ref" ("#") is not supported');

  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw capability(`recursive "$ref" through "#/$defs/${name}" is not supported`);
    }
    state.set(name, 'visiting');
    for (const ref of edges.get(name) ?? []) {
      const target = defName(ref);
      if (target !== undefined && edges.has(target)) visit(target);
    }
    state.set(name, 'done');
  };
  for (const name of edges.keys()) visit(name);
}

function nullable(schema: unknown): unknown {
  if (!isRecord(schema) || allowsNull(schema)) return schema;
  const plainType =
    typeof schema['type'] === 'string' &&
    !Object.hasOwn(schema, 'enum') &&
    !Object.hasOwn(schema, 'const') &&
    !Object.hasOwn(schema, '$ref');
  if (plainType) return { ...schema, type: [schema['type'], 'null'] };
  return { anyOf: [schema, { type: 'null' }] };
}

function normaliseChild(x: unknown): unknown {
  return isRecord(x) ? normaliseNode(x) : x;
}

function mapValues(x: Json): Json {
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, normaliseChild(v)]));
}

function normaliseNode(node: Json): Json {
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (Object.hasOwn(node, keyword)) throw capability(`unsupported keyword "${keyword}"`);
  }
  const out: Json = { ...node };

  if (node['type'] === 'object' || isRecord(node['properties'])) {
    const extra = node['additionalProperties'];
    if (extra !== undefined && typeof extra !== 'boolean') {
      throw capability(
        'a schema-valued "additionalProperties" (map-typed object) cannot be expressed',
      );
    }
    const props = isRecord(node['properties']) ? node['properties'] : {};
    const required = new Set(Array.isArray(node['required']) ? node['required'] : []);
    out['properties'] = Object.fromEntries(
      Object.entries(props).map(([key, value]) => {
        const normalised = normaliseChild(value);
        return [key, required.has(key) ? normalised : nullable(normalised)];
      }),
    );
    out['required'] = Object.keys(props);
    out['additionalProperties'] = false;
  }
  if (isRecord(node['items'])) out['items'] = normaliseNode(node['items']);
  if (Array.isArray(node['prefixItems']))
    out['prefixItems'] = node['prefixItems'].map(normaliseChild);
  if (Array.isArray(node['anyOf'])) out['anyOf'] = node['anyOf'].map(normaliseChild);
  if (isRecord(node['$defs'])) out['$defs'] = mapValues(node['$defs']);
  if (isRecord(node['definitions'])) out['definitions'] = mapValues(node['definitions']);
  return out;
}

/**
 * Pure: returns a normalised deep copy for OpenAI strict mode. Every object gets
 * `additionalProperties:false` and lists every property as required; a property that was
 * optional becomes nullable. Throws GENERATOR_CAPABILITY naming the keyword for anything
 * the rewrite cannot express (non-object root, recursive $ref, unsupported keywords,
 * map-typed objects).
 */
export function normaliseOpenAIStrict(schema: JsonSchema): JsonSchema {
  if (schema['type'] !== 'object') {
    throw capability('the root schema must be type "object"');
  }
  const copy: Json = structuredClone(schema);
  assertNoRecursiveRef(copy);
  return normaliseNode(copy);
}

function resolveRef(node: unknown, root: Json): unknown {
  let current = node;
  for (let depth = 0; depth < 32 && isRecord(current); depth += 1) {
    const ref = current['$ref'];
    if (typeof ref !== 'string') return current;
    const name = defName(ref);
    const defs = ref.startsWith('#/$defs/') ? root['$defs'] : root['definitions'];
    if (name === undefined || !isRecord(defs)) return current;
    current = defs[name];
  }
  return current;
}

function strip(value: unknown, schema: unknown, root: Json): unknown {
  const node = resolveRef(schema, root);
  if (!isRecord(node)) return value;
  if (Array.isArray(value)) {
    const items = node['items'];
    return isRecord(items) ? value.map((item) => strip(item, items, root)) : value;
  }
  const props = node['properties'];
  if (!isRecord(value) || !isRecord(props)) return value;
  const required = new Set(Array.isArray(node['required']) ? node['required'] : []);
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    const propSchema = props[key];
    if (propSchema === undefined) {
      out[key] = item;
      continue;
    }
    const dropNull =
      item === null && !required.has(key) && !allowsNull(resolveRef(propSchema, root));
    if (!dropNull) out[key] = strip(item, propSchema, root);
  }
  return out;
}

/**
 * Undoes the nullable rewrite on a model reply: drops a `null` on a property that was
 * optional in the caller's original schema and did not already allow `null`, so the reply
 * validates against that original schema. Returns a new value; the input is not mutated.
 */
export function stripNullOptionals(value: unknown, schema: JsonSchema): unknown {
  return strip(value, schema, schema);
}
