// Merges .env files into an injected env object with Node's `process.loadEnvFile` rules: a
// name already present (even as '') is never overwritten. `.env.local` is applied before
// `.env`, so under never-overwrite it wins. Pure: no logging and no implicit process.env;
// the reports carry names and paths only, never values.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export interface EnvFileReport {
  readonly path: string;
  /** Names that were absent from env before and were set from this file. */
  readonly applied: readonly string[];
  /** Set when an existing file could not be read; names the path only. */
  readonly error?: string;
}

export interface ApplyEnvFilesOptions {
  readonly dir: string;
  /** Mutated in place. */
  readonly env: Record<string, string | undefined>;
  /** Applied in order; defaults to ['.env.local', '.env']. */
  readonly files?: readonly string[];
}

const DEFAULT_FILES = ['.env.local', '.env'] as const;

let enabled = true;

// Called once per invocation (commander preAction), like output.ts's configureOutput.
export function configureEnvFiles(options: { readonly enabled: boolean }): void {
  enabled = options.enabled;
}

export function isEnvFilesEnabled(): boolean {
  return enabled;
}

function applyOne(path: string, env: Record<string, string | undefined>): EnvFileReport {
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return { path, applied: [], error: `cannot read ${path}` };
  }
  const applied: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (value === undefined || env[name] !== undefined) continue;
    env[name] = value;
    applied.push(name);
  }
  return { path, applied };
}

export function applyEnvFiles(options: ApplyEnvFilesOptions): EnvFileReport[] {
  if (!enabled) return [];
  const reports: EnvFileReport[] = [];
  for (const name of options.files ?? DEFAULT_FILES) {
    const path = join(options.dir, name);
    if (existsSync(path)) reports.push(applyOne(path, options.env));
  }
  return reports;
}
