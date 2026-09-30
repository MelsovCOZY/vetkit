import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Tracker ids leak planning metadata into shipped code. Provenance lives in git history and the
// tracker, so shipped files must not carry bead ids, epic names, bug numbers or planning turns.
const TRACKER_ID_PATTERNS: readonly RegExp[] = [
  /(?<![a-z])mol-[a-z0-9]{2,4}(\.[0-9]+)?/,
  /\b(dh8|pij|yxn|aq4|q4q|p4a|0nw|76a|fou|vv7)\.[0-9]+\b/,
  /\bvet-[a-z0-9]{3}\.[0-9]+\b/,
  /\bvet-(dh8|pij|yxn|aq4|q4q|p4a|0nw|76a|fou|vv7|d4m|d0i)\b/,
  new RegExp(['classified', 'evals', ''].join('-')),
  /\bbug F[0-9]+/,
  /\b(?:DECISION|CLAIM)\b[^\n]{0,20}\bturn\s+[0-9]+/,
];

// Prose pointers into the tracker are dead text for anyone reading the repo. A comment or test
// title must state the reason itself instead of naming a tracker note.
const TRACKER_POINTER_PATTERNS: readonly RegExp[] = [
  /\b(see|per|root|gate)\s+(bd\s+)?DECISION\b/,
  /\bDECISION\s+(C[0-9]+|20[0-9]{2}-)/,
  /[(]DECISION\b/,
  /\bPREMISE[:]/,
  /\bbd\s+(show|note|kv)\b/,
  /\blater[\s/#*]+beads\b/,
  /\broot\s+epic\b/,
];

// One legacy hook header is kept verbatim: the installer matches it to migrate old hook files,
// and its test writes the same text as a fixture. Lines carrying it are not scanned.
const LEGACY_HOOK_LINE = /Advisory only [(]root\s+DECISION/;

// Instruction files, the tracker's own export, the knowledge-graph
// output and agent settings are the only places allowed to name tracker ids.
const ALLOWLIST: readonly RegExp[] = [
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^\.beads\//,
  /^graphify-out\//,
  /^\.claude\//,
  /^bun\.lock$/,
  /^\.agents\//,
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

function findTrackerIds(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    if (ALLOWLIST.some((rule) => rule.test(file.path))) continue;
    for (const pattern of TRACKER_ID_PATTERNS) {
      const found = pattern.exec(file.text);
      if (found === null) continue;
      const line = file.text.slice(0, found.index).split('\n').length;
      hits.push({ path: file.path, line, match: found[0] });
    }
    const text = file.text
      .split('\n')
      .map((line) => (LEGACY_HOOK_LINE.test(line) ? '' : line))
      .join('\n');
    for (const pattern of TRACKER_POINTER_PATTERNS) {
      const found = pattern.exec(text);
      if (found === null) continue;
      const line = text.slice(0, found.index).split('\n').length;
      hits.push({ path: file.path, line, match: found[0] });
    }
  }
  return hits;
}

function trackedTextFiles(): SourceFile[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return listed
    .split('\0')
    .filter((path) => path !== '')
    .flatMap((path) => {
      try {
        const text = readFileSync(join(ROOT, path), 'utf8');
        return text.includes('\0') ? [] : [{ path, text }];
      } catch {
        return [];
      }
    });
}

const pointerCases: readonly string[] = [
  `# Alternatives, any one is enough (${['see', 'bd', 'DECISION'].join(' ')} on judge transport)`,
  `# Composite (${['DECISION', 'C10'].join(' ')})`,
  `describe('x (${['root', 'DECISION'].join(' ')} retry policy)', () => {})`,
  `it('x (${['DECISION', '2026-09-28'].join(' ')})', () => {})`,
  `it('x (${['PREMISE', ' npm'].join(':')})', () => {})`,
  `# recorded on the ${['root', 'epic'].join(' ')} (\`${['bd', 'kv', 'get'].join(' ')} x\`)`,
  `// every file (${['later', 'beads'].join(' ')}) must comply`,
  `probed first, ${['per', 'gate', 'DECISION'].join(' ')}`,
];

describe('tracker ids in shipped files', () => {
  it('flags a bead id in a file under packages/', () => {
    const id = ['mol', 'abc.1'].join('-');
    const hits = findTrackerIds([{ path: 'packages/core/src/x.ts', text: `// see ${id}\n` }]);
    expect(hits.map((hit) => hit.match)).toContain(id);
  });

  it('flags a bare short id, an epic name, a bug number and a planning turn', () => {
    const cases = [
      `// ${['dh8', '5'].join('.')}: outbox`,
      `see ${['classified', 'evals', 'd4m'].join('-')}`,
      `(${['bug', 'F3'].join(' ')})`,
      `DECISION (${['turn', '9'].join(' ')}, amendment)`,
    ];
    for (const text of cases) {
      expect(findTrackerIds([{ path: 'docs/contracts/x.md', text }])).toHaveLength(1);
    }
  });

  it('does not flag ordinary words that resemble an id', () => {
    const text =
      's' + ['mol', 'toml'].join('-') + '\nmultiple turns of a conversation\nreturn 1;\n';
    expect(findTrackerIds([{ path: 'packages/core/src/x.ts', text }])).toEqual([]);
  });

  it('flags a vet-prefixed child id and a known vet-prefixed epic id', () => {
    const cases = [
      ['vet', 'yxn'].join('-') + ['', '23'].join('.'),
      ['vet', 'd4m'].join('-'),
      ['vet', 'p4a'].join('-'),
    ];
    for (const id of cases) {
      const hits = findTrackerIds([{ path: 'packages/core/src/x.ts', text: `// see ${id}\n` }]);
      expect(hits.map((hit) => hit.match)).toContain(id);
    }
  });

  it('does not flag CLI words, the vetkit name or an unknown vet-prefixed word', () => {
    const text = ['vet-run', 'vet --json', 'vetkit-wt/x', 'vet-cli', 'vet-abc'].join('\n');
    expect(findTrackerIds([{ path: 'packages/core/src/x.ts', text }])).toEqual([]);
  });

  it('skips allowlisted paths', () => {
    const text = ['mol', 'abc.1'].join('-');
    const files = ['CLAUDE.md', '.beads/issues.jsonl', 'AGENTS.md'].map((path) => ({
      path,
      text,
    }));
    expect(findTrackerIds(files)).toEqual([]);
  });

  it('finds no tracker ids in any tracked file', () => {
    expect(findTrackerIds(trackedTextFiles())).toEqual([]);
  });
});

describe('prose pointers into the tracker', () => {
  it('shipped files carry no prose pointers into the tracker', () => {
    const fixture = ['see', 'bd', 'DECISION'].join(' ') + ' on judge transport';
    const flagged = findTrackerIds([
      { path: '.env.example', text: `# Alternatives (${fixture}):\n` },
    ]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.line).toBe(1);

    expect(findTrackerIds(trackedTextFiles())).toEqual([]);
  });

  it('flags each known shape of prose pointer', () => {
    for (const text of pointerCases) {
      const hits = findTrackerIds([{ path: 'packages/core/src/x.ts', text }]);
      expect(hits.length, text).toBeGreaterThan(0);
    }
  });

  it('scans tracked dotfiles, including .env.example', () => {
    const paths = trackedTextFiles().map((file) => file.path);
    expect(paths).toContain('.env.example');
    const hits = findTrackerIds([{ path: '.env.example', text: pointerCases[0] ?? '' }]);
    expect(hits).toHaveLength(1);
  });

  it('does not flag functional mentions of the tracker directory', () => {
    const cases = ['.beads/', '/.beads', '"!.beads/**"', 'skip .beads when copying hooks'];
    for (const text of cases) {
      expect(findTrackerIds([{ path: '.gitignore', text }])).toEqual([]);
    }
  });

  it('does not flag a technical RISK comment written in plain words', () => {
    const text = '# RISK: the gateway may rename the model alias, so the served id is recorded\n';
    expect(findTrackerIds([{ path: 'scripts/x.sh', text }])).toEqual([]);
  });

  it('does not scan the one legacy hook header kept for migration', () => {
    const text = '# Advisory only (' + ['root', 'DECISION'].join(' ') + ' resolving x)\n';
    expect(findTrackerIds([{ path: 'scripts/install-hooks.ts', text }])).toEqual([]);
  });
});
