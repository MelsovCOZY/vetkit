import { Writable } from 'node:stream';
import { CommanderError } from 'commander';
import { CEV_ERROR_CODES, VetError } from '@vetkit/spec';
import { describe, expect, test, vi } from 'vitest';
import {
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_SINK_SOURCE_STRICT,
  EXIT_UNSCORED_ONLY,
  EXIT_USAGE,
  handleError,
  HINTS_BY_CODE,
  hintFor,
  withExitCode,
  type HandleErrorContext,
} from './errors.ts';
import { createProgram } from './program.ts';

const MARKER = Symbol.for('vetkit.error');

function markerError(code: string, message: string, cause?: unknown): unknown {
  return { [MARKER]: true, code, message, cause };
}

class ExitCalled extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function makeStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback: () => void) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function run(
  err: unknown,
  overrides: Partial<Omit<HandleErrorContext, 'stdout' | 'stderr' | 'exit'>> = {},
): { code: number; stdout: string; stderr: string } {
  const stdout = makeStream();
  const stderr = makeStream();
  const exit = vi.fn((code: number): never => {
    throw new ExitCalled(code);
  });
  const ctx: HandleErrorContext = {
    json: false,
    verbose: false,
    strict: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exit,
    ...overrides,
  };
  try {
    handleError(err, ctx);
  } catch (e) {
    if (e instanceof ExitCalled) {
      return { code: e.code, stdout: stdout.text(), stderr: stderr.text() };
    }
    throw e;
  }
  throw new Error('handleError returned without exiting');
}

describe('handleError code classes', () => {
  test('an existing spec E_CONFIG code exits 2 with an error line and a hint', () => {
    const result = run(markerError('E_CONFIG', 'bad config'));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('error E_CONFIG: bad config\n');
    expect(result.stderr.trim().split('\n')).toHaveLength(2);
  });

  test('an existing spec E_IO code exits 70 (folds into INTERNAL)', () => {
    const result = run(markerError('E_IO', 'disk full'));
    expect(result.code).toBe(EXIT_INTERNAL);
  });

  test('a NOT_INTERACTIVE class code exits 2', () => {
    const result = run(markerError('E_NOT_INTERACTIVE', 'no tty'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('a GATE_ prefixed class code exits 2', () => {
    const result = run(markerError('E_GATE_THRESHOLD', 'gate refused'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an OUTBOX_CORRUPT code exits 2 (j6 config error)', () => {
    const result = run(markerError('OUTBOX_CORRUPT', 'pending.jsonl:2: Invalid JSON'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an UNSCORED_ONLY class code exits 3', () => {
    const result = run(markerError('E_UNSCORED_ONLY', 'nothing scored'));
    expect(result.code).toBe(EXIT_UNSCORED_ONLY);
  });

  test('a SOURCE_EMPTY code exits 2 by exact entry, not the SOURCE_ warning rule (J5)', () => {
    const result = run(markerError('SOURCE_EMPTY', 'otlp:traces/ produced 0 traces'));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('error SOURCE_EMPTY: otlp:traces/ produced 0 traces\n');
    expect(result.stderr).not.toContain('warning SOURCE_EMPTY');
  });

  test('a SOURCE_EMPTY code still exits 2 under --strict (J5)', () => {
    const result = run(markerError('SOURCE_EMPTY', 'no traces'), { strict: true });
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an OTLP_PARSE code exits 2 naming the file (J5)', () => {
    const result = run(
      markerError('OTLP_PARSE', 'traces/a.json: not an ExportTraceServiceRequest'),
    );
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(
      'error OTLP_PARSE: traces/a.json: not an ExportTraceServiceRequest\n',
    );
  });

  test('a RECEIVER_BIND code exits 2, not the default INTERNAL fallback (J7 `vet watch`)', () => {
    const result = run(markerError('RECEIVER_BIND', 'port 4318 already in use'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('a WATCH_CONFIG code exits 2 (J7 `vet watch --sample` outside 0..1)', () => {
    const result = run(markerError('WATCH_CONFIG', 'sampleRate 1.5 outside 0..1'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('a SINK_ prefixed class code exits 0 with a warning line by default', () => {
    const result = run(markerError('E_SINK_WRITE', 'sink dropped a batch'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toContain('warning E_SINK_WRITE: sink dropped a batch\n');
  });

  test('a SOURCE_ prefixed class code exits 1 under --strict', () => {
    const result = run(markerError('E_SOURCE_READ', 'source truncated'), { strict: true });
    expect(result.code).toBe(EXIT_SINK_SOURCE_STRICT);
    expect(result.stderr).toContain('error E_SOURCE_READ: source truncated\n');
  });

  test('an unrecognized VetError code falls back to INTERNAL exit 70', () => {
    const result = run(markerError('E_WACKY', 'never seen this one'));
    expect(result.code).toBe(EXIT_INTERNAL);
  });

  test('a plain Error (not a VetError) falls back to INTERNAL exit 70', () => {
    const result = run(new Error('boom'));
    expect(result.code).toBe(EXIT_INTERNAL);
    expect(result.stderr).toContain('error INTERNAL: boom\n');
  });
});

describe('handleError unprefixed literal codes', () => {
  test('an unprefixed CONFIG_INVALID code exits 2', () => {
    const result = run(markerError('CONFIG_INVALID', 'bad config'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an unprefixed GATE_REFUSED code exits 2', () => {
    const result = run(markerError('GATE_REFUSED', 'gate refused'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an unprefixed UNSCORED_ONLY code exits 3', () => {
    const result = run(markerError('UNSCORED_ONLY', 'nothing scored'));
    expect(result.code).toBe(EXIT_UNSCORED_ONLY);
  });

  test('an unprefixed NOT_INTERACTIVE code exits 2', () => {
    const result = run(markerError('NOT_INTERACTIVE', 'no tty'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an unprefixed SINK_WRITE code exits 0 with a warning line by default', () => {
    const result = run(markerError('SINK_WRITE', 'sink dropped a batch'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toContain('warning SINK_WRITE: sink dropped a batch\n');
  });

  test('an unprefixed SINK_WRITE code exits 1 under --strict', () => {
    const result = run(markerError('SINK_WRITE', 'sink dropped a batch'), { strict: true });
    expect(result.code).toBe(EXIT_SINK_SOURCE_STRICT);
  });

  test('an unprefixed SOURCE_READ code exits 0 with a warning line by default', () => {
    const result = run(markerError('SOURCE_READ', 'source truncated'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toContain('warning SOURCE_READ: source truncated\n');
  });

  test('an unprefixed EXPORT_TARGET_UNKNOWN code exits 2 (`vet export --to`)', () => {
    const result = run(markerError('EXPORT_TARGET_UNKNOWN', "unknown export target 'nope'"));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an unprefixed EXPORT_NO_LOCK code exits 2 (`vet export --require-lock`)', () => {
    const result = run(markerError('EXPORT_NO_LOCK', 'no lock file'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an unprefixed RUN_NOT_FOUND code exits 2 (`vet rerun`)', () => {
    const result = run(markerError('RUN_NOT_FOUND', 'no run record'));
    expect(result.code).toBe(EXIT_USAGE);
  });

  test('an unprefixed unknown class code falls back to INTERNAL exit 70', () => {
    const result = run(markerError('FOO_BAR', 'never seen this one'));
    expect(result.code).toBe(EXIT_INTERNAL);
  });
});

describe('handleError verbosity', () => {
  test('a plain Error has no stack on stderr without --verbose', () => {
    const err = new Error('boom');
    const result = run(err);
    expect(result.stderr).not.toContain(String(err.stack));
  });

  test('a plain Error includes its stack on stderr under --verbose', () => {
    const err = new Error('boom');
    const result = run(err, { verbose: true });
    expect(result.stderr).toContain(String(err.stack));
  });

  test('a VetError cause chain renders as indented "caused by" lines under --verbose', () => {
    const result = run(markerError('E_CONFIG', 'bad config', new Error('root cause')), {
      verbose: true,
    });
    expect(result.stderr).toContain('  caused by: root cause\n');
  });
});

describe('handleError special error shapes', () => {
  test('AbortError exits 130 with no stack, even under --verbose', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const result = run(err, { verbose: true });
    expect(result.code).toBe(EXIT_SIGINT);
    expect(result.stderr).toBe('');
  });

  test('a CommanderError exits 2 without handleError writing its own line', () => {
    const err = new CommanderError(1, 'commander.unknownOption', 'unknown option');
    const result = run(err);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toBe('');
  });

  test('a failure while rendering the error writes a minimal line and exits 70', () => {
    const poison = {
      [MARKER]: true,
      code: 'E_CONFIG',
      get message(): string {
        throw new Error('rendering blew up');
      },
    };
    const result = run(poison);
    expect(result.code).toBe(EXIT_INTERNAL);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  test('a marker object from a duplicate package copy still maps by code, never instanceof', () => {
    class OtherVetError extends Error {}
    const duplicate = Object.assign(new OtherVetError('bad config'), {
      [MARKER]: true,
      code: 'E_CONFIG',
    });
    const result = run(duplicate);
    expect(result.code).toBe(EXIT_USAGE);
  });
});

describe('handleError --json mode', () => {
  test('prints {error:{code,message,hint}} on stdout and nothing else', () => {
    const result = run(markerError('E_CONFIG', 'bad config'), { json: true });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `${JSON.stringify({
        error: {
          code: 'E_CONFIG',
          message: 'bad config',
          hint: hintFor('E_CONFIG'),
        },
      })}\n`,
    );
  });

  test('includes a redacted cause when the VetError has one', () => {
    const secret = 'sk-fakeSecretValue123456';
    const result = run(markerError('E_CONFIG', 'bad config', new Error(`token=${secret}`)), {
      json: true,
    });
    expect(result.stdout).toContain(`"cause":"token=<redacted:${secret.length} chars>"`);
    expect(result.stdout).not.toContain(secret);
  });
});

describe('handleError input, credential and lock codes', () => {
  const configCodes = [
    'CRITERIA_INVALID',
    'CASE_INVALID',
    'INPUT_TOO_LARGE',
    'LABELS_INVALID',
    'LABELS_TOO_FEW',
    'JUDGE_UNAUTHORIZED',
  ];

  for (const base of configCodes) {
    for (const code of [base, `E_${base}`]) {
      test(`${code} exits 2 with its own hint`, () => {
        const result = run(markerError(code, 'bad input'));
        expect(result.code).toBe(EXIT_USAGE);
        expect(result.stderr).toBe(`error ${code}: bad input\n${hintFor(code)}\n`);
      });
    }
  }

  for (const code of ['LOCK_STALE', 'E_LOCK_STALE']) {
    test(`${code} exits 1 with the stale-lock hint`, () => {
      const result = run(markerError(code, 'lock is stale'));
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        `error ${code}: lock is stale\nthe lock is stale; rerun vet validate to refresh it.\n`,
      );
    });
  }
});

// SOURCE_UNREADABLE is lenient by class (SOURCE_* prefix rule above), but `vet
// init --source` needs exit 2 for the one pre-flight stat check on a path the user named,
// without changing that class rule for `run`/`run-sinks`. withExitCode is the escape hatch.
describe('handleError exit override (withExitCode)', () => {
  test('forces the exit code and renders as an error, bypassing the SOURCE_ class default', () => {
    const err = withExitCode(
      new VetError('SOURCE_UNREADABLE', "--source 'x': x is not a readable directory"),
      EXIT_USAGE,
    );
    const result = run(err);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toBe(
      `error SOURCE_UNREADABLE: --source 'x': x is not a readable directory\n${hintFor('SOURCE_UNREADABLE')}\n`,
    );
  });

  test('a SOURCE_UNREADABLE code without the override is unaffected: still lenient (exit 0, warn)', () => {
    const result = run(markerError('SOURCE_UNREADABLE', 'source truncated'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toContain('warning SOURCE_UNREADABLE: source truncated\n');
  });

  test('--json mode still reports the overridden exit code and message', () => {
    const err = withExitCode(new VetError('SOURCE_UNREADABLE', 'no such directory'), EXIT_USAGE);
    const result = run(err, { json: true });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stdout).toContain('"code":"SOURCE_UNREADABLE"');
    expect(result.stdout).toContain('"message":"no such directory"');
  });
});

const lines = (text: string): string[] => text.split('\n').filter((l) => l !== '');
const billing = (): VetError =>
  new VetError('JUDGE_UNAVAILABLE', 'judge account has no credit', {
    details: { kind: 'terminal-billing', retryable: false },
  });

describe('judge failures exit by details.kind', () => {
  test('JUDGE_UNAVAILABLE with details.kind terminal-billing exits 2 with the message verbatim', () => {
    const result = run(billing());
    expect(result.code).toBe(2);
    const [first, hint] = lines(result.stderr);
    expect(first).toBe('error JUDGE_UNAVAILABLE: judge account has no credit');
    expect(hint).toMatch(/credit|billing/);
  });

  test('JUDGE_UNAVAILABLE with details.kind terminal-request exits 2', () => {
    const err = new VetError('JUDGE_UNAVAILABLE', 'judge rejected the request', {
      details: { kind: 'terminal-request', retryable: false },
    });
    expect(run(err).code).toBe(2);
  });

  test('JUDGE_UNAUTHORIZED with details.kind terminal-auth exits 2', () => {
    const err = new VetError('JUDGE_UNAUTHORIZED', 'judge rejected the API key (request id: r1)', {
      details: { kind: 'terminal-auth', retryable: false },
    });
    const result = run(err);
    expect(result.code).toBe(2);
    const [first, hint] = lines(result.stderr);
    expect(first).toBe('error JUDGE_UNAUTHORIZED: judge rejected the API key (request id: r1)');
    expect(hint).toContain('vet doctor');
  });

  test('JUDGE_UNAUTHORIZED without details still exits 2', () => {
    expect(run(new VetError('JUDGE_UNAUTHORIZED', 'nope')).code).toBe(2);
  });

  test('JUDGE_UNAVAILABLE without a terminal kind exits 3', () => {
    expect(run(new VetError('JUDGE_UNAVAILABLE', 'down')).code).toBe(3);
  });

  test('JUDGE_UNAVAILABLE with details.kind retryable exits 3', () => {
    const err = new VetError('JUDGE_UNAVAILABLE', 'down', {
      details: { kind: 'retryable', retryable: true },
    });
    expect(run(err).code).toBe(3);
  });

  test('JUDGE_TIMEOUT exits 3', () => {
    const result = run(new VetError('JUDGE_TIMEOUT', 'slow'));
    expect(result.code).toBe(3);
    expect(lines(result.stderr)[1]).toContain('vet doctor');
  });

  test('--json carries kind', () => {
    const result = run(billing(), { json: true });
    const hint = lines(run(billing()).stderr)[1];
    expect(result.stdout).toBe(
      `${JSON.stringify({
        error: {
          code: 'JUDGE_UNAVAILABLE',
          message: 'judge account has no credit',
          hint,
          kind: 'terminal-billing',
        },
      })}\n`,
    );
  });

  test('--json without details.kind has no kind key', () => {
    const result = run(new VetError('JUDGE_UNAVAILABLE', 'down'), { json: true });
    expect(result.stdout).not.toContain('"kind"');
  });
});

describe('handleError --verbose non-Error causes', () => {
  test('--verbose renders an object cause as HTTP status only', () => {
    const err = new VetError('JUDGE_UNAVAILABLE', 'no credit', {
      cause: { status: 402, body: { secret: 'sk-canary-1234567890' } },
    });
    const result = run(err, { verbose: true });
    expect(result.stderr).toContain('  caused by: HTTP 402\n');
    expect(result.stderr).not.toContain('sk-canary');
    expect(result.stderr).not.toContain('body');
  });

  test('--verbose renders a string cause as itself', () => {
    const err = new VetError('JUDGE_UNAVAILABLE', 'down', { cause: 'JUDGE_UNAVAILABLE' });
    expect(run(err, { verbose: true }).stderr).toContain('  caused by: JUDGE_UNAVAILABLE\n');
  });

  test('without --verbose no caused by line', () => {
    const err = new VetError('JUDGE_UNAVAILABLE', 'down', { cause: { status: 402, body: 'x' } });
    expect(run(err).stderr).not.toContain('caused by');
  });

  test('an object cause never puts its body in --json output', () => {
    const err = new VetError('JUDGE_UNAVAILABLE', 'down', {
      cause: { status: 402, body: { secret: 'sk-canary-1234567890' } },
    });
    const result = run(err, { json: true, verbose: true });
    expect(result.stdout).not.toContain('sk-canary');
    expect(result.stdout).not.toContain('"cause"');
  });
});

const OLD_GENERIC_HINT = 'check your configuration and CLI flags, then retry.';
const GLOBAL_FLAGS = ['--json', '--quiet', '--verbose', '--no-color'];
// A hint is a command the reader can run as printed, so a flag that takes a value is followed
// by a <placeholder> or by one of these literal values.
const LITERAL_FLAG_VALUES = ['--to vitest'];

describe('hints', () => {
  test('hints: every CEV_ERROR_CODES value has a non-empty hint that differs from the old generic one', () => {
    for (const code of Object.values(CEV_ERROR_CODES)) {
      const line = run(markerError(code, 'x')).stderr.split('\n')[1];
      expect(line, code).toBeTruthy();
      expect(line, code).not.toBe(OLD_GENERIC_HINT);
    }
  });

  test('hints: LABELS_TOO_FEW names vet label', () => {
    expect(hintFor('LABELS_TOO_FEW')).toContain('vet label --from');
    expect(hintFor('LABELS_TOO_FEW')).toContain('vet label --tty');
    expect(hintFor('LABELS_TOO_FEW')).toContain('vet validate');
  });

  test('hints: CRITERIA_INVALID names vet lint', () => {
    expect(hintFor('CRITERIA_INVALID')).toContain('vet lint');
  });

  test('hints: RUN_NOT_FOUND names vet run', () => {
    expect(hintFor('RUN_NOT_FOUND')).toContain('vet run');
  });

  test('hints: GATE_UNCALIBRATED names vet validate', () => {
    expect(hintFor('GATE_UNCALIBRATED')).toContain('vet validate');
  });

  test('hints: E_SINK_WRITE hint does not mention --strict', () => {
    const line = run(markerError('E_SINK_WRITE', 'x')).stderr.split('\n')[1];
    expect(line).toBeTruthy();
    expect(line).not.toContain('--strict');
  });

  test('hints: a config error names vet doctor --config with its <path> placeholder', () => {
    for (const code of ['CONFIG_INVALID', 'E_CONFIG']) {
      expect(hintFor(code), code).toContain('vet doctor --config <path> ');
    }
  });

  test('hints: the JSON error document keeps code, message and the per-code hint', () => {
    const out = run(markerError('LABELS_TOO_FEW', 'x'), { json: true }).stdout;
    const expected = {
      error: { code: 'LABELS_TOO_FEW', message: 'x', hint: hintFor('LABELS_TOO_FEW') },
    };
    expect(out).toBe(`${JSON.stringify(expected)}\n`);
  });

  test('hints: every flag a hint names exists on the command it names, and a flag that takes a value shows a value or a <placeholder>', () => {
    const program = createProgram();
    const findCommand = (parts: readonly string[]) => {
      let current = program;
      for (const name of parts) {
        const next = current.commands.find((c) => c.name() === name);
        if (next === undefined) return undefined;
        current = next;
      }
      return current;
    };
    const hints = [
      ...Object.values(CEV_ERROR_CODES).map((code) => hintFor(code)),
      ...Object.values(HINTS_BY_CODE),
      hintFor('E_SINK_WRITE'),
      hintFor('SOURCE_READ'),
      hintFor('SOMETHING_UNKNOWN'),
    ];
    expect(hints.length).toBeGreaterThan(40);
    for (const hint of hints) {
      expect(hint).not.toContain('--strict');
      let current: ReturnType<typeof findCommand>;
      const tokens = hint.matchAll(/vet ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?|(--[a-z][a-z-]*)/g);
      for (const match of tokens) {
        const [, name, sub, flag] = match;
        if (name !== undefined) {
          const top = findCommand([name]);
          expect(top, `${hint} names unknown command vet ${name}`).toBeDefined();
          const withSub = sub === undefined ? undefined : findCommand([name, sub]);
          current = withSub ?? top;
        } else if (flag !== undefined) {
          const known =
            GLOBAL_FLAGS.includes(flag) || (current?.options.some((o) => o.long === flag) ?? false);
          expect(known, `${hint}: ${flag} is not an option of the preceding command`).toBe(true);
          const takesValue = current?.options.find((o) => o.long === flag)?.required ?? false;
          const rest = hint.slice(match.index + flag.length);
          const shown =
            /^ <[a-z][a-z-]*>/.test(rest) ||
            LITERAL_FLAG_VALUES.some((literal) => `${flag}${rest}`.startsWith(literal));
          expect(
            !takesValue || shown,
            `${hint}: ${flag} takes a value; show one or a <placeholder>`,
          ).toBe(true);
        }
      }
    }
  });
});
