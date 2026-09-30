// Schema versions of the three files vetkit reads and writes. Each format is versioned on its own:
// criteria.yaml and the run record carry `schemaVersion`, the lock keeps its `lockVersion`. A file
// with no version counts as version 1. A version bump ships with a changeset and a migrator that
// `vet migrate` runs; the readers refuse a newer file with a link to the migration page.
import { isMap, isScalar, parseDocument, type Document } from 'yaml';

export const SCHEMA_VERSIONS = { criteria: 1, lock: 1, runRecord: 1 } as const;

export type SchemaFormat = keyof typeof SCHEMA_VERSIONS;

export const MIGRATE_DOCS = 'https://melsovcozy.github.io/vetkit/docs/migrate.html';

export interface SchemaChange {
  readonly format: SchemaFormat;
  readonly version: number;
  readonly summary: string;
}

export const SCHEMA_CHANGELOG: readonly SchemaChange[] = [
  {
    format: 'criteria',
    version: 1,
    summary: 'criteria.yaml carries an optional top-level schemaVersion; absent means 1.',
  },
  {
    format: 'lock',
    version: 1,
    summary: 'criteria.lock.json carries lockVersion 1.',
  },
  {
    format: 'runRecord',
    version: 1,
    summary: 'The run record carries schemaVersion 1.',
  },
];

export interface CriteriaMigration {
  readonly from: number;
  readonly to: number;
  apply(doc: Document): void;
}

/** One step per version bump of criteria.yaml, applied in order by `vet migrate`. */
export const CRITERIA_MIGRATIONS: readonly CriteriaMigration[] = [];

const FIELD: Record<SchemaFormat, string> = {
  criteria: 'criteria.yaml schemaVersion',
  lock: 'criteria.lock.json lockVersion',
  runRecord: 'run record schemaVersion',
};

export type SchemaVersionCheck = { readonly ok: true } | { readonly ok: false; message: string };

/** Never throws. An absent version counts as 1. */
export function checkSchemaVersion(format: SchemaFormat, found: unknown): SchemaVersionCheck {
  if (found === undefined) return { ok: true };
  const current = SCHEMA_VERSIONS[format];
  const shown = JSON.stringify(found);
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return {
      ok: false,
      message: `${FIELD[format]} ${shown} is not a valid version (expected an integer from 1 to ${String(current)}); see ${MIGRATE_DOCS}`,
    };
  }
  if (found > current) {
    return {
      ok: false,
      message: `${FIELD[format]} ${shown} is newer than this vetkit supports (${String(current)}); upgrade vetkit or see ${MIGRATE_DOCS}`,
    };
  }
  return { ok: true };
}

export interface StampResult {
  readonly changed: boolean;
  readonly text: string;
  /** The version the document carried, or null when it had none. */
  readonly from: number | null;
}

/** Inserts `schemaVersion: 1` as the first key of criteria.yaml; a document that has one is untouched. */
export function stampCriteriaSchemaVersion(text: string): StampResult {
  const doc = parseDocument(text);
  const root = doc.contents;
  if (doc.errors.length > 0 || !isMap(root)) return { changed: false, text, from: null };
  if (root.has('schemaVersion')) {
    const found = root.get('schemaVersion');
    return { changed: false, text, from: typeof found === 'number' ? found : null };
  }
  // A comment block right above the first key belongs to the top of the file, not to that key.
  const [first] = root.items;
  const above = isScalar(first?.key) ? first.key.commentBefore : undefined;
  if (isScalar(first?.key)) first.key.commentBefore = null;
  root.add(doc.createPair('schemaVersion', SCHEMA_VERSIONS.criteria));
  const added = root.items.pop();
  if (added !== undefined) {
    if (isScalar(added.key) && above !== undefined) added.key.commentBefore = above;
    root.items.unshift(added);
  }
  return { changed: true, text: doc.toString(), from: null };
}
