// Redaction end-to-end (mol-bn4.2): `vet run --verbose` with a known secret in env must
// never write that value to stdout, stderr or any file it produces under the project
// (.vet/cache, .vet/runs, .vet/outbox). The judge is the in-process fake from
// fixtures/cli/run: no network. A second group listens on the core event bus and asserts
// no judge request/response payload (state, questions, answers) rides on any event.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_NAMES, createEvents, runEvals } from '@vetkit/core';
import type { EventMap } from '@vetkit/core';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from './test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../fixtures/cli/run', import.meta.url));
// 40 chars, hyphenated so no generic key pattern matches it: only the env-derived
// secret list can catch it.
const SECRET = 'vetkit-e2e-gw-key-0123456789-abcdefghijk';
// Judge request/response bodies: the fixture's case state and criterion instructions.
const STATE_TEXT = 'Hello! How can I help?';
const INSTRUCTIONS_TEXT = 'Is the reply polite?';

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-redaction-'));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function secretEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    VETKIT_FIXTURE_MODE: 'pass',
    VETKIT_FIXTURE_KEY: SECRET,
    AI_GATEWAY_API_KEY: SECRET,
    TYPESAFE_API_KEY: SECRET,
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

const RUNS = [
  ['run', '--verbose'],
  ['run', '--verbose', '--json'],
].map((args) => [args.join(' '), args] as const);

describe('vet run --verbose never leaks the secret', () => {
  test.each(RUNS)('vet %s: stdout, stderr and every produced file have 0 hits', (_label, args) => {
    const project = freshProject();
    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: project,
      env: secretEnv(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    // --verbose really ran at debug level: the judge request line is there.
    expect(result.stderr).toMatch(/judge/);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);

    const produced = filesUnder(join(project, '.vet'));
    // The run wrote its verdict cache, so the grep below is not vacuous.
    expect(produced.length).toBeGreaterThan(0);
    const hits = filesUnder(project).filter((file) => readFileSync(file, 'utf8').includes(SECRET));
    expect(hits.map((file) => relative(project, file))).toEqual([]);
  });

  test.each(RUNS)('vet %s: stderr carries no judge request/response body', (_label, args) => {
    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: freshProject(),
      env: secretEnv(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(STATE_TEXT);
    expect(result.stderr).not.toContain(INSTRUCTIONS_TEXT);
  });
});

describe('the event bus carries only sizes, status codes and durations', () => {
  test('no event or diag payload holds the state, questions, answers or the key', async () => {
    const events = createEvents();
    const seen: { name: string; payload: unknown }[] = [];
    const diags: EventMap['diag'][] = [];
    events.on('diag', (diag) => {
      diags.push(diag);
    });
    for (const name of [...Object.values(EVENT_NAMES), 'diag'] as const) {
      events.on(name, (payload: EventMap[typeof name]) => {
        seen.push({ name, payload });
      });
    }
    const judge = {
      specVersion: 'v1' as const,
      id: 'fake-judge',
      capabilities: {
        questionTypes: ['boolean' as const, 'choice' as const, 'score' as const],
        maxStateTokens: 32_000,
        pinned: false,
        transport: 'fake',
        model: 'fake-jev',
      },
      doJudge(req: { questions: Record<string, unknown> }) {
        const answers = Object.fromEntries(
          Object.keys(req.questions).map((key) => [
            key,
            {
              type: 'choice' as const,
              choice: 'yes',
              confidence: 0.9,
              probabilities: { yes: 0.9, no: 0.1, escape: 0 },
            },
          ]),
        );
        return Promise.resolve({
          answers,
          usage: { inputTokens: 12, outputTokens: 1 },
          model: {
            requested: 'fake-jev',
            resolved: 'fake-jev-resolved',
            transport: 'fake',
            pinned: false,
          },
        });
      },
    };
    const project = freshProject();
    await runEvals({
      config: {
        criteriaPath: join(project, 'evals/criteria.yaml'),
        casesDir: join(project, 'evals/cases'),
        judge,
        cacheDir: join(project, '.vet'),
      },
      events,
    });

    const names = new Set(seen.map((e) => e.name));
    expect(names).toContain('judge:request');
    expect(names).toContain('judge:response');
    for (const { name, payload } of seen) {
      const text = JSON.stringify(payload);
      for (const field of ['state', 'questions', 'answers', 'body', 'instructions']) {
        expect(payload, `${name} payload`).not.toHaveProperty(field);
      }
      expect(text, `${name} payload`).not.toContain(STATE_TEXT);
      expect(text, `${name} payload`).not.toContain(INSTRUCTIONS_TEXT);
      expect(text, `${name} payload`).not.toContain(SECRET);
    }
    const request = seen.find((e) => e.name === 'judge:request')?.payload;
    expect(request).toMatchObject({ stateBytes: expect.any(Number) });
    const response = seen.find((e) => e.name === 'judge:response')?.payload;
    expect(response).toMatchObject({
      status: expect.any(Number),
      durationMs: expect.any(Number),
    });
    for (const diag of diags) {
      for (const value of Object.values(diag.data ?? {}))
        expect(['number', 'boolean']).toContain(typeof value);
    }
  });
});
