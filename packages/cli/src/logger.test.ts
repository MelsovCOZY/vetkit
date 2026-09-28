import { Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { createLogger } from './logger.ts';

function makeStream(isTTY = false): { stream: Writable & { isTTY?: boolean }; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback: () => void) {
      lines.push(chunk.toString());
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return { stream, lines };
}

describe('createLogger', () => {
  test('suppresses levels below the configured threshold', () => {
    const { stream, lines } = makeStream();
    const logger = createLogger({ level: 'warn', stream });
    logger.debug('hidden debug');
    logger.info('hidden info');
    logger.warn('shown warn');
    logger.error('shown error');
    expect(lines).toHaveLength(2);
  });

  test('defaults to writing every line to stderr, never stdout', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createLogger({});
    logger.info('hello');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  test('json format prints one JSON object per line', () => {
    const { stream, lines } = makeStream();
    const logger = createLogger({ format: 'json', stream });
    logger.info('hello', { a: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(lines[0]).toContain('"level":"info"');
    expect(lines[0]).toContain('"message":"hello"');
    expect(lines[0]).toContain('"a":1');
  });

  test('redacts key-like and value-like secrets', () => {
    const { stream, lines } = makeStream();
    const logger = createLogger({ format: 'json', stream });
    logger.info('Bearer zzz999', {
      apiKey: 'value1',
      authorization: 'value2',
      plain: 'sk-topsecret',
      ok: 'fine',
    });
    const [line] = lines;
    expect(line).toContain('"message":"[redacted]"');
    expect(line).toContain('"apiKey":"[redacted]"');
    expect(line).toContain('"authorization":"[redacted]"');
    expect(line).toContain('"plain":"[redacted]"');
    expect(line).toContain('"ok":"fine"');
  });

  test('disables ANSI color when NO_COLOR is set on a non-TTY stream', () => {
    vi.stubEnv('NO_COLOR', '1');
    const { stream, lines } = makeStream(false);
    const logger = createLogger({ stream });
    logger.error('boom');
    // eslint-disable-next-line no-control-regex
    expect(lines[0]).not.toMatch(/\u001b\[/);
  });

  test('an injected color: true colours labels even on a non-TTY stream', () => {
    const { stream, lines } = makeStream(false);
    createLogger({ stream, color: true }).error('boom');
    // eslint-disable-next-line no-control-regex
    expect(lines[0]).toMatch(/\u001b\[/);
  });

  test('an injected color: false leaves labels uncoloured on a TTY stream', () => {
    const { stream, lines } = makeStream(true);
    createLogger({ stream, color: false }).error('boom');
    // eslint-disable-next-line no-control-regex
    expect(lines[0]).not.toMatch(/\u001b\[/);
  });

  test('falls back to info with a warning when CEV_LOG_LEVEL is invalid, never NaN', () => {
    vi.stubEnv('CEV_LOG_LEVEL', 'nonsense');
    const { stream, lines } = makeStream();
    const logger = createLogger({ stream });
    logger.debug('hidden debug');
    logger.info('shown info');
    expect(lines.some((line) => line.includes('hidden debug'))).toBe(false);
    expect(lines.some((line) => line.includes('shown info'))).toBe(true);
    expect(
      lines.some((line) => line.toLowerCase().includes('invalid') && line.includes('nonsense')),
    ).toBe(true);
  });
});
