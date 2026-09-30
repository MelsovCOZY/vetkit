// Unit tests for the `--source` string registry: a bare path or `jsonl:<dir>`
// both resolve through source-jsonl; other prefixes register via registerSourcePrefix without
// touching resolveSource's callers (`otlp:`, `langfuse:`), so these tests never assert a
// closed set of registered prefixes.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceV1 } from '@vetkit/spec';
import { describe, expect, test, vi } from 'vitest';
import { registerSourcePrefix, resolveSource } from './sources.ts';

function tmpDirWithJsonl(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-sources-'));
  writeFileSync(join(dir, 'a.jsonl'), `${JSON.stringify({ traceId: 't1', messages: [] })}\n`);
  return dir;
}

async function* emptyDoRead(): AsyncGenerator<never> {
  /* no traces */
}

describe('resolveSource', () => {
  test('a bare directory path resolves to a jsonl SourceV1', () => {
    const source = resolveSource(tmpDirWithJsonl());
    expect(source.specVersion).toBe('v1');
    expect(source.id).toBe('jsonl/traces');
  });

  test('a jsonl: prefix resolves the same directory as a jsonl SourceV1', () => {
    const dir = tmpDirWithJsonl();
    const source = resolveSource(`jsonl:${dir}`);
    expect(source.id).toBe('jsonl/traces');
  });

  test('registerSourcePrefix adds a new prefix without disturbing jsonl', () => {
    const dir = tmpDirWithJsonl();
    let seenSpec: string | undefined;
    registerSourcePrefix('mol76a7-fake', (spec) => {
      seenSpec = spec;
      const fake: SourceV1 = {
        specVersion: 'v1',
        id: 'mol76a7-fake/traces',
        capabilities: { streaming: false, content: 'captured' },
        doRead: emptyDoRead,
      };
      return fake;
    });
    const source = resolveSource(`mol76a7-fake:${dir}`);
    expect(source.id).toBe('mol76a7-fake/traces');
    expect(seenSpec).toBe(dir);
    // jsonl is unaffected by registering a sibling prefix.
    expect(resolveSource(dir).id).toBe('jsonl/traces');
  });

  test('an unregistered prefix throws CONFIG_INVALID naming it', () => {
    const dir = tmpDirWithJsonl();
    expect(() => resolveSource(`nope-mol76a7:${dir}`)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  test('a missing path throws SOURCE_UNREADABLE naming the path', () => {
    expect(() => resolveSource('/does/not/exist/mol76a7')).toThrowError(
      expect.objectContaining({ code: 'SOURCE_UNREADABLE' }),
    );
  });

  test('a path that is a file, not a directory, throws SOURCE_UNREADABLE', () => {
    const dir = tmpDirWithJsonl();
    const file = join(dir, 'a.jsonl');
    expect(() => resolveSource(file)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_UNREADABLE' }),
    );
  });

  // registerSourcePrefix's validate hook is optional, and
  // resolveSource only runs it when the matched prefix registered one; a prefix with no
  // validate hook (e.g. `otlp`) gets its rest passed straight to its factory, even when
  // rest is not a directory (a port fragment like ':4318', not a filesystem path at all).
  test('a prefix with no validate hook passes a non-directory rest straight to its factory', () => {
    let seenRest: string | undefined;
    registerSourcePrefix('fake-prefix', (rest) => {
      seenRest = rest;
      const fake: SourceV1 = {
        specVersion: 'v1',
        id: 'fake-prefix/traces',
        capabilities: { streaming: false, content: 'captured' },
        doRead: emptyDoRead,
      };
      return fake;
    });
    const source = resolveSource('fake-prefix::4318');
    expect(source.id).toBe('fake-prefix/traces');
    expect(seenRest).toBe(':4318');
  });
});

describe('unknown prefix', () => {
  test('unknown prefix lists supported', async () => {
    // Fresh module registry: earlier tests in this file register extra prefixes.
    vi.resetModules();
    const fresh = await import('./sources.ts');
    const otlp = await import('./commands/init-otlp.ts');
    otlp.registerOtlpSource();
    let caught: unknown;
    try {
      fresh.resolveSource('langfuse:x');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(caught instanceof Error && caught.message).toContain(
      'unknown source prefix langfuse; supported: jsonl, otlp',
    );
  });
});
