import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunEvalsResult, RunVerdict } from '@vetkit/core';
import { safeParseJson } from '@vetkit/spec';
import { Command } from 'commander';
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_HTML_PATH,
  DEFAULT_JUNIT_PATH,
  DEFAULT_MD_PATH,
  registerReporterFlag,
  renderJunit,
  writeReports,
  writeTextReport,
  type JunitSuiteInput,
} from './junit.ts';

const fixtures = fileURLToPath(new URL('../../../../fixtures/reporters/', import.meta.url));
const TIMESTAMP = new Date('2026-09-28T12:34:56.789Z');

function loadRun(): RunEvalsResult {
  const parsed = safeParseJson<RunEvalsResult>(
    readFileSync(join(fixtures, 'run.json'), 'utf8'),
    {},
  );
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

// ---- a small XML parser: elements, attributes, text, the five predefined entities ----

interface XmlNode {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(raw: string): string {
  if (raw.includes('<')) throw new Error(`raw '<' in character data: ${raw}`);
  return raw.replaceAll(/&([^;]*);?/g, (match, name: string) => {
    const value = ENTITIES[name];
    if (value === undefined || !match.endsWith(';')) throw new Error(`bad entity: ${match}`);
    return value;
  });
}

function parseXml(xml: string): XmlNode {
  let pos = 0;
  const src = xml.replace(/^\s*<\?xml[^?]*\?>/, '');
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/y;
  const attr = /\s+([\w:.-]+)\s*=\s*"([^"]*)"/g;
  while (pos < src.length) {
    const lt = src.indexOf('<', pos);
    const text = src.slice(pos, lt === -1 ? src.length : lt);
    const top = stack.at(-1);
    if (top === undefined) {
      if (text.trim() !== '') throw new Error(`text outside the root: ${text}`);
    } else top.text += decode(text);
    if (lt === -1) break;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end === -1) throw new Error('unterminated comment');
      pos = end + 3;
      continue;
    }
    tag.lastIndex = lt;
    const m = tag.exec(src);
    if (m === null) throw new Error(`malformed tag at ${String(lt)}: ${src.slice(lt, lt + 40)}`);
    const [whole, closing, name = '', attrText = '', selfClosing] = m;
    pos = lt + whole.length;
    if (closing === '/') {
      const open = stack.pop();
      if (open?.name !== name) throw new Error(`mismatched </${name}>`);
      continue;
    }
    if (root !== undefined && stack.length === 0) throw new Error('second root element');
    const attrs: Record<string, string> = {};
    for (const [, key = '', value = ''] of attrText.matchAll(attr)) {
      if (Object.hasOwn(attrs, key)) throw new Error(`duplicate attribute ${key}`);
      attrs[key] = decode(value);
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    if (top === undefined) root = node;
    else top.children.push(node);
    if (selfClosing !== '/') stack.push(node);
  }
  if (stack.length > 0 || root === undefined) throw new Error('unclosed element or empty doc');
  return root;
}

// ---- a minimal XSD interpreter covering the constructs junit-10.xsd uses ----

interface AttrRule {
  readonly type: string;
  readonly required: boolean;
  readonly minLength: number;
}
interface ElementRule {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly type: TypeRule;
}
interface TypeRule {
  readonly attrs: Map<string, AttrRule>;
  readonly model: 'sequence' | 'choice' | 'text';
  readonly elements: ElementRule[];
}

function xsdChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === `xs:${name}`);
}

function compileSchema(xsd: XmlNode): { root: (name: string) => ElementRule } {
  const namedComplex = new Map(xsdChildren(xsd, 'complexType').map((n) => [n.attrs.name, n]));
  const namedSimple = new Map(xsdChildren(xsd, 'simpleType').map((n) => [n.attrs.name, n]));

  function simpleBase(node: XmlNode): { type: string; minLength: number } {
    const restriction = xsdChildren(node, 'restriction')[0];
    const base = restriction?.attrs.base ?? 'xs:string';
    const minLength = restriction === undefined ? 0 : xsdChildren(restriction, 'minLength')[0];
    const pattern = restriction === undefined ? undefined : xsdChildren(restriction, 'pattern')[0];
    return {
      type: pattern === undefined ? base : `pattern:${pattern.attrs.value ?? ''}`,
      minLength: typeof minLength === 'object' ? Number(minLength.attrs.value) : 0,
    };
  }

  function attrRule(node: XmlNode): [string, AttrRule] {
    const inline = xsdChildren(node, 'simpleType')[0];
    const named = node.attrs.type === undefined ? undefined : namedSimple.get(node.attrs.type);
    const simple = inline ?? named;
    const resolved =
      simple === undefined
        ? { type: node.attrs.type ?? 'xs:string', minLength: 0 }
        : simpleBase(simple);
    return [node.attrs.name ?? '', { ...resolved, required: node.attrs.use === 'required' }];
  }

  function complex(node: XmlNode): TypeRule {
    const attrs = new Map(xsdChildren(node, 'attribute').map(attrRule));
    const content = xsdChildren(node, 'complexContent')[0] ?? xsdChildren(node, 'simpleContent')[0];
    if (content !== undefined) {
      const ext = xsdChildren(content, 'extension')[0];
      if (ext === undefined) throw new Error('unsupported content');
      const baseNode = namedComplex.get(ext.attrs.base ?? '');
      const base: TypeRule =
        baseNode === undefined
          ? { attrs: new Map(), model: 'text', elements: [] }
          : complex(baseNode);
      for (const [k, v] of xsdChildren(ext, 'attribute').map(attrRule)) base.attrs.set(k, v);
      for (const [k, v] of attrs) base.attrs.set(k, v);
      return base;
    }
    const group = xsdChildren(node, 'sequence')[0] ?? xsdChildren(node, 'choice')[0];
    if (group === undefined) return { attrs, model: 'sequence', elements: [] };
    return {
      attrs,
      model: group.name === 'xs:choice' ? 'choice' : 'sequence',
      elements: xsdChildren(group, 'element').map(element),
    };
  }

  function element(node: XmlNode): ElementRule {
    const inline = xsdChildren(node, 'complexType')[0];
    const named = node.attrs.type === undefined ? undefined : namedComplex.get(node.attrs.type);
    const type = inline ?? named;
    return {
      name: node.attrs.name ?? '',
      min: Number(node.attrs.minOccurs ?? '1'),
      max: node.attrs.maxOccurs === 'unbounded' ? Infinity : Number(node.attrs.maxOccurs ?? '1'),
      type: type === undefined ? { attrs: new Map(), model: 'text', elements: [] } : complex(type),
    };
  }

  const tops = new Map(xsdChildren(xsd, 'element').map((n) => [n.attrs.name, n]));
  return {
    root(name) {
      const node = tops.get(name);
      if (node === undefined) throw new Error(`no top-level element ${name}`);
      return element(node);
    },
  };
}

function checkValue(where: string, value: string, rule: AttrRule): void {
  if (value.length < rule.minLength)
    throw new Error(`${where}: shorter than ${String(rule.minLength)}`);
  const ok =
    rule.type === 'xs:int'
      ? /^-?\d+$/.test(value)
      : rule.type === 'xs:decimal'
        ? /^-?\d+(\.\d+)?$/.test(value)
        : rule.type.startsWith('pattern:')
          ? new RegExp(`^${rule.type.slice('pattern:'.length)}$`).test(value)
          : true;
  if (!ok) throw new Error(`${where}: ${value} is not ${rule.type}`);
}

function validate(node: XmlNode, rule: ElementRule, extraAttrs: readonly string[] = []): void {
  const where = `<${node.name}>`;
  if (node.name !== rule.name) throw new Error(`expected <${rule.name}>, got ${where}`);
  for (const [name, attr] of rule.type.attrs) {
    const value = node.attrs[name];
    if (value === undefined) {
      if (attr.required) throw new Error(`${where} missing required @${name}`);
    } else checkValue(`${where}@${name}`, value, attr);
  }
  for (const name of Object.keys(node.attrs)) {
    if (!rule.type.attrs.has(name) && !extraAttrs.includes(name)) {
      throw new Error(`${where} has undeclared @${name}`);
    }
  }
  if (rule.type.model === 'text') {
    if (node.children.length > 0) throw new Error(`${where} must hold text only`);
    return;
  }
  if (rule.type.model === 'choice') {
    if (node.children.length > 1) throw new Error(`${where} allows one child`);
    for (const child of node.children) {
      const match = rule.type.elements.find((e) => e.name === child.name);
      if (match === undefined) throw new Error(`${where} does not allow <${child.name}>`);
      validate(child, match);
    }
    return;
  }
  let i = 0;
  for (const el of rule.type.elements) {
    let count = 0;
    while (i < node.children.length && node.children[i]?.name === el.name && count < el.max) {
      const child = node.children[i];
      if (child !== undefined) validate(child, el);
      i += 1;
      count += 1;
    }
    if (count < el.min) throw new Error(`${where} needs <${el.name}> at child ${String(i)}`);
  }
  if (i < node.children.length)
    throw new Error(`${where} unexpected <${node.children[i]?.name ?? ''}>`);
}

const schema = compileSchema(parseXml(readFileSync(join(fixtures, 'junit-10.xsd'), 'utf8')));

// DEVIATION (documented): the windyroad XSD declares no attributes on <testsuites>; the CI
// consumers (GitHub, GitLab, Jenkins, Buildkite) read these aggregate counts there, so they
// are the one allowance the validator makes.
const ROOT_COUNTS = ['tests', 'failures', 'errors', 'skipped'] as const;

function validateDoc(xml: string): XmlNode {
  const doc = parseXml(xml);
  validate(doc, schema.root('testsuites'), ROOT_COUNTS);
  return doc;
}

function testcases(doc: XmlNode): XmlNode[] {
  return doc.children.flatMap((s) => s.children.filter((c) => c.name === 'testcase'));
}

function suite(result: RunEvalsResult, criteriaPath = 'evals/criteria.yaml'): JunitSuiteInput {
  return { criteriaPath, result };
}

function withStatus(status: string): RunEvalsResult {
  const run = loadRun();
  const [first] = run.results;
  if (first === undefined) throw new Error('fixture has no results');
  const { answer: _a, pass: _p, ...rest } = first;
  // Statuses beyond today's Verdict vocabulary (aborted, pending-review) must skip as well.
  const verdict: RunVerdict = { ...rest, status: 'unscored' };
  Reflect.set(verdict, 'status', status);
  return { ...run, results: [verdict] };
}

describe('renderJunit', () => {
  test('renders fixtures/reporters/run.json into XML that validates against junit-10.xsd', () => {
    const xml = renderJunit([suite(loadRun())], { timestamp: TIMESTAMP });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const doc = validateDoc(xml);
    expect(doc.attrs).toMatchObject({ tests: '4', failures: '1', errors: '0', skipped: '2' });
    expect(doc.children[0]?.attrs).toMatchObject({
      name: 'criteria',
      package: 'evals/criteria.yaml',
      id: '0',
      tests: '4',
      failures: '1',
      skipped: '2',
      timestamp: '2026-09-28T12:34:56',
    });
  });

  test('one <testsuite> per criteria file, one <testcase> per case x criterion', () => {
    const run = loadRun();
    const xml = renderJunit([suite(run, 'a/tone.yaml'), suite(run, 'a/safety.yml')], {
      timestamp: TIMESTAMP,
    });
    const doc = validateDoc(xml);
    expect(doc.children.map((s) => s.attrs.name)).toEqual(['tone', 'safety']);
    expect(doc.children.map((s) => s.attrs.id)).toEqual(['0', '1']);
    expect(testcases(doc)).toHaveLength(run.results.length * 2);
    expect(doc.attrs.tests).toBe(String(run.results.length * 2));
  });

  test('testcase names embed caseId::criterionId exactly (vitest export format)', () => {
    const doc = validateDoc(renderJunit([suite(loadRun())], { timestamp: TIMESTAMP }));
    expect(testcases(doc).map((t) => t.attrs.name)).toEqual([
      'refund-1::polite',
      'refund-1::cites-policy',
      'refund-<2>&co::polite',
      'refund-<2>&co::cites-policy',
    ]);
    expect(testcases(doc).every((t) => t.attrs.classname === 'criteria')).toBe(true);
  });

  test('a pass renders a bare <testcase>', () => {
    const doc = validateDoc(renderJunit([suite(loadRun())], { timestamp: TIMESTAMP }));
    expect(testcases(doc)[0]?.children).toEqual([]);
  });

  test('a fail renders <failure message> carrying the probability and the threshold', () => {
    const doc = validateDoc(renderJunit([suite(loadRun())], { timestamp: TIMESTAMP }));
    const failure = testcases(doc)[1]?.children[0];
    expect(failure?.name).toBe('failure');
    expect(failure?.attrs.message).toContain('probability 0.31');
    expect(failure?.attrs.message).toContain('threshold 0.5');
  });

  test.each(['unscored', 'not_applicable', 'error', 'aborted', 'pending-review'])(
    'status %s renders <skipped message="<status>">, never a pass',
    (status) => {
      const doc = validateDoc(renderJunit([suite(withStatus(status))], { timestamp: TIMESTAMP }));
      const [testcase] = testcases(doc);
      expect(testcase?.children.map((c) => c.name)).toEqual(['skipped']);
      expect(testcase?.children[0]?.attrs.message).toBe(status);
      expect(doc.attrs).toMatchObject({ tests: '1', failures: '0', skipped: '1' });
    },
  );

  test('an ok verdict without pass: true is a failure, not a pass', () => {
    const run = loadRun();
    const [first] = run.results;
    if (first === undefined) throw new Error('fixture has no results');
    const { pass: _p, ...noPass } = first;
    const doc = validateDoc(
      renderJunit([suite({ ...run, results: [noPass] })], { timestamp: TIMESTAMP }),
    );
    expect(testcases(doc)[0]?.children[0]?.name).toBe('failure');
  });

  test('<properties> carry model.requested/resolved/transport/pinned', () => {
    const doc = validateDoc(renderJunit([suite(loadRun())], { timestamp: TIMESTAMP }));
    const props = doc.children[0]?.children.find((c) => c.name === 'properties');
    const map = Object.fromEntries(
      (props?.children ?? []).map((p) => [p.attrs.name, p.attrs.value]),
    );
    expect(map).toMatchObject({
      'model.requested': 'typesafe-ai/jev',
      'model.resolved': 'typesafe-ai/jev-2026-09',
      'model.transport': 'vercel-ai-gateway',
      'model.pinned': 'false',
    });
  });

  test('zero results render a valid empty <testsuites tests="0">', () => {
    const empty = validateDoc(renderJunit([], { timestamp: TIMESTAMP }));
    expect(empty.name).toBe('testsuites');
    expect(empty.attrs.tests).toBe('0');
    expect(empty.children).toEqual([]);
    const run = loadRun();
    const noResults = validateDoc(
      renderJunit([suite({ ...run, results: [] })], { timestamp: TIMESTAMP }),
    );
    expect(noResults.attrs.tests).toBe('0');
    expect(noResults.children[0]?.attrs.tests).toBe('0');
  });

  test('ids with < and & are escaped in the raw XML', () => {
    const xml = renderJunit([suite(loadRun())], { timestamp: TIMESTAMP });
    expect(xml).toContain('name="refund-&lt;2&gt;&amp;co::polite"');
    expect(xml).not.toContain('refund-<2>');
  });

  test('two criteria files with the same base name get short-hash suffixed suite names', () => {
    const run = loadRun();
    const doc = validateDoc(
      renderJunit([suite(run, 'a/criteria.yaml'), suite(run, 'b/criteria.yaml')], {
        timestamp: TIMESTAMP,
      }),
    );
    const names = doc.children.map((s) => s.attrs.name ?? '');
    expect(names[0]).toMatch(/^criteria-[0-9a-f]{6,8}$/);
    expect(names[1]).toMatch(/^criteria-[0-9a-f]{6,8}$/);
    expect(names[0]).not.toBe(names[1]);
  });

  test('is pure: same input, same output', () => {
    const run = loadRun();
    expect(renderJunit([suite(run)], { timestamp: TIMESTAMP })).toBe(
      renderJunit([suite(run)], { timestamp: TIMESTAMP }),
    );
  });
});

function parseRun(args: readonly string[]): Record<string, unknown> {
  const cmd = registerReporterFlag(new Command('run').exitOverride());
  cmd.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  cmd.action(() => {});
  cmd.parse(['node', 'run', ...args]);
  return cmd.opts();
}

describe('registerReporterFlag', () => {
  test('--reporter junit defaults the path to .vet/junit.xml', () => {
    expect(DEFAULT_JUNIT_PATH).toBe('.vet/junit.xml');
    expect(parseRun(['--reporter', 'junit']).reporter).toEqual([
      { kind: 'junit', path: '.vet/junit.xml' },
    ]);
  });

  test('--reporter junit=<path> takes the given path', () => {
    expect(parseRun(['--reporter', 'junit=out/vet-junit.xml']).reporter).toEqual([
      { kind: 'junit', path: 'out/vet-junit.xml' },
    ]);
  });

  test('--reporter junit,md,html defaults the three paths', () => {
    expect(DEFAULT_MD_PATH).toBe('.vet/report.md');
    expect(DEFAULT_HTML_PATH).toBe('.vet/report.html');
    expect(parseRun(['--reporter', 'junit,md,html']).reporter).toEqual([
      { kind: 'junit', path: '.vet/junit.xml' },
      { kind: 'md', path: '.vet/report.md' },
      { kind: 'html', path: '.vet/report.html' },
    ]);
  });

  test('--reporter md=a.md,html=b.html takes the given paths', () => {
    expect(parseRun(['--reporter', 'md=a.md, html=b.html']).reporter).toEqual([
      { kind: 'md', path: 'a.md' },
      { kind: 'html', path: 'b.html' },
    ]);
  });

  test('an unknown kind is rejected', () => {
    expect(() => parseRun(['--reporter', 'pdf'])).toThrow(/reporter/);
    expect(() => parseRun(['--reporter', 'junit,pdf=x'])).toThrow(/unknown reporter/);
    expect(() => parseRun(['--reporter', 'junit='])).toThrow(/reporter/);
    expect(() => parseRun(['--reporter', 'md='])).toThrow(/reporter/);
  });

  test('a repeated kind is rejected', () => {
    expect(() => parseRun(['--reporter', 'junit,junit=x'])).toThrow(/given twice/);
    expect(() => parseRun(['--reporter', 'md,md=other.md'])).toThrow(/"md" given twice/);
  });

  test('no flag leaves the reporter unset', () => {
    expect(parseRun([]).reporter).toBeUndefined();
  });
});

describe('writeReports', () => {
  test('creates a missing directory, writes the XML atomically and nothing to stdout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vetkit-junit-'));
    const stdout = vi.spyOn(process.stdout, 'write');
    try {
      const written = await writeReports(
        { kind: 'junit', path: 'deep/missing/vet-junit.xml' },
        [suite(loadRun())],
        { cwd, timestamp: TIMESTAMP },
      );
      expect(written).toBe(join(cwd, 'deep/missing/vet-junit.xml'));
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
    const xml = readFileSync(join(cwd, 'deep/missing/vet-junit.xml'), 'utf8');
    expect(testcases(validateDoc(xml))).toHaveLength(4);
    expect(readdirSync(join(cwd, 'deep/missing'))).toEqual(['vet-junit.xml']);
  });

  test('writes the default path under .vet when given --reporter junit', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vetkit-junit-'));
    await writeReports({ kind: 'junit', path: DEFAULT_JUNIT_PATH }, [suite(loadRun())], { cwd });
    expect(existsSync(join(cwd, '.vet/junit.xml'))).toBe(true);
  });

  test('no reporter writes nothing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vetkit-junit-'));
    expect(await writeReports(undefined, [suite(loadRun())], { cwd })).toBeUndefined();
    expect(readdirSync(cwd)).toEqual([]);
  });

  test('writes only the kinds asked for and returns their absolute paths', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vetkit-junit-'));
    const mdOnly = await writeReports({ kind: 'md', path: 'r.md' }, [suite(loadRun())], { cwd });
    expect(mdOnly).toBeUndefined();
    expect(readdirSync(cwd)).toEqual([]);
    const junit = await writeReports({ kind: 'junit', path: 'j.xml' }, [suite(loadRun())], { cwd });
    expect(junit).toBe(join(cwd, 'j.xml'));
    expect(readdirSync(cwd)).toEqual(['j.xml']);
  });
});

describe('writeTextReport', () => {
  test('md/html are written atomically (no .tmp left) into created directories', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vetkit-text-'));
    const target = join(cwd, 'a', 'b', 'report.md');
    await writeTextReport(target, '### hello\n');
    expect(readFileSync(target, 'utf8')).toBe('### hello\n');
    expect(readdirSync(join(cwd, 'a', 'b'))).toEqual(['report.md']);
    await writeTextReport(target, 'second');
    expect(readFileSync(target, 'utf8')).toBe('second');
    expect(readdirSync(join(cwd, 'a', 'b'))).toEqual(['report.md']);
  });

  test('a failed write leaves no temp file behind', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vetkit-text-'));
    // A directory in the way makes the rename fail.
    mkdirSync(join(cwd, 'taken'));
    await expect(writeTextReport(join(cwd, 'taken'), 'x')).rejects.toThrow();
    expect(readdirSync(cwd)).toEqual(['taken']);
  });
});
