/**
 * `mc language` — the key, the reads, the cache.
 *
 * Nothing real is behind it: git, the reads' spawn, the keychain and stdin are
 * handed in. The cache and the deploy record are real files under the
 * throwaway MC_WORK_ROOT, because they are what the verb reads and leaves.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';

import { readingPath, run, TOKEN_SECRET, ACCOUNT_SECRET, withoutCloudflare } from '../../../src/mc/commands/language.js';
import { recordStart } from '../../../src/mc/deploys.js';
import { CUTOVER_DIR } from '../../../src/mc/language-manifest.js';
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
function fakeGit({ dirty = '', ahead = '0', behind = '0', calls = [] } = {}) {
  return (cwd, args) => {
    calls.push([cwd, ...args]);
    const cmd = args.join(' ');
    if (cmd === 'worktree list --porcelain') return `worktree ${worktree}\nHEAD ${SHA}\nbranch refs/heads/main\n`;
    if (cmd.startsWith('fetch')) return '';
    if (cmd === 'status --porcelain') return dirty;
    if (cmd === 'rev-list --count origin/main..HEAD') return ahead;
    if (cmd === 'rev-list --count HEAD..origin/main') return behind;
    if (cmd === 'merge --ff-only origin/main') return '';
    if (cmd === 'rev-parse HEAD') return SHA;
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

  it('the subcommands of the later steps are not yet', async () => {
    for (const sub of ['run', 'resume', 'promote']) {
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
