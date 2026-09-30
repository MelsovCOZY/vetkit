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

const VS = '## vs promptfoo / evalite / DeepEval / Braintrust';

describe('landing README', () => {
  it('cli README opens with # vetkit and its tagline equals README.md and the package description', () => {
    expect(lines(cliReadme)[0]).toBe('# vetkit');
    expect(lines(rootReadme)[0]).toBe('# vetkit');
    expect(tagline(cliReadme)).toBe(cliManifest.description);
    expect(tagline(rootReadme)).toBe(tagline(cliReadme));
    const badges = cliReadme.slice(0, cliReadme.indexOf('\n## Quickstart'));
    expect(badges).toContain(
      'https://api.scorecard.dev/projects/github.com/MelsovCOZY/vetkit/badge',
    );
    expect(badges).toMatch(/npm\/v\/vetkit/);
  });

  it('cli README has Quickstart, CI, vs and Trust sections in order', () => {
    const order = ['## Quickstart', '## CI', VS, '## Trust'].map((title) =>
      cliReadme.indexOf(`\n${title}\n`),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
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
    const trust = section(cliReadme, 'Trust');
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

  it('vs table has a column per tool and the five comparison rows', () => {
    const vs = section(cliReadme, VS.slice(3));
    const rows = vs.split('\n').filter((row) => row.startsWith('|'));
    const header = rows[0] ?? '';
    for (const tool of ['vetkit', 'promptfoo', 'evalite', 'DeepEval', 'Braintrust']) {
      expect(header, tool).toContain(tool);
    }
    const labels = rows.slice(2).map((row) => row.split('|')[1]?.trim());
    expect(labels).toEqual([
      'First result without a key',
      'Calibrated, pinned gate with a lock',
      'Provider neutrality',
      'Telemetry',
      'Install scripts or native dependencies',
    ]);
  });

  it('README.md mirrors the cli README after link normalisation', () => {
    const packages = rootReadme.indexOf('\n## Packages\n');
    expect(packages).toBeGreaterThan(0);
    expect(rootReadme).toContain('\n## Contributing\n');
    const mirrored = rootReadme.slice(0, packages + 1);
    const normalised = cliReadme.replaceAll(RAW, '').replaceAll(BLOB, '');
    expect(`${mirrored.trimEnd()}\n`).toBe(normalised.trimEnd() + '\n');
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
