/**
 * Programme review (src/mc/programme-review.js): `mc programs review` launches
 * one independent headless reading of the programme document at origin/main exports,
 * and `mc programs sign` verifies the reading before Martin can sign.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as claude from '../../src/adapters/claude-code.js';
import { run as ask } from '../../src/mc/commands/ask.js';
import { run as programs } from '../../src/mc/commands/programs.js';
import { newRecord, recordPageTemplate, writeRecord } from '../../src/mc/programme-record.js';
import { readTextOrNull } from '../../src/mc/goals.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { applyObservation, normaliseCapacity } from '../../src/mc/model-capacity.js';
import {
  PROGRAMME_REVIEW_FILE, PROGRAMME_REVIEW_RECORD, PROGRAMME_REVIEW_LAUNCH, PROGRAMME_REVIEW_LIMIT_MS,
} from '../../src/mc/programme-review.js';
import { TIMEOUT_EXIT } from '../../src/mc/run-plan.js';

const FILE_BOOT_MS = performance.now();
let reportedBoot = false;

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
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
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
  const setupStart = performance.now();
  if (!reportedBoot) { t.diagnostic(`programme-review file process startup through imports: ${FILE_BOOT_MS.toFixed(3)} ms`); reportedBoot = true; }
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
  const verdicts = [];
  const reads = (word, before = () => {}) => async (spawned) => {
    await before(spawned);
    writeFileSync(join(dir, PROGRAMME_REVIEW_FILE), `${word === 'ok' ? 'OK' : 'NOT OK'}\nfindings: 2\n\nPart 1, Solution: evidence and narrow fix.\n`);
    const result = await call(['review', 'p', 'verdict', word], { identity: spawned.env });
    verdicts.push(result);
    assert.equal(result.code, 0, result.err);
    return DONE;
  };
  const meta = () => JSON.parse(readTextOrNull(join(dir, PROGRAMME_REVIEW_RECORD)) ?? 'null');
  t.diagnostic(`programme fixture setup: ${(performance.now() - setupStart).toFixed(3)} ms`);
  return { ...shared, dir, page, env, checkout, deps, call, reads, files, meta, verdicts,
    martin: { ...env, MC_ROLE: 'martin', MC_HEADLESS: undefined, MC_GOAL: undefined } };
}

test('programme review: real command launches its own identity on named origin/main exports, records both verdicts and permits a third reading', async (t) => {
  const f = programmeSetup(t);
  for (const word of ['ok', 'not-ok', 'ok']) {
    const result = await f.call(['review', 'p'], { extra: { session: f.reads(word, (spawned) => {
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
      assert.ok(prompt.includes('playback and basis'));
      assert.ok(Object.values(f.files()).every((text) => !text.includes(spawned.env.MC_PROGRAMME_REVIEW_TOKEN)), 'no raw token persisted');
    }) } });
    assert.equal(result.code, word === 'ok' ? 0 : 1, result.err);
    assert.ok(result.out.includes(join(f.dir, PROGRAMME_REVIEW_FILE)));
    assert.ok(result.out.includes(word === 'ok' ? 'OK' : 'NOT OK'));
    assert.deepEqual([f.meta().verdict, f.meta().findings, f.meta().hash, f.meta().at], [word, 2, sha256(f.page), NOW.toISOString()]);
    assert.equal(f.meta().report_sha256, sha256(readFileSync(join(f.dir, PROGRAMME_REVIEW_FILE))));
    assert.deepEqual(Object.keys(f.files()).sort(), [PROGRAMME_REVIEW_RECORD, 'PROGRAMME-REVIEW.md', 'PROGRAMME.json', 'README.md'].sort(), 'no launch or desk item');
    assert.equal(existsSync(f.checkout), false);
  }
  assert.deepEqual(f.rows.map(({ kind, name, cls }) => [kind, name, cls]), Array(3).fill(['programme-review', 'programme:p', 'review']));
});

test('programme review: caller authority and repository declarations refuse before launch or effects', async (t) => {
  for (const identity of [
    { MC_ROLE: 'build-session:goal' }, { MC_ROLE: 'review-session:goal' }, { MC_ROLE: 'mend-session' },
    { MC_ROLE: 'desk-prepare' }, { MC_ROLE: 'decision' }, { MC_ROLE: 'programme-review' },
    { MC_ROLE: 'martin', MC_HEADLESS: '1' }, { MC_ROLE: 'plan', MC_HEADLESS: '1' },
    { MC_ROLE: 'plan', MC_HEADLESS: undefined, MC_GOAL: 'p/g' },
  ]) {
    const f = programmeSetup(t), before = f.files();
    const result = await f.call(['review', 'p'], { identity: { ...f.env, ...identity }, extra: { session: f.reads('ok') } });
    assert.equal(result.code, 2, JSON.stringify(identity));
    assert.deepEqual(f.files(), before);
    assert.deepEqual(readdirSync(f.tmp), []);
  }
  for (const identity of [
    { MC_ROLE: 'manager', MC_HEADLESS: '1' }, { MC_ROLE: 'martin' }, { MC_ROLE: 'plan' }, { MC_ROLE: undefined },
  ]) {
    const f = programmeSetup(t);
    assert.equal((await f.call(['review', 'p'], { identity: { ...f.env, MC_HEADLESS: undefined, MC_GOAL: undefined, ...identity }, extra: { session: f.reads('ok') } })).code, 0);
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

test('programme review: missing verdict, timeout (even after a verdict), failed export or unavailable routing exit 2 without current metadata', async (t) => {
  for (const condition of ['no verdict', 'timeout', 'timeout after verdict', 'export', 'route', 'adapter', 'billing']) {
    const f = programmeSetup(t);
    const extra = {
      'no verdict': { session: async () => DONE },
      timeout: { session: async () => ({ ...DONE, status: TIMEOUT_EXIT, timedOut: true }) },
      'timeout after verdict': { session: async (spawned) => { await f.reads('ok')(spawned); return { ...DONE, timedOut: true, status: TIMEOUT_EXIT }; } },
      export: { checkout: () => ({ ok: false, reason: 'export failed' }) },
      route: { route: () => ({ ok: false, reason: 'no capacity' }) },
      adapter: { launch: () => ({ ok: false, reason: 'no adapter' }) },
      billing: { billingRoute: () => ({ billing: 'unavailable', why: 'no billing' }) },
    }[condition];
    const result = await f.call(['review', 'p'], { extra });
    assert.equal(result.code, 2, `${condition}: ${result.err}`);
    assert.equal(f.meta(), null, condition);
    assert.equal(existsSync(join(f.dir, PROGRAMME_REVIEW_LAUNCH)), false);
    assert.equal(existsSync(f.checkout), false);
    if (condition.includes('timeout')) assert.match(result.err, /thirty minutes/u);
  }
});

test('programme review: each forged role, programme, token, launch, report or expired/dead call refuses the real verdict handler', async (t) => {
  const cases = ['role', 'programme', 'token absent', 'token wrong', 'token hash', 'launch role', 'launch binding', 'launch dead', 'expired', 'future', 'report absent', 'report old', 'report verdict', 'report findings', 'changed README'];
  for (const fault of cases) {
    const f = programmeSetup(t);
    let observed;
    const result = await f.call(['review', 'p'], { extra: { session: async (spawned) => {
      let identity = { ...spawned.env };
      let extra = {};
      const launchPath = join(f.dir, PROGRAMME_REVIEW_LAUNCH);
      const launch = JSON.parse(readFileSync(launchPath, 'utf8'));
      writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'OK\nfindings: 0\n');
      if (fault === 'role') identity.MC_ROLE = 'build-session:goal';
      if (fault === 'programme') identity.MC_PROGRAMME = 'other';
      if (fault === 'token absent') delete identity.MC_PROGRAMME_REVIEW_TOKEN;
      if (fault === 'token wrong') identity.MC_PROGRAMME_REVIEW_TOKEN = 'wrong';
      if (fault === 'token hash') identity.MC_PROGRAMME_REVIEW_TOKEN = launch.token_sha256;
      if (fault === 'launch role') writeFileSync(launchPath, JSON.stringify({ ...launch, role: 'build-session:goal' }));
      if (fault === 'launch binding') writeFileSync(launchPath, JSON.stringify({ ...launch, binding: 'other' }));
      if (fault === 'launch dead') extra.alive = () => false;
      if (fault === 'expired') extra.now = () => new Date(NOW.getTime() + PROGRAMME_REVIEW_LIMIT_MS);
      if (fault === 'future') extra.now = () => new Date(NOW.getTime() - 1);
      if (fault === 'report absent') unlinkSync(join(f.dir, PROGRAMME_REVIEW_FILE));
      if (fault === 'report old') extra.mtime = () => NOW.getTime() - 1;
      if (fault === 'report verdict') writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'NOT OK\nfindings: 0\n');
      if (fault === 'report findings') writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'OK\n\nno count\n');
      if (fault === 'changed README') writeFileSync(join(f.dir, 'README.md'), f.page + '\nchanged\n');
      const before = readFileSync(launchPath, 'utf8');
      const verdict = await f.call(['review', 'p', 'verdict', 'ok'], { identity, extra });
      observed = { verdict, before, after: readFileSync(launchPath, 'utf8') };
      return DONE;
    } } });
    assert.ok(observed, `${fault}: verdict handler was reached`);
    assert.equal(observed.verdict.code, 2, `${fault}: ${observed.verdict.err}`);
    assert.equal(observed.after, observed.before, `${fault}: no verdict write`);
    assert.equal(result.code, 2, fault);
    assert.equal(f.meta(), null, fault);
    const late = await f.call(['review', 'p', 'verdict', 'ok'], { identity: { ...f.env, MC_ROLE: 'programme-review', MC_PROGRAMME: 'p', MC_PROGRAMME_REVIEW_TOKEN: 'a'.repeat(48) } });
    assert.equal(late.code, 2, 'ended launch cannot answer');
  }
});

test('programme review: a valid verdict cannot persist changed README, changed report, or replaced launch; cleanup preserves an unowned export', async (t) => {
  for (const fault of ['README', 'report', 'launch', 'export']) {
    const f = programmeSetup(t);
    const result = await f.call(['review', 'p'], { extra: { session: async (spawned) => {
      await f.reads('ok')(spawned);
      if (fault === 'README') writeFileSync(join(f.dir, 'README.md'), f.page + '\nchanged after verdict\n');
      if (fault === 'report') writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'OK\nfindings: 999\nreplacement\n');
      if (fault === 'launch') {
        const path = join(f.dir, PROGRAMME_REVIEW_LAUNCH);
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), token_sha256: sha256('other') }));
      }
      if (fault === 'export') {
        renameSync(f.checkout, f.checkout + '-original');
        mkdirSync(f.checkout);
        writeFileSync(join(f.checkout, 'keep'), 'not ours');
      }
      return DONE;
    } } });
    assert.deepEqual(f.verdicts.map(({ code }) => code), [0], `${fault}: the prior verdict really was valid`);
    assert.equal(result.code, 2, `${fault}: ${result.err}`);
    assert.equal(f.meta(), null, fault);
    if (fault === 'export') {
      assert.match(result.err, /left in place.*identity/u);
      assert.equal(readFileSync(join(f.checkout, 'keep'), 'utf8'), 'not ours');
    }
  }
});

test('programme sign: no reading never signs, a reading of an earlier text signs at the desk and is logged, NOT OK requires a logged reason, and OK signs exact bytes', async (t) => {
  for (const condition of ['none', 'stale', 'not-ok', 'ok', 'changed report']) {
    const f = programmeSetup(t);
    if (condition !== 'none') {
      const word = condition === 'not-ok' ? 'not-ok' : 'ok';
      assert.equal((await f.call(['review', 'p'], { extra: { session: f.reads(word) } })).code, word === 'ok' ? 0 : 1);
    }
    if (condition === 'stale') writeFileSync(join(f.dir, 'README.md'), f.page + '\nnew text\n');
    if (condition === 'changed report') writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'OK\nfindings: 2\nnot the recorded reading\n');
    const before = f.files();
    const signed = await f.call(['sign', 'p'], { identity: f.martin });
    assert.equal(signed.code, ['ok', 'stale'].includes(condition) ? 0 : 1, `${condition}: ${signed.err}`);
    if (condition === 'stale') assert.match(readFileSync(join(f.dir, 'LOG.md'), 'utf8'), /the reading read an earlier text; the edits since were made at the desk/u);
    if (['ok', 'stale'].includes(condition)) {
      const record = JSON.parse(readFileSync(join(f.dir, 'PROGRAMME.json'), 'utf8'));
      assert.equal(record.state, 'open');
      assert.equal(record.signed_by, 'martin');
      assert.equal(record.signed_text, sha256(readFileSync(join(f.dir, 'SIGNED.md'))));
      assert.ok(readFileSync(join(f.dir, 'SIGNED.md'), 'utf8').startsWith(f.page));
    } else {
      assert.deepEqual(f.files(), before, `${condition}: no signature or other effects`);
      const override = await f.call(['sign', 'p', '--reason', 'Explicitly accepted the findings'], { identity: f.martin });
      assert.equal(override.code, condition === 'not-ok' ? 0 : 1, `${condition}: ${override.err}`);
      if (condition === 'not-ok') assert.match(readFileSync(join(f.dir, 'LOG.md'), 'utf8'), /martin · signed — Explicitly accepted the findings/u);
      else {
        assert.match(override.err, /has no reading — mc programs review p/u);
        assert.deepEqual(f.files(), before, 'reason cannot invent a current reading');
      }
    }
  }
});

test('programme review: completion rechecks README inside the strict metadata lock', async (t) => {
  const f = programmeSetup(t);
  const locks = [];
  const result = await f.call(['review', 'p'], {
    lock: (root, fn, options) => {
      assert.equal(root, f.root);
      assert.equal(options.strict, true);
      locks.push(options.name);
      if (options.name === 'programme-review-store') writeFileSync(join(f.dir, 'README.md'), f.page + '\nconcurrent edit\n');
      return fn();
    },
    extra: { session: f.reads('ok') },
  });
  assert.equal(result.code, 2);
  assert.match(result.err, /README.md changed during the reading/u);
  assert.deepEqual(locks, ['programme-review-claim', 'programme-review-store']);
  assert.equal(f.meta(), null);
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
