import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// vetkit sends nothing anywhere but the judge, generator and sinks the user configured. A shipped
// source file that pulls in an analytics/telemetry client, or hard-codes a vetkit or update-check
// URL, is how that promise breaks, so it fails here. The runtime half is
// packages/cli/src/zero-telemetry.test.ts.
const BANNED_MODULE =
  /posthog|segment|analytics|telemetry|sentry|mixpanel|amplitude|update-notifier/i;
const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

// Prose may say "telemetry" (OTLP sources and sinks handle OpenTelemetry data) and "segment" (a
// path segment), so only client-shaped references are banned outside import specifiers.
const REFERENCE_PATTERNS: readonly RegExp[] = [
  /\bposthog\b/i,
  /\banalytics\b/i,
  /@segment\/|\bsegment\.(?:io|com)\b/i,
  /\b[a-z]*[Tt]elemetry(?:Client|Endpoint|Url|Enabled|Event|Id)\b/,
  /\bupdate[-_ ]?(?:check|notifier)\b|\bcheckForUpdates?\b/i,
  /registry\.npmjs\.org|registry\.yarnpkg\.com|api\.github\.com\/repos\/\S*\/releases/,
  // Schema $id URIs and docs links are identifiers, never fetched; any other vetkit URL is a
  // hard-coded endpoint.
  /https?:\/\/(?:[\w-]+\.)*vetkit\.[a-z]+\/(?!schemas\/|docs\/)/i,
];

interface SourceFile {
  path: string;
  text: string;
}

interface Hit {
  path: string;
  line: number;
  match: string;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function findTelemetry(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    for (const found of file.text.matchAll(IMPORT_SPECIFIER)) {
      const specifier = found[1] ?? '';
      if (BANNED_MODULE.test(specifier)) {
        hits.push({ path: file.path, line: lineOf(file.text, found.index), match: specifier });
      }
    }
    for (const pattern of REFERENCE_PATTERNS) {
      const found = pattern.exec(file.text);
      if (found === null) continue;
      hits.push({ path: file.path, line: lineOf(file.text, found.index), match: found[0] });
    }
  }
  return hits;
}

const SHIPPED_SOURCE = /^packages\/[^/]+\/src\/.+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const NOT_SHIPPED = /\.test(?:-d)?\.[cm]?[jt]sx?$|\/test-support\/|\/e2e\//;

function shippedSources(): SourceFile[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return listed
    .split('\0')
    .filter((path) => SHIPPED_SOURCE.test(path) && !NOT_SHIPPED.test(path))
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}

describe('no telemetry in shipped sources', () => {
  it('flags an import of an analytics or telemetry client', () => {
    const specifiers = [
      'posthog-node',
      '@segment/analytics-node',
      '@sentry/node',
      'mixpanel',
      'update-notifier',
      '@opentelemetry/api',
    ];
    for (const specifier of specifiers) {
      const hits = findTelemetry([
        { path: 'packages/cli/src/x.ts', text: `import x from '${specifier}';\n` },
        { path: 'packages/cli/src/y.ts', text: `const y = await import("${specifier}");\n` },
        { path: 'packages/cli/src/z.cjs', text: `const z = require('${specifier}');\n` },
      ]);
      expect([...new Set(hits.map((hit) => hit.path))]).toEqual([
        'packages/cli/src/x.ts',
        'packages/cli/src/y.ts',
        'packages/cli/src/z.cjs',
      ]);
    }
  });

  it('flags a client-shaped reference and a hard-coded vetkit or update URL', () => {
    const cases = [
      'const client = new PostHog(key);',
      'analytics.track("run");',
      'const url = "https://api.segment.io/v1/track";',
      'const telemetryEndpoint = "x";',
      'await checkForUpdates();',
      'fetch("https://registry.npmjs.org/vetkit/latest");',
      'fetch("https://vetkit.dev/api/ping");',
      'fetch("https://updates.vetkit.io/latest");',
    ];
    for (const text of cases) {
      expect(findTelemetry([{ path: 'packages/core/src/x.ts', text }])).not.toEqual([]);
    }
  });

  it('reports the path and line of a hit', () => {
    const text = 'const a = 1;\nfetch("https://vetkit.dev/ping");\n';
    expect(findTelemetry([{ path: 'packages/core/src/x.ts', text }])).toMatchObject([
      { path: 'packages/core/src/x.ts', line: 2 },
    ]);
  });

  it('does not flag OpenTelemetry prose, schema ids, docs links or a path segment', () => {
    const text = [
      '// Encodes OpenTelemetry log records for OTLP.',
      "const id = 'https://vetkit.dev/schemas/verdict.schema.json';",
      "const docs = 'https://vetkit.dev/docs/lint';",
      'const segment = path.split("/")[0];',
    ].join('\n');
    expect(findTelemetry([{ path: 'packages/core/src/x.ts', text }])).toEqual([]);
  });

  it('finds no telemetry or analytics reference in any shipped source file', () => {
    const files = shippedSources();
    expect(files.length).toBeGreaterThan(50);
    expect(findTelemetry(files)).toEqual([]);
  });
});
