import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on Windows.
const TEMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;

// Tests create scratch directories under os.tmpdir() and rarely remove them. This runs once in
// the main process before any worker starts and points the temp dir at one fresh directory;
// workers, and every process a test spawns (the built CLI, the bash smokes), inherit it. One
// removal at the end of the run then takes everything the run created with it.
export default function setup(): () => void {
  const previous = TEMP_VARS.map((name) => [name, process.env[name]] as const);
  const runDir = mkdtempSync(join(tmpdir(), 'vetkit-test-run-'));
  for (const name of TEMP_VARS) process.env[name] = runDir;

  const remove = (): void => {
    rmSync(runDir, { recursive: true, force: true });
  };
  // Vitest skips the teardown below when the run is interrupted (SIGINT, SIGTERM) but still
  // leaves through process.exit, so the directory is removed from an exit listener as well.
  process.once('exit', remove);

  return () => {
    process.off('exit', remove);
    remove();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
