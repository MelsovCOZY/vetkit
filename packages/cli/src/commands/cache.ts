// `vet cache clear`: empty the verdict cache. Only top-level `<64 hex>.json` entries under the
// configured cacheDir are removed; run records (runs/), in-flight `.tmp` files and anything
// else stay. Prints a count and the directory, never entry contents.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { emit, type GlobalOptions } from '../output.ts';

const ENTRY_RE = /^[0-9a-f]{64}\.json$/;

interface ClearOptions extends GlobalOptions {
  readonly config?: string;
}

async function clearCommand(options: ClearOptions): Promise<void> {
  const loaded = await loadVetConfig({
    cwd: process.cwd(),
    ...(options.config === undefined ? {} : { configPath: options.config }),
    requireCredentials: false,
  });
  const dir = loaded.paths.cacheDir;
  let names: string[] = [];
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    names = dirents.filter((d) => d.isFile() && ENTRY_RE.test(d.name)).map((d) => d.name);
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  await Promise.all(names.map((name) => rm(join(dir, name), { force: true })));
  const cleared = names.length;
  emit({ cleared, dir }, () => `cleared ${String(cleared)} cache entries from ${dir}`);
}

export function registerCache(program: Command): Command {
  const cache = program.command('cache').description('verdict cache maintenance');
  cache
    .command('clear')
    .description('delete every cached verdict and print how many were removed')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .action(async (_options: unknown, command: Command) => {
      await clearCommand(command.optsWithGlobals<ClearOptions>());
    });
  return program;
}
