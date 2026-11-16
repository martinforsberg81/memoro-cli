/**
 * Programme review (src/mc/programme-review.js): `mc programs review` launches
 * one independent headless reading of the programme document at origin/main exports.
 * Advisory: writes PROGRAMME-REVIEW.md beside the programme, records no verdict or currency.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as claude from '../../src/adapters/claude-code.js';
import { run as ask } from '../../src/mc/commands/ask.js';
import { run as programs } from '../../src/mc/commands/programs.js';
import { newRecord, recordPageTemplate, writeRecord } from '../../src/mc/programme-record.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { applyObservation, normaliseCapacity } from '../../src/mc/model-capacity.js';
import {
  PROGRAMME_REVIEW_FILE, PROGRAMME_REVIEW_LAUNCH, PROGRAMME_REVIEW_LIMIT_MS,
} from '../../src/mc/programme-review.js';
import { TIMEOUT_EXIT } from '../../src/mc/run-plan.js';

const NOW = new Date('2026-11-15T10:00:00Z');
const AFTER_START = NOW.getTime() + 60_000;
const AHEAD = '2026-11-15T15:00:00.000Z';
const SOL = Object.freeze({ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
const OPUS = Object.freeze({ tool: 'claude', model: 'opus', effort: 'high' });
const LISTED = [{ id: 'gpt-6.1-sol', efforts: ['high'] }];
const win = (fraction_used, resets_at = AHEAD) => ({ fraction_used, resets_at });
const capacityOf = (claudeUsed, codexUsed) => {
  let state = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: win(claudeUsed), seven_day: win(claudeUsed) } }, NOW);
  state = applyObservation(state, 'codex', { windows: { primary: win(codexUsed), secondary: null }, models: LISTED }, NOW);
  return state;
};
const catalogOf = (review, providerPriority = 'auto') => ({ ...DEFAULT_CATALOG, providerPriority, review });
const sink = () => { const parts = []; return { write: (text) => parts.push(text), text: () => parts.join('') }; };
const DONE = { status: 0, stdout: '', stderr: '' };

function baseSetup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-programme-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const baseEnv = { MC_WORK_ROOT: root, MC_HOME: join(root, 'home'), MC_ROLE: 'plan', MC_PROGRAMME: 'p', MC_TOOL: 'claude', MC_MODEL: 'opus' };
  const rows = [];
  const deps = {
    checkoutId: () => 'fixture', now: () => NOW, alive: () => true, tmp, pid: 4242, mtime: () => AFTER_START, logRun: (row) => rows.push(row),
    catalog: catalogOf([SOL, OPUS]), capacity: capacityOf(0.5, 0.5), token: () => 'a'.repeat(48),
    launch: () => ({ ok: true, id: 'claude-code', shortName: 'claude', spec: { bin: '/fake/claude' }, adapter: claude }),
    billingRoute: () => ({ billing: 'plan' }),
    checkout: ({ dir: into }) => { writeFileSync(join(into, 'README.md'), 'origin/main'); return { ok: true }; },
    session: async () => DONE,
  };
  return { root, tmp, baseEnv, rows, deps };
}

function programmeSetup(t) {
  const shared = baseSetup(t);
  const dir = join(shared.root, 'programs', 'p');
  mkdirSync(dir, { recursive: true });
  const page = recordPageTemplate().replace(/^Repositories:.*$/mu, 'Repositories: memoro-cli, memoro.');
  writeFileSync(join(dir, 'README.md'), page);
  writeRecord(dir, newRecord({ end: 'The promised result runs.', createdBy: 'manager', now: NOW }));
  const env = { ...shared.baseEnv, MC_ROLE: 'manager', MC_PROGRAMME: 'p', MC_HEADLESS: '1', MC_SESSION_STARTED: 'old', MC_SCRATCH: '/old/scratch' };
  const known = ['/known/memoro-cli.git', '/known/memoro'];
  const checkout = join(shared.tmp, 'mc-programme-review-p-fixture');
  const deps = { ...shared.deps, checkout: ({ repos, dir: into }) => {
    assert.deepEqual(repos, [{ repo: 'memoro-cli', path: known[0] }, { repo: 'memoro', path: known[1] }]);
    for (const { repo } of repos) {
      mkdirSync(join(into, repo));
      writeFileSync(join(into, repo, 'main.txt'), `origin/main of ${repo}`);
    }
    return { ok: true };
  } };
  const call = async (argv = ['review', 'p'], { identity = env, extra = {}, lock = (_root, fn) => fn() } = {}) => {
    const stdout = sink(), stderr = sink();
    const code = await programs(argv, { env: identity, stdout, stderr, known: () => known, lock, now: () => NOW, review: { ...deps, ...extra } });
    return { code, out: stdout.text(), err: stderr.text() };
  };
  const files = () => Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), 'utf8')]));
  const reads = (before = () => {}) => async (spawned) => {
    await before(spawned);
    writeFileSync(join(dir, PROGRAMME_REVIEW_FILE), 'findings: 0\n\nNo findings.\n');
    return DONE;
  };
  return { ...shared, dir, page, env, checkout, deps, call, reads, files,
    martin: { ...env, MC_ROLE: 'martin', MC_HEADLESS: undefined, MC_GOAL: undefined } };
}

test('programme review: real command launches its own identity on named origin/main exports, and writes review file', async (t) => {
  const f = programmeSetup(t);
  const result = await f.call(['review', 'p'], { extra: { session: f.reads((spawned) => {
    assert.equal(spawned.timeoutMs, 30 * 60_000);
    assert.equal(spawned.timeoutMs, PROGRAMME_REVIEW_LIMIT_MS);
    assert.equal(spawned.cwd, f.dir);
    assert.deepEqual([spawned.env.MC_ROLE, spawned.env.MC_PROGRAMME, spawned.env.MC_HEADLESS], ['programme-review', 'p', '1']);
    for (const key of ['MC_GOAL', 'MC_STEP', 'MC_PROJECT', 'MC_REPO', 'MC_SESSION_STARTED', 'MC_SCRATCH']) assert.equal(spawned.env[key], undefined, key);
    assert.equal(spawned.env.MC_PROGRAMME_REVIEW_TOKEN, 'a'.repeat(48));
    assert.deepEqual([spawned.env.MC_TOOL, spawned.env.MC_MODEL], ['codex', 'gpt-6.1-sol'], 'shared author exclusion');
    assert.ok(spawned.args.includes('--add-dir') && spawned.args.includes(f.checkout));
    const prompt = JSON.stringify(spawned.args);
    for (const repo of ['memoro-cli', 'memoro']) {
      assert.ok(prompt.includes(join(f.checkout, repo)));
      assert.equal(readFileSync(join(f.checkout, repo, 'main.txt'), 'utf8'), `origin/main of ${repo}`);
    }
    assert.ok(prompt.includes('README.md follows:'));
    assert.ok(Object.values(f.files()).every((text) => !text.includes(spawned.env.MC_PROGRAMME_REVIEW_TOKEN)), 'no raw token persisted');
  }) } });
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(`review written — ${join(f.dir, PROGRAMME_REVIEW_FILE)}`));
  assert.deepEqual(Object.keys(f.files()).sort(), ['PROGRAMME-REVIEW.md', 'PROGRAMME.json', 'README.md'].sort(), 'no .programme-review.json or desk item');
  assert.equal(existsSync(f.checkout), false);
  assert.deepEqual(f.rows.map(({ kind, name, cls }) => [kind, name, cls]), [['programme-review', 'programme:p', 'review']]);
});

test('programme review: caller authority and repository declarations refuse before launch or effects', async (t) => {
  for (const identity of [
    { MC_ROLE: 'build-session:goal' }, { MC_ROLE: 'review-session:goal' }, { MC_ROLE: 'mend-session' },
    { MC_ROLE: 'desk-prepare' }, { MC_ROLE: 'decision' }, { MC_ROLE: 'programme-review' },
    { MC_ROLE: 'martin', MC_HEADLESS: '1' }, { MC_ROLE: 'plan', MC_HEADLESS: '1' },
    { MC_ROLE: 'plan', MC_HEADLESS: undefined, MC_GOAL: 'p/g' },
  ]) {
    const f = programmeSetup(t), before = f.files();
    const result = await f.call(['review', 'p'], { identity: { ...f.env, ...identity }, extra: { session: f.reads() } });
    assert.equal(result.code, 2, JSON.stringify(identity));
    assert.deepEqual(f.files(), before);
    assert.deepEqual(readdirSync(f.tmp), []);
  }
  for (const identity of [
    { MC_ROLE: 'manager', MC_HEADLESS: '1' }, { MC_ROLE: 'martin' }, { MC_ROLE: 'plan' }, { MC_ROLE: undefined },
  ]) {
    const f = programmeSetup(t);
    assert.equal((await f.call(['review', 'p'], { identity: { ...f.env, MC_HEADLESS: undefined, MC_GOAL: undefined, ...identity }, extra: { session: f.reads() } })).code, 0);
  }
  for (const line of ['', 'Repositories:', 'Repositories: /private/repository', 'Repositories: unknown.']) {
    const f = programmeSetup(t);
    writeFileSync(join(f.dir, 'README.md'), f.page.replace(/^Repositories:.*$/mu, line));
    const before = f.files();
    const result = await f.call(['review', 'p'], { extra: { session: () => assert.fail('invalid repositories launched') } });
    assert.equal(result.code, 2, line);
    assert.match(result.err, /Repositories:/u);
    assert.deepEqual(f.files(), before);
  }
});

test('programme review: session that ends without writing report exits 1', async (t) => {
  const f = programmeSetup(t);
  const result = await f.call(['review', 'p'], { extra: { session: async () => DONE } });
  assert.equal(result.code, 1);
  assert.match(result.err, /no reading stored — the session ended without writing PROGRAMME-REVIEW.md/u);
});

test('programme review: timeout or unavailable routing exits 2', async (t) => {
  for (const condition of ['timeout', 'export', 'route']) {
    const f = programmeSetup(t);
    const extra = {
      timeout: { session: async () => ({ ...DONE, status: TIMEOUT_EXIT, timedOut: true }) },
      export: { checkout: () => ({ ok: false, reason: 'export failed' }) },
      route: { route: () => ({ ok: false, reason: 'no capacity' }) },
    }[condition];
    const result = await f.call(['review', 'p'], { extra });
    assert.equal(result.code, 2, condition);
    if (condition === 'timeout') assert.match(result.err, /thirty minutes/u);
  }
});

test('programme review: verdict subcommand and sign exit 2', async (t) => {
  const f = programmeSetup(t);
  const verdictRes = await f.call(['review', 'p', 'verdict', 'ok']);
  assert.equal(verdictRes.code, 2);
  const signRes = await f.call(['sign', 'p']);
  assert.equal(signRes.code, 2);
});

test('programme review: completion rechecks README inside the strict metadata lock', async (t) => {
  const f = programmeSetup(t);
  const result = await f.call(['review', 'p'], {
    extra: { session: f.reads(() => {
      writeFileSync(join(f.dir, 'README.md'), f.page + '\nconcurrent edit\n');
    }) },
  });
  assert.equal(result.code, 2);
  assert.match(result.err, /README.md changed during the reading/u);
  assert.equal(f.rows.at(-1).kind, 'programme-review', 'failed storage still records the completed provider run');
});

test('mc ask is refused from a programme-review session before jev or writes', async () => {
  const stderr = sink(), stdout = sink();
  const code = await ask(['--reason', 'May I?', '--option', 'a: yes', '--option', 'b: no', '--recommend', 'a'], {
    env: { MC_ROLE: 'programme-review', MC_PROGRAMME: 'p', MC_HEADLESS: '1' }, stdout, stderr,
    readKeys: () => assert.fail('read credentials'), jev: { transport: () => assert.fail('asked jev') },
  });
  assert.equal(code, 2);
  assert.match(stderr.text(), /programme-review session cannot ask or decide/u);
  assert.equal(stdout.text(), '');
});
