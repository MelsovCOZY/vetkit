import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADVISORY = 'https://github.com/MelsovCOZY/vetkit/security/advisories/new';

const FILES = [
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
] as const;

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('community health files', () => {
  it.each(FILES)('%s exists and is non-empty', (path) => {
    expect(existsSync(join(ROOT, path))).toBe(true);
    expect(read(path).trim().length).toBeGreaterThan(0);
  });

  it('SECURITY.md states the reporting link and the three timelines', () => {
    const security = read('SECURITY.md');
    expect(security).toContain(ADVISORY);
    expect(security).toContain('3 business days');
    expect(security).toContain('7 days');
    expect(security).toContain('90 days');
  });

  it('no community file contains an email address', () => {
    for (const path of FILES) {
      expect(read(path), path).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    }
  });

  it('CODE_OF_CONDUCT.md is Contributor Covenant 2.1 with the advisory link as contact', () => {
    const coc = read('CODE_OF_CONDUCT.md');
    expect(coc).toContain('Contributor Covenant');
    expect(coc).toContain('https://www.contributor-covenant.org/version/2/1/code_of_conduct.html');
    expect(coc).toContain(ADVISORY);
    expect(coc).not.toContain('[INSERT CONTACT METHOD]');
  });

  it('issue template config disables blank issues and links the advisory page', () => {
    const config = read('.github/ISSUE_TEMPLATE/config.yml');
    expect(config).toMatch(/^blank_issues_enabled: false$/m);
    expect(config).toContain(ADVISORY);
  });

  it('bug report form asks for version, Node, preset and doctor output', () => {
    const form = read('.github/ISSUE_TEMPLATE/bug_report.yml');
    expect(form).toContain('vet --version');
    expect(form).toContain('Node');
    expect(form).toMatch(/preset/i);
    expect(form).toContain('vet doctor');
    expect(form).toMatch(/^body:$/m);
  });
});
