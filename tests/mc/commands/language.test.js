/**
 * `mc language` — the key, the reads, the cache.
 *
 * Nothing real is behind it: git, the reads' spawn, the keychain and stdin are
 * handed in. The cache and the deploy record are real files under the
 * throwaway MC_WORK_ROOT, because they are what the verb reads and leaves.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';

import {
  languageDir, readingPath, run, TOKEN_SECRET, ACCOUNT_SECRET, withoutCloudflare,
} from '../../../src/mc/commands/language.js';
import { recordStart } from '../../../src/mc/deploys.js';
import { CUTOVER_DIR } from '../../../src/mc/language-manifest.js';
import { readRuns, startRun } from '../../../src/mc/language-runs.js';
import { logPath } from '../../../src/mc/logger.js';
import { manifest } from '../_helpers/language-manifest.js';

const SHA = '1a2b3c4d5e6f70819293a4b5c6d7e8f900112233';
const TOKEN = 'cfT0kenSecretValue123';

function sink() {
  const chunks = [];
  return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
}

let env;
let worktree;

beforeEach(() => {
  env = {
    MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-language-work-')),
    MC_HOME: mkdtempSync(join(tmpdir(), 'mc-language-home-')),
    PATH: process.env.PATH,
  };
  worktree = mkdtempSync(join(tmpdir(), 'mc-language-memoro-'));
  mkdirSync(join(worktree, CUTOVER_DIR), { recursive: true });
  writeFileSync(join(worktree, CUTOVER_DIR, 'sv-forms-cutover.json'), JSON.stringify(manifest()));
});

/** A git where `main` is checked out in `worktree`, clean and level with origin. */
function fakeGit({ dirty = '', ahead = '0', behind = '0', head = SHA, calls = [] } = {}) {
  return (cwd, args) => {
    calls.push([cwd, ...args]);
    const cmd = args.join(' ');
    if (cmd === 'worktree list --porcelain') return `worktree ${worktree}\nHEAD ${SHA}\nbranch refs/heads/main\n`;
    if (cmd.startsWith('fetch')) return '';
    if (cmd === 'status --porcelain') return dirty;
    if (cmd === 'rev-list --count origin/main..HEAD') return ahead;
    if (cmd === 'rev-list --count HEAD..origin/main') return behind;
    if (cmd === 'merge --ff-only origin/main') return '';
    if (cmd === 'rev-parse HEAD') return head;
    return null;
  };
}

const REPORTS = {
  'grammar-selector-readiness-report.mjs': {
    languages: {
      sv: {
        selectors: { unresolved: 3 },
        rows: { without_usable_resolved: 2 },
        unresolved_selectors: [{ uses: 'language_form' }, { uses: 'language_form' }, { uses: 'language_lemma' }],
      },
    },
  },
  'readiness-report.mjs': { languages: { sv: { d1: { totals: { forms: 897392 } } } } },
  'language-grammar-promote.mjs': { languages: { sv: { status: 'ready' } }, plans: { sv: { upsert: 5, delete_stale: 2 } } },
  'apply-curated-lemma-anchors.mjs': { languages: { sv: { would_update: 0, missing: ['A1/noun hus'] } } },
};

/** The reads, answered from REPORTS; `fail` names scripts that print nothing. */
function fakeSpawn({ fail = [], calls = [] } = {}) {
  return async (call) => {
    calls.push(call);
    const script = call.args[0].split('/').at(-1);
    if (fail.includes(script)) return { code: 1, stdout: '', stderr: 'wrangler: something\nAuthentication error [code: 10000]\n' };
    // The lemma script exits 1 when anchors are missing, read or not.
    return { code: script.startsWith('apply-curated') ? 1 : 0, stdout: JSON.stringify(REPORTS[script]), stderr: '' };
  };
}

const statusDeps = (extra = {}) => ({
  env,
  repos: [{ name: 'memoro', path: '/tmp/does-not-exist/memoro' }],
  git: fakeGit(),
  spawnRead: fakeSpawn(),
  exists: () => true,
  alive: () => false,
  ...extra,
});

describe('mc language key set', () => {
  it('reads the token from stdin and keeps both in the keychain, nothing of it in any output', async () => {
    const kept = {};
    const stdout = sink();
    const stderr = sink();
    const code = await run(['key', 'set', '--account', 'acc0123'], {
      env, stdout, stderr,
      stdin: Readable.from([`${TOKEN}\n`]),
      setSecret: async (name, value) => { kept[name] = value; return 'keychain'; },
    });
    assert.equal(code, 0, stderr.text());
    assert.deepEqual(kept, { [TOKEN_SECRET]: TOKEN, [ACCOUNT_SECRET]: 'acc0123' });
    assert.ok(!stdout.text().includes(TOKEN));
    assert.ok(!stdout.text().includes('acc0123'));
  });

  it('refuses a terminal with nothing piped, and says how', async () => {
    const stdin = Readable.from([]);
    stdin.isTTY = true;
    const stderr = sink();
    let called = false;
    const code = await run(['key', 'set', '--account', 'acc0123'], {
      env, stdout: sink(), stderr, stdin, setSecret: async () => { called = true; },
    });
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(stderr.text(), /printf %s "<token>" \| mc language key set --account <id>/u);
  });

  it('takes no token as an argument', async () => {
    const stderr = sink();
    const code = await run(['key', 'set', TOKEN, '--account', 'acc0123'], {
      env, stdout: sink(), stderr, stdin: Readable.from([]), setSecret: async () => { throw new Error('no'); },
    });
    assert.equal(code, 2);
  });

  it('mc language key says whether both are held and never prints the token', async () => {
    const secrets = { [TOKEN_SECRET]: TOKEN, [ACCOUNT_SECRET]: 'acc0123' };
    const stdout = sink();
    const code = await run(['key'], { env, stdout, stderr: sink(), getSecret: async (name) => secrets[name] || null });
    assert.equal(code, 0);
    assert.match(stdout.text(), /token\s+held/u);
    assert.match(stdout.text(), /account\s+acc0123/u);
    assert.ok(!stdout.text().includes(TOKEN));
  });
});

describe('mc language status <lang>', () => {
  it('runs the four reads in the deploy worktree without CLOUDFLARE_*, prints the block and writes the cache', async () => {
    env.CLOUDFLARE_API_TOKEN = TOKEN;
    const spawnCalls = [];
    const stdout = sink();
    const code = await run(['status', 'sv'], statusDeps({ stdout, stderr: sink(), spawnRead: fakeSpawn({ calls: spawnCalls }) }));
    assert.equal(code, 0);
    assert.equal(spawnCalls.length, 4);
    for (const call of spawnCalls) {
      assert.equal(call.cmd, 'node');
      assert.equal(call.cwd, worktree);
      assert.ok(call.args.includes('--json'));
      assert.deepEqual(Object.keys(call.env).filter((name) => name.startsWith('CLOUDFLARE_')), []);
    }
    const out = stdout.text();
    assert.match(out, /CLOUDFLARE_API_TOKEN set here — not passed to the reads/u);
    assert.ok(!out.includes(TOKEN));
    assert.match(out, /selectors\s+3 unresolved · 2 rows without a usable selector/u);
    assert.match(out, /forms\s+897,392/u);
    assert.match(out, /grammar\s+ready · 7 rows waiting/u);
    assert.match(out, /lemma bands\s+0 would update · 1 missing/u);
    const reading = JSON.parse(readFileSync(readingPath('sv', env), 'utf8'));
    assert.equal(reading.sha, SHA);
    assert.equal(reading.reads.forms.forms, 897392);
    assert.equal(reading.reads.anchors.ok, true, 'a non-zero exit with a report is a reading');
    assert.ok(reading.at);
  });

  it('names the manifest that closes each unresolved use', async () => {
    const stdout = sink();
    await run(['status', 'sv'], statusDeps({ stdout, stderr: sink() }));
    assert.match(stdout.text(), /language_form\s+2\s+closed by sv-forms-cutover/u);
    assert.match(stdout.text(), /language_lemma\s+1\s+no manifest closes it/u);
  });

  it('a read that fails prints its stderr, and the others still print', async () => {
    const stdout = sink();
    const code = await run(['status', 'sv'], statusDeps({
      stdout, stderr: sink(), spawnRead: fakeSpawn({ fail: ['readiness-report.mjs'] }),
    }));
    assert.equal(code, 1);
    assert.match(stdout.text(), /forms\s+read failed — exit 1/u);
    assert.match(stdout.text(), /Authentication error/u);
    assert.match(stdout.text(), /grammar\s+ready/u);
    assert.equal(JSON.parse(readFileSync(readingPath('sv', env), 'utf8')).reads.forms.ok, false);
  });

  it('refuses while a deploy is running, and touches nothing', async () => {
    recordStart({ sha: SHA, holder: 'martin', pid: 4242 }, env);
    const gitCalls = [];
    const spawnCalls = [];
    const stderr = sink();
    const code = await run(['status', 'sv'], statusDeps({
      stdout: sink(), stderr, alive: () => true,
      git: fakeGit({ calls: gitCalls }), spawnRead: fakeSpawn({ calls: spawnCalls }),
    }));
    assert.equal(code, 1);
    assert.match(stderr.text(), /a deploy of 1a2b3c4 has been running/u);
    assert.equal(gitCalls.length, 0);
    assert.equal(spawnCalls.length, 0);
    assert.equal(existsSync(readingPath('sv', env)), false);
  });

  it('refuses a dirty or ahead main, and fast-forwards a behind one', async () => {
    const dirty = await run(['status', 'sv'], statusDeps({ stdout: sink(), stderr: sink(), git: fakeGit({ dirty: ' M src/app.js' }) }));
    assert.equal(dirty, 1);
    const ahead = await run(['status', 'sv'], statusDeps({ stdout: sink(), stderr: sink(), git: fakeGit({ ahead: '2' }) }));
    assert.equal(ahead, 1);
    const calls = [];
    const behind = await run(['status', 'sv'], statusDeps({ stdout: sink(), stderr: sink(), git: fakeGit({ behind: '3', calls }) }));
    assert.equal(behind, 0);
    assert.ok(calls.some((call) => call[0] === worktree && call.slice(1).join(' ') === 'merge --ff-only origin/main'));
  });

  it('refuses without wrangler in the worktree', async () => {
    const stderr = sink();
    const code = await run(['status', 'sv'], statusDeps({ stdout: sink(), stderr, exists: () => false }));
    assert.equal(code, 1);
    assert.match(stderr.text(), /no wrangler in .* — run npm ci there/u);
  });
});

describe('mc language', () => {
  it('with no cache and no manifest says how to read one', async () => {
    const stdout = sink();
    const code = await run([], { env, stdout, stderr: sink(), repos: [] });
    assert.equal(code, 0);
    assert.match(stdout.text(), /no language read yet .* mc language status <lang>/u);
  });

  it('prints every language from the cache and the manifests, offline', async () => {
    await run(['status', 'sv'], statusDeps({ stdout: sink(), stderr: sink() }));
    writeFileSync(join(worktree, CUTOVER_DIR, 'fr-forms.json'), JSON.stringify(manifest({ name: 'fr-forms', lang: 'fr' })));
    const spawnCalls = [];
    const stdout = sink();
    const code = await run([], { ...statusDeps({ spawnRead: fakeSpawn({ calls: spawnCalls }) }), stdout, stderr: sink() });
    assert.equal(code, 0);
    assert.equal(spawnCalls.length, 0);
    const out = stdout.text();
    assert.match(out, /^fr · never read/mu);
    assert.match(out, /^sv · read \d+ min ago/mu);
    assert.match(out, /last run\s+none recorded/u);
    assert.match(out, /mc language status <lang>/u);

    const json = sink();
    await run(['--json'], { ...statusDeps(), stdout: json, stderr: sink() });
    const parsed = JSON.parse(json.text());
    assert.deepEqual(Object.keys(parsed.languages), ['fr', 'sv']);
    assert.equal(parsed.languages.sv.reading.reads.forms.forms, 897392);
    assert.equal(parsed.languages.sv.last_run, null);
  });

  it('the subcommand of a later step is not yet', async () => {
    for (const sub of ['promote']) {
      assert.equal(await run([sub], { env, stdout: sink(), stderr: sink() }), 2);
    }
  });
});

describe('withoutCloudflare', () => {
  it('takes out every CLOUDFLARE_* and says which', () => {
    const { env: clean, removed } = withoutCloudflare({ A: '1', CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: 'y' });
    assert.deepEqual(clean, { A: '1' });
    assert.deepEqual(removed.sort(), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  });
});

/* ---------------------------------------------------------------- run */

const CUTOVER = JSON.parse(readFileSync(new URL('../../fixtures/language/sv-test-cutover.json', import.meta.url), 'utf8'));
const ACCOUNT = 'acc0123';
const PARENT_TOKEN = 'parentShellToken999';

/**
 * The fixture's four scripts as one small production: what the checks read
 * follows what the executes wrote. `answer` overrides a command by the
 * script and its first flag (`purge.mjs --execute`) with a function of the
 * state; every call is kept with its argv and environment.
 */
function fakeMemoro({ answer = {}, calls = [], state = {} } = {}) {
  const world = { local: 0, source: true, forms: 100, remaining: 40, pending: 100, ...state };
  const base = {
    'ingest.js --verify': () => ({ source: { present: world.source }, counts: { forms: world.local } }),
    'ingest.js --all': () => { world.local = 100; return { counts: { forms: 100 } }; },
    'readiness.mjs --json': () => ({ forms: world.forms }),
    'purge.mjs --check': () => ({ remaining: world.remaining }),
    'purge.mjs --execute': () => { world.remaining = 0; return { remaining: 0 }; },
    'sync.mjs --check': () => ({ pending: world.pending }),
    'sync.mjs --execute': () => { world.pending = 0; return { pending: 0 }; },
  };
  const spawnAct = async (call) => {
    calls.push(call);
    const key = `${call.argv[1].split('/').at(-1)} ${call.argv[2]}`;
    const own = answer[key];
    if (own) {
      const result = own(world, call);
      if (result && Object.hasOwn(result, 'code')) return { stdout: '', ...result };
      return { code: 0, stdout: JSON.stringify(result) };
    }
    // Logs leak onto stdout before the report, as scripts' do.
    return { code: 0, stdout: `wrangler 3.x\n${JSON.stringify(base[key](world))}\n` };
  };
  return { spawnAct, calls, world };
}

function installCutover(manifestJson = CUTOVER) {
  writeFileSync(join(worktree, CUTOVER_DIR, `${manifestJson.name}.json`), JSON.stringify(manifestJson));
}

/** Answers handed out in order; each question is kept. */
function answers(...said) {
  const asked = [];
  const ask = (prompt) => { asked.push(prompt); return said.shift() ?? ''; };
  return { ask, asked };
}

const runDeps = (extra = {}) => ({
  ...statusDeps(),
  interactive: () => true,
  holder: { name: 'martin@laptop' },
  getSecret: async (name) => ({ [TOKEN_SECRET]: TOKEN, [ACCOUNT_SECRET]: ACCOUNT }[name] || null),
  stdout: sink(),
  stderr: sink(),
  ...extra,
});

const executes = (calls) => calls.filter((call) => call.argv.includes('--execute') || call.argv.includes('--all')).map((call) => call.argv[1].split('/').at(-1));

describe('mc language run', () => {
  beforeEach(() => installCutover());

  it('with no terminal exits 2 before reading anything, and MC_NO_PROMPT refuses rather than assumes', async () => {
    const memoro = fakeMemoro();
    const gitCalls = [];
    const stderr = sink();
    const code = await run(['run', 'sv-test-cutover'], runDeps({
      stderr, interactive: () => false, spawnAct: memoro.spawnAct, git: fakeGit({ calls: gitCalls }),
    }));
    assert.equal(code, 2);
    assert.match(stderr.text(), /no terminal here to ask/u);
    assert.equal(memoro.calls.length, 0);
    assert.equal(gitCalls.length, 0);
    assert.equal(readRuns(env).length, 0);

    env.MC_NO_PROMPT = '1';
    const deps = runDeps({ spawnAct: memoro.spawnAct });
    delete deps.interactive;
    assert.equal(await run(['run', 'sv-test-cutover'], deps), 2);
    assert.equal(await run(['resume'], deps), 2);
    assert.equal(memoro.calls.length, 0);
  });

  it('runs every act in order with a question before every write, and records it', async () => {
    const memoro = fakeMemoro();
    const { ask, asked } = answers('y', 'yes', 'y');
    const stdout = sink();
    const code = await run(['run', 'sv-test-cutover'], runDeps({ stdout, ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 0, stdout.text());
    assert.deepEqual(asked, ['ingest-local: write to local? [y/N]', 'purge-forms: write to production? [y/N]', 'sync-forms: write to production? [y/N]']);
    assert.deepEqual(executes(memoro.calls), ['ingest.js', 'purge.mjs', 'sync.mjs']);
    for (const call of memoro.calls) assert.equal(call.cwd, worktree);
    const out = stdout.text();
    assert.match(out, /act 2\/4 forms-read — Production has the old forms/u);
    assert.match(out, /✓ forms = 100/u);
    assert.match(out, /· rows = missing — advisory: about fifty/u);
    const [record] = readRuns(env);
    assert.equal(record.outcome, 'done');
    assert.equal(record.sha, SHA);
    assert.equal(record.lang, 'sv');
    assert.equal(record.holder, 'martin@laptop');
    assert.ok(record.ended);
    assert.deepEqual(record.acts.filter((act) => act.phase === 'execute').map((act) => [act.id, act.outcome]),
      [['ingest-local', 'done'], ['purge-forms', 'done'], ['sync-forms', 'done']]);
    assert.deepEqual(record.acts.find((act) => act.id === 'purge-forms' && act.phase === 'execute').observed, { remaining: 0 });
  });

  it('runs each argument array exactly as the manifest gives it', async () => {
    const memoro = fakeMemoro();
    await run(['run', 'sv-test-cutover'], runDeps({ ask: answers('y', 'y', 'y').ask, spawnAct: memoro.spawnAct }));
    const given = CUTOVER.acts.flatMap((act) => [act.check, act.execute]).filter(Boolean).map((argv) => argv.join(' '));
    for (const call of memoro.calls) assert.ok(given.includes(call.argv.join(' ')), call.argv.join(' '));
  });

  it('the key goes only into the children of acts that name it, and nowhere else', async () => {
    env.CLOUDFLARE_API_TOKEN = PARENT_TOKEN;
    env.CLOUDFLARE_ACCOUNT_ID = 'parentAccount';
    env.CLOUDFLARE_EMAIL = 'me@example.com';
    const memoro = fakeMemoro({
      answer: {
        // A script that echoes the token it was given, to stderr and in its report.
        'purge.mjs --execute': (world, call) => {
          call.onStderr(`deleting with ${call.env.CLOUDFLARE_API_TOKEN}\n`);
          world.remaining = 0;
          return { remaining: 0, token: call.env.CLOUDFLARE_API_TOKEN };
        },
      },
    });
    const stdout = sink();
    const stderr = sink();
    const code = await run(['run', 'sv-test-cutover'], runDeps({ stdout, stderr, ask: answers('y', 'y', 'y').ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 0, stderr.text());
    assert.match(stdout.text(), /mc: CLOUDFLARE_\* set in this shell are ignored — the key comes from the keychain/u);
    assert.equal(stdout.text().match(/CLOUDFLARE_\* set in this shell/gu).length, 1, 'said once per run');
    for (const call of memoro.calls) {
      assert.ok(!call.argv.some((arg) => arg.includes(TOKEN)), 'never an argument');
      const credentialed = ['purge.mjs', 'sync.mjs'].includes(call.argv[1].split('/').at(-1));
      assert.equal(call.env.CLOUDFLARE_API_TOKEN, credentialed ? TOKEN : undefined);
      assert.equal(call.env.CLOUDFLARE_ACCOUNT_ID, credentialed ? ACCOUNT : undefined);
      assert.equal(call.env.CLOUDFLARE_EMAIL, undefined, 'the parent\'s CLOUDFLARE_* are stripped');
      assert.ok(!Object.values(call.env).includes(PARENT_TOKEN));
    }
    assert.ok(!stdout.text().includes(TOKEN));
    assert.ok(!stderr.text().includes(TOKEN));
    assert.match(stderr.text(), /deleting with <redacted>/u);
    const logs = readdirSync(languageDir(env)).filter((file) => file.endsWith('.log'));
    assert.equal(logs.length, 1);
    const log = readFileSync(join(languageDir(env), logs[0]), 'utf8');
    assert.match(log, /deleting with <redacted>/u);
    assert.ok(!log.includes(TOKEN));
    const runFile = readdirSync(join(languageDir(env), 'runs'))[0];
    assert.ok(!readFileSync(join(languageDir(env), 'runs', runFile), 'utf8').includes(TOKEN), 'nor does the record');
    if (existsSync(logPath())) assert.ok(!readFileSync(logPath(), 'utf8').includes(TOKEN), 'mc.log never carries it');
  });

  it('refuses before any write when the key is not in the keychain', async () => {
    const memoro = fakeMemoro();
    const stderr = sink();
    const code = await run(['run', 'sv-test-cutover'], runDeps({ stderr, getSecret: async () => null, spawnAct: memoro.spawnAct }));
    assert.equal(code, 1);
    assert.match(stderr.text(), /mc language key set/u);
    assert.equal(memoro.calls.length, 0);
    assert.equal(readRuns(env)[0].outcome, 'refused');
  });

  it('refuses before any write when the key does not read', async () => {
    const memoro = fakeMemoro({ answer: { 'purge.mjs --check': () => ({ code: 1, stdout: '' }) } });
    const { ask, asked } = answers('y');
    const code = await run(['run', 'sv-test-cutover'], runDeps({ ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 1);
    assert.equal(asked.length, 0);
    assert.deepEqual(executes(memoro.calls), []);
    assert.equal(memoro.calls[0].env.CLOUDFLARE_API_TOKEN, TOKEN, 'the harmless read is the first credentialed check');
  });

  it('a no at the question records declined, runs nothing more and exits 1', async () => {
    const memoro = fakeMemoro();
    const { ask, asked } = answers('y', 'n');
    const code = await run(['run', 'sv-test-cutover'], runDeps({ ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 1);
    assert.equal(asked.length, 2);
    assert.deepEqual(executes(memoro.calls), ['ingest.js']);
    const [record] = readRuns(env);
    assert.equal(record.outcome, 'stopped');
    assert.deepEqual(record.acts.filter((act) => act.phase === 'execute').map((act) => [act.id, act.outcome]),
      [['ingest-local', 'done'], ['purge-forms', 'declined']]);
  });

  it('an exact deviation stops the run before the next write and prints if_not; advisory never stops', async () => {
    const memoro = fakeMemoro({ state: { forms: 99 } });
    const { ask, asked } = answers('y', 'y', 'y');
    const stdout = sink();
    const stderr = sink();
    const code = await run(['run', 'sv-test-cutover'], runDeps({ stdout, stderr, ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 1);
    assert.match(stdout.text(), /✗ forms = 99, expected 100/u);
    assert.match(stderr.text(), /forms-read — Production is not what this manifest was written against/u);
    assert.match(stderr.text(), /mc language resume/u);
    assert.deepEqual(executes(memoro.calls), ['ingest.js']);
    assert.equal(asked.length, 1);
    assert.equal(readRuns(env)[0].outcome, 'stopped');
    // `rows` was missing all along — advisory — and sync's `pending` advisory never stopped either run.
    assert.match(stdout.text(), /advisory: about fifty/u);
  });

  it('a write whose expectations already hold is offered, default no, and the run goes on', async () => {
    const memoro = fakeMemoro({ state: { local: 100 } });
    const { ask, asked } = answers('', 'y', 'y');
    const code = await run(['run', 'sv-test-cutover'], runDeps({ ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 0);
    assert.equal(asked[0], 'ingest-local: run it anyway? [y/N]');
    assert.deepEqual(executes(memoro.calls), ['purge.mjs', 'sync.mjs']);
  });

  it('requires_runnable failing stops the write that needs it', async () => {
    let verifies = 0;
    const memoro = fakeMemoro({
      answer: {
        // Holds through the preflight and the act itself, then is gone.
        'ingest.js --verify': (world) => { verifies += 1; return { source: { present: verifies < 3 }, counts: { forms: world.local } }; },
      },
    });
    const { ask } = answers('y', 'y', 'y');
    const stderr = sink();
    const code = await run(['run', 'sv-test-cutover'], runDeps({ stderr, ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 1);
    assert.match(stderr.text(), /purge-forms requires ingest-local, and ingest-local does not hold/u);
    assert.deepEqual(executes(memoro.calls), ['ingest.js']);
  });

  it('a requires_runnable that does not hold refuses the run in preflight, before the first write', async () => {
    const cutover = structuredClone(CUTOVER);
    cutover.acts[0].requires_runnable = ['forms-read'];
    installCutover(cutover);
    const memoro = fakeMemoro({ state: { forms: 7 } });
    const { ask, asked } = answers('y', 'y', 'y');
    const code = await run(['run', 'sv-test-cutover'], runDeps({ ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 1);
    assert.equal(asked.length, 0);
    assert.deepEqual(executes(memoro.calls), []);
    assert.equal(readRuns(env)[0].outcome, 'refused');
  });

  it('a write that exits non-zero or deviates stops the run with if_not', async () => {
    const failing = fakeMemoro({ answer: { 'purge.mjs --execute': () => ({ code: 1, stdout: '' }) } });
    const stderr = sink();
    assert.equal(await run(['run', 'sv-test-cutover'], runDeps({ stderr, ask: answers('y', 'y', 'y').ask, spawnAct: failing.spawnAct })), 1);
    assert.match(stderr.text(), /purge-forms — Run the purge again/u);
    assert.equal(readRuns(env).at(-1).outcome, 'failed');
    assert.deepEqual(executes(failing.calls), ['ingest.js', 'purge.mjs']);

    const short = fakeMemoro({ answer: { 'purge.mjs --execute': () => ({ remaining: 3 }) } });
    assert.equal(await run(['run', 'sv-test-cutover'], runDeps({ ask: answers('y', 'y', 'y').ask, spawnAct: short.spawnAct })), 1);
    assert.equal(readRuns(env).at(-1).outcome, 'stopped');
    assert.deepEqual(executes(short.calls), ['ingest.js', 'purge.mjs']);
  });

  it('^C during a write stops the run with the act failed, exit 130', async () => {
    const memoro = fakeMemoro({ answer: { 'purge.mjs --execute': () => ({ code: 1, interrupted: 'SIGINT' }) } });
    const code = await run(['run', 'sv-test-cutover'], runDeps({ ask: answers('y', 'y').ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 130);
    const [record] = readRuns(env);
    assert.equal(record.outcome, 'stopped');
    const purge = record.acts.find((act) => act.id === 'purge-forms' && act.phase === 'execute');
    assert.equal(purge.outcome, 'failed');
    assert.match(purge.note, /interrupted by SIGINT/u);
  });

  it('is refused while a deploy is running, and while another run is', async () => {
    recordStart({ sha: SHA, holder: 'martin', pid: 4242 }, env);
    const memoro = fakeMemoro();
    const stderr = sink();
    assert.equal(await run(['run', 'sv-test-cutover'], runDeps({ stderr, alive: (pid) => pid === 4242, spawnAct: memoro.spawnAct })), 1);
    assert.match(stderr.text(), /a deploy of 1a2b3c4 has been running/u);
    assert.equal(memoro.calls.length, 0);
    assert.equal(readRuns(env).length, 0);

    const otherEnv = { ...env, MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-language-work-')) };
    env = otherEnv;
    startRun({ manifest: 'sv-other', lang: 'sv', sha: SHA, pid: 4242, started: '2026-10-10T08:00:00.000Z' }, env);
    const again = sink();
    assert.equal(await run(['run', 'sv-test-cutover'], runDeps({ stderr: again, alive: (pid) => pid === 4242, spawnAct: memoro.spawnAct })), 1);
    assert.match(again.text(), /a language run of sv-other has been running since 2026-10-10 08:00 \(pid 4242\)/u);
    assert.equal(memoro.calls.length, 0);
  });

  it('a run whose process is gone is closed as failed, and the new one goes ahead', async () => {
    startRun({ manifest: 'sv-other', lang: 'sv', sha: SHA, pid: 4242, started: '2026-10-10T08:00:00.000Z' }, env);
    const memoro = fakeMemoro();
    const stdout = sink();
    const code = await run(['run', 'sv-test-cutover'], runDeps({ stdout, alive: () => false, ask: answers('y', 'y', 'y').ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 0);
    assert.match(stdout.text(), /the run of sv-other started 2026-10-10 08:00 never came back/u);
    const [old, now] = readRuns(env);
    assert.equal(old.outcome, 'failed');
    assert.equal(now.outcome, 'done');
  });

  it('names a manifest it does not have', async () => {
    const stderr = sink();
    assert.equal(await run(['run', 'sv-nope'], runDeps({ stderr })), 1);
    assert.match(stderr.text(), /no manifest sv-nope .* sv-forms-cutover, sv-test-cutover/u);
  });
});

describe('mc language run --dry-run', () => {
  beforeEach(() => installCutover());

  it('asks nothing, writes nothing, checks up to the first production write and lists the rest', async () => {
    const memoro = fakeMemoro();
    let asked = 0;
    const stdout = sink();
    const code = await run(['run', 'sv-test-cutover', '--dry-run'], runDeps({
      stdout, interactive: () => false, ask: () => { asked += 1; return 'y'; }, spawnAct: memoro.spawnAct,
    }));
    assert.equal(code, 0, stdout.text());
    assert.equal(asked, 0);
    assert.deepEqual(executes(memoro.calls), []);
    const checked = memoro.calls.map((call) => call.argv[1].split('/').at(-1));
    assert.ok(!checked.includes('sync.mjs'));
    assert.ok(checked.filter((script) => script === 'ingest.js').length >= 2, 'purge-forms\' requires_runnable is checked');
    const out = stdout.text();
    assert.match(out, /act 4\/4 sync-forms — not checkable until purge-forms has written/u);
    assert.match(out, /check {4}node scripts\/sync.mjs --check --json/u);
    assert.match(out, /--dry-run — every exact expectation read held; nothing was written/u);
    const [record] = readRuns(env);
    assert.equal(record.dry_run, true);
    assert.equal(record.outcome, 'done');
    assert.equal(record.acts.filter((act) => act.phase === 'execute').length, 0);
  });

  it('stops at the first exact deviation with if_not, exit 1, and the record shows no execute', async () => {
    const memoro = fakeMemoro({ state: { remaining: 41 } });
    const stderr = sink();
    const code = await run(['run', 'sv-test-cutover', '--dry-run'], runDeps({ stderr, interactive: () => false, spawnAct: memoro.spawnAct }));
    assert.equal(code, 1);
    assert.match(stderr.text(), /purge-forms — Run the purge again/u);
    const [record] = readRuns(env);
    assert.equal(record.outcome, 'stopped');
    assert.equal(record.dry_run, true);
    assert.equal(record.acts.filter((act) => act.phase === 'execute').length, 0);
  });

  it('prints a manifest\'s ran first', async () => {
    installCutover({ ...CUTOVER, ran: { on: '2026-10-09', note: 'stopped at 7403' } });
    const stdout = sink();
    await run(['run', 'sv-test-cutover', '--dry-run'], runDeps({ stdout, spawnAct: fakeMemoro().spawnAct }));
    assert.match(stdout.text(), /^mc: sv-test-cutover ran on 2026-10-09 — stopped at 7403$/mu);
  });
});

describe('mc language resume', () => {
  beforeEach(() => installCutover());

  async function interrupted() {
    const memoro = fakeMemoro({ answer: { 'purge.mjs --execute': (world) => { world.remaining = 12; return { code: 1, interrupted: 'SIGHUP' }; } } });
    assert.equal(await run(['run', 'sv-test-cutover'], runDeps({ ask: answers('y', 'y').ask, spawnAct: memoro.spawnAct })), 130);
    return memoro.world;
  }

  it('skips the done acts, relaxes only the interrupted one, asks again and links the run', async () => {
    const world = await interrupted();
    const memoro = fakeMemoro({ state: { ...world } });
    const { ask, asked } = answers('y', 'y');
    const stdout = sink();
    const code = await run(['resume'], runDeps({ stdout, ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 0, stdout.text());
    assert.deepEqual(executes(memoro.calls), ['purge.mjs', 'sync.mjs']);
    assert.deepEqual(asked, ['purge-forms: write to production? [y/N]', 'sync-forms: write to production? [y/N]']);
    assert.match(stdout.text(), /act 1\/4 ingest-local — Ingest the forms into the local D1\n {4}written in the run this resumes — skipped/u);
    assert.match(stdout.text(), /remaining = 12, expected 40 — not enforced: resuming an interrupted write/u);
    const [first, second] = readRuns(env);
    assert.equal(second.resumes, first.started);
    assert.equal(second.outcome, 'done');
  });

  it('keeps every other act\'s exact expectations', async () => {
    const world = await interrupted();
    const memoro = fakeMemoro({ state: { ...world, forms: 98 } });
    const { ask, asked } = answers('y', 'y');
    const code = await run(['resume'], runDeps({ ask, spawnAct: memoro.spawnAct }));
    assert.equal(code, 1);
    assert.equal(asked.length, 0);
    assert.deepEqual(executes(memoro.calls), []);
  });

  it('refuses when memoro\'s main moved since, unless --from-head', async () => {
    const world = await interrupted();
    const moved = 'ffffffffffffffffffffffffffffffffffffffff';
    const stderr = sink();
    const memoro = fakeMemoro({ state: { ...world } });
    assert.equal(await run(['resume'], runDeps({ stderr, git: fakeGit({ head: moved }), spawnAct: memoro.spawnAct })), 1);
    assert.match(stderr.text(), /stopped at 1a2b3c4, and memoro's main is fffffff now — the manifest may have changed/u);
    assert.equal(memoro.calls.length, 0);
    assert.equal(await run(['resume', '--from-head'], runDeps({ git: fakeGit({ head: moved }), ask: answers('y', 'y').ask, spawnAct: memoro.spawnAct })), 0);
  });

  it('with nothing stopped says so', async () => {
    const stderr = sink();
    assert.equal(await run(['resume'], runDeps({ stderr })), 1);
    assert.match(stderr.text(), /no stopped language run to resume/u);
  });
});
