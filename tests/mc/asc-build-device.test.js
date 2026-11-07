/**
 * `mc asc build --device`: the preflights the asking process runs, the
 * builder's commands in order, the read-back, and the row from `running` to
 * how it ended. Every external command is injected — a fake `run` for the
 * preflights, a fake `step` for the builder that records argv, cwd and env —
 * against a repository the test makes and a temporary work root.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { run } from '../../src/mc/commands/asc.js';
import { holdBuildLane } from '../../src/mc/commands/deploy.js';
import {
  buildIos, buildPaths, builtApp, makeStep, pairedDevices, readBack, STALL_MS, stepNote, xcodeHint,
} from '../../src/mc/ios-build.js';
import { readIosBuilds, recordStart } from '../../src/mc/ios-builds.js';
import { buildSim, simApp, simPaths } from '../../src/mc/ios-sim-build.js';
import { artifactCachePath, defaultPackageCache, resolvedPath } from '../../src/mc/swiftpm.js';

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

/** What a fake curl downloads, and the checksum a Package.swift declares for it. */
const ZIP = 'the xcframework zip';
const ZIP_SUM = createHash('sha256').update(ZIP).digest('hex');
const CAPACITOR_ZIP = 'https://github.com/ionic-team/capacitor-swift-pm/releases/download/8.5.3/Capacitor.xcframework.zip';

/** A `Package.swift` as capacitor-swift-pm's declares its xcframework. */
function capacitorManifest(checksum = ZIP_SUM) {
  return `let package = Package(\n  targets: [\n    .binaryTarget(\n      name: "Capacitor",\n      url: "${CAPACITOR_ZIP}",\n      checksum: "${checksum}"\n    ),\n  ]\n)\n`;
}

/** `text` written at `path`, its directories made. */
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

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

async function device({ repo, live, list = FIXTURE, argv = ['build', '--device'], startBuilder }) {
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

describe('mc asc build --device — the preflights', () => {
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
      repo, live: second, list: devices([PHONE, OTHER]), argv: ['build', '--device', '--device-id', 'Other iPhone'],
    });
    assert.equal(code, 1, 'the fake builder did not start');
    assert.equal(started[0].device.id, '00000000-0000-0000-0000-000000000002');
  });

  it('refuses a --sha production does not contain', async () => {
    const { repo, first, second } = makeRepo();
    const { code, err, started, env } = await device({ repo, live: first, argv: ['build', '--device', '--sha', second] });
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
    const older = await device({ repo, live: second, argv: ['build', '--device', '--sha', first.slice(0, 7)] });
    assert.equal(older.started[0].sha, first);
  });

  it('refuses while another build runs, before anything else', async () => {
    const { repo, second } = makeRepo();
    const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-device-work-')) };
    recordStart({ sha: second, kind: 'device', pid: '4321' }, env);
    const stderr = capture();
    const preflights = fakeRun(FIXTURE);
    const code = await run(['build', '--device'], {
      env, stdout: capture(), stderr, repos: [{ name: 'memoro', path: repo }], run: preflights, alive: () => true,
    });
    assert.equal(code, 2);
    assert.equal(stderr.text, 'mc: an iOS build is running (pid 4321) — mc asc build --follow\n');
    assert.deepEqual(preflights.calls, []);
  });

  it('--follow says so when no build runs', async () => {
    const stdout = capture();
    const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-device-work-')) };
    assert.equal(await run(['build', '--follow'], { env, stdout, stderr: capture() }), 0);
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

/**
 * A step that records what it was asked and answers `ok` unless `fails` names
 * the label. A `curl` writes `download` (or `downloads[url]`) where it was told to.
 */
function fakeStep({ fails = {}, head = SHA, download = ZIP, downloads = {} } = {}) {
  const calls = [];
  const step = async (label, argv, options = {}) => {
    calls.push({
      label, argv, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs, silenceMs: options.silenceMs, group: options.group,
    });
    if (fails[label]) return { ok: false, code: 1, signal: null, timedOut: false, error: null, output: '', ...fails[label] };
    if (argv[0] === 'curl') writeFileSync(argv[argv.indexOf('--output') + 1], downloads[argv.at(-1)] ?? download);
    if (argv.includes('rev-parse')) return { ok: true, code: 0, output: `${head}\n` };
    return { ok: true, code: 0, output: '' };
  };
  step.calls = calls;
  return step;
}

function builder({ fails, head, worktreeExists = false, readBackApp = app(), download } = {}) {
  const env = {
    MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-device-work-')),
    MC_HOME: mkdtempSync(join(tmpdir(), 'mc-ios-device-home-')),
    HOME: mkdtempSync(join(tmpdir(), 'mc-ios-device-user-')),
    X_BUILD_NUMBER: '99',
  };
  const key = recordStart({ sha: SHA, kind: 'device', live_commit: SHA, pid: '' }, env);
  const lane = [];
  const stdout = capture();
  const stderr = capture();
  const step = fakeStep({ fails, head, download });
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

describe('mc asc build --device — start and follow', () => {
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
    assert.match(out, /mc: building memoro \w{7} for Test iPhone in its own process \(pid 4242\) — \^C stops watching, not the build; mc asc build --follow watches again\n/u);
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

describe('buildIos — the binary artifacts prefetched before xcodebuild', () => {
  /** The CapApp-SPM the sync generates in the build worktree, naming a local package that declares the zip. */
  function capApp(env, checksum) {
    const { worktree } = buildPaths(env);
    put(join(worktree, 'ios', 'App', 'CapApp-SPM', 'Package.swift'), '.package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")\n');
    put(join(worktree, 'node_modules', '@capacitor', 'app', 'Package.swift'), capacitorManifest(checksum));
  }

  it('curls each zip into SwiftPM\'s artifact path, verified, before xcodebuild — and reuses it next time', async () => {
    const b = builder();
    capApp(b.env);
    assert.equal(await buildIos(b.job, b.deps), 0, b.stderr.text);
    const labels = b.step.calls.map((c) => c.label);
    assert.deepEqual(labels.slice(labels.indexOf('npm run cap:build')), ['npm run cap:build', 'curl Capacitor', 'xcodebuild', 'install']);
    const cached = artifactCachePath(defaultPackageCache(b.env), CAPACITOR_ZIP);
    assert.equal(cached, join(b.env.HOME, 'Library', 'Caches', 'org.swift.swiftpm', 'artifacts',
      'https___github_com_ionic_team_capacitor_swift_pm_releases_download_8_5_3_Capacitor_xcframework_zip'));
    assert.equal(createHash('sha256').update(readFileSync(cached)).digest('hex'), ZIP_SUM);
    assert.deepEqual(readdirSync(dirname(cached)), [basename(cached)], 'no partial file is left beside it');
    assert.match(b.stdout.text, new RegExp(`mc: prefetch Capacitor: downloaded ${CAPACITOR_ZIP.replaceAll('.', '\\.')}\\n`, 'u'));

    const again = builder();
    again.env.HOME = b.env.HOME;
    again.env.MC_HOME = b.env.MC_HOME;
    assert.equal(await buildIos(again.job, again.deps), 0, again.stderr.text);
    assert.equal(again.step.calls.some((c) => c.argv[0] === 'curl'), false, 'a verified zip is not downloaded again');
    assert.match(again.stdout.text, /mc: prefetch Capacitor: reused /u);
  });

  it('fails at prefetch naming the URL when the checksum does not match, and leaves no file', async () => {
    const b = builder({ download: 'something else' });
    capApp(b.env);
    assert.equal(await buildIos(b.job, b.deps), 1);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'prefetch');
    assert.match(row.note, new RegExp(`^checksum mismatch for ${CAPACITOR_ZIP.replaceAll('.', '\\.')}: `, 'u'));
    assert.equal(b.step.calls.some((c) => c.label === 'xcodebuild'), false);
    const dir = join(defaultPackageCache(b.env), 'artifacts');
    assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
  });
});

describe('holdBuildLane — a held lane is said, once, with its holder and age', () => {
  it('prints the waiting line while another holds it, then takes it', async () => {
    const stdout = capture();
    const answers = [
      { ok: false, running: { pid: 4321, mode: 'deploy', since: '2026-11-07T10:00:00.000Z' } },
      { ok: false, running: { pid: 4321, mode: 'deploy', since: '2026-11-07T10:00:00.000Z' } },
      { ok: true, took: true },
    ];
    const took = await holdBuildLane({ root: '/nowhere', lockRoot: '/nowhere' }, {
      stdout, mode: 'ios-build', takeGateLock: () => answers.shift(), sleep: async () => {},
      runningRound: () => null, readMerger: () => null, now: () => new Date('2026-11-07T10:03:20.000Z'),
    });
    assert.equal(took, true);
    assert.equal(stdout.text, 'mc: waiting for the build lane (deploy pid 4321, 3 min)\n');
  });
});

/** A child process as `spawn` gives it, driven by the test. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 777;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => true;
  return child;
}

describe('makeStep — the stall stop', () => {
  it('stops the whole tree after 5 silent minutes and names the stage and the last line', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const kills = [];
    let spawned = null;
    const step = makeStep({
      stdout: capture(), graceMs: 1000,
      spawnProcess: (command, args, options) => { spawned = options; return child; },
      killTree: (target, signal) => { kills.push([target.pid, signal]); if (signal === 'SIGTERM') target.emit('close', null, 'SIGTERM'); },
    });
    const pending = step('xcodebuild Debug', ['xcodebuild', 'build'], { timeoutMs: 60 * 60 * 1000, silenceMs: STALL_MS, group: true });
    assert.equal(spawned.detached, true, 'its own process group, so the tree can be stopped');
    child.stdout.emit('data', 'Command line invocation:\n    xcodebuild build\n\nResolve Package Graph\n');
    t.mock.timers.tick(STALL_MS - 1);
    child.stdout.emit('data', 'Fetching from https://github.com/ionic-team/ion-ios-camera.git\n');
    t.mock.timers.tick(STALL_MS - 1);
    assert.deepEqual(kills, [], 'output restarts the silence');
    t.mock.timers.tick(1);
    assert.deepEqual(kills, [[777, 'SIGTERM']], 'five silent minutes stop the tree');
    const r = await pending;
    assert.equal(r.ok, false);
    assert.deepEqual(r.stalled, { stage: 'Resolve Package Graph', line: 'Fetching from https://github.com/ionic-team/ion-ios-camera.git' });
    assert.equal(stepNote('xcodebuild Debug', r, 60 * 60 * 1000),
      'xcodebuild Debug stalled at Resolve Package Graph: Fetching from https://github.com/ionic-team/ion-ios-camera.git — silent for 5 min, stopped');
  });
});

describe('makeStep — the builder\'s own stop', () => {
  it('sends a grouped command\'s stop to its whole tree, and SIGKILL to the tree after the grace', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const alone = [];
    const kills = [];
    child.kill = (signal) => { alone.push(signal); return true; };
    const step = makeStep({
      stdout: capture(), graceMs: 1000,
      spawnProcess: () => child,
      killTree: (target, signal) => kills.push([target.pid, signal]),
    });
    const pending = step('xcodebuild Debug', ['xcodebuild', 'build'], { group: true });
    step.stop('SIGTERM');
    assert.deepEqual(kills, [[777, 'SIGTERM']], 'the tree, not xcodebuild alone');
    t.mock.timers.tick(999);
    assert.equal(kills.length, 1, 'the grace is not over');
    t.mock.timers.tick(1);
    assert.deepEqual(kills, [[777, 'SIGTERM'], [777, 'SIGKILL']]);
    child.emit('close', null, 'SIGKILL');
    const r = await pending;
    assert.equal(r.ok, false);
    assert.equal(r.signal, 'SIGKILL');
    assert.deepEqual(alone, [], 'the child alone is not signalled');
  });

  it('sends an ungrouped command\'s stop to the command alone, and SIGKILL after the grace', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const alone = [];
    const trees = [];
    child.kill = (signal) => { alone.push(signal); return true; };
    const step = makeStep({
      stdout: capture(), graceMs: 1000,
      spawnProcess: () => child,
      killTree: (target, signal) => trees.push(signal),
    });
    const pending = step('echo', ['echo', 'x']);
    step.stop('SIGINT');
    assert.deepEqual(alone, ['SIGINT']);
    t.mock.timers.tick(1000);
    assert.deepEqual(alone, ['SIGINT', 'SIGKILL']);
    assert.deepEqual(trees, []);
    child.emit('close', null, 'SIGKILL');
    assert.equal((await pending).ok, false);
  });
});

describe('buildSim — the simulator builder', () => {
  /** A `workspace-state.json` holding capacitor-swift-pm at `revision`, as a seed or a cloned-packages directory keeps it. */
  function workspaceState(revision) {
    return JSON.stringify({ object: { dependencies: [{ packageRef: { identity: 'capacitor-swift-pm' }, state: { checkoutState: { revision } } }] } });
  }
  /** A worktree, a seed holding capacitor-swift-pm at `seedRevision`, a build's kept copy at `keptRevision` when given, and a Package.resolved pinning `resolvedRevision`. */
  function sim({ resolvedRevision = 'aaa', seedRevision = 'aaa', keptRevision = null, releaseCheck = false, projectExists = true } = {}) {
    const env = {
      MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-sim-work-')),
      MC_HOME: mkdtempSync(join(tmpdir(), 'mc-ios-sim-home-')),
      MC_SCRATCH: mkdtempSync(join(tmpdir(), 'mc-ios-sim-scratch-')),
      X_BUILD_NUMBER: '99',
    };
    const worktree = mkdtempSync(join(tmpdir(), 'mc-ios-sim-tree-'));
    const paths = simPaths(env);
    if (resolvedRevision) {
      put(resolvedPath(worktree, DECLARATION.project), JSON.stringify({
        pins: [{ identity: 'capacitor-swift-pm', kind: 'remoteSourceControl', state: { revision: resolvedRevision, version: '8.5.3' } }], version: 3,
      }));
    }
    put(join(paths.seed, 'workspace-state.json'), workspaceState(seedRevision));
    if (keptRevision) put(join(paths.spm, 'workspace-state.json'), workspaceState(keptRevision));
    const key = recordStart({ sha: SHA, kind: 'sim', artifact: paths.derived, pid: '' }, env);
    const fake = fakeStep();
    const step = async (label, argv, options) => {
      if (argv[0] === 'cp') cpSync(argv[3], argv[4], { recursive: true }); // the seed's APFS clone, as `cp -c -R` makes it
      return fake(label, argv, options);
    };
    step.calls = fake.calls;
    const lane = [];
    const stdout = capture();
    const stderr = capture();
    const job = { key, kind: 'sim', sha: SHA, worktree, declaration: DECLARATION, paths, releaseCheck };
    const deps = {
      env, stdout, stderr, step, exists: () => projectExists,
      takeGateLock: (args) => { lane.push(['take', args.mode, args.lane]); return { ok: true, took: true }; },
      releaseGateLock: (args) => { lane.push(['release', args.lane]); },
      runningRound: () => null, readMerger: () => null,
    };
    return { env, worktree, paths, job, deps, step, lane, stdout, stderr };
  }
  const flagsOf = (s, label = 'xcodebuild Debug') => s.step.calls.find((c) => c.label === label).argv;

  it('builds Debug for the simulator in the build lane, packages seeded, resolution off when Package.resolved matches the cloned packages', async () => {
    const s = sim();
    assert.equal(await buildSim(s.job, s.deps), 0, s.stderr.text);
    assert.deepEqual(s.lane, [['take', 'ios-build', 'memoro'], ['release', 'memoro']]);
    assert.deepEqual(s.step.calls.map((c) => c.label), ['npm ci', 'npm run cap:build', 'seed packages', 'xcodebuild Debug']);
    assert.deepEqual(s.step.calls[2].argv, ['cp', '-c', '-R', s.paths.seed, join(s.env.MC_SCRATCH, 'DerivedData', 'SourcePackages')]);
    const xcode = flagsOf(s);
    assert.deepEqual(xcode.slice(0, 13), [
      'xcodebuild', '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug',
      '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', s.paths.derived,
    ]);
    assert.ok(xcode.includes('-disableAutomaticPackageResolution') && xcode.includes('-skipPackageUpdates'));
    assert.equal(xcode[xcode.indexOf('-packageCachePath') + 1], join(s.paths.derived, 'PackageCache'));
    assert.equal(xcode.includes('-allowProvisioningUpdates'), false, 'no signing, no account');
    assert.equal(s.step.calls.at(-1).silenceMs, STALL_MS);
    assert.equal(s.step.calls.at(-1).group, true);
    assert.equal(s.step.calls.every((c) => c.cwd === s.worktree), true, 'the worktree the caller stands in');
    const [row] = readIosBuilds(s.env);
    assert.equal(row.outcome, 'built');
    assert.equal(row.artifact, simApp(s.paths.derived));
  });

  it('lets SwiftPM resolve when Package.resolved differs from the cloned packages or is missing', async () => {
    for (const s of [sim({ resolvedRevision: 'bbb' }), sim({ resolvedRevision: null })]) {
      assert.equal(await buildSim(s.job, s.deps), 0, s.stderr.text);
      const xcode = flagsOf(s);
      assert.equal(xcode.includes('-disableAutomaticPackageResolution'), false);
      assert.equal(xcode.includes('-skipPackageUpdates'), false);
      assert.match(s.stdout.text, /Package\.resolved is missing or differs from the cloned packages — SwiftPM resolves/u);
    }
  });

  it('turns resolution off only when Package.resolved pins what the build\'s own packages hold, not the seed', async () => {
    // The seed was refreshed to ccc and pins Package.resolved; the build's kept copy still holds the older bbb.
    const stale = sim({ resolvedRevision: 'ccc', seedRevision: 'ccc', keptRevision: 'bbb' });
    assert.equal(await buildSim(stale.job, stale.deps), 0, stale.stderr.text);
    assert.equal(flagsOf(stale).includes('-disableAutomaticPackageResolution'), false);
    assert.equal(flagsOf(stale).includes('-skipPackageUpdates'), false);
    assert.match(stale.stdout.text, /Package\.resolved is missing or differs from the cloned packages — SwiftPM resolves/u);

    const kept = sim({ resolvedRevision: 'ccc', seedRevision: 'ccc', keptRevision: 'ccc' });
    assert.equal(await buildSim(kept.job, kept.deps), 0, kept.stderr.text);
    assert.ok(flagsOf(kept).includes('-disableAutomaticPackageResolution') && flagsOf(kept).includes('-skipPackageUpdates'));
    assert.match(kept.stdout.text, /pins what the cloned packages hold — package resolution off/u);
  });

  it('runs the setup only for a project not there yet, and --release-check builds Release unsigned too', async () => {
    const s = sim({ projectExists: false, releaseCheck: true });
    assert.equal(await buildSim(s.job, s.deps), 0, s.stderr.text);
    assert.deepEqual(s.step.calls.map((c) => c.label), ['npm ci', 'npx cap add ios', 'npm run cap:build', 'seed packages', 'xcodebuild Debug', 'xcodebuild Release']);
    const release = flagsOf(s, 'xcodebuild Release');
    assert.equal(release[release.indexOf('-configuration') + 1], 'Release');
    assert.ok(release.includes('CODE_SIGNING_ALLOWED=NO'));
    assert.equal(flagsOf(s).includes('CODE_SIGNING_ALLOWED=NO'), false);
  });

  it('fails naming the stage when xcodebuild stalled', async () => {
    const s = sim();
    s.deps.step = fakeStep({ fails: { 'xcodebuild Debug': { code: 1, signal: 'SIGTERM', stalled: { stage: 'Resolve Package Graph', line: 'Fetching from https://x' } } } });
    assert.equal(await buildSim(s.job, s.deps), 1);
    const [row] = readIosBuilds(s.env);
    assert.equal(row.stopped_at, 'xcodebuild Debug');
    assert.match(row.note, /^xcodebuild Debug stalled at Resolve Package Graph: Fetching from https:\/\/x — silent for 5 min, stopped$/u);
    assert.match(s.stderr.text, /the simulator build stopped at xcodebuild Debug — xcodebuild Debug stalled at Resolve Package Graph/u);
  });
});
