// Secondary criteria actions: disable/enable, delete and revalidate. YAML edits go
// through the yaml Document API so comments and order survive (DECISION: Code conventions: one
// parser, IR-first), never string replacement. Lock edits are pure (Lock in, Lock out); the caller
// writes the result through writeLockAtomic, so wordingHash and datasetHash stay as validate wrote
// them. `enabled` is not part of the wording hash: disabling never stales the lock.
import { CEV_ERROR_CODES, type Lock } from '@vetkit/spec';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';

export type CriteriaDocument = Document.Parsed;

export type EditResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'CRITERIA_INVALID'; readonly message: string };

export type ParseCriteriaDocumentResult =
  | { readonly ok: true; readonly doc: CriteriaDocument }
  | { readonly ok: false; readonly code: 'CRITERIA_INVALID'; readonly message: string };

export type MarkUncalibratedResult =
  | { readonly ok: true; readonly lock: Lock }
  | { readonly ok: false; readonly code: 'CRITERIA_INVALID'; readonly message: string };

function invalid(message: string): { ok: false; code: 'CRITERIA_INVALID'; message: string } {
  return { ok: false, code: CEV_ERROR_CODES.CRITERIA_INVALID, message };
}

export function parseCriteriaDocument(text: string): ParseCriteriaDocumentResult {
  const doc = parseDocument(text);
  const [first] = doc.errors;
  if (first !== undefined) return invalid(`invalid YAML: ${first.message}`);
  return { ok: true, doc };
}

/** yaml's default line width, the same one the generate pipeline writes criteria.yaml with. */
export function formatCriteriaDocument(doc: CriteriaDocument): string {
  return doc.toString();
}

function findCriterion(
  doc: CriteriaDocument,
  id: string,
): { index: number; node: YAMLMap } | undefined {
  const list = doc.get('criteria');
  if (!isSeq(list)) return undefined;
  for (const [index, node] of list.items.entries()) {
    if (isMap(node) && node.get('id') === id) return { index, node };
  }
  return undefined;
}

function unknownId(id: string): EditResult {
  return invalid(`no criterion with id '${id}' in criteria.yaml`);
}

/** Disabling writes `enabled: false`; enabling removes the key (absent means enabled). */
export function setEnabled(doc: CriteriaDocument, id: string, enabled: boolean): EditResult {
  const found = findCriterion(doc, id);
  if (found === undefined) return unknownId(id);
  if (enabled) found.node.delete('enabled');
  else found.node.set('enabled', false);
  return { ok: true };
}

export function removeCriterion(doc: CriteriaDocument, id: string): EditResult {
  const found = findCriterion(doc, id);
  if (found === undefined) return unknownId(id);
  doc.deleteIn(['criteria', found.index]);
  return { ok: true };
}

export function removeLockEntry(lock: Lock, id: string): Lock {
  const criteria = Object.fromEntries(Object.entries(lock.criteria).filter(([key]) => key !== id));
  return { ...lock, criteria };
}

/** status 'uncalibrated' and no threshold: `vet run --gate` refuses it until `vet validate`. */
export function markUncalibrated(lock: Lock, id: string): MarkUncalibratedResult {
  const entry = lock.criteria[id];
  if (entry === undefined) return invalid(`criterion '${id}' has no entry in criteria.lock.json`);
  const { threshold: _cleared, ...rest } = entry;
  return {
    ok: true,
    lock: { ...lock, criteria: { ...lock.criteria, [id]: { ...rest, status: 'uncalibrated' } } },
  };
}
