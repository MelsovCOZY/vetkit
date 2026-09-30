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

  test('does not redact a long filesystem path spanning many short segments', () => {
    const path =
      '/tmp/claude-1000/-home-yernur-Projects-vetkit/scratchpad/dispatch/vetkit-criteria-Ab3dEf/evals/labels/greets.csv';
    expect(redact(path, {})).toBe(path);
  });

  test('does not redact a uuid-shaped (hyphen-free) path segment', () => {
    const path = '/tmp/43cf950f8a834ea685817196e9a879ef/scratchpad/out.log';
    expect(redact(path, {})).toBe(path);
  });

  test('does not redact a 64-hex case id', () => {
    const caseId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    expect(caseId.length).toBe(64);
    expect(redact(`case ${caseId}`, {})).toBe(`case ${caseId}`);
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

describe('redact: shared sanitizer contract', () => {
  test('short values are not substituted', () => {
    expect(redact('please edit the file', { MY_KEY: 'e1t' })).toBe('please edit the file');
    expect(redact('please edit the file', { MY_KEY: 'edi' })).toBe('please edit the file');
  });

  test('boundary match', () => {
    const env = { MY_KEY: 'abcdefgh' };
    expect(redact('xabcdefgh abcdefghx', env)).toBe('xabcdefgh abcdefghx');
    expect(redact('key=abcdefgh;', env)).toBe('key=<redacted:8 chars>;');
  });

  test('matches env names containing CREDENTIAL, case-insensitively', () => {
    expect(redact('v=svc-cred-value', { svc_credential_x: 'svc-cred-value' })).toBe(
      'v=<redacted:14 chars>',
    );
  });

  test('json stays valid', () => {
    const secret = 'canary-Key-9f8e7d6c5b4a';
    const out = redact(JSON.stringify({ header: `authorization: ${secret}`, n: 1 }), {
      AI_GATEWAY_API_KEY: secret,
    });
    expect(out).not.toContain(secret);
    expect(JSON.parse(out)).toEqual({ header: 'authorization: <redacted:23 chars>', n: 1 });
  });

  test('a canary in a judge request header value never survives', () => {
    const secret = 'canary-Key-9f8e7d6c5b4a';
    const header = { 'x-api-key': secret, Authorization: `Basic ${secret}` };
    const out = redact({ headers: header }, { TYPESAFE_API_KEY: secret });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  test('identity when no secrets', () => {
    expect(redact('plain output, path /a/b', {})).toBe('plain output, path /a/b');
  });
});
