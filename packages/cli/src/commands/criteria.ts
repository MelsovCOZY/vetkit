// `vet criteria disable|enable|delete|revalidate <id>` (bead mol-e3g): secondary criteria actions,
// so nobody hand-edits criteria.yaml and lets the lock drift. YAML edits go through @vetkit/core's
// Document-API helpers (comments and order kept); lock edits go through writeLockAtomic.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  formatCriteriaDocument,
  LOCK_FILE,
  markUncalibrated,
  parseCriteriaDocument,
  readLock,
  removeCriterion,
  removeLockEntry,
  setEnabled,
  writeLockAtomic,
  type CriteriaDocument,
  type EditResult,
} from '@vetkit/core';
import { CEV_ERROR_CODES, VetError, type Lock } from '@vetkit/spec';
import type { Command } from 'commander';
import { emit, getLogger } from '../output.ts';

interface CriteriaOptions {
  readonly criteria: string;
  readonly lock: string;
  readonly export?: string;
}

function check(result: EditResult): void {
  if (!result.ok) throw new VetError(result.code, result.message);
}

async function loadDocument(path: string): Promise<CriteriaDocument> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new VetError(CEV_ERROR_CODES.CONFIG_INVALID, `cannot read ${path}: ${String(cause)}`);
  }
  const parsed = parseCriteriaDocument(text);
  if (!parsed.ok) throw new VetError(parsed.code, `${path}: ${parsed.message}`);
  return parsed.doc;
}

async function loadLock(path: string): Promise<Lock> {
  const read = await readLock(path);
  if ('error' in read) throw read.error;
  return read;
}

function report(data: { files: string[] } & Record<string, unknown>): void {
  emit(data, () => data.files.join('\n'));
}

async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// A grep of evals/ (minus criteria.yaml and the lock) and the export dir for the id as a whole
// token: promoted cases, label files and exported vitest files that still name the criterion.
async function referencingFiles(id: string, options: CriteriaOptions): Promise<string[]> {
  const criteriaPath = resolve(options.criteria);
  const skip = new Set([criteriaPath, resolve(options.lock)]);
  const dirs = [resolve(criteriaPath, '..')];
  if (options.export !== undefined) dirs.push(resolve(options.export));
  const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`);
  const files = new Set<string>();
  for (const dir of dirs) {
    for (const file of await filesUnder(dir)) {
      if (skip.has(file)) continue;
      const text = await readFile(file, 'utf8').catch(() => '');
      if (pattern.test(text)) files.add(file);
    }
  }
  return [...files].toSorted();
}

async function toggle(id: string, enabled: boolean, options: CriteriaOptions): Promise<void> {
  const path = resolve(options.criteria);
  const doc = await loadDocument(path);
  check(setEnabled(doc, id, enabled));
  await writeFile(path, formatCriteriaDocument(doc));
  report({ [enabled ? 'enabled' : 'disabled']: id, files: [path] });
}

async function remove(id: string, options: CriteriaOptions): Promise<void> {
  const path = resolve(options.criteria);
  const lockPath = resolve(options.lock);
  const doc = await loadDocument(path);
  check(removeCriterion(doc, id));
  const lock = existsSync(lockPath) ? await loadLock(lockPath) : null;

  const refs = await referencingFiles(id, options);
  if (refs.length > 0) {
    getLogger().warn(`criterion '${id}' is still referenced by: ${refs.join(', ')}`);
  }
  await writeFile(path, formatCriteriaDocument(doc));
  const files = [path];
  if (lock !== null && Object.hasOwn(lock.criteria, id)) {
    await writeLockAtomic(lockPath, removeLockEntry(lock, id));
    files.push(lockPath);
  }
  report({ removed: id, files });
}

async function revalidate(id: string, options: CriteriaOptions): Promise<void> {
  const lockPath = resolve(options.lock);
  if (!existsSync(lockPath)) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `no ${LOCK_FILE} at ${lockPath}; run \`vet validate\` first`,
    );
  }
  const marked = markUncalibrated(await loadLock(lockPath), id);
  if (!marked.ok) throw new VetError(marked.code, marked.message);
  await writeLockAtomic(lockPath, marked.lock);
  report({ revalidate: id, files: [lockPath] });
}

function addPaths(command: Command): Command {
  return command
    .option('--criteria <file>', 'criteria file', 'evals/criteria.yaml')
    .option('--lock <path>', 'lock file', LOCK_FILE);
}

export function registerCriteria(program: Command): Command {
  const group = program
    .command('criteria')
    .description(
      'disable, enable, delete or revalidate one criterion in criteria.yaml and the lock',
    );
  addPaths(
    group.command('disable <id>').description('set enabled: false; vet run skips it'),
  ).action(async (id: string, options: CriteriaOptions) => {
    await toggle(id, false, options);
  });
  addPaths(group.command('enable <id>').description('remove enabled: false')).action(
    async (id: string, options: CriteriaOptions) => {
      await toggle(id, true, options);
    },
  );
  addPaths(group.command('delete <id>').description('remove it from criteria.yaml and the lock'))
    .option('--export <dir>', 'exported vitest dir to scan for references')
    .action(async (id: string, options: CriteriaOptions) => {
      await remove(id, options);
    });
  addPaths(
    group
      .command('revalidate <id>')
      .description('mark its lock entry uncalibrated until vet validate runs again'),
  ).action(async (id: string, options: CriteriaOptions) => {
    await revalidate(id, options);
  });
  return group;
}
