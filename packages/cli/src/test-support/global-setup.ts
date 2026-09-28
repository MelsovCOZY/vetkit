import type { TestProject } from 'vitest/node';
import { DIST_READY_ENV, buildWorkspace } from './build-cli.js';

// Builds the workspace dist once, before any cli test worker starts, so no test ever
// runs tsdown (which cleans dist/) while another test spawns packages/cli/dist/bin.js.
// In watch mode, reruns rebuild between runs, never during one.
export default async function setup(project: TestProject): Promise<void> {
  await buildWorkspace();
  process.env[DIST_READY_ENV] = '1';
  project.onTestsRerun(async () => {
    await buildWorkspace();
  });
}
