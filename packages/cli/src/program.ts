import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';

const require = createRequire(import.meta.url);

function readVersion(): string {
  const pkgJson = require('../package.json');
  return pkgJson.version;
}

// Codes commander uses for --version and --help; every other exit (unknown command,
// excess arguments, unknown option, …) is a usage error and exits 2, per clig.dev.
const ZERO_EXIT_CODES = new Set(['commander.version', 'commander.help', 'commander.helpDisplayed']);

export function createProgram(): Command {
  const program = new Command();
  program.name('vet').description('vetkit CLI').version(readVersion());
  program.exitOverride();
  return program;
}

export function run(argv: readonly string[]): void {
  const program = createProgram();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  try {
    program.parse([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exit(ZERO_EXIT_CODES.has(error.code) ? error.exitCode : 2);
      return;
    }
    throw error;
  }
}
