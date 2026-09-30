import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const marketplace = readFileSync(join(ROOT, 'docs/listings/marketplace.md'), 'utf8');
const aiSdk = readFileSync(join(ROOT, 'docs/listings/ai-sdk-observability.md'), 'utf8');

describe('docs/listings', () => {
  it('marketplace listing has name, categories, description, prerequisites, snippet and checklist', () => {
    for (const heading of [
      'Listing name',
      'Categories',
      'Tagline',
      'Description',
      'Prerequisites',
      'Usage snippet',
      'Release checklist',
    ]) {
      expect(marketplace).toContain(`## ${heading}`);
    }
    expect(marketplace).toMatch(/Listing name[\s\S]*`vetkit`/);
    expect(marketplace).toMatch(/Primary category/);
    expect(marketplace).toMatch(/Secondary category/);
    expect(marketplace).toContain('2FA');
    expect(marketplace).toContain('branding');
  });

  it('marketplace snippet uses the v0 major tag', () => {
    expect(marketplace).toContain('uses: MelsovCOZY/vetkit@v0');
    expect(marketplace).not.toContain('@v1');
  });

  it('AI SDK listing has a PR title, provider text and submission steps', () => {
    expect(aiSdk).toContain('## PR title');
    expect(aiSdk).toContain('## Provider page text');
    expect(aiSdk).toContain('## Submission steps');
    expect(aiSdk).toContain('experimental_telemetry');
    expect(aiSdk).toContain('http/json');
    expect(aiSdk).toMatch(/no `ai` dependency/);
  });

  it('both files state that agents never submit them', () => {
    for (const text of [marketplace, aiSdk]) {
      expect(text.split('\n')[0]).toMatch(/prep text/i);
      expect(text.split('\n')[0]).toMatch(/agents never submit/i);
    }
  });
});
