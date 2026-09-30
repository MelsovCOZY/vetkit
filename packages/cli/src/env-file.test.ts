import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { applyEnvFiles, configureEnvFiles, isEnvFilesEnabled } from './env-file.ts';

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-env-file-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterEach(() => {
  configureEnvFiles({ enabled: true });
});

describe('applyEnvFiles', () => {
  test('a variable already in env is never overwritten', () => {
    const dir = dirWith({ '.env': 'A=file\nB=other\n' });
    const env: Record<string, string | undefined> = { A: 'proc' };
    const reports = applyEnvFiles({ dir, env });
    expect(env['A']).toBe('proc');
    expect(env['B']).toBe('other');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.applied).toEqual(['B']);
  });

  test('.env.local wins over .env for the same name', () => {
    const dir = dirWith({ '.env.local': 'B=local\n', '.env': 'B=base\nC=base\n' });
    const env: Record<string, string | undefined> = {};
    const reports = applyEnvFiles({ dir, env });
    expect(env['B']).toBe('local');
    expect(env['C']).toBe('base');
    const local = reports.find((r) => r.path === join(dir, '.env.local'));
    const base = reports.find((r) => r.path === join(dir, '.env'));
    expect(local?.applied).toEqual(['B']);
    expect(base?.applied).toEqual(['C']);
  });

  test('a missing file is silent and reports nothing', () => {
    const dir = dirWith({});
    const env: Record<string, string | undefined> = {};
    expect(applyEnvFiles({ dir, env })).toEqual([]);
    expect(env).toEqual({});
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable existing file yields a report with applied [] and an `error` field naming the path only',
    () => {
      const secret = 'super-secret-value-123';
      const dir = dirWith({ '.env': `KEY=${secret}\n` });
      const file = join(dir, '.env');
      chmodSync(file, 0o000);
      const env: Record<string, string | undefined> = {};
      const reports = applyEnvFiles({ dir, env });
      expect(reports).toHaveLength(1);
      const report = reports[0];
      expect(report?.path).toBe(file);
      expect(report?.applied).toEqual([]);
      const error = report?.error;
      expect(error).toContain(file);
      expect(error).not.toContain(secret);
      expect(error).not.toContain('KEY');
      expect(env).toEqual({});
    },
  );

  test('a directory named .env yields an error report', () => {
    const dir = dirWith({});
    mkdirSync(join(dir, '.env'));
    const reports = applyEnvFiles({ dir, env: {} });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toContain(join(dir, '.env'));
  });

  test('quoted, CRLF and empty values parse as Node does', () => {
    const dir = dirWith({ '.env': 'X="two"\r\nC=\r\nD=plain\r\n' });
    const env: Record<string, string | undefined> = {};
    applyEnvFiles({ dir, env });
    expect(env['X']).toBe('two');
    expect(env['C']).toBe('');
    expect(env['D']).toBe('plain');
  });

  test('a name present in env as the empty string counts as present', () => {
    const dir = dirWith({ '.env': 'E=file\n' });
    const env: Record<string, string | undefined> = { E: '' };
    applyEnvFiles({ dir, env });
    expect(env['E']).toBe('');
  });

  test('the files option overrides the default file list', () => {
    const dir = dirWith({ '.env': 'A=1\n', 'custom.env': 'Z=9\n' });
    const env: Record<string, string | undefined> = {};
    const reports = applyEnvFiles({ dir, env, files: ['custom.env'] });
    expect(env['Z']).toBe('9');
    expect(env['A']).toBeUndefined();
    expect(reports.map((r) => r.path)).toEqual([join(dir, 'custom.env')]);
  });

  test('disabled policy applies nothing', () => {
    const dir = dirWith({ '.env': 'A=1\n' });
    const env: Record<string, string | undefined> = {};
    configureEnvFiles({ enabled: false });
    expect(isEnvFilesEnabled()).toBe(false);
    expect(applyEnvFiles({ dir, env })).toEqual([]);
    expect(env).toEqual({});
  });

  test('the report never carries values', () => {
    const dir = dirWith({ '.env': 'A=value-one-abc\nB="value two xyz"\n' });
    const reports = applyEnvFiles({ dir, env: {} });
    const json = JSON.stringify(reports);
    expect(json).not.toContain('value-one-abc');
    expect(json).not.toContain('value two xyz');
  });
});
