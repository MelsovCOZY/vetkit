// Plain Node test runner: `node --test action/run.test.mjs`. No network: `vet` is a shim script
// on PATH that never calls out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUN_SH = fileURLToPath(new URL('./run.sh', import.meta.url));

// Every directory these tests create sits under one root, removed when the file is done.
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'vetkit-run-test-'));
after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

function scratch(prefix) {
  return mkdtempSync(join(TEMP_ROOT, prefix));
}

// run.sh and what it starts get the root as their temp dir, and as the runner temp dir a
// tarball install lands in, so whatever they create there is removed with it.
const CHILD_ENV = { ...process.env, TMPDIR: TEMP_ROOT, RUNNER_TEMP: TEMP_ROOT };

/** A `vet` shim on its own PATH entry, so run.sh finds it ahead of any real vetkit. */
function vetShim(script) {
  const dir = scratch('vetkit-vet-shim-');
  const bin = join(dir, 'vet');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return dir;
}

function runAction(cwd, binDir) {
  return spawnSync('bash', [RUN_SH, 'run'], {
    cwd,
    env: {
      ...CHILD_ENV,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: join(cwd, 'github_output.txt'),
      INPUT_CONFIG: '',
      INPUT_GATE: 'false',
      INPUT_ALLOW_UNPINNED: 'false',
    },
    encoding: 'utf8',
  });
}

void test('run.sh keeps the RunRecord vet already wrote instead of overwriting it with --json stdout', () => {
  const dir = scratch('vetkit-run-');
  const bin = vetShim(`#!/usr/bin/env bash
set -euo pipefail
mkdir -p .vet/runs
cat > .vet/runs/latest.json <<'EOF'
{"summary":{"passed":3,"failed":0,"unscored":0},"model":{"requested":"m"},"results":[],"criteriaPath":"criteria.yaml","casesPath":"cases.yaml","startedAt":"2026-09-28T00:00:00.000Z"}
EOF
echo '{"summary":{"passed":3,"failed":0,"unscored":0},"model":{"requested":"m"},"results":[]}'
`);

  const result = runAction(dir, bin);

  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(dir, '.vet/runs/latest.json'), 'utf8'));
  assert.equal(record.criteriaPath, 'criteria.yaml');
  assert.equal(record.casesPath, 'cases.yaml');
  assert.equal(record.startedAt, '2026-09-28T00:00:00.000Z');
});

void test('run.sh falls back to the --json output when vet does not persist its own record', () => {
  const dir = scratch('vetkit-run-');
  const bin = vetShim(`#!/usr/bin/env bash
set -euo pipefail
echo '{"summary":{"passed":1,"failed":2,"unscored":0},"model":{"requested":"m"},"results":[]}'
`);

  const result = runAction(dir, bin);

  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(dir, '.vet/runs/latest.json'), 'utf8'));
  assert.equal(record.summary.passed, 1);
  assert.equal(record.summary.failed, 2);
});

/** The current PATH without any directory that already provides a `vet`. */
function pathWithoutVet() {
  return (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir !== '' && !existsSync(join(dir, 'vet')))
    .join(':');
}

/** An executable `node_modules/.bin/vet` in a fresh project directory. */
function projectWithVet(script) {
  const dir = scratch('vetkit-project-');
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"consumer","private":true}');
  const bin = join(dir, 'node_modules/.bin/vet');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return dir;
}

const PROJECT_VET = '#!/usr/bin/env bash\necho 9.9.9\n';

function runInstall(cwd, inputs, binDir) {
  return spawnSync('bash', [RUN_SH, 'install'], {
    cwd,
    env: {
      ...CHILD_ENV,
      PATH: binDir === undefined ? pathWithoutVet() : `${binDir}:${pathWithoutVet()}`,
      GITHUB_WORKSPACE: cwd,
      GITHUB_ENV: join(cwd, 'github_env.txt'),
      GITHUB_PATH: join(cwd, 'github_path.txt'),
      INPUT_TARBALLS: '',
      INPUT_VERSION: '',
      ...inputs,
    },
    encoding: 'utf8',
  });
}

/** An `npm` on PATH that records its argv instead of installing anything. */
function npmStub(cwd) {
  const dir = scratch('vetkit-npm-stub-');
  const bin = join(dir, 'npm');
  writeFileSync(bin, `#!/usr/bin/env bash\necho "$*" >> "${join(cwd, 'npm-argv.txt')}"\n`);
  chmodSync(bin, 0o755);
  return dir;
}

function readOr(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

void test('run.sh install fails with a next-step message when neither a project vet nor a version is given', () => {
  const dir = scratch('vetkit-empty-');

  const result = runInstall(dir, {});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error title=vetkit::vetkit is not installed in this project/);
  assert.match(result.stderr, /npm i -D vetkit/);
});

void test('run.sh install picks the project-local vet and records VETKIT_INSTALL_MODE=project', () => {
  const dir = projectWithVet(PROJECT_VET);

  const result = runInstall(dir, {});

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'vetkit 9.9.9 (project)');
  assert.match(readOr(join(dir, 'github_env.txt')), /^VETKIT_INSTALL_MODE=project$/m);
});

void test('run.sh install prefers tarballs over version over the project vet', () => {
  const dir = projectWithVet(PROJECT_VET);
  const tarballs = scratch('vetkit-tarballs-');
  const npm = npmStub(dir);

  const withBoth = runInstall(dir, { INPUT_TARBALLS: tarballs, INPUT_VERSION: '1.2.3' }, npm);
  assert.equal(withBoth.status, 0, withBoth.stderr);
  const tarballArgv = readOr(join(dir, 'npm-argv.txt'));
  assert.match(tarballArgv, /--prefix/);
  assert.doesNotMatch(tarballArgv, /vetkit@1\.2\.3/);
  assert.doesNotMatch(readOr(join(dir, 'github_env.txt')), /VETKIT_INSTALL_MODE=project/);

  writeFileSync(join(dir, 'npm-argv.txt'), '');
  const withVersion = runInstall(dir, { INPUT_VERSION: '1.2.3' }, npm);
  assert.equal(withVersion.status, 0, withVersion.stderr);
  const versionArgv = readOr(join(dir, 'npm-argv.txt'));
  assert.match(versionArgv, /install -g .*vetkit@1\.2\.3/);
  assert.match(readOr(join(dir, 'github_env.txt')), /^VETKIT_INSTALL_MODE=global$/m);
  assert.doesNotMatch(readOr(join(dir, 'github_env.txt')), /VETKIT_INSTALL_MODE=project/);
});

void test('run.sh install never installs globally when version is empty', () => {
  const dir = projectWithVet(PROJECT_VET);
  const npm = npmStub(dir);

  const result = runInstall(dir, {}, npm);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readOr(join(dir, 'npm-argv.txt')), '');
});

const RUN_JSON = `echo '{"summary":{"passed":1,"failed":0,"unscored":0},"model":{"requested":"m"},"results":[]}'`;

function runProject(dir, extraEnv = {}) {
  return spawnSync('bash', [RUN_SH, 'run'], {
    cwd: dir,
    env: {
      ...CHILD_ENV,
      PATH: pathWithoutVet(),
      GITHUB_WORKSPACE: dir,
      GITHUB_OUTPUT: join(dir, 'github_output.txt'),
      INPUT_CONFIG: '',
      INPUT_GATE: 'false',
      INPUT_ALLOW_UNPINNED: 'false',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

void test('run.sh run invokes the project vet through npm exec when VETKIT_INSTALL_MODE=project', () => {
  const dir = projectWithVet(`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo 9.9.9; exit 0; fi
echo hit > "\${PWD}/marker.txt"
${RUN_JSON}
`);

  const result = runProject(dir, { VETKIT_INSTALL_MODE: 'project' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readOr(join(dir, 'marker.txt')).trim(), 'hit');
});

void test('run.sh run appends version= to GITHUB_OUTPUT', () => {
  const dir = projectWithVet(`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo 9.9.9; exit 0; fi
${RUN_JSON}
`);

  const result = runProject(dir, { VETKIT_INSTALL_MODE: 'project' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readOr(join(dir, 'github_output.txt')), /^version=9\.9\.9$/m);
});

void test('run.sh run asks for the md and html reports and keeps the raw output at .vet/raw.json', () => {
  const dir = projectWithVet(`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo 9.9.9; exit 0; fi
echo "$*" > "\${PWD}/args.txt"
${RUN_JSON}
`);

  const result = runProject(dir, { VETKIT_INSTALL_MODE: 'project' });

  assert.equal(result.status, 0, result.stderr);
  const args = readOr(join(dir, 'args.txt'));
  assert.match(args, /--reporter [^ ]*md=\.vet\/report\.md/);
  assert.match(args, /html=\.vet\/report\.html/);
  assert.match(args, /junit=vet-junit\.xml/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.vet/raw.json'), 'utf8')).summary.passed, 1);
});

// vet writes .vet/ next to the resolved config, while the --reporter paths are relative to the
// working directory. With a config in a subdirectory, run.sh must keep every file it owns and ask
// for the reports inside that subdirectory's .vet, never at the workspace root.
function runDir(cwd, config) {
  return spawnSync('bash', [RUN_SH, 'dir'], {
    cwd,
    env: { ...CHILD_ENV, GITHUB_OUTPUT: join(cwd, 'github_output.txt'), INPUT_CONFIG: config },
    encoding: 'utf8',
  });
}

void test('run.sh dir appends vetDir=<config directory>/.vet to GITHUB_OUTPUT', () => {
  for (const [config, expected] of [
    ['', '.vet'],
    ['vetkit.config.ts', '.vet'],
    ['./vetkit.config.ts', '.vet'],
    ['app/vetkit.config.ts', 'app/.vet'],
    ['fixtures/cli/run/vetkit.config.mjs', 'fixtures/cli/run/.vet'],
  ]) {
    const dir = scratch('vetkit-dir-');
    const result = runDir(dir, config);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readOr(join(dir, 'github_output.txt')), `vetDir=${expected}\n`, config);
  }
});

void test('run.sh run keeps the run record, the baseline, the raw output and the reports under the .vet next to the config', () => {
  const dir = projectWithVet(`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo 9.9.9; exit 0; fi
echo "$*" > "\${PWD}/args.txt"
${RUN_JSON}
`);
  mkdirSync(join(dir, 'app/.vet/runs'), { recursive: true });
  writeFileSync(join(dir, 'app/vetkit.config.ts'), 'export default {};\n');
  // The restored base-branch result sits where the cache step put it: next to the config.
  writeFileSync(
    join(dir, 'app/.vet/runs/latest.json'),
    '{"summary":{"passed":7,"failed":0,"unscored":0}}',
  );

  const result = runProject(dir, {
    VETKIT_INSTALL_MODE: 'project',
    INPUT_CONFIG: 'app/vetkit.config.ts',
  });

  assert.equal(result.status, 0, result.stderr);
  const args = readOr(join(dir, 'args.txt'));
  assert.match(args, /--config app\/vetkit\.config\.ts/);
  assert.match(args, /--reporter [^ ]*md=app\/\.vet\/report\.md/);
  assert.match(args, /html=app\/\.vet\/report\.html/);
  assert.match(args, /junit=vet-junit\.xml/);
  const baseline = JSON.parse(readFileSync(join(dir, 'app/.vet/baseline/latest.json'), 'utf8'));
  assert.equal(baseline.summary.passed, 7);
  assert.equal(JSON.parse(readFileSync(join(dir, 'app/.vet/raw.json'), 'utf8')).summary.passed, 1);
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'app/.vet/runs/latest.json'), 'utf8')).summary.passed,
    1,
  );
  assert.equal(
    existsSync(join(dir, '.vet')),
    false,
    'nothing may be written to .vet at the workspace root',
  );
  assert.match(readOr(join(dir, 'github_output.txt')), /^passed=1$/m);
});
