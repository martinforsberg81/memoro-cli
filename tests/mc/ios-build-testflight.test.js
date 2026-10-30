/**
 * `mc build ios --testflight`: the number from App Store Connect, the
 * question, the builder's order from archive to upload, the IPA read back,
 * the number asked again, the delivery id, the pruning, and the attach
 * command printed and never run. Every external command is injected — a fake
 * `run` for the asking process, a fake `step` for the builder — against a
 * repository the test makes and a temporary work root and home.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { run } from '../../src/mc/commands/build.js';
import {
  archivedApp, archivePaths, atRev, buildIos, buildPaths, deliveryId, listBuilds, pruneArchives, reasonLine, runSync,
  secretsEnv,
} from '../../src/mc/ios-build.js';
import { readIosBuilds, recordStart } from '../../src/mc/ios-builds.js';

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
  app_local_plugins: ['MemoroCameraPlugin'],
  native_paths: ['cap-config/'],
  native_dependency_prefixes: ['@capacitor/'],
};

const LIST_SOURCE = "console.log('list on main');\n";
/** origin/main's list script, as `atRev` writes it out: `node <its directory>/scripts/list.mjs --json`. */
const isRevList = (argv) => argv[0] === 'node' && /\/mc-ios-script-[^/]+\/scripts\/list\.mjs$/u.test(argv[1] || '') && argv[2] === '--json';
const noExport = () => null;

const SHA = '3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d';
const NEXT = 43;
const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'mc-ios-tf-repo-'));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, '.mc'));
  writeFileSync(join(repo, '.mc', 'ios.json'), JSON.stringify(DECLARATION));
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  mkdirSync(join(repo, 'scripts'));
  writeFileSync(join(repo, 'scripts', 'list.mjs'), LIST_SOURCE);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'one');
  const head = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'update-ref', 'refs/remotes/origin/main', head);
  return { repo, head };
}

function capture() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

const ASC = JSON.stringify({ builds: [{ version: '40' }, { version: '42' }, { version: '7' }, { version: '41' }] });

/** The asking process's commands: Xcode, both identities, and App Store Connect answering `asc`. */
function fakeRun({ asc = { code: 0, stdout: ASC, stderr: '' }, identities = ['Apple Development: T (X)', 'Apple Distribution: T (Y)'] } = {}) {
  const calls = [];
  const fn = (argv, options = {}) => {
    calls.push({ argv, cwd: options.cwd, input: options.input, env: options.env });
    if (argv[1] === 'xcodebuild') return { code: 0, stdout: 'Xcode 26.6\n', stderr: '' };
    if (argv[0] === 'security') {
      return { code: 0, stdout: `${identities.map((id, i) => `  ${i + 1}) ABCDEF "${id}"`).join('\n')}\n`, stderr: '' };
    }
    if (argv.join(' ') === DECLARATION.list_builds.join(' ') || isRevList(argv)) return asc;
    return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
  };
  fn.calls = calls;
  return fn;
}

async function testflight({
  argv = ['ios', '--testflight', '--no-upload'], runFake = fakeRun(), answer = null, isInteractive = true,
} = {}) {
  const { repo, head } = makeRepo();
  const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-tf-work-')) };
  const stdout = capture();
  const stderr = capture();
  const started = [];
  const asked = [];
  const code = await run(argv, {
    env, stdout, stderr, repos: [{ name: 'memoro', path: repo }],
    fetchVersion: async () => ({ commit_full: head }),
    run: runFake,
    alive: () => false,
    interactive: () => isInteractive,
    ask: (prompt) => { asked.push(prompt); if (answer === null) throw new Error('asked'); return answer; },
    startBuilder: (job) => { started.push(job); return { pid: null, error: 'test' }; },
  });
  return {
    code, out: stdout.text, err: stderr.text, env, started, asked, head, repo, runFake,
  };
}

describe('the number from App Store Connect', () => {
  it('is one more than the highest version, in whatever order they come', () => {
    const asked = listBuilds({ repoPath: '/repos/memoro', declaration: DECLARATION, run: fakeRun() });
    assert.deepEqual(asked, { ok: true, versions: [40, 42, 7, 41], next: 43 });
  });

  it('asks with origin/main\'s script, not the checkout\'s working tree', async () => {
    const t = await testflight();
    const call = t.runFake.calls.find((c) => c.argv[0] === 'node');
    assert.ok(isRevList(call.argv), call.argv.join(' '));
    assert.equal(call.cwd, join(t.repo, 'scripts'));
    assert.equal(t.started[0].build, NEXT);
    assert.equal(existsSync(dirname(dirname(call.argv[1]))), false, 'the written-out tree is removed afterwards');
  });

  it('runs the script with the rev\'s helpers and the checkout\'s packages, the checkout behind and on another branch', () => {
    const { repo } = makeRepo();
    mkdirSync(join(repo, 'scripts', 'lib'));
    writeFileSync(join(repo, 'scripts', 'lib', 'helper.mjs'), "export const said = 'helper on main';\n");
    writeFileSync(join(repo, 'scripts', 'list.mjs'), [
      "import { said } from './lib/helper.mjs';",
      "import { pkg } from 'fakepkg';",
      'console.log(JSON.stringify({ said, pkg, cwd: process.cwd() }));',
      '',
    ].join('\n'));
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'main imports a helper');
    sh(repo, 'update-ref', 'refs/remotes/origin/main', sh(repo, 'rev-parse', 'HEAD'));
    sh(repo, 'checkout', '-q', '-b', 'elsewhere', 'HEAD~1');
    // The installed packages are the checkout's, outside git.
    mkdirSync(join(repo, 'node_modules', 'fakepkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'fakepkg', 'package.json'), JSON.stringify({ name: 'fakepkg', type: 'module', exports: './index.js' }));
    writeFileSync(join(repo, 'node_modules', 'fakepkg', 'index.js'), "export const pkg = 'installed';\n");
    assert.equal(existsSync(join(repo, 'scripts', 'lib')), false);

    const command = atRev(DECLARATION.list_builds, { repoPath: repo, rev: 'origin/main' });
    try {
      assert.ok(isRevList(command.argv), command.argv.join(' '));
      const r = runSync(command.argv, { cwd: command.cwd });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.said, 'helper on main');
      assert.equal(out.pkg, 'installed');
      assert.equal(realpathSync(out.cwd), realpathSync(join(repo, 'scripts')));
    } finally {
      rmSync(command.dir, { recursive: true, force: true });
    }
  });

  it('refuses a script the rev does not have', async () => {
    const asked = listBuilds({
      repoPath: '/repos/memoro', declaration: DECLARATION, rev: 'origin/main', run: fakeRun(), git: () => null,
    });
    assert.deepEqual(asked, {
      ok: false,
      line: 'App Store Connect\'s build numbers could not be read (scripts/list.mjs is not on origin/main) — no build number can be chosen',
    });
  });

  it('refuses in words when the tree cannot be written out, and leaves no directory', () => {
    let written;
    const asked = listBuilds({
      repoPath: '/repos/memoro', declaration: DECLARATION, rev: 'origin/main', run: fakeRun(), git: () => '',
      exportTree: (_repo, _rev, path, dir) => { written = dir; return `git archive origin/main ${path}: fatal: nope`; },
    });
    assert.equal(asked.line, 'App Store Connect\'s build numbers could not be read (git archive origin/main scripts: fatal: nope) — no build number can be chosen');
    assert.equal(existsSync(written), false);
  });

  it('names the error, not the place in Node that threw it', () => {
    const stderr = [
      'node:internal/modules/esm/resolve:274',
      '    throw new ERR_MODULE_NOT_FOUND(',
      '          ^',
      '',
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/m/scripts/lib/dev-vars-path.mjs' imported from /m/scripts/",
      '    at finalizeResolution (node:internal/modules/esm/resolve:274:11)',
    ].join('\n');
    assert.equal(reasonLine(stderr), "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/m/scripts/lib/dev-vars-path.mjs' imported from /m/scripts/");
    assert.equal(reasonLine('TypeError: x is not a function\n    at y'), 'TypeError: x is not a function');
    assert.equal(reasonLine('no builds for that app\n'), 'no builds for that app');
  });

  it('names the secrets file in memoro\'s checkout for the script', () => {
    const runFake = fakeRun();
    listBuilds({ repoPath: '/repos/memoro', checkout: '/mc/self/memoro', declaration: DECLARATION, run: runFake, env: { HOME: '/h' } });
    assert.equal(runFake.calls[0].env.MEMORO_DEV_VARS, '/mc/self/memoro/.dev.vars');
  });

  it('keeps a secrets file the caller named, and names none without a checkout', () => {
    assert.equal(secretsEnv({ MEMORO_DEV_VARS: '/elsewhere' }, '/mc/self/memoro').MEMORO_DEV_VARS, '/elsewhere');
    assert.equal(secretsEnv({ HOME: '/h' }, null).MEMORO_DEV_VARS, undefined);
  });

  it('runs anything but node <relative path> as declared', () => {
    const argv = ['npm', 'run', 'asc:list'];
    assert.deepEqual(atRev(argv, { repoPath: '/r', rev: 'origin/main', git: () => 'x' }), { argv, cwd: '/r' });
  });

  it('exits 1 when App Store Connect does not answer, and builds nothing', async () => {
    const t = await testflight({
      runFake: fakeRun({ asc: { code: 1, stdout: '', stderr: 'Error: 401 NOT_AUTHORIZED\n    at main\n' } }),
    });
    assert.equal(t.code, 1);
    // The test's repository has no origin to fetch, which is the warning before it.
    assert.equal(t.err.split('\n').at(-2), 'mc: App Store Connect\'s build numbers could not be read (Error: 401 NOT_AUTHORIZED) — no build number can be chosen');
    assert.deepEqual(t.started, []);
    assert.deepEqual(readIosBuilds(t.env), []);
  });

  it('asks for an Apple Distribution identity', async () => {
    const t = await testflight({ runFake: fakeRun({ identities: ['Apple Development: T (X)'] }) });
    assert.equal(t.code, 1);
    assert.match(t.err, /no Apple Distribution signing identity in the login keychain/u);
    assert.deepEqual(t.started, []);
  });
});

describe('the question', () => {
  it('a no records a refused row and builds nothing', async () => {
    const t = await testflight({ argv: ['ios', '--testflight'], answer: 'n' });
    assert.equal(t.code, 1);
    assert.deepEqual(t.asked, [
      `upload memoro me (build ${NEXT}) from ${t.head.slice(0, 7)} — production runs ${t.head.slice(0, 7)} — to TestFlight after it is built and verified? [y/N]`,
    ]);
    assert.deepEqual(t.started, []);
    const [row] = readIosBuilds(t.env);
    assert.equal(row.outcome, 'refused');
    assert.equal(row.kind, 'testflight');
    assert.equal(row.build, String(NEXT));
    assert.ok(row.ended);
  });

  it('a yes goes into the job', async () => {
    const t = await testflight({ argv: ['ios', '--testflight'], answer: 'y' });
    assert.equal(t.started[0].upload, true);
    assert.equal(t.started[0].kind, 'testflight');
    assert.equal(readIosBuilds(t.env)[0].outcome, 'failed', 'the fake builder did not start');
  });

  it('is refused without a terminal unless --yes or --no-upload', async () => {
    const t = await testflight({ argv: ['ios', '--testflight'], isInteractive: false });
    assert.equal(t.code, 2);
    assert.equal(t.err, 'mc: mc build ios --testflight asks before it uploads — run it in a terminal, or add --yes or --no-upload\n');
    assert.deepEqual(t.runFake.calls, []);
    assert.deepEqual(readIosBuilds(t.env), []);
  });

  it('--yes uploads without asking, even without a terminal', async () => {
    const t = await testflight({ argv: ['ios', '--testflight', '--yes'], isInteractive: false });
    assert.deepEqual(t.asked, []);
    assert.equal(t.started[0].upload, true);
    assert.equal(t.started[0].kind, 'testflight');
  });

  it('--yes and --no-upload together are a bad argument', async () => {
    const t = await testflight({ argv: ['ios', '--testflight', '--yes', '--no-upload'] });
    assert.equal(t.code, 2);
    assert.deepEqual(t.started, []);
    assert.deepEqual(t.runFake.calls, []);
  });

  it('--yes without --testflight is a bad argument', async () => {
    const t = await testflight({ argv: ['ios', '--yes'] });
    assert.equal(t.code, 2);
    assert.deepEqual(t.started, []);
  });

  it('--no-upload asks nothing, even without a terminal', async () => {
    const t = await testflight({ isInteractive: false });
    assert.deepEqual(t.asked, []);
    assert.equal(t.started[0].upload, false);
    assert.equal(t.started[0].sha, t.head);
  });
});

/** A step that records its label in `events` and answers `ok` unless `fails` names it. */
function fakeStep(events, { fails = {}, uploadOutput = '' } = {}) {
  const calls = [];
  const step = async (label, argv, options = {}) => {
    calls.push({ label, argv, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
    events.push(label);
    if (fails[label]) return { ok: false, code: 1, signal: null, timedOut: false, error: null, output: '', ...fails[label] };
    if (argv.includes('rev-parse')) return { ok: true, code: 0, output: `${SHA}\n` };
    if (label === 'xcodebuild archive') mkdirSync(argv[argv.indexOf('-archivePath') + 1], { recursive: true });
    if (label === 'upload') return { ok: true, code: 0, output: uploadOutput };
    return { ok: true, code: 0, output: '' };
  };
  step.calls = calls;
  return step;
}

function builder({
  upload = false, ipaBuild = String(NEXT), authority = 'Authority=Apple Distribution: T (Y)', fails, uploadOutput,
  ascAgain = ASC,
} = {}) {
  const env = {
    MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-tf-work-')),
    MC_HOME: mkdtempSync(join(tmpdir(), 'mc-ios-tf-home-')),
  };
  const key = recordStart({ sha: SHA, kind: 'testflight', build: String(NEXT), live_commit: SHA, pid: '' }, env);
  const events = [];
  const stdout = capture();
  const stderr = capture();
  const step = fakeStep(events, { fails, uploadOutput });
  const plist = (path) => ({
    CFBundleIdentifier: 'test.bundle', MemoroBuildCommit: SHA,
    CFBundleVersion: path.includes('/Payload/') ? ipaBuild : String(NEXT),
    CFBundleShortVersionString: '1.4', CFBundleDisplayName: 'memoro me',
  });
  const job = {
    key, sha: SHA, live: SHA, repoPath: '/repos/memoro', declaration: DECLARATION, root: env.MC_WORK_ROOT,
    kind: 'testflight', build: NEXT, upload,
  };
  const deps = {
    env, stdout, stderr, step,
    exists: () => true,
    takeGateLock: () => ({ ok: true, took: true }),
    releaseGateLock: () => {},
    runningRound: () => null,
    readMerger: () => null,
    readdir: () => ['memoro me.ipa', 'DistributionSummary.plist'],
    plutil: (path) => { events.push(path.includes('/Payload/') ? 'IPA read-back' : 'read-back'); return plist(path); },
    readFile: () => JSON.stringify({ server: { url: 'https://example.test' }, packageClassList: ['MemoroCameraPlugin'] }),
    codesign: () => ({ ok: true, detail: '' }),
    git: () => LIST_SOURCE.trim(),
    exportTree: noExport,
    codesignDisplay: () => `Executable=/x/App\nIdentifier=test.bundle\n${authority}\nAuthority=Apple Worldwide Developer Relations Certification Authority\n`,
    run: (argv) => {
      events.push(isRevList(argv) ? 'asc list' : `asc ${argv.join(' ')}`);
      return { code: 0, stdout: ascAgain, stderr: '' };
    },
  };
  return { env, job, deps, step, events, stdout, stderr };
}

const ipaPath = (env) => join(archivePaths(NEXT, env).exportDir, 'memoro me.ipa');

describe('buildIos --testflight — the builder', () => {
  it('archives, reads back, exports, reads the IPA back, and uploads, in that order', async () => {
    const b = builder({ upload: true });
    const code = await buildIos(b.job, b.deps);
    assert.equal(code, 0, b.stderr.text);
    assert.deepEqual(b.events.slice(b.events.indexOf('npm run cap:build')), [
      'npm run cap:build', 'xcodebuild archive', 'read-back', 'xcodebuild -exportArchive', 'unzip', 'IPA read-back',
      'asc list', 'upload',
    ]);
    const { worktree, derived, spm } = buildPaths(b.env);
    const { archive, exportDir } = archivePaths(NEXT, b.env);
    const call = (label) => b.step.calls.find((c) => c.label === label);
    assert.equal(call('npm run cap:build').env.X_BUILD_NUMBER, String(NEXT));
    assert.equal(call('npm run cap:build').env.X_BUILD_COMMIT, SHA);
    assert.deepEqual(call('xcodebuild archive').argv, [
      'xcodebuild', '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release',
      '-destination', 'generic/platform=iOS', '-derivedDataPath', derived, '-clonedSourcePackagesDirPath', spm,
      '-archivePath', archive, '-allowProvisioningUpdates', 'archive',
    ]);
    assert.deepEqual(call('xcodebuild -exportArchive').argv, [
      'xcodebuild', '-exportArchive', '-archivePath', archive,
      '-exportOptionsPlist', join(worktree, 'ios/ExportOptions.plist'), '-exportPath', exportDir, '-allowProvisioningUpdates',
    ]);
    assert.deepEqual(call('upload').argv, ['node', 'scripts/upload.mjs', ipaPath(b.env)]);
    assert.equal(call('upload').cwd, worktree);
    assert.equal(call('upload').timeoutMs, 30 * 60 * 1000);
    assert.match(call('upload').env.MEMORO_DEV_VARS, /\/\.dev\.vars$/u);
    assert.match(b.stdout.text, new RegExp(`mc: ${archivedApp(archive).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} says test\\.bundle, 1\\.4 \\(${NEXT}\\)`, 'u'));
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'uploaded');
    assert.equal(row.build, String(NEXT));
    assert.equal(row.version, '1.4');
    assert.equal(row.artifact, ipaPath(b.env));
  });

  it('--no-upload stops at the verified IPA and completes the row built', async () => {
    const b = builder();
    assert.equal(await buildIos(b.job, b.deps), 0, b.stderr.text);
    assert.equal(b.events.includes('upload'), false);
    assert.equal(b.events.some((e) => e.startsWith('asc ')), false);
    assert.match(b.stdout.text, new RegExp(`mc: built ${ipaPath(b.env)} — memoro me 1\\.4 \\(${NEXT}\\) from 3c4d5e6; not uploaded\\n`, 'u'));
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'built');
    assert.equal(row.artifact, ipaPath(b.env));
  });

  it('a wrong CFBundleVersion in the IPA stops at export-read-back and never uploads', async () => {
    const b = builder({ upload: true, ipaBuild: '1' });
    assert.equal(await buildIos(b.job, b.deps), 1);
    assert.equal(b.events.includes('upload'), false);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'export-read-back');
    assert.match(row.note, new RegExp(`CFBundleVersion is 1, expected ${NEXT}`, 'u'));
    assert.match(b.stderr.text, /mc: nothing was uploaded\n/u);
  });

  it('an IPA without Authority=Apple Distribution stops the same way', async () => {
    const b = builder({ upload: true, authority: 'Authority=Apple Development: T (X)' });
    assert.equal(await buildIos(b.job, b.deps), 1);
    assert.equal(b.events.includes('upload'), false);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.stopped_at, 'export-read-back');
    assert.match(row.note, /is not signed by Apple Distribution \(codesign -dvv says Authority=Apple Development: T \(X\)\)/u);
  });

  it('a number taken between the question and the upload fails number-taken and uploads nothing', async () => {
    const b = builder({ upload: true, ascAgain: JSON.stringify({ builds: [{ version: '42' }, { version: String(NEXT) }] }) });
    assert.equal(await buildIos(b.job, b.deps), 1);
    assert.equal(b.events.includes('upload'), false);
    const [row] = readIosBuilds(b.env);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'number-taken');
    assert.match(row.note, new RegExp(`build ${NEXT} is in App Store Connect by now`, 'u'));
  });

  it('captures the delivery id when the upload prints one', async () => {
    const b = builder({ upload: true, uploadOutput: `Uploading…\nUPLOAD SUCCEEDED with no errors\nDelivery UUID: ${UUID}\nTransferred 40 MB\n` });
    assert.equal(await buildIos(b.job, b.deps), 0, b.stderr.text);
    assert.equal(readIosBuilds(b.env)[0].delivery, UUID);
    assert.equal(deliveryId('UPLOAD SUCCEEDED'), '');
    assert.equal(deliveryId(`"delivery_id": "${UUID}"`), UUID);
  });

  it('prints the attach command and never runs it', async () => {
    const b = builder({ upload: true });
    assert.equal(await buildIos(b.job, b.deps), 0, b.stderr.text);
    assert.match(b.stdout.text, new RegExp(`mc: uploaded memoro me 1\\.4 \\(${NEXT}\\) from 3c4d5e6\\n`, 'u'));
    assert.match(b.stdout.text, new RegExp(`next, by hand when it has processed: npm run asc:attach-build -- 1\\.4 ${NEXT} --wait \\(in memoro\\)\\n`, 'u'));
    assert.equal(b.step.calls.some((c) => c.argv.join(' ').includes('attach-build')), false);
    assert.equal(b.events.some((e) => e.includes('attach-build')), false);
  });

  it('prunes the archives after a build', async () => {
    const b = builder();
    const { root } = archivePaths(NEXT, b.env);
    for (const n of [30, 31, 32, 33, 34, 35]) mkdirSync(join(root, String(n)), { recursive: true });
    assert.equal(await buildIos(b.job, b.deps), 0, b.stderr.text);
    assert.equal(readdirSync(root).length, 5);
    assert.ok(existsSync(join(root, String(NEXT))));
  });
});

describe('pruneArchives', () => {
  it('keeps the five newest and never the current one', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-ios-tf-archives-'));
    const at = Date.now() / 1000;
    for (const [n, age] of [[1, 10], [2, 9], [3, 8], [4, 7], [5, 6], [6, 5], [7, 4]]) {
      mkdirSync(join(root, String(n)));
      utimesSync(join(root, String(n)), at - age * 60, at - age * 60);
    }
    // The current one is the oldest by its time on disk, and is still kept.
    const removed = pruneArchives(root, { current: join(root, '1') });
    assert.deepEqual(readdirSync(root).sort(), ['1', '4', '5', '6', '7']);
    assert.deepEqual(removed.map((path) => path.slice(root.length + 1)).sort(), ['2', '3']);
    assert.deepEqual(pruneArchives(root, { current: join(root, '7') }), []);
    assert.deepEqual(pruneArchives(join(root, 'missing')), []);
  });
});
