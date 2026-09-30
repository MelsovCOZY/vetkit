import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEV_ERROR_CODES } from '@vetkit/spec';
import { describe, expect, it } from 'vitest';
import { loadCriteria } from './criteria/load.ts';
import {
  CRITERIA_MIGRATIONS,
  MIGRATE_DOCS,
  SCHEMA_CHANGELOG,
  SCHEMA_VERSIONS,
  checkSchemaVersion,
  stampCriteriaSchemaVersion,
} from './schema-version.ts';
import { readLock } from './validate/lock.ts';

const LINK = 'https://melsovcozy.github.io/vetkit/docs/migrate.html';

const CRITERION = `  - id: tone
    type: boolean
    instructions: Is the reply polite?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
`;

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vetkit-schema-version-'));
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

describe('schema versions', () => {
  it('checkSchemaVersion accepts absent and current versions', () => {
    expect(SCHEMA_VERSIONS).toEqual({ criteria: 1, lock: 1, runRecord: 1 });
    expect(MIGRATE_DOCS).toBe(LINK);
    expect(checkSchemaVersion('criteria', undefined)).toEqual({ ok: true });
    expect(checkSchemaVersion('criteria', 1)).toEqual({ ok: true });
    expect(checkSchemaVersion('lock', 1)).toEqual({ ok: true });
    expect(checkSchemaVersion('runRecord', undefined)).toEqual({ ok: true });
  });

  it('checkSchemaVersion refuses a newer version with the migrate link', () => {
    expect(checkSchemaVersion('criteria', 2)).toEqual({
      ok: false,
      message: `criteria.yaml schemaVersion 2 is newer than this vetkit supports (1); upgrade vetkit or see ${LINK}`,
    });
    const lock = checkSchemaVersion('lock', 3);
    expect(lock.ok).toBe(false);
    if (!lock.ok) {
      expect(lock.message).toContain('criteria.lock.json lockVersion 3');
      expect(lock.message.endsWith(LINK)).toBe(true);
    }
    for (const bad of [0, 1.5, 'one', null]) {
      const result = checkSchemaVersion('criteria', bad);
      expect(result.ok, String(bad)).toBe(false);
      if (!result.ok) expect(result.message.endsWith(LINK)).toBe(true);
    }
  });

  it('stampCriteriaSchemaVersion inserts schemaVersion first and keeps comments', () => {
    const text = `# leading comment
# second line
criteria:
  # about tone
${CRITERION.replace('id: tone', 'id: tone # trailing')}`;
    const stamped = stampCriteriaSchemaVersion(text);
    expect(stamped.changed).toBe(true);
    expect(stamped.from).toBeNull();
    expect(stamped.text.startsWith('# leading comment\n# second line\n')).toBe(true);
    expect(stamped.text.indexOf('schemaVersion: 1')).toBeGreaterThan(-1);
    expect(stamped.text.indexOf('schemaVersion: 1')).toBeLessThan(
      stamped.text.indexOf('criteria:'),
    );
    expect(stamped.text).toContain('# about tone');
    expect(stamped.text).toContain('# trailing');
  });

  it('stampCriteriaSchemaVersion is a no-op on a stamped document', () => {
    const text = `schemaVersion: 1\ncriteria:\n${CRITERION}`;
    expect(stampCriteriaSchemaVersion(text)).toEqual({ changed: false, text, from: 1 });
    const newer = `schemaVersion: 2\ncriteria:\n${CRITERION}`;
    expect(stampCriteriaSchemaVersion(newer)).toEqual({ changed: false, text: newer, from: 2 });
  });

  it('CRITERIA_MIGRATIONS chains every version below the current one', () => {
    const steps = [...CRITERIA_MIGRATIONS].toSorted((a, b) => a.from - b.from);
    expect(steps).toHaveLength(SCHEMA_VERSIONS.criteria - 1);
    for (const [index, step] of steps.entries()) {
      expect(step.from).toBe(index + 1);
      expect(step.to).toBe(index + 2);
    }
  });

  it('loadCriteria accepts a file without schemaVersion', async () => {
    const bare = await tempFile('criteria.yaml', `criteria:\n${CRITERION}`);
    expect((await loadCriteria(bare)).ok).toBe(true);
    const one = await tempFile('criteria.yaml', `schemaVersion: 1\ncriteria:\n${CRITERION}`);
    expect((await loadCriteria(one)).ok).toBe(true);
  });

  it('loadCriteria reports schemaVersion 2 at /schemaVersion with the link', async () => {
    const file = await tempFile('criteria.yaml', `schemaVersion: 2\ncriteria:\n${CRITERION}`);
    const result = await loadCriteria(file);
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: CEV_ERROR_CODES.CRITERIA_INVALID,
          path: '/schemaVersion',
          message: `criteria.yaml schemaVersion 2 is newer than this vetkit supports (1); upgrade vetkit or see ${LINK}`,
        },
      ],
    });
    for (const bad of ['0', '1.5', 'one']) {
      const other = await tempFile(
        'criteria.yaml',
        `schemaVersion: ${bad}\ncriteria:\n${CRITERION}`,
      );
      const loaded = await loadCriteria(other);
      expect(loaded.ok, bad).toBe(false);
      if (!loaded.ok) expect(loaded.issues[0]?.path).toBe('/schemaVersion');
    }
  });

  it('readLock reports lockVersion 2 with the migrate link', async () => {
    const file = await tempFile('criteria.lock.json', JSON.stringify({ lockVersion: 2 }));
    const result = await readLock(file);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe(CEV_ERROR_CODES.CONFIG_INVALID);
    expect(result.error.message).toBe(
      `criteria.lock.json lockVersion 2 is newer than this vetkit supports (1); upgrade vetkit or see ${LINK}`,
    );
  });

  it('SCHEMA_CHANGELOG has an entry for every format and version', () => {
    for (const format of ['criteria', 'lock', 'runRecord'] as const) {
      for (let version = 1; version <= SCHEMA_VERSIONS[format]; version += 1) {
        const entries = SCHEMA_CHANGELOG.filter(
          (e) => e.format === format && e.version === version,
        );
        expect(entries, `${format} v${String(version)}`).toHaveLength(1);
        expect(entries[0]?.summary.length).toBeGreaterThan(0);
      }
    }
  });
});
