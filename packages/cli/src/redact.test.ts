import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { createLogger } from './logger.ts';
import { redact } from './redact.ts';

function makeStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback: () => void) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines };
}

describe('redact', () => {
  test('masks an sk- prefixed secret', () => {
    const secret = 'sk-fakeSecretValue123';
    expect(redact(`token=${secret}`, {})).toBe(`token=<redacted:${secret.length} chars>`);
  });

  test('masks a pk-lf- prefixed secret', () => {
    const secret = 'pk-lf-fakePublicKeyValue123';
    expect(redact(`key=${secret}`, {})).toBe(`key=<redacted:${secret.length} chars>`);
  });

  test('masks a Bearer-prefixed token', () => {
    const secret = 'Bearer fakeBearerToken1234567890';
    expect(redact(`auth: ${secret}`, {})).toBe(`auth: <redacted:${secret.length} chars>`);
  });

  test('masks a 32+ char base64-like run', () => {
    const secret = 'ghijklmnopqrstuvwxyz0123456789AB';
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(redact(`payload=${secret}`, {})).toBe(`payload=<redacted:${secret.length} chars>`);
  });

  test('masks a 32+ char hex run', () => {
    const secret = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(redact(`digest=${secret}`, {})).toBe(`digest=<redacted:${secret.length} chars>`);
  });

  test('masks the exact value of an env var whose name ends in KEY/TOKEN/SECRET', () => {
    const secret = 'sup3rSecretValue';
    expect(redact(`using ${secret} now`, { MY_API_KEY: secret })).toBe(
      `using <redacted:${secret.length} chars> now`,
    );
  });
});

describe('createLogger + redact', () => {
  test('applies redact() to an argument at a non-info level', () => {
    const { stream, lines } = makeStream();
    const logger = createLogger({ format: 'json', stream });
    const secret = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
    logger.warn('token issued', { detail: secret });
    const [line] = lines;
    expect(line).toContain(`<redacted:${secret.length} chars>`);
    expect(line).not.toContain(secret);
  });
});
