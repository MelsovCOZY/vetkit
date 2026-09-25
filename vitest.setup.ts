import { beforeEach, vi } from 'vitest';

// Unit tests never make live network calls. Every test starts with global `fetch`
// replaced by a guard that throws immediately; a test that needs the network stubs
// it back itself with `vi.stubGlobal('fetch', …)` (or a direct `globalThis.fetch =`
// assignment), which this guard does not touch. `unstubGlobals` (see vitest.config.ts)
// restores the guard before every test regardless of what the previous test did.
//
// The final-gate e2e tests against the real Jev endpoint set CEV_E2E=1 and skip this.
beforeEach(() => {
  if (process.env.CEV_E2E === '1') return;

  vi.stubGlobal('fetch', () => {
    throw new Error(
      "CevTestNetworkBlocked: use vi.stubGlobal('fetch', …) to stub fetch in this test",
    );
  });
});
