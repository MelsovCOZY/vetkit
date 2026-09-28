import { Writable } from 'node:stream';
import { CommanderError } from 'commander';
import { describe, expect, test, vi } from 'vitest';
import {
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_SINK_SOURCE_STRICT,
  EXIT_UNSCORED_ONLY,
  EXIT_USAGE,
  handleError,
  type HandleErrorContext,
} from './errors.ts';

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
          hint: 'check your configuration and CLI flags, then retry.',
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
  const CONFIG_HINT = 'check your configuration and CLI flags, then retry.';
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
      test(`${code} exits 2 with the config hint`, () => {
        const result = run(markerError(code, 'bad input'));
        expect(result.code).toBe(EXIT_USAGE);
        expect(result.stderr).toBe(`error ${code}: bad input\n${CONFIG_HINT}\n`);
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
