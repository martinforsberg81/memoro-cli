/**
 * `mc asc`'s script subverbs: the declared script run as origin/main has it,
 * with `script_paths` written out beside `scripts/`, through `mc keys run`,
 * and `submit`/`release` asked at the terminal — refused without one before
 * anything runs.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { declaredScript, parseScriptArgs, run, usage } from '../../src/mc/commands/asc.js';
import { listBuilds, runSync } from '../../src/mc/ios-build.js';
import { runScriptWithKeys } from '../../src/mc/keys-run.js';
import { VERB_MODULES } from '../../src/mc-verbs.js';
import { HELP_TEXT } from '../../src/mc/help-text.js';

const checkout = mkdtempSync(join(tmpdir(), 'mc-asc-test-'));
after(() => rmSync(checkout, { recursive: true, force: true }));

const DECLARATION = {
  schema_version: 1, project: 'p', scheme: 's', bundle_id: 'b', team_id: 't', server_url: 'https://x',
  setup: [], sync: 'x', export_options: 'e', env: { build_number: 'N', build_commit: 'C' },
  info_plist_commit_key: 'K', list_builds: ['node', 'scripts/asc-list-builds.mjs', '--json'],
  upload: ['node', 'scripts/asc-upload-ipa.mjs'],
  status: ['node', 'scripts/asc-status.mjs'],
  submit: ['node', 'scripts/asc-submit-version.mjs'],
  release: ['node', 'scripts/asc-release-version.mjs'],
  metadata: ['node', 'scripts/asc-update-metadata.mjs'],
  screenshots: ['node', 'scripts/asc-upload-screenshots.mjs'],
  review_notes: ['node', 'scripts/asc-update-review-notes.mjs'],
  iap: ['node', 'scripts/asc-upload-iap-metadata.mjs'],
  script_paths: ['marketing'],
  app_local_plugins: [], native_paths: [], native_dependency_prefixes: [],
};

function capture() {
  const out = { text: '', write(chunk) { out.text += chunk; } };
  return out;
}

/** `mc asc <argv>` with every boundary faked; what ran and what it said. */
async function asc(argv, {
  declaration = DECLARATION, reading = { code: 0, stdout: '{"refused":null,"plan":["request the release"]}' },
  liveCode = 0, isInteractive = true, answer = null,
} = {}) {
  const calls = { live: [], capture: [], exported: [], asked: [] };
  const stdout = capture();
  const stderr = capture();
  const git = (_repo, args) => {
    if (args[0] === 'show') return JSON.stringify(declaration);
    if (args[0] === 'cat-file') return '';
    return '';
  };
  const code = await run(argv, {
    env: { HOME: checkout, PATH: process.env.PATH, MC_KEYS_FILE: '/synthetic/keys.env' },
    repos: [{ name: 'memoro', path: checkout, checkout }],
    git,
    exportTree: (_repo, rev, top) => { calls.exported.push(`${rev}:${top}`); return null; },
    run: (cmd, opts) => { calls.capture.push({ cmd, opts }); return { stderr: '', error: null, ...reading }; },
    runLive: (cmd, opts) => { calls.live.push({ cmd, opts }); return { code: liveCode }; },
    interactive: () => isInteractive,
    ask: (question) => { calls.asked.push(question); return answer; },
    stdout,
    stderr,
  });
  return { code, out: stdout.text, err: stderr.text, calls };
}

const scriptOf = (call) => call.cmd[4].split('/').slice(-2).join('/');
const isKeysRun = (call) => call.cmd[1].endsWith('/src/mc-cli.js') && call.cmd[2] === 'keys' && call.cmd[3] === 'run';

describe('ASC keys delivery through the real executor', () => {
  it('delivers synthetic entries, filters both streams, refuses missing source and isolates parent env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-asc-keys-child-'));
    const home = join(root, 'home');
    const source = join(root, 'synthetic.env');
    mkdirSync(home); mkdirSync(join(root, 'scripts'));
    writeFileSync(source, 'ASC_KEY_ID=synthetic-fixture-secret\n');
    const parent = { HOME: home, MC_HOME: join(root, 'mc'), MC_WORK_ROOT: join(root, 'work'), MC_KEYS_FILE: source, PATH: process.env.PATH };
    const before = { ...parent };
    const sessionBefore = { ...process.env };
    const exported = [];
    const selected = declaredScript('status', {
      env: parent, repos: [{ name: 'memoro', path: root, checkout: root }],
      git: (_repo, args) => args[0] === 'show' ? JSON.stringify(DECLARATION) : '',
      exportTree: (_repo, rev, top, dir) => {
        exported.push(`${rev}:${top}`);
        mkdirSync(join(dir, top));
        if (top === 'scripts') writeFileSync(join(dir, 'scripts/asc-status.mjs'), [
          "console.log(JSON.stringify({ delivered: process.env.ASC_KEY_ID === 'synthetic-fixture-secret', diagnostic: process.env.ASC_KEY_ID }));",
          "console.error('stderr ' + process.env.ASC_KEY_ID);",
        ].join('\n'));
        return null;
      },
    });
    try {
      assert.equal(selected.ok, true);
      assert.deepEqual(exported, ['origin/main:scripts', 'origin/main:marketing']);
      const { command } = selected;
      assert.equal(existsSync(command.dir), true);
      const result = runSync(command.argv, { cwd: command.cwd, env: parent, timeoutMs: 5_000 });
      assert.equal(result.code, 0, result.stderr);
      const json = JSON.parse(result.stdout);
      assert.equal(json.delivered, true);
      assert.notEqual(json.diagnostic, 'synthetic-fixture-secret');
      assert.match(result.stderr, /^stderr /u);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-fixture-secret/u);
      // The refusal needs no CLI bootstrap or child: exercise the same real
      // executor in-process, which must stop before starting the exported script.
      const stdout = capture(); const stderr = capture();
      const code = await runScriptWithKeys(command.argv[4], [], {
        cwd: command.cwd, env: { ...parent, MC_KEYS_FILE: join(root, 'missing.env') }, stdout, stderr,
      });
      assert.notEqual(code, 0);
      assert.equal(stdout.text, '');
      assert.match(stderr.text, /shared dotenv source is missing or unreadable/u);
      assert.doesNotMatch(stderr.text, /synthetic-fixture-secret/u);
      assert.deepEqual(parent, before);
      assert.deepEqual({ ...process.env }, sessionBefore);
    } finally {
      selected.cleanup?.();
      if (selected.ok) assert.equal(existsSync(selected.command.dir), false);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes exported trees when declared scripts or list_builds refuse an unsupported extension', () => {
    const exported = new Set();
    const declaration = { ...DECLARATION, status: ['node', 'scripts/unsupported.txt'], list_builds: ['node', 'scripts/unsupported.txt'] };
    const git = (_repo, args) => args[0] === 'show' ? JSON.stringify(declaration) : '';
    const exportTree = (_repo, _rev, _top, dir) => { exported.add(dir); return null; };
    try {
      const script = declaredScript('status', {
        env: {}, repos: [{ name: 'memoro', path: checkout, checkout }], git, exportTree,
      });
      assert.equal(script.ok, false);
      assert.match(script.line, /unsupported declared credential-command shape/u);
      const builds = listBuilds({ repoPath: checkout, declaration, rev: 'origin/main', git, exportTree,
        run: () => assert.fail('unsupported script must not run'), env: {},
      });
      assert.equal(builds.ok, false);
      assert.match(builds.line, /unsupported declared credential-command shape/u);
      assert.equal(exported.size, 2);
      for (const dir of exported) assert.equal(existsSync(dir), false, 'refused export must be removed');
    } finally {
      for (const dir of exported) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mc asc — the verb', () => {
  it('replaces mc build: asc is routed, build is not', () => {
    assert.equal(VERB_MODULES.asc, './mc/commands/asc.js');
    assert.equal('build' in VERB_MODULES, false);
    assert.doesNotMatch(HELP_TEXT, /mc build\b/u);
    assert.doesNotMatch(usage(), /mc build\b/u);
    for (const sub of ['build', 'status', 'metadata', 'screenshots', 'review-notes', 'iap', 'submit', 'release']) {
      assert.match(`${HELP_TEXT}\n${usage()}`, new RegExp(`mc asc ${sub}\\b`, 'u'), `mc asc ${sub} is listed`);
    }
  });

  it('refuses no subverb and an unknown one with exit 2', async () => {
    assert.equal((await asc([])).code, 2);
    const ios = await asc(['ios']);
    assert.equal(ios.code, 2);
    assert.match(ios.err, /mc asc has no ios/u);
  });

  it('parses each script subverb\'s words', () => {
    assert.ok(parseScriptArgs('status', ['--dry-run']).error, 'status only reads');
    assert.ok(parseScriptArgs('submit', ['1.1.2']).error);
    assert.ok(parseScriptArgs('release', ['1.1.2', '--yes']).error);
    assert.deepEqual(parseScriptArgs('release', ['1.1.2', '--phased', '--dry-run']), { dryRun: true, args: ['1.1.2', '--phased'], positional: ['1.1.2'] });
    assert.deepEqual(parseScriptArgs('metadata', ['--locale=sv']), { dryRun: false, args: ['--locale=sv'], positional: [] });
  });
});

describe('mc asc status and the syncs — the declared script as origin/main has it', () => {
  it('runs status with its words, scripts/ and marketing/ from origin/main through keys, preserving control env', async () => {
    const t = await asc(['status', '1.1.1', '--json'], { liveCode: 0 });
    assert.equal(t.code, 0);
    assert.deepEqual(t.calls.exported, ['origin/main:scripts', 'origin/main:marketing']);
    const [call] = t.calls.live;
    assert.equal(scriptOf(call), 'scripts/asc-status.mjs');
    assert.equal(isKeysRun(call), true);
    assert.deepEqual(call.cmd.slice(5), ['1.1.1', '--json']);
    assert.equal(call.opts.env.MC_KEYS_FILE, '/synthetic/keys.env');
    assert.equal(call.opts.env.MEMORO_DEV_VARS, undefined);
    assert.equal(call.opts.cwd, join(checkout, 'scripts'));
  });

  it('passes the script\'s exit code on', async () => {
    assert.equal((await asc(['status', '9.9.9'], { liveCode: 1 })).code, 1);
  });

  it('runs review-notes with --dry-run and the words it was given', async () => {
    const t = await asc(['review-notes', '--version=1.1.2', '--dry-run']);
    assert.equal(scriptOf(t.calls.live[0]), 'scripts/asc-update-review-notes.mjs');
    assert.equal(isKeysRun(t.calls.live[0]), true);
    assert.deepEqual(t.calls.live[0].cmd.slice(5), ['--version=1.1.2', '--dry-run']);
    assert.deepEqual(t.calls.asked, [], 'a sync asks nothing');
  });

  it('refuses unsupported declared credential-command shapes without echoing values', async () => {
    const token = 'synthetic-command-token';
    const declaration = { ...DECLARATION, status: ['npm', 'run', token] };
    const t = await asc(['status'], { declaration });
    assert.equal(t.code, 1);
    assert.match(t.err, /unsupported declared credential-command shape/u);
    assert.doesNotMatch(t.err, new RegExp(token, 'u'));
    assert.deepEqual(t.calls.live, []);
  });

  it('refuses in words when origin/main declares no such script', async () => {
    const { iap: _iap, ...without } = DECLARATION;
    const t = await asc(['iap'], { declaration: without });
    assert.equal(t.code, 1);
    assert.match(t.err, /declares no iap script/u);
    assert.deepEqual(t.calls.live, []);
  });
});

  it('routes each declared subverb script through the local keys executor', async () => {
    const cases = [
      [['status'], 'asc-status.mjs'], [['metadata'], 'asc-update-metadata.mjs'],
      [['screenshots'], 'asc-upload-screenshots.mjs'], [['review-notes'], 'asc-update-review-notes.mjs'],
      [['iap'], 'asc-upload-iap-metadata.mjs'], [['submit', '1.1.2', '44', '--dry-run'], 'asc-submit-version.mjs'],
      [['release', '1.1.2', '--dry-run'], 'asc-release-version.mjs'],
    ];
    for (const [args, script] of cases) {
      const t = await asc(args);
      const call = t.calls.live[0];
      assert.equal(isKeysRun(call), true, args[0]);
      assert.equal(call.cmd[4].split('/').at(-1), script);
    }
  });

describe('mc asc submit and release — a person\'s acts', () => {
  for (const argv of [['submit', '1.1.2', '44'], ['release', '1.1.2']]) {
    it(`mc asc ${argv.join(' ')} without a terminal exits 2 and runs nothing`, async () => {
      const t = await asc(argv, { isInteractive: false });
      assert.equal(t.code, 2);
      assert.match(t.err, /no terminal here to ask/u);
      assert.deepEqual([t.calls.live, t.calls.capture, t.calls.exported], [[], [], []]);
    });
  }

  it('--dry-run asks nothing, needs no terminal, and passes the refusal on', async () => {
    const t = await asc(['release', '1.1.1', '--dry-run'], { isInteractive: false, liveCode: 1 });
    assert.equal(t.code, 1);
    assert.deepEqual(t.calls.asked, []);
    assert.deepEqual(t.calls.live[0].cmd.slice(5), ['1.1.1', '--dry-run']);
  });

  it('a refused reading stops before the question', async () => {
    const t = await asc(['release', '1.1.1'], {
      reading: { code: 1, stdout: '{"refused":"version 1.1.1 is READY_FOR_SALE, not PENDING_DEVELOPER_RELEASE"}' },
    });
    assert.equal(t.code, 1);
    assert.match(t.err, /refused — version 1\.1\.1 is READY_FOR_SALE, not PENDING_DEVELOPER_RELEASE; nothing was sent/u);
    assert.deepEqual(t.calls.asked, []);
    assert.deepEqual(t.calls.live, []);
    assert.deepEqual(t.calls.capture[0].cmd.slice(5), ['1.1.1', '--dry-run', '--json']);
  });

  it('a no at the question sends nothing', async () => {
    const t = await asc(['submit', '1.1.2', '44'], { answer: 'n' });
    assert.equal(t.code, 1);
    assert.match(t.calls.asked[0], /^submit memoro me 1\.1\.2 with build 44 for App Review/u);
    assert.match(t.out, /nothing was submitted/u);
    assert.deepEqual(t.calls.live, []);
  });

  it('a yes runs the act once, without --dry-run', async () => {
    const t = await asc(['release', '1.1.2', '--phased'], { answer: 'y' });
    assert.equal(t.code, 0);
    assert.match(t.calls.asked[0], /^release memoro me 1\.1\.2 to the App Store \(request the release\)\? \[y\/N\]$/u);
    assert.equal(t.calls.live.length, 1);
    assert.deepEqual(t.calls.live[0].cmd.slice(5), ['1.1.2', '--phased']);
  });
});
