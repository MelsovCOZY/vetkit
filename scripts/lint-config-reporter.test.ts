import { describe, expect, test } from 'vitest';
import { runOxlintOnFixture } from './oxlint-fixture.ts';

const restrictedImport = 'scripts/fixtures/lint-bad/packages/judge-jev/src/restricted-import.ts';

describe('oxlint fixture runner is independent of the CI reporter', () => {
  test('with GITHUB_ACTIONS=true in the child env the rule message is still printed', () => {
    const { status, output } = runOxlintOnFixture(restrictedImport, {
      GITHUB_ACTIONS: 'true',
      CI: 'true',
    });
    expect(status).toBe(1);
    expect(output).toContain('adapters import only @vetkit/spec');
  });

  test('the GitHub ::error annotation format is never produced', () => {
    const { output } = runOxlintOnFixture(restrictedImport, { GITHUB_ACTIONS: 'true' });
    expect(output).not.toContain('::error');
  });
});
