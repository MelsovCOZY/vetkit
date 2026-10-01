import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = 'https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/';
const BLOB = 'https://github.com/MelsovCOZY/vetkit/blob/master/';
const REPO = 'https://github.com/MelsovCOZY/vetkit';

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

const cliReadme = read('packages/cli/README.md');
const rootReadme = read('README.md');
const cliManifest: { description: string } = JSON.parse(read('packages/cli/package.json'));

const packageNames = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((dir) => dir !== 'cli' && dir !== 'scorers')
  .map((dir) => {
    const manifest: { name: string } = JSON.parse(read(`packages/${dir}/package.json`));
    return manifest.name;
  });

function lines(text: string): string[] {
  return text.split('\n');
}

/** The first non-blank line after the H1. */
function tagline(text: string): string {
  const rows = lines(text);
  return rows.slice(1).find((row) => row.trim() !== '') ?? '';
}

/** Body of the `## <title>` section, up to the next H2. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  if (start === -1) return '';
  const body = text.slice(start + 1);
  const next = body.indexOf('\n## ', 4);
  return next === -1 ? body : body.slice(0, next);
}

function fences(text: string): string[] {
  return [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? '');
}

function allReadmes(): string[] {
  const found = ['README.md'];
  for (const entry of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    const path = `packages/${entry.name}/README.md`;
    if (entry.isDirectory() && existsSync(join(ROOT, path))) found.push(path);
  }
  return found;
}

const SITE = 'https://melsovcozy.github.io/vetkit/';
const H1 = '# vetkit — LLM evals judged by typed decisions';

/** The paragraph that starts at the tagline: its lines joined with a space, as rendered. */
function firstParagraph(text: string): string {
  const rows = lines(text);
  const start = rows.findIndex((row, at) => at > 0 && row.trim() !== '');
  const paragraph: string[] = [];
  for (const row of rows.slice(start)) {
    if (row.trim() === '') break;
    paragraph.push(row.trim());
  }
  return paragraph.join(' ');
}

/** Everything above the Quickstart heading: logo, H1, pitch, badges and the nav line. */
function head(text: string): string {
  return text.slice(0, text.indexOf('\n## Quickstart'));
}

/** Link and image targets of a README: Markdown `](target)` and HTML src/href. */
function targets(text: string): string[] {
  const markdown = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1] ?? '');
  const html = [...text.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
  return [...markdown, ...html];
}

/** A cli README section with its absolute targets turned back into the repo-relative form. */
function normalise(text: string): string {
  return text
    .replaceAll(RAW, '')
    .replaceAll(BLOB, '')
    .replaceAll(`${SITE}docs/ci-gate.html`, 'docs/ci-gate.md');
}

describe('landing README', () => {
  it('both READMEs open with the H1 phrase and a tagline equal to the package description', () => {
    expect(lines(cliReadme)[0]).toBe(H1);
    expect(lines(rootReadme)[0]).toBe(H1);
    expect(tagline(cliReadme)).toBe(cliManifest.description);
    expect(tagline(rootReadme)).toBe(tagline(cliReadme));
  });

  it('the first paragraph is under 300 chars and names the search terms and the keyless try-out', () => {
    for (const text of [cliReadme, rootReadme]) {
      const paragraph = firstParagraph(text);
      expect(paragraph.length).toBeLessThan(300);
      for (const term of ['LLM evals', 'LLM-as-a-judge', 'CI gate', 'vitest', 'TypeScript']) {
        expect(paragraph, term).toContain(term);
      }
      expect(paragraph).toMatch(/no API key/i);
    }
  });

  it('badges: npm version, npm downloads, CI workflow status, license and Scorecard', () => {
    for (const text of [cliReadme, rootReadme]) {
      const badges = head(text);
      expect(badges).toContain(
        'https://api.scorecard.dev/projects/github.com/MelsovCOZY/vetkit/badge',
      );
      expect(badges).toMatch(/npm\/v\/vetkit/);
      expect(badges).toMatch(/npm\/dm\/vetkit/);
      expect(badges).toContain(`${REPO}/actions/workflows/ci.yml/badge.svg`);
      expect(badges).toContain('github/license/MelsovCOZY/vetkit');
      expect(badges).toContain('Apache-2.0');
    }
  });

  it('the logo appears above Quickstart with alt text: relative in README.md, raw URL on npm', () => {
    expect(head(rootReadme)).toMatch(/<img src="assets\/logo\.png" alt="[^"]{5,}"/);
    expect(head(cliReadme)).toMatch(
      new RegExp(String.raw`<img src="${RAW}assets/logo\.png" alt="[^"]{5,}"`),
    );
  });

  it('a nav line under the badges links Docs, Quickstart, Integrations, GitHub Action and llms.txt', () => {
    const rootNav = lines(head(rootReadme)).find((row) => row.includes('[Docs](')) ?? '';
    const cliNav = lines(head(cliReadme)).find((row) => row.includes('[Docs](')) ?? '';
    for (const [nav, examples, action] of [
      [rootNav, 'examples/', 'action/README.md'],
      [cliNav, `${REPO}/tree/master/examples`, `${BLOB}action/README.md`],
    ] as const) {
      expect(nav).toContain(`[Docs](${SITE})`);
      expect(nav).toContain('[Quickstart](#quickstart)');
      expect(nav).toContain(`[Integrations](${examples})`);
      expect(nav).toContain(`[GitHub Action](${action})`);
      expect(nav).toContain(`[llms.txt](${SITE}llms.txt)`);
    }
    const badgeAt = rootReadme.indexOf('npm/v/vetkit');
    expect(rootReadme.indexOf(rootNav)).toBeGreaterThan(badgeAt);
  });

  it('Jev is explained as the default typed-decision judge the first time it appears', () => {
    for (const text of [cliReadme, rootReadme]) {
      const at = text.indexOf('Jev');
      expect(at).toBeGreaterThan(0);
      const sentence = text.slice(at, text.indexOf('.', at) + 1);
      expect(sentence).toMatch(/^Jev, TypeSafe AI's typed-decision judge/);
      expect(sentence).toContain('default');
    }
  });

  it('README.md has Quickstart, CI, How it compares, Trust, Coding agents and Packages in order', () => {
    const order = [
      '## Quickstart',
      '## CI',
      '## How it compares',
      '## Trust',
      '## Coding agents',
      '## Packages',
      '## Contributing',
    ].map((title) => rootReadme.indexOf(`\n${title}\n`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it('the npm page has Quickstart then CI and leaves the rest to the docs site', () => {
    const order = ['## Quickstart', '## CI'].map((title) => cliReadme.indexOf(`\n${title}\n`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    for (const title of ['## Trust', '## Packages', '## How it compares', '## vs ']) {
      expect(cliReadme, title).not.toContain(`\n${title}`);
    }
    expect(cliReadme.slice(cliReadme.indexOf('\n## CI\n'))).toContain(SITE);
  });

  it('every link and image target on the npm page is an https URL or a same-page anchor', () => {
    const found = targets(cliReadme);
    expect(found.length).toBeGreaterThan(10);
    for (const target of found) expect(target, target).toMatch(/^(https:\/\/|#)/);
  });

  it('quickstart lists the three commands, demoJudge and the .env line, and never npx vet', () => {
    const quickstart = section(cliReadme, 'Quickstart');
    const commands = fences(quickstart).find((block) => block.includes('npm i -D vetkit')) ?? '';
    expect(commands.trim().split('\n')).toEqual([
      'npm i -D vetkit',
      'npx vetkit init',
      'npx vetkit run',
    ]);
    expect(quickstart).toContain('judge: demoJudge');
    expect(quickstart).toContain("imported from 'vetkit'");
    expect(quickstart).toMatch(/needs no key/);
    expect(quickstart).toContain('`demo`');
    expect(fences(quickstart)).toContain('OPENROUTER_API_KEY=...\n');
    expect(cliReadme).not.toMatch(/npx vet /);
    expect(rootReadme).not.toMatch(/npx vet /);
  });

  it('CI snippet uses the v0 major tag with env and permissions', () => {
    const ci = section(cliReadme, 'CI');
    const workflow = fences(ci).find((block) => block.includes('uses: MelsovCOZY/vetkit@v0')) ?? '';
    expect(workflow).toMatch(
      /uses: MelsovCOZY\/vetkit@v0\n\s+env:\n\s+OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/,
    );
    expect(workflow).toMatch(/permissions:\n(?:\s+contents: read\n)?\s+pull-requests: write/);
    expect(ci).toContain('`vet run` is an uncalibrated threshold gate');
    expect(ci).toContain('`vet run --gate`');
    expect(ci).toContain('calibrated');
    expect(cliReadme).not.toContain('@v1');
  });

  it('trust section names license, telemetry, install scripts, judge, pinned and drift', () => {
    const trust = section(rootReadme, 'Trust');
    for (const phrase of [
      'Apache-2.0',
      'zero telemetry',
      'no install scripts',
      'typesafe-ai/jev',
      'pinned: false',
    ]) {
      expect(trust, phrase).toContain(phrase);
    }
    expect(trust).toMatch(/drift run to run/);
    expect(trust).toMatch(/at least 3 repeats/);
    expect(trust).toMatch(/one minor/);
    expect(trust).toMatch(/release/i);
  });

  it('the comparison is by category, keeps only cited vendor facts and has no unchecked cell', () => {
    const compare = section(rootReadme, 'How it compares');
    for (const phrase of ['typed-decision judge', 'calibrated', 'no key', 'prompt-based']) {
      expect(compare, phrase).toContain(phrase);
    }
    // Each vendor fact that stays is backed by the source line that already cited it.
    expect(compare).toContain('https://www.promptfoo.dev/docs/configuration/telemetry/');
    expect(compare).toContain('https://deepeval.com/docs/data-privacy');
    expect(compare).toContain('https://www.npmjs.com/package/promptfoo');
    for (const text of [cliReadme, rootReadme]) {
      expect(text).not.toMatch(/not checked/i);
      expect(text).not.toContain('## vs ');
    }
  });

  it('a Coding agents section points at llms.txt and the setup skill', () => {
    const agents = section(rootReadme, 'Coding agents');
    expect(agents).toContain(`${SITE}llms.txt`);
    expect(agents).toContain('skills/vetkit-setup/SKILL.md');
  });

  it('the Quickstart and CI sections of the npm page equal README.md after link normalisation', () => {
    for (const title of ['Quickstart', 'CI']) {
      expect(normalise(section(cliReadme, title)), title).toBe(section(rootReadme, title));
    }
    expect(rootReadme).toContain('\n## Contributing\n');
    expect(rootReadme).not.toContain('@vetkit/source-langfuse');
    expect(rootReadme).toContain('(packages/core)');
  });

  it('no README uses the old npx form, the old Node floor, @v1 or the preset shorthand', () => {
    for (const path of allReadmes()) {
      const text = read(path);
      expect(text, path).not.toMatch(/npx vet /);
      expect(text, path).not.toContain('Node >=22.12');
      expect(text, path).not.toContain('@v1');
      expect(text, path).not.toContain("preset: 'demo'");
    }
  });

  it('no command fence holds prose', () => {
    for (const block of fences(cliReadme)) {
      if (!/^(npm|npx|vet) /.test(block)) continue;
      for (const row of block.trim().split('\n')) {
        expect(row, row).toMatch(/^(npm|npx|vet) /);
      }
    }
  });

  it.each(packageNames)('%s has a README opening with its package name', (name) => {
    const dir = name.replace('@vetkit/', '');
    const text = read(`packages/${dir}/README.md`);
    expect(lines(text)[0]).toBe(`# ${name}`);
    expect(text).toContain(REPO);
    expect(text).not.toMatch(/npx vet /);
  });

  it('program.ts passes the package description to commander', () => {
    const source = read('packages/cli/src/program.ts');
    expect(source).toContain('.description(readDescription())');
    expect(source).toContain('function readDescription()');
    expect(source).not.toContain("'vetkit CLI'");
  });
});

describe('terminal screenshot', () => {
  const image = 'assets/vet-run.png';

  it('the tape runs npx vetkit init then npx vetkit run and screenshots to assets/vet-run.png', () => {
    const tape = read('assets/vet-run.tape');
    const init = tape.indexOf('Type "npx vetkit init"');
    const run = tape.indexOf('Type "npx vetkit run"');
    const shot = tape.indexOf(`Screenshot ${image}`);
    expect(init).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(init);
    expect(shot).toBeGreaterThan(run);
    expect(tape).not.toMatch(/npx vet /);
    expect(tape).toContain('env -u OPENROUTER_API_KEY');
  });

  it('the screenshot exists and is at most 150 KB', () => {
    expect(existsSync(join(ROOT, image))).toBe(true);
    expect(statSync(join(ROOT, image)).size).toBeLessThanOrEqual(150 * 1024);
  });

  it('both READMEs show the screenshot after Quickstart with alt text', () => {
    const pairs = [
      [cliReadme, `${RAW}${image}`],
      [rootReadme, image],
    ] as const;
    for (const [text, url] of pairs) {
      const match = new RegExp(
        String.raw`!\[([^\]]{20,})\]\(${url.replaceAll('.', String.raw`\.`)}\)`,
      ).exec(text);
      expect(match, url).not.toBeNull();
      expect(match?.index ?? 0).toBeGreaterThan(text.indexOf('\n## Quickstart\n'));
      expect(match?.index ?? Infinity).toBeLessThan(text.indexOf('\n## CI\n'));
    }
  });

  it('the tape has no Output directive for gif or video', () => {
    const tape = read('assets/vet-run.tape');
    expect(tape).not.toMatch(/^\s*Output\b/m);
    expect(tape).not.toMatch(/\.(gif|mp4|webm)\b/);
  });
});

describe('report screenshot', () => {
  const image = 'assets/vet-report.png';

  it('assets/vet-report.png exists, is a PNG and is under 200 KB', () => {
    expect(existsSync(join(ROOT, image))).toBe(true);
    const bytes = readFileSync(join(ROOT, image));
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.length).toBeLessThan(200 * 1024);
  });

  it('both READMEs embed the report image with alt text that says it is the HTML report', () => {
    const pairs = [
      [cliReadme, `${RAW}${image}`],
      [rootReadme, image],
    ] as const;
    for (const [text, url] of pairs) {
      const match = new RegExp(
        String.raw`!\[([^\]]{20,})\]\(${url.replaceAll('.', String.raw`\.`)}\)`,
      ).exec(text);
      expect(match, url).not.toBeNull();
      expect(match?.[1] ?? '', url).toMatch(/HTML report/);
    }
  });

  it('every image in the cli README has an absolute https URL', () => {
    const urls = [...cliReadme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url, url).toMatch(/^https:\/\//);
  });

  it('the tape works in a directory with a fixed name, not a bare mktemp directory', () => {
    const tape = read('assets/vet-run.tape');
    expect(tape).not.toContain('cd $(mktemp -d)');
    expect(tape).toContain('/my-app');
  });

  it('no file under assets/ and neither README names a /tmp/tmp. path', () => {
    const paths = [
      'README.md',
      'packages/cli/README.md',
      ...readdirSync(join(ROOT, 'assets')).map((name) => `assets/${name}`),
    ];
    for (const path of paths) {
      expect(readFileSync(join(ROOT, path), 'latin1'), path).not.toContain('/tmp/tmp.');
    }
  });
});
