import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig as coreDefineConfig } from '@vetkit/core';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadVetConfig } from './config-load.ts';
import { defineConfig } from './index.ts';
import { NODE_FLOOR_RANGE, nodeFloorError } from './node-floor.ts';
import { run } from './program.ts';
import { ensureCliBuilt } from './test-support/build-cli.ts';

const realVersion = process.version;

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

afterEach(() => {
  Object.defineProperty(process, 'version', { value: realVersion, configurable: true });
});

describe('nodeFloorError', () => {
  test('nodeFloorError: v22.12.0, v22.17.9, v23.11.0 and v24.10.0 are below the floor', () => {
    expect(NODE_FLOOR_RANGE).toBe('^22.18 || >=24.11');
    for (const version of ['v22.12.0', 'v22.17.9', 'v23.11.0', 'v24.10.0']) {
      expect(nodeFloorError(version)).toBe(
        `vetkit needs Node ^22.18 || >=24.11 (found ${version})`,
      );
    }
  });

  test('nodeFloorError: v22.18.0, v22.23.2, v24.11.0, v25.0.0 and v26.0.0 pass', () => {
    for (const version of ['v22.18.0', 'v22.23.2', 'v24.11.0', 'v25.0.0', 'v26.0.0']) {
      expect(nodeFloorError(version)).toBeUndefined();
    }
  });
});

describe('run() floor check', () => {
  test('run() with a stubbed process.version v22.12.0 writes the floor message to stderr and exits 2 before parsing argv', () => {
    Object.defineProperty(process, 'version', { value: 'v22.12.0', configurable: true });
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${String(code)}`);
    });
    const action = vi.fn();
    const program = new Command().exitOverride();
    program.command('probe').action(action);
    expect(() => {
      run(['node', 'vet', 'probe'], program);
    }).toThrow('exit:2');
    expect(written.join('')).toBe('vetkit needs Node ^22.18 || >=24.11 (found v22.12.0)\n');
    expect(action).not.toHaveBeenCalled();
  });

  test('run() on the current Node does not print the floor message', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const action = vi.fn();
    const program = new Command().exitOverride();
    program.command('probe').action(action);
    run(['node', 'vet', 'probe'], program);
    await vi.waitFor(() => {
      expect(action).toHaveBeenCalled();
    });
    expect(written.join('')).not.toContain('vetkit needs Node');
    process.removeAllListeners('SIGINT');
  });
});

describe('vetkit entry', () => {
  test("defineConfig exported by the vetkit entry is core's defineConfig", () => {
    expect(defineConfig).toBe(coreDefineConfig);
  });

  test("a vetkit.config.ts importing defineConfig from 'vetkit' loads through node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), 'vetkit-floor-'));
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(
      fileURLToPath(new URL('..', import.meta.url)),
      join(root, 'node_modules', 'vetkit'),
      'dir',
    );
    await writeFile(
      join(root, 'vetkit.config.ts'),
      `import { defineConfig } from 'vetkit';
export default defineConfig({
  judge: {
    specVersion: 'v1',
    id: 'via-vetkit',
    capabilities: { questionTypes: ['boolean'], maxStateTokens: 10, pinned: true, transport: 'inline', model: 'm' },
    async doJudge() {
      throw new Error('not called');
    },
  },
  thresholds: { default: 0.7 },
});
`,
    );
    const loaded = await loadVetConfig({ cwd: root });
    expect(loaded.judge.id).toBe('via-vetkit');
  });
});
