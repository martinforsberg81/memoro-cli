/**
 * `mc build ios` the question: the declaration read from origin/main, the
 * native difference between two commits, the answer, and `--shipped`. Against
 * a repository the test makes, with production's answer injected and the
 * register in a temporary work root.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../../src/mc/commands/build.js';
import { fetchVersionDefault, nativeChanges, readIosDeclaration } from '../../src/mc/ios-build.js';
import { lastShipped, readIosBuilds, recordStart } from '../../src/mc/ios-builds.js';

const DECLARATION = {
  schema_version: 1,
  project: 'ios/App/App.xcodeproj',
  scheme: 'App',
  bundle_id: 'test.bundle',
  team_id: 'TEAM',
  server_url: 'https://example.test',
  setup: 'npm ci',
  sync: 'npx cap sync ios',
  export_options: 'ios/ExportOptions.plist',
  env: { build_number: 'X_BUILD_NUMBER', build_commit: 'X_BUILD_COMMIT' },
  info_plist_commit_key: 'MemoroBuildCommit',
  list_builds: 'node scripts/list.mjs --json',
  upload: 'node scripts/upload.mjs',
  app_local_plugins: ['XPlugin'],
  native_paths: ['cap-config/', 'capacitor.config.ts'],
  native_dependency_prefixes: ['@capacitor/'],
};

function lock(capacitor, leftPad) {
  return `${JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/@capacitor/core': { version: capacitor },
      'node_modules/left-pad': { version: leftPad },
    },
  }, null, 2)}\n`;
}

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Two commits: the second changes a native path, a web path, a native package and a web package. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'mc-ios-repo-'));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, '.mc'));
  mkdirSync(join(repo, 'cap-config'));
  mkdirSync(join(repo, 'public', 'js'), { recursive: true });
  const write = (path, text) => writeFileSync(join(repo, path), text);
  write('.mc/ios.json', JSON.stringify(DECLARATION));
  write('cap-config/x.swift', 'one\n');
  write('public/js/a.js', 'one\n');
  write('package-lock.json', lock('6.0.0', '1.0.0'));
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'one');
  const first = sh(repo, 'rev-parse', 'HEAD');
  write('cap-config/x.swift', 'two\n');
  write('public/js/a.js', 'two\n');
  write('package-lock.json', lock('6.1.0', '1.3.0'));
  sh(repo, 'commit', '-q', '-am', 'two');
  const second = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'update-ref', 'refs/remotes/origin/main', second);
  return { repo, first, second };
}

function capture() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function ask({ repo, live, shipped, argv = ['ios'] }) {
  const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-work-')) };
  if (shipped) recordStart({ sha: shipped, kind: 'seed', build: '38', outcome: 'uploaded', ended: '2026-10-01T00:00:00.000Z' }, env);
  const stdout = capture();
  const stderr = capture();
  const code = await run(argv, {
    env, stdout, stderr, repos: [{ name: 'memoro', path: repo }],
    fetchVersion: async () => (live ? { commit_full: live } : null),
  });
  return { code, out: stdout.text, err: stderr.text, env };
}

describe('nativeChanges', () => {
  it('reports only the native path and only the native package', () => {
    const { repo, first, second } = makeRepo();
    const changes = nativeChanges({ repoPath: repo, from: first, to: second, declaration: DECLARATION });
    assert.deepEqual(changes, { paths: ['cap-config/x.swift'], packages: ['@capacitor/core 6.0.0→6.1.0'] });
  });

  it('is empty between a commit and itself', () => {
    const { repo, second } = makeRepo();
    assert.deepEqual(nativeChanges({ repoPath: repo, from: second, to: second, declaration: DECLARATION }), { paths: [], packages: [] });
  });
});

describe('readIosDeclaration', () => {
  it('reads origin/main, not the working tree', () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, '.mc', 'ios.json'), JSON.stringify({ schema_version: 2 }));
    const read = readIosDeclaration(repo);
    assert.equal(read.ok, true);
    assert.equal(read.declaration.bundle_id, 'test.bundle');
  });

  it('names a missing key, nested ones too', () => {
    const { repo } = makeRepo();
    const { scheme, ...noScheme } = DECLARATION;
    assert.ok(scheme);
    writeFileSync(join(repo, '.mc', 'ios.json'), JSON.stringify(noScheme));
    sh(repo, 'commit', '-q', '-am', 'no scheme');
    sh(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.deepEqual(readIosDeclaration(repo), { ok: false, reason: "memoro's .mc/ios.json on origin/main has no scheme" });
    writeFileSync(join(repo, '.mc', 'ios.json'), JSON.stringify({ ...DECLARATION, env: { build_number: 'X' } }));
    sh(repo, 'commit', '-q', '-am', 'no build_commit');
    sh(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.match(readIosDeclaration(repo).reason, /has no env\.build_commit$/u);
  });

  it('says memoro has none yet when origin/main lacks it', () => {
    const { repo } = makeRepo();
    sh(repo, 'rm', '-q', '.mc/ios.json');
    sh(repo, 'commit', '-q', '-m', 'gone');
    sh(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(readIosDeclaration(repo).reason, 'memoro has no .mc/ios.json on origin/main yet (memoro project ios-build-declaration)');
  });
});

describe('mc build ios — the question', () => {
  it('says mc deploy is enough when nothing native changed', async () => {
    const { repo, second } = makeRepo();
    const { code, out } = await ask({ repo, live: second, shipped: second });
    assert.equal(code, 0);
    assert.match(out, /last shipped: build 38 from \w{7} \(2026-10-01\)/u);
    assert.match(out, new RegExp(`production runs: ${second.slice(0, 7)}`, 'u'));
    assert.match(out, /no native change since build 38 — mc deploy is enough/u);
    assert.doesNotMatch(out, /mc deploy first/u);
  });

  it('names the native paths and packages when they changed', async () => {
    const { repo, first, second } = makeRepo();
    const { code, out } = await ask({ repo, live: second, shipped: first });
    assert.equal(code, 0);
    assert.match(out, /native paths: cap-config\/x\.swift\n/u);
    assert.match(out, /native packages: @capacitor\/core 6\.0\.0→6\.1\.0\n/u);
    assert.doesNotMatch(out, /left-pad|public\/js/u);
    assert.match(out, /a new binary is needed — mc build ios --device to try it, --testflight to ship it/u);
  });

  it('says to deploy first when origin/main has a native change production lacks', async () => {
    const { repo, first } = makeRepo();
    const { code, out } = await ask({ repo, live: first, shipped: first });
    assert.equal(code, 0);
    assert.match(out, /no native change since build 38/u);
    assert.match(out, /origin\/main has native changes production does not run yet \(cap-config\/x\.swift, @capacitor\/core 6\.0\.0→6\.1\.0\) — mc deploy first, then build/u);
  });

  it('is exit 1 when production does not answer', async () => {
    const { repo, first } = makeRepo();
    const { code, err } = await ask({ repo, live: null, shipped: first });
    assert.equal(code, 1);
    assert.match(err, /production did not answer \/api\/version — cannot say what the app would meet/u);
  });

  it('gives the seed hint when nothing has shipped, and counts every native path', async () => {
    const { repo, second } = makeRepo();
    const { code, out } = await ask({ repo, live: second });
    assert.equal(code, 0);
    assert.match(out, /no shipped build is recorded — mc build ios --shipped <build> <sha> records the last one/u);
    assert.match(out, /native paths: cap-config\/, capacitor\.config\.ts/u);
    assert.match(out, /a new binary is needed/u);
  });

  it('refuses another platform, and the builds that are not here yet', async () => {
    const { repo, second } = makeRepo();
    assert.equal((await ask({ repo, live: second, argv: ['android'] })).code, 2);
    const testflight = await ask({ repo, live: second, argv: ['ios', '--testflight', '--no-upload'] });
    assert.equal(testflight.code, 2);
    assert.match(testflight.err, /not yet: mc-build-ios step 3/u);
    assert.equal((await ask({ repo, live: second, argv: ['ios', '--sha', second] })).code, 2, '--sha goes with --device');
  });

  it('reads production through the injected fetch, and null when it fails', async () => {
    const seen = [];
    const ok = await fetchVersionDefault('https://example.test/', {
      fetchImpl: async (url) => { seen.push(url); return { ok: true, json: async () => ({ commit_full: 'abc' }) }; },
    });
    assert.deepEqual(ok, { commit_full: 'abc' });
    assert.deepEqual(seen, ['https://example.test/api/version']);
    assert.equal(await fetchVersionDefault('https://example.test', { fetchImpl: async () => { throw new Error('down'); } }), null);
  });
});

describe('mc build ios --shipped', () => {
  it('refuses a sha that does not resolve, and records nothing', async () => {
    const { repo } = makeRepo();
    const { code, err, env } = await ask({ repo, argv: ['ios', '--shipped', '38', 'deadbeef'] });
    assert.equal(code, 1);
    assert.match(err, /deadbeef is not a commit/u);
    assert.deepEqual(readIosBuilds(env), []);
  });

  it('refuses a build that is not digits', async () => {
    const { repo, first } = makeRepo();
    assert.equal((await ask({ repo, argv: ['ios', '--shipped', 'x38', first] })).code, 2);
  });

  it('records a seed row that lastShipped then returns', async () => {
    const { repo, first } = makeRepo();
    const { code, env } = await ask({ repo, argv: ['ios', '--shipped', '38', first.slice(0, 7)] });
    assert.equal(code, 0);
    const shipped = lastShipped(env);
    assert.equal(shipped.kind, 'seed');
    assert.equal(shipped.build, '38');
    assert.equal(shipped.sha, first);
    assert.equal(shipped.outcome, 'uploaded');
    assert.equal(shipped.ended, shipped.started);
  });
});
