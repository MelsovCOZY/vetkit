import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { registerCache } from './commands/cache.ts';
import { registerCases } from './commands/cases.ts';
import { registerCheck } from './commands/check.ts';
import { registerCriteria } from './commands/criteria.ts';
import { registerDoctor } from './commands/doctor.ts';
import { registerEstimate } from './commands/estimate.ts';
import { registerExport } from './commands/export.ts';
import { registerInit } from './commands/init.ts';
import { registerOtlpSource } from './commands/init-otlp.ts';
import { registerLabel } from './commands/label.ts';
import { registerLint } from './commands/lint.ts';
import { registerLock } from './commands/lock.ts';
import { registerRerun } from './commands/rerun.ts';
import { registerReport } from './commands/report.ts';
import { registerRun } from './commands/run.ts';
import { registerRunSinks } from './commands/run-sinks.ts';
import { registerValidate } from './commands/validate.ts';
import { registerWatch } from './commands/watch.ts';
import { handleError } from './errors.ts';
import { configureEnvFiles } from './env-file.ts';
import { CEV_EXIT, configureOutput, type GlobalOptions } from './output.ts';
import { nodeFloorError } from './node-floor.ts';

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
  ${CEV_EXIT.USAGE}    usage, config, auth or billing error (including a missing input with no TTY)
  ${CEV_EXIT.UNSCORED_ONLY}    unscored-only run: no case could be judged (judge down or throttled)
  ${CEV_EXIT.INTERNAL}   internal error (bug or unreadable environment); rerun with --verbose and file an issue
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
    .option('--no-env-file', 'do not load .env/.env.local next to the config')
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
    const opts = actionCommand.optsWithGlobals<GlobalOptions & { envFile?: boolean }>();
    const log = configureOutput(opts);
    configureEnvFiles({ enabled: opts.envFile !== false });
    log.debug(`vet ${version}: running ${actionCommand.name()}`);
  });
  registerDoctor(program);
  registerLabel(program);
  registerRun(program);
  registerRunSinks(program);
  registerRerun(program);
  registerReport(program);
  registerValidate(program);
  registerEstimate(program);
  registerOtlpSource();
  registerInit(program);
  registerCheck(program);
  registerLock(program);
  registerCache(program);
  registerCriteria(program);
  registerCases(program);
  registerLint(program);
  registerExport(program);
  registerWatch(program);
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
  const floorError = nodeFloorError(process.version);
  if (floorError !== undefined) {
    process.stderr.write(`${floorError}\n`);
    exitNow(CEV_EXIT.USAGE);
  }
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
