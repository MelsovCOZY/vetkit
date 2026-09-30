import { isCancel, text } from '@clack/prompts';
import { VetError } from '@vetkit/spec';
import picocolors from 'picocolors';
import {
  EXIT_FAILED,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_UNSCORED_ONLY,
  EXIT_USAGE,
} from './errors.ts';
import { createLogger, type Logger } from './logger.ts';

type Env = Record<string, string | undefined>;

interface TtyLike {
  readonly isTTY?: boolean;
}

// The CLI's exit-code contract (listed in `vet --help`). Values come from errors.ts so
// handleError and commands can never disagree on a number.
export const CEV_EXIT: {
  readonly OK: number;
  readonly FAILED: number;
  readonly USAGE: number;
  readonly UNSCORED_ONLY: number;
  readonly INTERNAL: number;
  readonly SIGINT: number;
} = {
  OK: EXIT_OK,
  FAILED: EXIT_FAILED,
  USAGE: EXIT_USAGE,
  UNSCORED_ONLY: EXIT_UNSCORED_ONLY,
  INTERNAL: EXIT_INTERNAL,
  SIGINT: EXIT_SIGINT,
} as const;

export interface GlobalOptions {
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  // commander's `--no-color` sets `color: false`; it defaults to true.
  readonly color?: boolean;
}

export interface ColorInput {
  readonly env: Env;
  // Optional: a piped process.stdout has no isTTY at runtime despite its typing.
  readonly isTTY?: boolean;
  readonly flag?: boolean;
}

// FORCE_COLOR (non-empty, not "0") wins over everything; then --no-color and a
// non-empty NO_COLOR disable colour; otherwise colour only on a TTY.
export function colorEnabled({ env, isTTY, flag }: ColorInput): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  if (flag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return isTTY === true;
}

let current: GlobalOptions = {};
let logger: Logger | undefined;

function colorFor(stream: TtyLike): boolean {
  return colorEnabled({
    env: process.env,
    ...(stream.isTTY === undefined ? {} : { isTTY: stream.isTTY }),
    ...(current.color === undefined ? {} : { flag: current.color }),
  });
}

// Called once per invocation (commander preAction) with the merged global options.
export function configureOutput(options: GlobalOptions): Logger {
  current = options;
  const level = options.quiet ? 'error' : options.verbose ? 'debug' : undefined;
  const color = colorFor(process.stderr);
  logger = createLogger(level === undefined ? { color } : { level, color });
  return logger;
}

export function getLogger(): Logger {
  logger ??= createLogger({ color: colorFor(process.stderr) });
  return logger;
}

export function colors(): ReturnType<typeof picocolors.createColors> {
  return picocolors.createColors(colorFor(process.stdout));
}

// Data goes to stdout: one JSON document under --json, the pretty rendering otherwise.
export function emit(data: unknown, pretty: () => string): void {
  process.stdout.write(current.json ? `${JSON.stringify(data)}\n` : `${pretty()}\n`);
}

export function isInteractive(stdin: TtyLike = process.stdin, env: Env = process.env): boolean {
  return stdin.isTTY === true && !env.CI;
}

export interface PromptOptions {
  // Names the input in the NOT_INTERACTIVE error, e.g. "judge model".
  readonly name: string;
  readonly message: string;
}

interface PromptDeps {
  readonly stdin?: TtyLike;
  readonly env?: Env;
}

// Every CLI prompt goes through here, so a closed stdin or CI never hangs on input.
export async function prompt(options: PromptOptions, deps: PromptDeps = {}): Promise<string> {
  if (!isInteractive(deps.stdin, deps.env)) {
    throw new VetError(
      'NOT_INTERACTIVE',
      `missing input "${options.name}": stdin is not a TTY or CI is set; pass it as a flag or in config`,
    );
  }
  const answer = await text({ message: options.message });
  if (isCancel(answer)) {
    const abort = new Error(`prompt for "${options.name}" cancelled`);
    abort.name = 'AbortError';
    throw abort;
  }
  return answer;
}
