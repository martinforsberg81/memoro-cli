/**
 * `mc build ios --device`: the preflights the asking process runs, the
 * builder's commands in order, the read-back, and the row from `running` to
 * how it ended. Every external command is injected — a fake `run` for the
 * preflights, a fake `step` for the builder that records argv, cwd and env —
 * against a repository the test makes and a temporary work root.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../../src/mc/commands/build.js';
import {
  buildIos, buildPaths, builtApp, makeStep, pairedDevices, readBack, xcodeHint,
} from '../../src/mc/ios-build.js';
import { readIosBuilds, recordStart } from '../../src/mc/ios-builds.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/devicectl-list-devices.json', import.meta.url), 'utf8'));
const PHONE_ID = '00000000-0000-0000-0000-000000000001';

const DECLARATION = {
  schema_version: 1,
  project: 'ios/App/App.xcodeproj',
  scheme: 'App',
  bundle_id: 'test.bundle',
  team_id: 'TEAM',
  server_url: 'https://example.test',
  setup: ['npx cap add ios'],
  sync: 'npm run cap:build',
  export_options: 'ios/ExportOptions.plist',
  env: { build_number: 'X_BUILD_NUMBER', build_commit: 'X_BUILD_COMMIT' },
  info_plist_commit_key: 'MemoroBuildCommit',
  list_builds: ['node', 'scripts/list.mjs', '--json'],
  upload: ['node', 'scripts/upload.mjs'],
  app_local_plugins: ['MemoroCameraPlugin', 'MemoroSharePlugin'],
  native_paths: ['cap-config/'],
  native_dependency_prefixes: ['@capacitor/'],
};

const SHA = '3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d';

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'mc-ios-device-repo-'));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, '.mc'));
  writeFileSync(join(repo, '.mc', 'ios.json'), JSON.stringify(DECLARATION));
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'one');
  const first = sh(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  sh(repo, 'commit', '-q', '-am', 'two');
  const second = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'update-ref', 'refs/remotes/origin/main', second);
  return { repo, first, second };
}

function capture() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

function devices(list) {
  return { ...FIXTURE, result: { devices: list } };
}

const PHONE = FIXTURE.result.devices[0];
const OTHER = {
  ...PHONE,
  identifier: '00000000-0000-0000-0000-000000000002',
  deviceProperties: { ...PHONE.deviceProperties, name: 'Other iPhone' },
};

/** The preflight commands, answered: Xcode works, the identity is there, devicectl lists `list`. */
function fakeRun(list) {
  const calls = [];
  const fn = (argv, options = {}) => {
    calls.push({ argv, timeoutMs: options.timeoutMs });
    if (argv[1] === 'xcodebuild') return { code: 0, stdout: 'Xcode 26.6\n', stderr: '' };
    if (argv[0] === 'security') return { code: 0, stdout: '  1) ABCDEF "Apple Development: T (X)"\n     1 valid identities found\n', stderr: '' };
    if (argv[1] === 'devicectl') {
      writeFileSync(argv.at(-1), JSON.stringify(list));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
  };
  fn.calls = calls;
  return fn;
}

async function device({ repo, live, list = FIXTURE, argv = ['ios', '--device'], startBuilder }) {
  const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-device-work-')) };
  const stdout = capture();
  const stderr = capture();
  const started = [];
  const code = await run(argv, {
    env, stdout, stderr, repos: [{ name: 'memoro', path: repo }],
    fetchVersion: async () => ({ commit_full: live }),
    run: fakeRun(list),
    alive: () => false,
    sleep: async () => {},
    signals: { on() {}, off() {} },
    startBuilder: startBuilder || ((job) => { started.push(job); return { pid: null, error: 'test' }; }),
  });
  return { code, out: stdout.text, err: stderr.text, env, started };
}

describe('devicectl list devices', () => {
  it('reads the paired iPhone from the pinned fixture', () => {
    assert.deepEqual(pairedDevices(FIXTURE), [{
      id: PHONE_ID, name: 'Test iPhone', model: 'iPhone 14 Plus', udid: '00008110-000000000000000A',
    }]);
  });

  it('leaves out a phone that is not paired and a device that is not iOS', () => {
    const unpaired = { ...PHONE, connectionProperties: { ...PHONE.connectionProperties, pairingState: 'unpaired' } };
    const watch = { ...OTHER, hardwareProperties: { ...PHONE.hardwareProperties, platform: 'watchOS' } };
    assert.deepEqual(pairedDevices(devices([unpaired, watch])), []);
  });
});

describe('mc build ios --device — the preflights', () => {
  it('refuses without a paired iPhone, and starts nothing', async () => {
    const { repo, second } = makeRepo();
    const unpaired = { ...PHONE, connectionProperties: { ...PHONE.connectionProperties, pairingState: 'unpaired' } };
    const { code, err, env, started } = await device({ repo, live: second, list: devices([unpaired]) });
    assert.equal(code, 1);
    assert.equal(err, 'mc: no paired iPhone — connect and unlock it, trust this Mac\n');
    assert.deepEqual(started, []);
    assert.deepEqual(readIosBuilds(env), []);
  });

  it('lists two phones with --device-id and builds on neither', async () => {
    const { repo, second } = makeRepo();
    const { code, err, started } = await device({ repo, live: second, list: devices([PHONE, OTHER]) });
    assert.equal(code, 1);
    assert.match(err, /2 paired iPhones — say which:/u);
    assert.match(err, new RegExp(`--device-id ${PHONE_ID}\\s+Test iPhone \\(iPhone 14 Plus\\)`, 'u'));
    assert.match(err, /--device-id 00000000-0000-0000-0000-000000000002\s+Other iPhone/u);
    assert.deepEqual(started, []);
  });

  it('takes the phone --device-id names among several', async () => {
    const { repo, second } = makeRepo();
    const { code, started } = await device({
      repo, live: second, list: devices([PHONE, OTHER]), argv: ['ios', '--device', '--device-id', 'Other iPhone'],
    });
    assert.equal(code, 1, 'the fake builder did not start');
    assert.equal(started[0].device.id, '00000000-0000-0000-0000-000000000002');
  });

  it('refuses a --sha production does not contain', async () => {
    const { repo, first, second } = makeRepo();
    const { code, err, started, env } = await device({ repo, live: first, argv: ['ios', '--device', '--sha', second] });
    assert.equal(code, 1);
    assert.equal(err, `mc: production runs ${first.slice(0, 7)}, which does not contain ${second.slice(0, 7)} — mc deploy first\n`);
    assert.deepEqual(started, []);
    assert.deepEqual(readIosBuilds(env), []);
  });

  it('builds what production runs by default, and an older --sha it contains', async () => {
    const { repo, first, second } = makeRepo();
    const byDefault = await device({ repo, live: second });
    assert.equal(byDefault.started[0].sha, second);
    assert.equal(byDefault.started[0].live, second);
    const older = await device({ repo, live: second, argv: ['ios', '--device', '--sha', first.slice(0, 7)] });
    assert.equal(older.started[0].sha, first);
  });

  it('refuses while another build runs, before anything else', async () => {
    const { repo, second } = makeRepo();
    const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-device-work-')) };
    recordStart({ sha: second, kind: 'device', pid: '4321' }, env);
    const stderr = capture();
    const preflights = fakeRun(FIXTURE);
    const code = await run(['ios', '--device'], {
      env, stdout: capture(), stderr, repos: [{ name: 'memoro', path: repo }], run: preflights, alive: () => true,
    });
    assert.equal(code, 2);
    assert.equal(stderr.text, 'mc: an iOS build is running (pid 4321) — mc build ios --follow\n');
    assert.deepEqual(preflights.calls, []);
  });

  it('--follow says so when no build runs', async () => {
    const stdout = capture();
    const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-device-work-')) };
    assert.equal(await run(['ios', '--follow'], { env, stdout, stderr: capture() }), 0);
    assert.equal(stdout.text, 'mc: no iOS build is running\n');
  });
});

/** An app on disk as the fake reads give it: what `overrides` change, matching otherwise. */
function app({ info = {}, config = {}, signed = true } = {}) {
  const plist = {
    CFBundleIdentifier: 'test.bundle', MemoroBuildCommit: SHA, CFBundleVersion: '1',
    CFBundleShortVersionString: '1.0', CFBundleDisplayName: 'memoro me', ...info,
  };
  const capacitor = {
    server: { url: 'https://example.test' }, packageClassList: ['CapacitorHttp', 'MemoroCameraPlugin', 'MemoroSharePlugin'], ...config,
  };
  const reads = [];
  return {
    reads,
    plutil: (path) => { reads.push(path); return plist; },
    readFile: (path) => { reads.push(path); return JSON.stringify(capacitor); },
    codesign: () => (signed ? { ok: true, detail: '' } : { ok: false, detail: 'a sealed resource is missing' }),
  };
}

describe('readBack', () => {
  it('passes an app that matches the declaration', () => {
    const fake = app();
    const read = readBack({ appDir: '/x/App.app', declaration: DECLARATION, sha: SHA, ...fake });
    assert.deepEqual(read, { ok: true, problems: [], name: 'memoro me', version: '1.0', build: '1' });
    assert.deepEqual(fake.reads, ['/x/App.app/Info.plist', '/x/App.app/capacitor.config.json']);
  });

  it('names each field that differs', () => {
    const read = readBack({
      appDir: '/x/App.app', declaration: DECLARATION, sha: SHA,
      ...app({
        info: { MemoroBuildCommit: '1a2b3c4d5e6f', CFBundleIdentifier: 'other.bundle' },
        config: { server: { url: 'http://localhost:8787' }, packageClassList: ['MemoroSharePlugin'] },
      }),
    });
    assert.equal(read.ok, false);
    assert.deepEqual(read.problems, [
      'CFBundleIdentifier is other.bundle, expected test.bundle',
      'MemoroBuildCommit is 1a2b3c4, expected 3c4d5e6',
      'server.url is http://localhost:8787, expected https://example.test',
      'packageClassList has no MemoroCameraPlugin',
    ]);
  });

  it('checks the build number only when one was set, and the signature always', () => {
    const fake = app({ signed: false });
    const read = readBack({ appDir: '/x/App.app', declaration: DECLARATION, sha: SHA, build: 7, ...fake });
    assert.deepEqual(read.problems, [
      'CFBundleVersion is 1, expected 7',
      'codesign --verify --deep --strict failed: a sealed resource is missing',
    ]);
  });

  it('says missing for a commit key the app does not carry', () => {
    const read = readBack({ appDir: '/x/App.app', declaration: DECLARATION, sha: SHA, ...app({ info: { MemoroBuildCommit: undefined } }) });
    assert.deepEqual(read.problems, ['MemoroBuildCommit is missing, expected 3c4d5e6']);
  });
});

/** A step that records what it was asked and answers `ok` unless `fails` names the label. */
function fakeStep({ fails = {}, head = SHA } = {}) {
  const calls = [];
  const step = async (label, argv, options = {}) => {
    calls.push({ label, argv, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
    if (fails[label]) return { ok: false, code: 1, signal: null, timedOut: false, error: null, output: '', ...fails[label] };
    if (argv.includes('rev-parse')) return { ok: true, code: 0, output: `${head}\n` };
    return { ok: true, code: 0, output: '' };
  };
  step.calls = calls;
  return step;
}

function builder({ fails, head, worktreeExists = false, readBackApp = app() } = {}) {
  const env = {
    MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-device-work-')),
    MC_HOME: mkdtempSync(join(tmpdir(), 'mc-ios-device-home-')),
    X_BUILD_NUMBER: '99',
  };
  const key = recordStart({ sha: SHA, kind: 'device', live_commit: SHA, pid: '' }, env);
  const lane = [];
  const stdout = capture();
  const stderr = capture();
  const step = fakeStep({ fails, head });
  const job = {
    key, sha: SHA, live: SHA, repoPath: '/repos/memoro', declaration: DECLARATION,
    device: { id: PHONE_ID, name: 'Test iPhone' }, root: env.MC_WORK_ROOT,
  };
  const deps = {
    env, stdout, stderr, step,
    exists: () => worktreeExists,
    takeGateLock: (args) => { lane.push(['take', args.mode, args.lane]); return { ok: true, took: true }; },
    releaseGateLock: (args) => { lane.push(['release', args.lane]); },
    runningRound: () => null,
    readMerger: () => null,
    ...readBackApp,
  };
  return { env, job, deps, step, lane, stdout, stderr };
}

describe('buildIos — the builder', () => {
  it('runs npm ci, the setup, the sync and xcodebuild in order, then installs', async () => {
    const b = builder();
    const code = await buildIos(b.job, b.deps);
    assert.equal(code, 0, b.stderr.text);
    const { worktree, derived, spm } = buildPaths(b.env);
    const labels = b.step.calls.map((c) => c.label);
    assert.deepEqual(labels, [
      'git worktree prune', 'git worktree add', 'git rev-parse', 'git status',
      'npm ci', 'npx cap add ios', 'npm run cap:build', 'xcodebuild', 'install',
    ]);
    const call = (label) => b.step.calls.find((c) => c.label === label);
    assert.deepEqual(call('git worktree add').argv, ['git', '-C', '/repos/memoro', 'worktree', 'add', '--detach', worktree, SHA]);
    assert.deepEqual(call('npm ci').argv, ['npm', 'ci']);
    assert.equal(call('npm ci').cwd, worktree);
    assert.deepEqual(call('npx cap add ios').argv, ['sh', '-c', 'npx cap add ios']);
    const sync = call('npm run cap:build');
    assert.equal(sync.env.X_BUILD_COMMIT, SHA);
    assert.equal('X_BUILD_NUMBER' in sync.env, false, 'a device build sets no build number');
    const xcode = call('xcodebuild').argv;
    assert.deepEqual(xcode.slice(xcode.indexOf('-derivedDataPath'), xcode.indexOf('-derivedDataPath') + 2), ['-derivedDataPath', derived]);
    assert.deepEqual(xcode.slice(xcode.indexOf('-clonedSourcePackagesDirPath'), xcode.indexOf('-clonedSourcePackagesDirPath') + 2), ['-clonedSourcePackagesDirPath', spm]);
    assert.ok(xcode.includes('-allowProvisioningUpdates'));
    assert.deepEqual(xcode.slice(0, 9), ['xcodebuild', '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS']);
    assert.equal(xcode.at(-1), 'build');
    assert.deepEqual(call('install').argv, ['xcrun', 'devicectl', 'device', 'install', 'app', '--device', PHONE_ID, builtApp(derived)]);
    assert.match(b.stdout.text, /mc: installed memoro me 1\.0 \(1\) from 3c4d5e6 on Test iPhone\n/u);
  });

  it('moves an existing worktree with checkout and clean -ffdx', async () => {
    const b = builder({ worktreeExists: true });
    assert.equal(await buildIos(b.job, b.deps), 0);
    const { worktree } = buildPaths(b.env);
    assert.deepEqual(b.step.calls.slice(0, 2).map((c) => c.argv), [
      ['git', '-C', worktree, 'checkout', '--detach', '--force', SHA],
      ['git', '-C', worktree, 'clean', '-ffdx'],
    ]);
  });

  it('takes its repository lane as ios-build and the row goes running → installed', async () => {
    const b = builder();
    assert.equal(readIosBuilds(b.env)[0].outcome, 'running');
    await buildIos(b.job, b.deps);
    assert.deepEqual(b.lane, [['take', 'ios-build', 'memoro'], ['release', 'memoro']]);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'installed');
    assert.equal(row.version, '1.0');
    assert.equal(row.build, '1');
    assert.equal(row.artifact, builtApp(buildPaths(b.env).derived));
    assert.ok(row.ended);
  });

  it('never installs an app whose read-back fails, and says why on the row', async () => {
    const b = builder({ readBackApp: app({ config: { server: { url: 'http://localhost:8787' } } }) });
    assert.equal(await buildIos(b.job, b.deps), 1);
    assert.equal(b.step.calls.some((c) => c.label === 'install'), false);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'read-back');
    assert.match(row.note, /server\.url is http:\/\/localhost:8787, expected https:\/\/example\.test/u);
    assert.deepEqual(b.lane, [['take', 'ios-build', 'memoro'], ['release', 'memoro']]);
  });

  it('goes running → failed at the step that failed, releasing the lane', async () => {
    const b = builder({ fails: { 'npm ci': { code: 1, output: 'npm error code EUSAGE\n' } } });
    assert.equal(await buildIos(b.job, b.deps), 1);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'npm ci');
    assert.equal(row.note, 'npm ci exited 1 — npm error code EUSAGE');
    assert.equal(b.step.calls.some((c) => c.label === 'xcodebuild'), false);
    assert.deepEqual(b.lane, [['take', 'ios-build', 'memoro'], ['release', 'memoro']]);
  });

  it('fails at worktree when HEAD is not the commit', async () => {
    const b = builder({ head: 'ffffffffffffffffffffffffffffffffffffffff' });
    assert.equal(await buildIos(b.job, b.deps), 1);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.stopped_at, 'worktree');
    assert.match(row.note, /HEAD is fffffff/u);
  });

  it('puts the keychain fix in the note when xcodebuild cannot sign', async () => {
    const b = builder({ fails: { xcodebuild: { code: 65, output: 'errSecInternalComponent\n** BUILD FAILED **\n' } } });
    assert.equal(await buildIos(b.job, b.deps), 1);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.stopped_at, 'xcodebuild');
    assert.match(row.note, /security unlock-keychain ~\/Library\/Keychains\/login\.keychain-db/u);
    assert.match(xcodeHint('error: No Account for Team "X"'), /sign in to Xcode once/u);
  });

  it('completes the row as failed on a throw, releases the lane, and rethrows', async () => {
    const b = builder();
    b.deps.step = async () => { throw new Error('boom'); };
    await assert.rejects(() => buildIos(b.job, b.deps), /boom/u);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'worktree');
    assert.deepEqual(b.lane, [['take', 'ios-build', 'memoro'], ['release', 'memoro']]);
  });
});

describe('mc build ios --device — start and follow', () => {
  it('writes the running row, names the builder on it, and follows it to installed', async () => {
    const { repo, second } = makeRepo();
    const b = builder();
    const log = join(b.env.MC_WORK_ROOT, 'ios-build.log');
    writeFileSync(log, '▸ npm ci\n');
    let seen = null;
    const { code, out, env } = await device({
      repo, live: second,
      startBuilder: (job, { env: given }) => {
        seen = readIosBuilds(given).at(-1);
        // The fake app and HEAD say SHA; the row stays keyed by what was asked.
        return { pid: 4242, log, inline: buildIos({ ...job, sha: SHA }, { ...b.deps, env: given }) };
      },
    });
    assert.equal(seen.outcome, 'running');
    assert.equal(seen.kind, 'device');
    assert.equal(seen.live_commit, second);
    assert.equal(seen.pid, '');
    assert.match(out, /mc: building memoro \w{7} for Test iPhone in its own process \(pid 4242\) — \^C stops watching, not the build; mc build ios --follow watches again\n/u);
    assert.match(out, /▸ npm ci\n/u);
    const row = readIosBuilds(env).at(-1);
    assert.equal(row.pid, '4242');
    assert.equal(row.outcome, 'installed');
    assert.equal(code, 0);
  });

  it('marks the row failed at start when the builder does not start', async () => {
    const { repo, second } = makeRepo();
    const { code, err, env } = await device({ repo, live: second });
    assert.equal(code, 1);
    assert.match(err, /the builder did not start: test/u);
    const [row] = readIosBuilds(env);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'start');
  });
});

describe('makeStep', () => {
  it('prints the label, streams the output and keeps it', async () => {
    const stdout = capture();
    const step = makeStep({ stdout });
    const r = await step('echo', ['sh', '-c', 'echo hello; echo there >&2'], { timeoutMs: 10_000 });
    assert.equal(r.ok, true);
    assert.match(stdout.text, /^▸ echo\n/u);
    assert.match(r.output, /hello/u);
    assert.match(r.output, /there/u);
  });

  it('stops a command past its timeout', async () => {
    const step = makeStep({ stdout: capture(), graceMs: 50 });
    const r = await step('sleep', ['sleep', '5'], { timeoutMs: 50 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
  });

  it('starts nothing after stop', async () => {
    const step = makeStep({ stdout: capture() });
    step.stop('SIGTERM');
    const r = await step('echo', ['echo', 'x']);
    assert.equal(r.ok, false);
    assert.match(r.error, /stopped by SIGTERM/u);
  });
});
