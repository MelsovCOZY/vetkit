// The e2e vitest project only collects e2e/**/*.e2e.test.ts; this pulls the J1 journey test
// (packages/cli/e2e/j1-run.e2e.test.ts, the path the J1 gate names) into that project.
// oxlint-disable-next-line import/no-unassigned-import -- imported for its describe/it side effects
import '../packages/cli/e2e/j1-run.e2e.test.ts';
