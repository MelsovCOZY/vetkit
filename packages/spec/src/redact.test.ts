import { describe, expect, test } from 'vitest';
import { redactSecrets, redactSecretsDeep, secretsFrom } from './redact.ts';

const CANARY = 'canary-Key-9f8e7d6c5b4a';

describe('secretsFrom', () => {
  test('keeps only secret-named env values of at least 8 chars, longest first, de-duplicated', () => {
    const secrets = secretsFrom({
      AI_GATEWAY_API_KEY: CANARY,
      OPENROUTER_API_KEY: CANARY,
      MY_TOKEN: 'tok-12345678',
      DB_PASSWORD: 'e1t',
      PLAIN: 'not-a-secret-name',
      EMPTY_SECRET: '',
      SVC_credential: 'cred-abcdefghijkl',
    });
    expect(secrets).toEqual(['cred-abcdefghijkl', CANARY, 'tok-12345678']);
  });

  test('explicit extra secrets join the set, under the same length floor', () => {
    expect(secretsFrom({}, ['extra-secret-value', 'short'])).toEqual(['extra-secret-value']);
  });
});

describe('redactSecrets', () => {
  test('short values are not substituted', () => {
    for (const short of ['e1t', 'edi']) {
      const secrets = secretsFrom({ MY_KEY: short });
      expect(redactSecrets('please edit the file', secrets)).toBe('please edit the file');
    }
    expect(redactSecrets('please edit the file', ['edi'])).toBe('please edit the file');
  });

  test('boundary match', () => {
    const secrets = secretsFrom({ MY_KEY: 'abcdefgh' });
    expect(redactSecrets('xabcdefgh abcdefghx abcdefgh', secrets)).toBe(
      'xabcdefgh abcdefghx [redacted]',
    );
    expect(redactSecrets('key=abcdefgh;', secrets)).toBe('key=[redacted];');
  });

  test('a secret with non-word edges is matched inside a longer token', () => {
    const secrets = secretsFrom({ MY_KEY: '-abc-defg-' });
    expect(redactSecrets('zz-abc-defg-zz', secrets)).toBe('zz[redacted]zz');
  });

  test('the same secret in several env vars is substituted once', () => {
    const secrets = secretsFrom({ A_KEY: CANARY, B_TOKEN: CANARY });
    expect(redactSecrets(`a ${CANARY} b`, secrets)).toBe('a [redacted] b');
  });

  test('the longer secret wins when one contains the other', () => {
    const secrets = secretsFrom({ A_KEY: 'abcdefgh', B_KEY: 'abcdefgh-ijklmnop' });
    expect(redactSecrets('v abcdefgh-ijklmnop v', secrets)).toBe('v [redacted] v');
  });

  test('regex metacharacters in a secret are matched literally', () => {
    const secrets = secretsFrom({ A_KEY: 'a.b*c+d?e(f)' });
    expect(redactSecrets('x a.b*c+d?e(f) y aXb', secrets)).toBe('x [redacted] y aXb');
  });

  test('a custom mask is applied per secret', () => {
    const secrets = secretsFrom({ A_KEY: CANARY });
    expect(redactSecrets(CANARY, secrets, (s) => `<${String(s.length)}>`)).toBe(
      `<${String(CANARY.length)}>`,
    );
  });

  test('identity when no secrets', () => {
    expect(redactSecrets('anything at all', [])).toBe('anything at all');
    expect(redactSecrets('anything at all', secretsFrom({}))).toBe('anything at all');
  });
});

describe('redactSecretsDeep', () => {
  test('walks nested objects and arrays, and JSON stays valid', () => {
    const secrets = secretsFrom({ A_KEY: CANARY });
    const out = redactSecretsDeep({ a: [`x ${CANARY}`, { b: CANARY }], n: 3, z: null }, secrets);
    expect(out).toEqual({ a: ['x [redacted]', { b: '[redacted]' }], n: 3, z: null });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  test('marks a circular reference instead of looping', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(redactSecretsDeep(loop, secretsFrom({ A_KEY: CANARY }))).toEqual({ self: '[circular]' });
  });
});
