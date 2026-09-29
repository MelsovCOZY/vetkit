import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A numbered or acronym-named reference to a research brief points at a document that a reader
// without docs/INDEX.md cannot resolve, and it goes stale. State the reason inline; where a source is
// genuinely needed, name the brief by file path (docs/research/<dated file>.md §n).
const BRIEF_REF_PATTERNS: readonly RegExp[] = [
  /\b[Bb]rief ?[0-9]+\b/,
  /\bbrief §/,
  /\b(?:[A-Z]{2,4}|[Jj]ev|eval-quality) brief\b/,
  new RegExp(['toolchain', 'brief(?!\\.md)'].join('-')),
];

// Instruction files, the tracker's own export, the briefs and their index, the knowledge-graph
// output and agent settings may name briefs by number.
const ALLOWLIST: readonly RegExp[] = [
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^\.beads\//,
  /^docs\/research\//,
  /^docs\/INDEX\.md$/,
  /^graphify-out\//,
  /^\.claude\//,
  /^bun\.lock$/,
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

function findBriefRefs(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    if (ALLOWLIST.some((rule) => rule.test(file.path))) continue;
    for (const pattern of BRIEF_REF_PATTERNS) {
      const found = pattern.exec(file.text);
      if (found === null) continue;
      const line = file.text.slice(0, found.index).split('\n').length;
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

describe('research-brief references in shipped files', () => {
  it('flags a numbered reference in a comment under packages/', () => {
    const text = `// RISK (${['brief', '6'].join(' ')}): whole-call deadlines are mandatory\n`;
    const hits = findBriefRefs([{ path: 'packages/core/src/x.ts', text }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      path: 'packages/core/src/x.ts',
      line: 1,
      match: ['brief', '6'].join(' '),
    });
  });

  it('flags a section reference and a named-brief reference', () => {
    const cases = [
      `see ${['brief', '§2.3'].join(' ')}`,
      `(${['UX', 'brief'].join(' ')} C1)`,
      `${['ET', 'brief'].join(' ')} OTEL-1`,
      `${['eval-quality', 'brief'].join(' ')} item 18`,
      `${['JEV', 'brief'].join(' ')} §2`,
      `docs/research/2026-09-25-${['toolchain', 'brief'].join('-')} §2`,
    ];
    for (const text of cases) {
      expect(findBriefRefs([{ path: 'docs/contracts/x.md', text }])).not.toEqual([]);
    }
  });

  it('does not flag a brief named by file path or ordinary uses of the word', () => {
    const text = [
      'docs/research/2026-09-25-toolchain-brief.md §2',
      'docs/research/2026-09-25-jev-eval-generation-brief.md §4',
      'a brief summary of the run',
    ].join('\n');
    expect(findBriefRefs([{ path: 'packages/core/src/x.ts', text }])).toEqual([]);
  });

  it('skips allowlisted paths', () => {
    const text = ['brief', '6'].join(' ');
    const files = ['CLAUDE.md', 'docs/INDEX.md', 'docs/research/brief.md'].map((path) => ({
      path,
      text,
    }));
    expect(findBriefRefs(files)).toEqual([]);
  });

  it('finds no numbered brief references in any tracked file', () => {
    expect(findBriefRefs(trackedTextFiles())).toEqual([]);
  });
});
