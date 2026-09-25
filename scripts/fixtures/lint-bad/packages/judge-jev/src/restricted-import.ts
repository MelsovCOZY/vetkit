// Fixture: adapters may only import @vetkit/spec. This simulates a real
// packages/judge-jev/src file reaching straight into @vetkit/core, which
// scripts/lint-config.test.ts asserts fails no-restricted-imports.
import { doSomething } from '@vetkit/core';

export function run(): void {
  doSomething();
}
