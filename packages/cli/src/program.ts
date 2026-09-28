import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { registerDoctor } from './commands/doctor.ts';
import { registerEstimate } from './commands/estimate.ts';
import { registerLabel } from './commands/label.ts';
import { registerRun } from './commands/run.ts';
import { handleError } from './errors.ts';
import { CEV_EXIT, configureOutput, type GlobalOptions } from './output.ts';

const require = createRequire(import.meta.url);

function readVersion(): string {
  const pkgJson = require('../package.json');
  return pkgJson.version;
}

// Codes commander uses for --version and --help; every other exit (unknown command,
// excess arguments, unknown option, …) is a usage error and exits 2, per clig.dev.
const ZERO_EXIT_CODES = new Set(['commander.version', 'commander.help', 'commander.helpDisplayed']);

const EXIT_CODES_HELP = `
Exit codes:
  ${CEV_EXIT.OK}    success
  ${CEV_EXIT.FAILED}    evaluation failed the threshold or gate
  ${CEV_EXIT.USAGE}    usage or config error (including a missing input with no TTY)
  ${CEV_EXIT.UNSCORED_ONLY}    unscored-only run: nothing could be judged
  ${CEV_EXIT.SIGINT}  interrupted (SIGINT); the first SIGINT to \`vet watch\` stops it with exit code 0`;

// The argv of the current invocation, set by execute() before parsing.
let invocationArgs: readonly string[] = [];

export function createProgram(): Command {
  const program = new Command();
  const version = readVersion();
  program
    .name('vet')
    .description('vetkit CLI')
    .option('-V, --version', 'output the version number')
    .option('--json', 'print one JSON document on stdout; logs stay on stderr')
    .option('-q, --quiet', 'suppress info and warn lines on stderr')
    .option('--verbose', 'add debug lines on stderr')
    .option('--no-color', 'disable coloured output (FORCE_COLOR still wins)')
    .addHelpText('after', EXIT_CODES_HELP)
    .exitOverride();
  // Replaces commander's own --version listener so `vet --version --json` prints JSON.
  // Options fire in argv order, so --json may not be parsed yet: read the raw args.
  program.on('option:version', () => {
    const json = invocationArgs.includes('--json');
    process.stdout.write(json ? `${JSON.stringify({ version })}\n` : `${version}\n`);
    throw new CommanderError(0, 'commander.version', version);
  });
  program.hook('preAction', (_root, actionCommand) => {
    const log = configureOutput(actionCommand.optsWithGlobals<GlobalOptions>());
    log.debug(`vet ${version}: running ${actionCommand.name()}`);
  });
  registerDoctor(program);
  registerLabel(program);
  registerRun(program);
  registerEstimate(program);
  return program;
}

function exitNow(code: number): never {
  process.exit(code);
}

async function execute(program: Command, argv: readonly string[]): Promise<void> {
  invocationArgs = argv;
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError && ZERO_EXIT_CODES.has(error.code)) {
      exitNow(error.exitCode);
    }
    const options = program.opts<GlobalOptions>();
    handleError(error, {
      json: options.json === true,
      verbose: options.verbose === true,
      strict: false,
      stdout: process.stdout,
      stderr: process.stderr,
      exit: exitNow,
    });
  }
}

export function run(argv: readonly string[], program: Command = createProgram()): void {
  // A command that handles SIGINT itself (`vet run` aborts and prints partial results)
  // registers its own listener; this default exit applies only when none is present.
  process.once('SIGINT', () => {
    if (process.listenerCount('SIGINT') === 0) exitNow(CEV_EXIT.SIGINT);
  });
  // `vet … | head` closes stdout early; that is not an error.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') exitNow(CEV_EXIT.OK);
    throw err;
  });
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  void execute(program, argv);
}
