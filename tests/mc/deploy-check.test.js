/**
 * The check after a deploy (src/mc/deploy-check.js): the verdict a set of parts
 * adds up to, the error comparison, the orchestration with every boundary
 * faked, the detached entry's headless refusal and the runner's chore.
 *
 * Nothing here reaches production, a network or a real clock: fetch, the suite
 * round, the survey script, the holder, the checkout and the clock are passed
 * in. The only process this file starts is `deploy-check-run.js` with
 * MC_HEADLESS=1, which exits before it does anything — and the survey tests'
 * "script", a few lines of node, in a temporary directory.
 *
 * Time: the two entry tests start a node process each (0.1–0.3 s); the other
 * 42 are in-process and in milliseconds, so the file stays near the gate's
 * start-up cost and is not a candidate for the 1 s indicator.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  BEFORE_WINDOW_MS, CHECK_RUN, COULD_NOT_RUN, GREEN, RED, SETTLE_MS, SURVEY_SCRIPT,
  attemptDeadline, attemptInFlight, ask, beforePath, checkCells, checkDatabase, checkWords, combine, deployCheckTick,
  executeCheck, startReactionDefault, judgeErrors, judgeSuites, judgeVersion, parseSurvey, readBeforeFile, readSurvey, readStored,
  gatedByTip, readVerdictFile, readVersion, runCheck, statePath, storedTime, takeBeforeReading, verdictPath, writeVerdictFile,
} from '../../src/mc/deploy-check.js';
import {
  DEPLOYS_HEADER, DEPLOYED, deploysPath, readDeploys, recordEnd, recordStart,
} from '../../src/mc/deploys.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const STARTED = '2026-11-15T12:00:00.000Z';
const ENDED = '2026-11-15T12:02:00.000Z';
const BASE = 'https://prod.example';

const DECLARATION = {
  schema_version: 1,
  suites: [{ name: 'smoke', argv: ['node', 'smoke.js'] }, { name: 'api', argv: ['node', 'api.js'] }, { name: 'slow', argv: ['x'], gate: false, gate_why: 'flaky' }],
  environments: { prod: { base_url: `${BASE}/` } },
};

const part = (name, verdict, why = '') => ({ part: name, verdict, why });
const ALL_GREEN = [part('version', GREEN), part('database', GREEN), part('suites', GREEN), part('errors', GREEN)];

function workRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mc-deploy-check-test-'));
  mkdirSync(join(root, 'runner', 'log'), { recursive: true });
  writeFileSync(join(root, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }));
  return { root, env: { MC_WORK_ROOT: root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A deployed row in deploys.tsv, written through the writers. */
function deployed(env, { started = STARTED, sha = SHA, ended = ENDED } = {}) {
  const key = recordStart({ sha, started, pid: 1 }, env);
  recordEnd(key, { ended, outcome: DEPLOYED, live_commit: sha.slice(0, 7) }, env);
  return readDeploys(env).findLast((row) => row.started === started && row.sha === sha);
}

/** A fetch that answers by the url's path, the way production would. */
function fetchOf(answers) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push(url);
    const answer = typeof answers === 'function' ? answers(url, calls.length) : answers[new URL(url).pathname];
    if (typeof answer === 'function') return answer(options);
    return { status: answer.status ?? 200, text: async () => answer.body ?? '' };
  };
  fn.calls = calls;
  return fn;
}
const json = (value, status = 200) => ({ status, body: JSON.stringify(value) });
const HEALTHY = { '/api/version': json({ commit: SHA.slice(0, 7), commit_full: SHA }), '/ping-d1': json({ d1: 'healthy' }) };

/** The clock the orchestration reads, moved only by `sleep`. */
function clock(at = Date.parse(ENDED)) {
  const state = { t: at, slept: [] };
  return { state, now: () => state.t, sleep: async (ms) => { state.slept.push(ms); state.t += ms; } };
}

const survey = (fingerprints, { total = fingerprints.length, returned = fingerprints.length } = {}) => ({
  ok: true, survey: { total, returned, fingerprints },
});
const print = (fingerprint, firstSeen, message = 'boom') => ({ fingerprint, firstSeen, message });

/* -------------------------------------------------------------- criterion 1 */

test('combine: green is only every part present and green', () => {
  const green = combine(ALL_GREEN, { at: new Date('2026-11-15T13:00:00Z') });
  assert.deepEqual([green.check, green.check_why, green.check_at], [GREEN, '', '2026-11-15T13:00:00.000Z']);
});

test('combine: a part that is missing, skipped, unmeasured or unanswered is never green', () => {
  const cases = [
    ['a missing part', ALL_GREEN.slice(0, 3), 'errors: not run'],
    ['a skipped suite', [...ALL_GREEN.slice(0, 2), part('suites', COULD_NOT_RUN, 'smoke skipped (no seeded account)'), ALL_GREEN[3]], 'suites: smoke skipped (no seeded account)'],
    ['an unmeasured suite', [...ALL_GREEN.slice(0, 2), part('suites', COULD_NOT_RUN, 'api unmeasured — production stopped answering while it ran'), ALL_GREEN[3]], 'suites: api unmeasured — production stopped answering while it ran'],
    ['a missing answer', [part('version', COULD_NOT_RUN, '/api/version: no answer'), ...ALL_GREEN.slice(1)], 'version: /api/version: no answer'],
    ['another commit', [part('version', COULD_NOT_RUN, 'production is at fedcba9, not 0123456'), ...ALL_GREEN.slice(1)], 'version: production is at fedcba9, not 0123456'],
    ['no part at all', [], 'version: not run; database: not run; suites: not run; errors: not run'],
    ['a part with no verdict', [{ part: 'errors' }, ...ALL_GREEN.slice(0, 3)], 'errors: undefined'],
  ];
  for (const [what, parts, why] of cases) {
    const verdict = combine(parts);
    assert.equal(verdict.check, COULD_NOT_RUN, what);
    if (what !== 'a part with no verdict') assert.equal(verdict.check_why, why, what);
  }
});

test('combine: red beats could-not-run, and the reason names every part that is not green', () => {
  const verdict = combine([
    part('version', COULD_NOT_RUN, 'v'),
    part('database', RED, '/ping-d1 answered 503'),
    part('suites', GREEN),
    part('errors', COULD_NOT_RUN, 'e'),
  ]);
  assert.equal(verdict.check, RED);
  assert.equal(verdict.check_why, 'version: v; database: /ping-d1 answered 503; errors: e');
  assert.equal(combine([part('database', RED, 'd')], { required: ['database'] }).check, RED);
});

test('the words every place says a verdict in', () => {
  assert.equal(checkWords({ check: GREEN }), 'checked green');
  assert.equal(checkWords({ check: RED, check_why: 'suites: smoke red' }), 'check red: suites: smoke red');
  assert.equal(checkWords({ check: COULD_NOT_RUN, check_why: 'x' }), 'check could not run: x');
  assert.equal(checkWords({ check: COULD_NOT_RUN }), 'check could not run');
  assert.equal(checkWords({ check: '' }), 'not checked');
  assert.equal(checkWords({}, { checking: true }), 'checking');
  assert.equal(checkWords({ check: GREEN }, { checking: true }), 'checked green', 'a verdict beats a live attempt');
});

/* ------------------------------------------------------------------- parts */

test('version: commit_full when the answer has it, commit by the shorter-length rule when it does not', async () => {
  const read = async (body) => readVersion(BASE, { fetchImpl: fetchOf({ '/api/version': json(body) }) });
  assert.equal(judgeVersion(await read({ commit: SHA.slice(0, 7), commit_full: SHA }), SHA).verdict, GREEN);
  assert.equal(judgeVersion(await read({ commit: SHA.slice(0, 7) }), SHA).verdict, GREEN, 'seven characters of the row');
  // A short commit that agrees with the row's first seven characters but a full one that does not.
  const mismatch = judgeVersion(await read({ commit: SHA.slice(0, 7), commit_full: OTHER }), SHA);
  assert.equal(mismatch.verdict, COULD_NOT_RUN);
  assert.match(mismatch.why, /production is at fedcba987654, not 0123456/u);
  assert.equal(judgeVersion(await read({ commit: OTHER.slice(0, 7) }), SHA).verdict, COULD_NOT_RUN);
  const second = judgeVersion(await read({ commit: OTHER.slice(0, 7) }), SHA, { second: true });
  assert.match(second.why, /production changed during the check/u);
});

test('version: a bad answer is red or could-not-run with its words, never green', async () => {
  const read = (answer) => readVersion(BASE, { fetchImpl: fetchOf({ '/api/version': answer }) });
  assert.deepEqual(judgeVersion(await read({ status: 500 }), SHA), part('version', RED, '/api/version answered 500'));
  assert.equal(judgeVersion(await read(json({})), SHA).verdict, COULD_NOT_RUN);
  assert.equal(judgeVersion(await read({ body: 'not json' }), SHA).verdict, COULD_NOT_RUN);
  const refused = await readVersion(BASE, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(judgeVersion(refused, SHA).why, '/api/version: ECONNREFUSED');
  assert.equal(judgeVersion(refused, SHA, { second: true }).why, 'second read: /api/version: ECONNREFUSED');
});

test('database: only d1 "healthy" on a 2xx is green', async () => {
  const check = (answer) => checkDatabase(BASE, { fetchImpl: fetchOf({ '/ping-d1': answer }) });
  assert.equal((await check(json({ d1: 'healthy' }))).verdict, GREEN);
  assert.equal((await check(json({ d1: 'degraded' }))).why, '/ping-d1 says d1 is "degraded"');
  assert.equal((await check(json({}))).why, '/ping-d1 says d1 is not given');
  assert.deepEqual(await check({ status: 503, body: '{"d1":"healthy"}' }), part('database', RED, '/ping-d1 answered 503'));
});

test('every request is bounded at its timeout, and a fetch that ignores its signal is given up on', async () => {
  let aborted = false;
  const hangs = (url, options) => new Promise((_, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); });
  const answer = await ask(`${BASE}/ping-d1`, { fetchImpl: hangs, timeoutMs: 20 });
  assert.match(answer.failed, /no answer, with its body, in 0 s/u);
  assert.equal(aborted, true);
  const deaf = await ask(`${BASE}/ping-d1`, { fetchImpl: () => new Promise(() => {}), timeoutMs: 20 });
  assert.ok(deaf.failed);
  const slowBody = await ask(`${BASE}/ping-d1`, { fetchImpl: async () => ({ status: 200, text: () => new Promise(() => {}) }), timeoutMs: 20 });
  assert.ok(slowBody.failed, 'the body is inside the bound too');
  const check = await checkDatabase(BASE, { fetchImpl: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(check.verdict, COULD_NOT_RUN);
  assert.match(check.why, /^\/ping-d1: no answer/u);
});

test('suites: red is a failed gating suite; skipped, unmeasured and never-run are could-not-run, none is not green', () => {
  const ok = (name) => ({ name, ok: true, status: 0 });
  assert.equal(judgeSuites({ results: [ok('smoke'), ok('api')] }, { names: ['smoke', 'api'] }).verdict, GREEN);
  const red = judgeSuites({ results: [ok('smoke'), { name: 'api', ok: false, status: 1 }] }, { names: ['smoke', 'api'] });
  assert.deepEqual(red, part('suites', RED, 'api (exit 1) red'));
  const skipped = judgeSuites({ results: [{ name: 'smoke', ok: false, skipped: true, status: 77 }, ok('api')], account: { available: false, why: 'no seeded account' } });
  assert.deepEqual(skipped, part('suites', COULD_NOT_RUN, 'smoke skipped (no seeded account)'));
  assert.match(judgeSuites({ results: [{ name: 'api', ok: false, unmeasured: true }] }).why, /api unmeasured/u);
  assert.match(judgeSuites({ results: [ok('smoke')], skipped: ['api'] }).why, /api never ran/u);
  assert.match(judgeSuites({ results: [ok('smoke')], gone: [{}] }).why, /production stopped answering during the round/u);
  assert.equal(judgeSuites({ results: [] }, { names: ['smoke'] }).why, 'no gating suite ran');
  assert.equal(judgeSuites({ results: [ok('smoke')] }, { names: ['smoke', 'api'] }).why, 'only 1 of 2 gating suites ran');
  assert.equal(judgeSuites(null).verdict, COULD_NOT_RUN);
});

/* -------------------------------------------------------------- criterion 2 */

test('stored time: UTC, YYYY-MM-DD HH:MM:SS, read back from either form', () => {
  assert.equal(storedTime(Date.parse(STARTED)), '2026-11-15 12:00:00');
  assert.equal(storedTime(Date.parse(STARTED) - BEFORE_WINDOW_MS), '2026-11-14 12:00:00');
  assert.equal(readStored('2026-11-15 12:05:00'), Date.parse('2026-11-15T12:05:00Z'));
  assert.equal(readStored('2026-11-15T12:05:00.250Z'), Date.parse('2026-11-15T12:05:00.250Z'));
  assert.ok(Number.isNaN(readStored('yesterday')));
  assert.ok(Number.isNaN(readStored(null)));
});

test('errors: a fingerprint first seen at or after the deploy began is red, also in the same second', () => {
  const before = survey([print('old', '2026-11-10 08:00:00')]);
  const at = (firstSeen) => judgeErrors({
    before, after: survey([print('old', '2026-11-10 08:00:00'), print('fresh', firstSeen, 'TypeError: x is not a function')]), started: STARTED,
  });
  const red = at('2026-11-15 12:05:00');
  assert.equal(red.verdict, RED);
  assert.equal(red.why, '1 fingerprint new since the deploy: fresh "TypeError: x is not a function"');
  assert.equal(at('2026-11-15 12:00:00').verdict, RED, 'the second the deploy began');
  assert.equal(judgeErrors({ before, after: survey([print('old', '2026-11-10 08:00:00')]), started: '2026-11-15T12:00:00.900Z' }).verdict, GREEN);
  assert.equal(at('2026-11-15 11:59:59').verdict, RED, 'absent from the complete before-reading: it returned');
});

test('errors: a fingerprint absent from a complete before-reading is red, "returned"', () => {
  const verdict = judgeErrors({
    before: survey([print('a', '2026-11-01 00:00:00')]),
    after: survey([print('a', '2026-11-01 00:00:00'), print('b', '2026-11-02 00:00:00', 'older than the deploy')]),
    started: STARTED,
  });
  assert.equal(verdict.verdict, RED);
  assert.equal(verdict.why, '1 fingerprint new since the deploy: b (returned) "older than the deploy"');
});

test('errors: the reason names at most five fingerprints with 80 characters of message', () => {
  const message = 'x'.repeat(200);
  const after = survey(Array.from({ length: 7 }, (_, i) => print(`f${i}`, '2026-11-15 12:30:00', message)));
  const verdict = judgeErrors({ before: survey([]), after, started: STARTED });
  assert.equal(verdict.verdict, RED);
  assert.match(verdict.why, /^7 fingerprints new since the deploy: /u);
  assert.equal([...verdict.why.matchAll(/ "x+"/gu)].length, 5);
  assert.ok(verdict.why.includes(`"${'x'.repeat(80)}"`));
  assert.ok(!verdict.why.includes('x'.repeat(81)));
  assert.ok(verdict.why.endsWith(', and 2 more'));
});

test('errors: a truncated, missing or unreadable reading is could-not-run, never green', () => {
  const clean = survey([print('a', '2026-11-01 00:00:00')]);
  const check = (before, after) => judgeErrors({ before, after, started: STARTED });
  assert.equal(check(clean, clean).verdict, GREEN);
  assert.match(check(survey([print('a', '2026-11-01 00:00:00')], { total: 300, returned: 200 }), clean).why, /before the deploy was truncated \(200 of 300/u);
  assert.match(check(clean, survey([print('a', '2026-11-01 00:00:00')], { total: 300, returned: 200 })).why, /after the deploy was truncated/u);
  assert.match(check({ ok: false, why: 'the reading before the deploy failed: boom' }, clean).why, /before the deploy failed: boom/u);
  assert.equal(check(clean, { ok: false, why: 'exited 1' }).why, 'the reading after the deploy failed: exited 1');
  assert.equal(check(clean, null).verdict, COULD_NOT_RUN);
  const known = survey([print('a', '2026-11-01 00:00:00'), print('a2', 'sometime')]);
  const unreadable = judgeErrors({ before: known, after: known, started: STARTED });
  assert.equal(unreadable.verdict, COULD_NOT_RUN);
  assert.match(unreadable.why, /1 fingerprint had a firstSeen that could not be read/u);
  assert.equal(check(null, clean).verdict, COULD_NOT_RUN);
});

test('errors: a red is found even when the other reading is truncated', () => {
  const after = survey([print('new', '2026-11-15 12:10:00')]);
  const truncated = survey([], { total: 500, returned: 200 });
  assert.equal(judgeErrors({ before: truncated, after, started: STARTED }).verdict, RED);
});

test('the survey output is read strictly: no count, no complete reading', () => {
  assert.deepEqual(parseSurvey('{"topFingerprints":[],"returnedFingerprints":0}').problem, 'the survey did not say how many fingerprints there are');
  assert.ok(parseSurvey('nope').problem);
  assert.ok(parseSurvey('{"totalFingerprints":1,"returnedFingerprints":1}').problem);
  const read = parseSurvey(JSON.stringify({
    totalFingerprints: 2, returnedFingerprints: 2,
    topFingerprints: [{ fingerprint: 'a', normalizedMessage: 'two\n  lines', firstSeen: '2026-11-15 12:00:00' }, { fingerprint: '' }],
  }));
  assert.deepEqual(read, { total: 2, returned: 2, fingerprints: [{ fingerprint: 'a', message: 'two lines', firstSeen: '2026-11-15 12:00:00' }] });
});

/** `exportTree` that writes a stand-in survey script, and a `run` that records its argv. */
function surveyBoundaries({ out = { code: 0, stdout: JSON.stringify({ totalFingerprints: 0, returnedFingerprints: 0, topFingerprints: [] }), stderr: '' }, exported = null } = {}) {
  const seen = { argv: [], cwd: [], exportArgs: [] };
  return {
    seen,
    exportTree: (path, sha, what, dir) => {
      seen.exportArgs.push([path, sha, what]);
      if (exported) return exported;
      mkdirSync(dirname(join(dir, SURVEY_SCRIPT)), { recursive: true });
      writeFileSync(join(dir, SURVEY_SCRIPT), '// stand-in');
      return null;
    },
    run: async (argv, { cwd }) => { seen.argv.push(argv); seen.cwd.push(cwd); return out; },
  };
}

test('both survey runs: production, since in the stored form, limit 200, no --repo, the written-out script as cwd', async () => {
  const { root, env, cleanup } = workRoot();
  try {
    const boundaries = surveyBoundaries();
    const before = await takeBeforeReading({
      path: '/repo.git', sha: SHA, started: STARTED, env, now: () => Date.parse(STARTED), exportTree: boundaries.exportTree, run: boundaries.run,
    });
    assert.equal(before.ok, true);
    assert.equal(before.since, '2026-11-14 12:00:00');
    const after = await readSurvey({ path: '/repo.git', sha: SHA, since: storedTime(Date.parse(STARTED)), exportTree: boundaries.exportTree, run: boundaries.run });
    assert.equal(after.ok, true);
    const [first, second] = boundaries.seen.argv;
    assert.deepEqual(first.slice(0, 1).concat(first.slice(2)), ['node', '--env', 'production', '--since', '2026-11-14 12:00:00', '--limit', '200']);
    assert.deepEqual(second.slice(2), ['--env', 'production', '--since', '2026-11-15 12:00:00', '--limit', '200']);
    for (const argv of boundaries.seen.argv) {
      assert.ok(!argv.includes('--repo'), 'the survey script takes no --repo');
      assert.ok(argv[1].endsWith(SURVEY_SCRIPT), 'the written-out scripts/ directory');
    }
    boundaries.seen.cwd.forEach((cwd, i) => {
      assert.ok(cwd.includes('mc-deploy-check-'), 'a directory of its own');
      assert.ok(boundaries.seen.argv[i][1].startsWith(cwd), 'the script is inside it');
    });
    assert.deepEqual(boundaries.seen.exportArgs[0], ['/repo.git', SHA, 'scripts']);
    assert.ok(readdirSync(tmpdir()).every((name) => !name.startsWith('mc-deploy-check-') || !existsSync(join(tmpdir(), name, 'scripts'))), 'the directory is removed afterwards');
    assert.deepEqual(readBeforeFile(env, STARTED), { ok: true, survey: { total: 0, returned: 0, fingerprints: [] } });
    assert.ok(root);
  } finally { cleanup(); }
});

test('the before-reading: a failing, hanging or missing script is noted in its file and throws nothing', async () => {
  const { env, cleanup } = workRoot();
  try {
    const cases = [
      ['exits 1', surveyBoundaries({ out: { code: 1, stdout: '', stderr: 'boom\n' } }), {}, /exited 1: boom/u],
      ['prints no count', surveyBoundaries({ out: { code: 0, stdout: '{}', stderr: '' } }), {}, /no topFingerprints/u],
      ['is not on the commit', surveyBoundaries({ exported: 'path not in tree' }), {}, /is not on 0123456 \(path not in tree\)/u],
      ['hangs', { ...surveyBoundaries(), run: () => new Promise(() => {}) }, { boundMs: 30 }, /did not finish in 0 s/u],
      ['throws', { ...surveyBoundaries(), run: async () => { throw new Error('spawn E2BIG'); } }, {}, /spawn E2BIG/u],
    ];
    for (const [what, boundaries, options, why] of cases) {
      const record = await takeBeforeReading({
        path: '/repo.git', sha: SHA, started: STARTED, env, exportTree: boundaries.exportTree, run: boundaries.run, ...options,
      });
      assert.equal(record.ok, false, what);
      assert.match(record.why, why, what);
      const file = JSON.parse(readFileSync(beforePath(env, STARTED), 'utf8'));
      assert.equal(file.ok, false, what);
      assert.match(file.why, why, what);
      assert.match(readBeforeFile(env, STARTED).why, /^the reading before the deploy failed: /u, what);
    }
    assert.deepEqual(readBeforeFile(env, 'never'), { ok: false, why: 'no reading was taken before the deploy' });
    writeFileSync(beforePath(env, 'torn'), '{');
    assert.match(readBeforeFile(env, 'torn').why, /not readable/u);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------- criterion 10 */

/** The boundaries of `runCheck`, every one faked, and what each was asked. */
function boundaries(overrides = {}) {
  const time = clock();
  const seen = { round: [], servers: [], placed: [], held: [], released: 0, survey: [], declared: [] };
  const deps = {
    now: time.now,
    sleep: time.sleep,
    fetch: fetchOf(HEALTHY),
    declare: (sha) => { seen.declared.push(sha); return { ok: true, declaration: DECLARATION }; },
    worktreePath: () => '/deploy/worktree',
    readBefore: () => survey([print('old', '2026-11-10 08:00:00')]),
    readAfter: async (since) => { seen.survey.push(since); return survey([print('old', '2026-11-10 08:00:00')]); },
    suites: {
      takeHolder: async (options) => { seen.held.push(options.verb); return { ok: true, release: () => { seen.released += 1; } }; },
      place: ({ worktree, sha }) => { seen.placed.push([worktree, sha]); return { ok: true }; },
      round: async (options) => { seen.round.push(options); return { results: [{ name: 'smoke', ok: true, status: 0 }, { name: 'api', ok: true, status: 0 }] }; },
      holderWaitMs: 0,
      worktreePath: () => '/deploy/worktree',
    },
    ...overrides,
  };
  return { deps, seen, time };
}

const ROW = { started: STARTED, sha: SHA, ended: ENDED };

test('runCheck: green asks version and database, runs the gating suites at the row, waits, asks again and reads the errors', async () => {
  const { deps, seen, time } = boundaries();
  const verdict = await runCheck({ row: ROW, env: {}, deps });
  assert.equal(verdict.check, GREEN, verdict.check_why);
  assert.equal(verdict.check_why, '');
  assert.deepEqual(verdict.parts.map((p) => p.part), ['version', 'database', 'suites', 'errors']);
  assert.deepEqual(deps.fetch.calls, [`${BASE}/api/version`, `${BASE}/ping-d1`, `${BASE}/api/version`]);
  // The base URL without its trailing slash, the gating suites only, at the row's sha, in the held worktree.
  assert.equal(seen.round.length, 1);
  assert.equal(seen.round[0].baseUrl, BASE);
  assert.equal(seen.round[0].gateOnly, true);
  assert.deepEqual(seen.round[0].declaration.suites.map((s) => s.name), ['smoke', 'api', 'slow']);
  assert.equal(seen.round[0].worktree, '/deploy/worktree');
  assert.deepEqual(seen.placed, [['/deploy/worktree', SHA]]);
  assert.deepEqual(seen.held, ['deploy check']);
  assert.equal(seen.released, 1, 'the holder is let go');
  assert.deepEqual(seen.declared, [SHA, 'origin/main'], "the row's commit, then main's tip for which suites gate");
  assert.deepEqual(time.state.slept, [SETTLE_MS], 'waited until ended + 30 min');
  assert.deepEqual(seen.survey, ['2026-11-15 12:00:00'], 'since the deploy began, in the stored form');
});

test('runCheck: the errors are not read before ended + 30 min, and a check started later waits only the rest', async () => {
  const early = boundaries();
  early.deps.readAfter = async () => { assert.ok(early.time.now() >= Date.parse(ENDED) + SETTLE_MS, 'read before the wait was over'); return survey([]); };
  await runCheck({ row: ROW, env: {}, deps: early.deps });
  const late = boundaries();
  late.time.state.t = Date.parse(ENDED) + SETTLE_MS + 5_000;
  await runCheck({ row: ROW, env: {}, deps: late.deps });
  assert.deepEqual(late.time.state.slept, [], 'nothing to wait for');
  const part = boundaries();
  part.time.state.t = Date.parse(ENDED) + 10 * 60_000;
  await runCheck({ row: ROW, env: {}, deps: part.deps });
  assert.deepEqual(part.time.state.slept, [SETTLE_MS - 10 * 60_000]);
});

test('runCheck: no dev server, no static server — production has one address', async () => {
  const { deps, seen } = boundaries();
  const servers = [];
  deps.suites.roundDeps = {
    suiteDeps: { ensureDevServer: () => servers.push('dev'), ensureAppServer: () => servers.push('app') },
  };
  deps.suites.round = async (options, roundDeps) => {
    seen.round.push(options);
    assert.equal(options.staticBaseUrl, undefined);
    assert.equal(options.baseUrl, BASE);
    assert.equal(typeof roundDeps.suiteDeps.ensureDevServer, 'function');
    return { results: [{ name: 'smoke', ok: true }, { name: 'api', ok: true }] };
  };
  assert.equal((await runCheck({ row: ROW, env: {}, deps })).check, GREEN);
  assert.deepEqual(servers, [], 'a check that served nothing never asked for a server');
});

test('runCheck: a red version or database ends it at once — no suites, no wait, no errors', async () => {
  for (const [path, answer, part] of [['/api/version', { status: 500 }, 'version'], ['/ping-d1', json({ d1: 'down' }), 'database']]) {
    const { deps, seen, time } = boundaries({ fetch: fetchOf({ ...HEALTHY, [path]: answer }) });
    const verdict = await runCheck({ row: ROW, env: {}, deps });
    assert.equal(verdict.check, RED, part);
    assert.match(verdict.check_why, new RegExp(`^${part}: `, 'u'));
    assert.deepEqual(seen.round, [], 'no suites against what is not working');
    assert.deepEqual(time.state.slept, [], 'no wait');
    assert.deepEqual(seen.survey, [], 'no errors read');
  }
});

test('runCheck: production at another commit is could-not-run, with no suites run against it', async () => {
  const { deps, seen } = boundaries({ fetch: fetchOf({ ...HEALTHY, '/api/version': json({ commit: OTHER.slice(0, 7), commit_full: OTHER }) }) });
  const verdict = await runCheck({ row: ROW, env: {}, deps });
  assert.equal(verdict.check, COULD_NOT_RUN);
  assert.match(verdict.check_why, /^version: production is at fedcba987654, not 0123456/u);
  assert.deepEqual(seen.round, []);
});

test('runCheck: a full-sha row against {commit, commit_full} and against {commit} alone', async () => {
  for (const body of [{ commit: SHA.slice(0, 7), commit_full: SHA }, { commit: SHA.slice(0, 7) }]) {
    const { deps } = boundaries({ fetch: fetchOf({ ...HEALTHY, '/api/version': json(body) }) });
    assert.equal((await runCheck({ row: ROW, env: {}, deps })).check, GREEN, JSON.stringify(body));
  }
});

test('runCheck: production moved during the wait — the second read differs — could-not-run, errors never read', async () => {
  const reads = [];
  const fetch = fetchOf((url) => {
    if (url.endsWith('/ping-d1')) return json({ d1: 'healthy' });
    reads.push(url);
    return reads.length === 1 ? json({ commit: SHA.slice(0, 7), commit_full: SHA }) : json({ commit: OTHER.slice(0, 7), commit_full: OTHER });
  });
  const { deps, seen } = boundaries({ fetch });
  const verdict = await runCheck({ row: ROW, env: {}, deps });
  assert.equal(verdict.check, COULD_NOT_RUN);
  assert.match(verdict.check_why, /version: production changed during the check/u);
  assert.deepEqual(seen.survey, []);
});

test('runCheck: a red suite is red and the check does not wait for the errors', async () => {
  const { deps, time } = boundaries();
  deps.suites.round = async () => ({ results: [{ name: 'smoke', ok: true }, { name: 'api', ok: false, status: 1 }] });
  const verdict = await runCheck({ row: ROW, env: {}, deps });
  assert.equal(verdict.check, RED);
  assert.equal(verdict.check_why, 'suites: api (exit 1) red; errors: not run', 'the errors were not read, and it says so');
  assert.deepEqual(time.state.slept, []);
});

test('runCheck: a checkout that cannot be put at the sha, or a holder that is not given, is could-not-run', async () => {
  const moved = boundaries();
  moved.deps.suites.place = () => ({ ok: false, reason: 'the checkout is on another commit' });
  const one = await runCheck({ row: ROW, env: {}, deps: moved.deps });
  assert.equal(one.check, COULD_NOT_RUN);
  assert.equal(one.check_why, 'suites: the checkout could not be put at 0123456: the checkout is on another commit');
  assert.deepEqual(moved.seen.round, [], 'no round on a tree that is not the row\'s');
  assert.equal(moved.seen.released, 1, 'the holder is let go');
  const busy = boundaries();
  busy.deps.suites.takeHolder = async () => ({ ok: false, reason: 'the deploy worktree was held for 10 min' });
  const two = await runCheck({ row: ROW, env: {}, deps: busy.deps });
  assert.equal(two.check, COULD_NOT_RUN);
  assert.equal(two.check_why, 'suites: the deploy worktree was held for 10 min');
  const broken = boundaries();
  broken.deps.suites.round = async () => { throw new Error('spawn ENOENT'); };
  assert.match((await runCheck({ row: ROW, env: {}, deps: broken.deps })).check_why, /suites: the round could not be run: spawn ENOENT/u);
});

test('runCheck: a /ping-d1 that never finishes is could-not-run at the bound', async () => {
  const { deps, seen } = boundaries({
    fetch: fetchOf({ ...HEALTHY, '/ping-d1': () => new Promise(() => {}) }),
    requestMs: 25,
  });
  const verdict = await runCheck({ row: ROW, env: {}, deps });
  assert.equal(verdict.check, COULD_NOT_RUN);
  assert.match(verdict.check_why, /database: \/ping-d1: no answer, with its body, in 0 s/u);
  assert.deepEqual(seen.round, [], 'no suites after a database that is not known to work');
});

test('runCheck: an undeclared commit, no production URL, and a part that throws are could-not-run', async () => {
  const none = boundaries({ declare: () => ({ ok: false, error: '0123456 does not declare .mc/test.json' }) });
  assert.match((await runCheck({ row: ROW, env: {}, deps: none.deps })).check_why, /declaration could not be read: 0123456 does not declare/u);
  const noUrl = boundaries({ declare: () => ({ ok: true, declaration: { ...DECLARATION, environments: {} } }) });
  assert.match((await runCheck({ row: ROW, env: {}, deps: noUrl.deps })).check_why, /declares no production base_url/u);
  const throws = boundaries({ readBefore: () => { throw new Error('disk gone'); } });
  const verdict = await runCheck({ row: ROW, env: {}, deps: throws.deps });
  assert.equal(verdict.check, COULD_NOT_RUN);
  assert.match(verdict.check_why, /errors: could not be checked: disk gone/u);
});

test('runCheck: an error that is new since the deploy is red', async () => {
  const { deps } = boundaries({ readAfter: async () => survey([print('old', '2026-11-10 08:00:00'), print('new', '2026-11-15 12:40:00', 'RangeError')]) });
  const verdict = await runCheck({ row: ROW, env: {}, deps });
  assert.equal(verdict.check, RED);
  assert.equal(verdict.check_why, 'errors: 1 fingerprint new since the deploy: new "RangeError"');
});

/* -------------------------------------------- the detached entry: its record */

test('executeCheck: the verdict goes to its own file first and then into the row, and nothing else of the row changes', async () => {
  const { env, cleanup } = workRoot();
  try {
    const row = deployed(env);
    const { deps } = boundaries();
    const said = [];
    const result = await executeCheck({ job: { started: row.started, sha: row.sha }, env, deps, say: (line) => said.push(line) });
    assert.equal(result.code, 0);
    assert.equal(result.written, true);
    const after = readDeploys(env).at(-1);
    assert.deepEqual([after.check, after.check_why], [GREEN, '']);
    assert.ok(after.check_at);
    assert.deepEqual({ ...after, check: '', check_at: '', check_why: '' }, { ...row, check: '', check_at: '', check_why: '' });
    assert.equal(readVerdictFile(env, row.started).check, GREEN);
    assert.ok(said.some((line) => /is green/u.test(line)));
  } finally { cleanup(); }
});

test('executeCheck: a row that cannot be written leaves the verdict file, and a row that carries one is not checked again', async () => {
  const { env, cleanup } = workRoot();
  try {
    const row = deployed(env);
    const { deps } = boundaries();
    deps.record = () => { throw new Error('the runner lock is held by pid 7 — try again'); };
    const result = await executeCheck({ job: { started: row.started, sha: row.sha }, env, deps });
    assert.equal(result.written, false);
    assert.match(result.why, /held by pid 7/u);
    assert.equal(readDeploys(env).at(-1).check, '');
    assert.equal(readVerdictFile(env, row.started).check, GREEN);
    // The chore copies it in.
    const tick = deployCheckTick({ env, now: () => Date.parse(ENDED) + 60_000, start: () => ({ pid: null }), running: () => null });
    assert.match(tick.notes.join('\n'), /verdict restored from its file/u);
    assert.equal(readDeploys(env).at(-1).check, GREEN);
    const again = await executeCheck({ job: { started: row.started, sha: row.sha }, env, deps });
    assert.match(again.why, /already carries a verdict/u);
    assert.equal((await executeCheck({ job: { started: 'x', sha: SHA }, env, deps })).code, 1);
  } finally { cleanup(); }
});

test('executeCheck: a check that throws is could-not-run with its words, never an unwritten row', async () => {
  const { env, cleanup } = workRoot();
  try {
    const row = deployed(env);
    const { deps } = boundaries({ declare: () => { throw new Error('git is gone'); } });
    const result = await executeCheck({ job: { started: row.started, sha: row.sha }, env, deps });
    assert.equal(result.verdict.check, COULD_NOT_RUN);
    assert.match(readDeploys(env).at(-1).check_why, /the check failed: git is gone/u);
  } finally { cleanup(); }
});

test('executeCheck: a red verdict starts the reaction at once, once, detached; green and could-not-run start nothing', async () => {
  const red = boundaries({ readAfter: async () => survey([print('old', '2026-11-10 08:00:00'), print('new', '2026-11-15 12:40:00', 'RangeError')]) });
  const cases = [['red', red.deps, 1], ['green', boundaries().deps, 0], ['could-not-run', boundaries({ declare: () => { throw new Error('git is gone'); } }).deps, 0]];
  for (const [name, deps, expected] of cases) {
    const { env, cleanup } = workRoot();
    try {
      const row = deployed(env);
      const started = [];
      const said = [];
      deps.startReaction = (job, options) => { started.push({ job, options }); return { pid: 321, log: '/log' }; };
      const result = await executeCheck({ job: { started: row.started, sha: row.sha }, env, deps, say: (line) => said.push(line) });
      assert.equal(started.length, expected, name);
      if (expected) {
        assert.equal(readDeploys(env).at(-1).check, RED);
        assert.deepEqual(started[0].job, { started: row.started });
        assert.equal(result.reaction.pid, 321);
        assert.ok(said.some((line) => /reaction/u.test(line)), 'the start is said');
        assert.ok(said.findIndex((line) => /reaction/u.test(line)) > said.findIndex((line) => /is red/u.test(line)), 'the row is written first');
      }
    } finally { cleanup(); }
  }
});

test('executeCheck: a red whose row could not be written starts no reaction — the chore restores the verdict, then reacts', async () => {
  const { env, cleanup } = workRoot();
  try {
    const row = deployed(env);
    const { deps } = boundaries({ readAfter: async () => survey([print('new', '2026-11-15 12:40:00', 'RangeError')]) });
    const started = [];
    deps.startReaction = (job) => { started.push(job); return { pid: 1 }; };
    deps.record = () => { throw new Error('the runner lock is held by pid 7 — try again'); };
    const result = await executeCheck({ job: { started: row.started, sha: row.sha }, env, deps });
    assert.equal(result.written, false);
    assert.deepEqual(started, []);
  } finally { cleanup(); }
});

test('startReactionDefault: runs the installed take-back-run.js detached in its own group, with the row as its argument, logging beside the verdict', () => {
  const { env, cleanup } = workRoot();
  try {
    const spawned = [];
    const result = startReactionDefault({ started: STARTED }, { env, spawnProcess: (command, args, options) => { spawned.push({ command, args, options }); return { pid: 77, unref() { spawned.at(-1).unref = true; } }; } });
    assert.equal(result.pid, 77);
    assert.equal(spawned[0].command, process.execPath);
    assert.match(spawned[0].args[0], /take-back-run\.js$/u);
    assert.equal(spawned[0].args[1], STARTED);
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].unref, true);
    assert.match(result.log, new RegExp(`${STARTED.replace(/[.]/gu, '\\.')}\\.take-back\\.log$`, 'u'));
    const failing = startReactionDefault({ started: STARTED }, { env, spawnProcess: () => { throw new Error('EAGAIN'); } });
    assert.equal(failing.pid, null);
    assert.match(failing.error, /EAGAIN/u);
  } finally { cleanup(); }
});

/* -------------------------------------------------------------- criterion 5 */

test('deploy-check-run.js under MC_HEADLESS=1 exits 2 and writes nothing', () => {
  const { root, env, cleanup } = workRoot();
  try {
    const row = deployed(env);
    const home = mkdtempSync(join(tmpdir(), 'mc-deploy-check-home-'));
    const before = readFileSync(deploysPath(env), 'utf8');
    const result = spawnSync(process.execPath, [CHECK_RUN, JSON.stringify({ started: row.started, sha: row.sha })], {
      env: { PATH: process.env.PATH, MC_HEADLESS: '1', MC_HOME: home, MC_WORK_ROOT: root }, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refused to a headless session/u);
    assert.deepEqual(readdirSync(home), [], 'MC_HOME is untouched');
    assert.equal(readFileSync(deploysPath(env), 'utf8'), before, 'deploys.tsv is untouched');
    assert.equal(existsSync(join(root, 'runner', 'log', 'deploy-check')), false, 'no verdict, log or reading written');
    rmSync(home, { recursive: true, force: true });
  } finally { cleanup(); }
});

test('deploy-check-run.js without MC_HEADLESS does its work: an unknown row is code 1 and a note, not a crash', () => {
  const { root, cleanup } = workRoot();
  try {
    const result = spawnSync(process.execPath, [CHECK_RUN, JSON.stringify({ started: 'nope', sha: SHA })], {
      env: { PATH: process.env.PATH, MC_WORK_ROOT: root }, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /no row nope/u);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------ the chore (D3) */

const FROM = Date.parse('2026-11-15T11:00:00.000Z');

/** A chore with its process boundaries faked: what it started, killed and said. */
function chore(env, overrides = {}) {
  const log = { started: [], killed: [], said: [] };
  let t = Date.parse('2026-11-15T12:10:00.000Z');
  const options = {
    env,
    now: () => t,
    alive: () => false,
    kill: (pid) => { log.killed.push(pid); },
    start: (job) => { log.started.push(job); return { pid: 4000 + log.started.length, log: '/log' }; },
    say: (line) => log.said.push(line),
    running: () => null,
    ...overrides,
  };
  return { log, options, tick: () => deployCheckTick(options), at: (ms) => { t = ms; } };
}

function seedState(env, state) {
  mkdirSync(dirname(statePath(env)), { recursive: true });
  writeFileSync(statePath(env), JSON.stringify(state));
}

test('deploy check chore: the first pass writes `from` and checks nothing that ended before it', () => {
  const { env, cleanup } = workRoot();
  try {
    deployed(env, { started: '2026-11-15T10:00:00.000Z', ended: '2026-11-15T10:05:00.000Z' });
    const c = chore(env);
    const first = c.tick();
    assert.equal(first.started, null);
    assert.equal(JSON.parse(readFileSync(statePath(env), 'utf8')).from, '2026-11-15T12:10:00.000Z');
    c.at(Date.parse('2026-11-15T15:00:00.000Z'));
    c.tick();
    assert.equal(JSON.parse(readFileSync(statePath(env), 'utf8')).from, '2026-11-15T12:10:00.000Z', 'never moved');
    assert.deepEqual(c.log.started, []);
    assert.equal(readDeploys(env)[0].check, '', 'it stays empty and reads "not checked"');
  } finally { cleanup(); }
});

test('deploy check chore: the oldest due row first, one at a time, none started while an attempt is alive', () => {
  const { env, cleanup } = workRoot();
  try {
    seedState(env, { from: new Date(FROM).toISOString() });
    // Two deploys; the second supersedes the first, so make them the *same* chain: one due only.
    const first = deployed(env, { started: '2026-11-15T12:00:00.000Z', sha: SHA, ended: '2026-11-15T12:02:00.000Z' });
    const c = chore(env, { alive: () => true });
    assert.deepEqual(c.tick().started, { started: first.started, sha: SHA });
    assert.equal(c.log.started.length, 1);
    const state = JSON.parse(readFileSync(statePath(env), 'utf8'));
    assert.equal(state.attempt.pid, 4001);
    assert.equal(state.attempt.deadline, Date.parse(ENDED) + SETTLE_MS + 30 * 60_000, 'max(start, ended + 30 min) + 30 min');
    assert.equal(attemptInFlight(env, { alive: () => true }).started, first.started);
    assert.equal(attemptInFlight(env, { alive: () => false }), null);
    // Another pass while it lives: nothing new starts.
    const waiting = c.tick();
    assert.equal(waiting.started, null);
    assert.equal(waiting.waiting, first.started);
    assert.equal(c.log.started.length, 1);
  } finally { cleanup(); }
});

test('deploy check chore: a due row a later deploy has superseded is written could-not-run without a start', () => {
  const { env, cleanup } = workRoot();
  try {
    seedState(env, { from: new Date(FROM).toISOString() });
    const first = deployed(env, { started: '2026-11-15T12:00:00.000Z', sha: SHA, ended: '2026-11-15T12:02:00.000Z' });
    const second = deployed(env, { started: '2026-11-15T12:05:00.000Z', sha: OTHER, ended: '2026-11-15T12:07:00.000Z' });
    const c = chore(env);
    const result = c.tick();
    const rows = readDeploys(env);
    assert.equal(rows[0].check, COULD_NOT_RUN);
    assert.equal(rows[0].check_why, 'superseded by fedcba9 before it was checked');
    assert.deepEqual(c.log.started, [{ started: second.started, sha: OTHER }], 'only the latest is started');
    assert.deepEqual(result.started, { started: second.started, sha: OTHER });
    assert.equal(first.check, '');
  } finally { cleanup(); }
});

test('deploy check chore: nothing starts during a deploy, STOP, UPDATE or a live attempt', () => {
  const { env, cleanup } = workRoot();
  try {
    seedState(env, { from: new Date(FROM).toISOString() });
    deployed(env);
    for (const [what, overrides] of [
      ['a deploy running', { running: () => ({ started: 'x' }) }],
      ['STOP', { stopRequested: () => true }],
      ['UPDATE', { updateRequested: () => true }],
    ]) {
      const c = chore(env, overrides);
      assert.equal(c.tick().started, null, what);
      assert.deepEqual(c.log.started, [], what);
    }
    assert.equal(readDeploys(env)[0].check, '');
    // A superseded row is not written during a deploy either: nothing is decided then.
    const c = chore(env);
    assert.ok(c.tick().started, 'with nothing in the way it starts');
  } finally { cleanup(); }
});

test('deploy check chore: an attempt that died without a verdict is could-not-run with its pid and not started again', () => {
  const { env, cleanup } = workRoot();
  try {
    const row = deployed(env);
    seedState(env, {
      from: new Date(FROM).toISOString(),
      attempt: { key: { started: row.started, sha: row.sha }, pid: 4321, started_at: ENDED, deadline: Date.parse(ENDED) + 3_600_000 },
    });
    const c = chore(env, { alive: () => false });
    c.at(Date.parse(ENDED) + 10 * 60_000);
    const result = c.tick();
    const after = readDeploys(env)[0];
    assert.equal(after.check, COULD_NOT_RUN);
    assert.equal(after.check_why, 'the check ended without a verdict (pid 4321)');
    assert.deepEqual(c.log.started, [], 'not started again');
    assert.equal(result.started, null);
    assert.equal(JSON.parse(readFileSync(statePath(env), 'utf8')).attempt, null);
    assert.deepEqual(c.log.killed, [], 'nothing alive to kill');
  } finally { cleanup(); }
});

test('deploy check chore: an alive attempt past its deadline is killed by its group, written, and the next due row starts on a later pass', () => {
  const { env, cleanup } = workRoot();
  try {
    const first = deployed(env, { started: '2026-11-15T12:00:00.000Z', sha: SHA, ended: '2026-11-15T12:02:00.000Z' });
    seedState(env, {
      from: new Date(FROM).toISOString(),
      attempt: { key: { started: first.started, sha: SHA }, pid: 4321, started_at: ENDED, deadline: attemptDeadline({ startedAt: Date.parse(ENDED), ended: ENDED }) },
    });
    const c = chore(env, { alive: () => true });
    c.at(Date.parse(ENDED) + SETTLE_MS + 29 * 60_000);
    assert.equal(c.tick().waiting, first.started, 'inside the deadline it waits');
    assert.deepEqual(c.log.killed, []);
    // Meanwhile a second deploy has landed and is due.
    const second = deployed(env, { started: '2026-11-15T13:00:00.000Z', sha: OTHER, ended: '2026-11-15T13:02:00.000Z' });
    c.at(Date.parse(ENDED) + SETTLE_MS + 31 * 60_000);
    const pass = c.tick();
    assert.deepEqual(c.log.killed, [4321]);
    const rows = readDeploys(env);
    assert.equal(rows[0].check, COULD_NOT_RUN);
    assert.equal(rows[0].check_why, 'the check passed its deadline (pid 4321)');
    assert.equal(pass.started, null, 'the next row starts on a later pass');
    assert.equal(rows[1].check, '');
    const next = c.tick();
    assert.deepEqual(next.started, { started: second.started, sha: OTHER });
  } finally { cleanup(); }
});

test('deploy check chore: a verdict file is copied into an empty cell, and a failed start is could-not-run', () => {
  const { env, cleanup } = workRoot();
  try {
    seedState(env, { from: new Date(FROM).toISOString() });
    const row = deployed(env);
    writeVerdictFile(env, row, { check: RED, check_at: '2026-11-15T12:40:00.000Z', check_why: 'database: down', parts: [] });
    assert.equal(verdictPath(env, row.started).endsWith(`${row.started}.verdict.json`), true);
    const c = chore(env);
    const note = c.tick().notes.join('\n');
    assert.match(note, /verdict restored from its file/u);
    const after = readDeploys(env)[0];
    assert.deepEqual([after.check, after.check_at, after.check_why], [RED, '2026-11-15T12:40:00.000Z', 'database: down']);
    assert.deepEqual(c.log.started, []);

    const second = deployed(env, { started: '2026-11-15T14:00:00.000Z', sha: OTHER, ended: '2026-11-15T14:02:00.000Z' });
    const failing = chore(env, { start: () => ({ pid: null, error: 'EMFILE' }) });
    failing.at(Date.parse('2026-11-15T14:10:00.000Z'));
    failing.tick();
    const last = readDeploys(env).find((one) => one.started === second.started);
    assert.equal(last.check, COULD_NOT_RUN);
    assert.equal(last.check_why, 'the check could not be started: EMFILE');
  } finally { cleanup(); }
});

test('deploy check chore: rows other than deployed ones are never checked, and a verdict file for another sha is not copied', () => {
  const { env, cleanup } = workRoot();
  try {
    seedState(env, { from: new Date(FROM).toISOString() });
    recordStart({ sha: SHA, started: STARTED, pid: 1 }, env);
    const c = chore(env, { alive: () => true });
    assert.equal(c.tick().started, null, 'a running row is not due');
    const row = deployed(env, { started: '2026-11-15T15:00:00.000Z', sha: OTHER, ended: '2026-11-15T15:02:00.000Z' });
    writeVerdictFile(env, { started: row.started, sha: SHA }, { check: GREEN, check_at: ENDED, check_why: '' });
    c.at(Date.parse('2026-11-15T15:10:00.000Z'));
    assert.deepEqual(c.tick().started, { started: row.started, sha: OTHER }, 'the stranger file is ignored');
    assert.equal(checkCells({ check: GREEN, check_at: 'x' }).check_why, '');
  } finally { cleanup(); }
});

test('the header of a file the chore writes into is the current one', () => {
  const { env, cleanup } = workRoot();
  try {
    deployed(env);
    assert.equal(readFileSync(deploysPath(env), 'utf8').split('\n')[0], DEPLOYS_HEADER.join('\t'));
    const at = DEPLOYS_HEADER.indexOf('check');
    assert.deepEqual(DEPLOYS_HEADER.slice(at, at + 3), ['check', 'check_at', 'check_why']);
  } finally { cleanup(); }
});

test("runCheck: which suites gate is main's tip's word, not the deployed commit's (Martin, 2026-11-15)", async () => {
  // The deployed commit makes `slow` a gate and `api` not one; the tip says the opposite.
  const shipped = { ...DECLARATION, suites: [{ name: 'smoke', argv: ['node', 'smoke.js'] }, { name: 'api', argv: ['node', 'api.js'], gate: false, gate_why: 'old' }, { name: 'slow', argv: ['x'] }, { name: 'gone', argv: ['y'] }] };
  const tip = { ...DECLARATION, suites: [{ name: 'smoke', argv: ['other'] }, { name: 'api', argv: ['other'] }, { name: 'slow', argv: ['x'], gate: false, gate_why: 'measures time' }] };
  const { deps, seen } = boundaries({ declare: (at) => ({ ok: true, declaration: at === 'origin/main' ? tip : shipped }) });
  const verdict = await runCheck({ row: ROW, env: {}, deps });
  assert.equal(verdict.check, GREEN, verdict.check_why);
  const suites = seen.round[0].declaration.suites;
  assert.deepEqual(suites.filter((s) => s.gate !== false).map((s) => s.name), ['smoke', 'api']);
  assert.deepEqual(suites.find((s) => s.name === 'slow'), { name: 'slow', argv: ['x'], gate: false, gate_why: 'measures time' });
  assert.deepEqual(suites.find((s) => s.name === 'gone'), { name: 'gone', argv: ['y'], gate: false, gate_why: "not on main's tip" });
  assert.deepEqual(suites.find((s) => s.name === 'smoke').argv, ['node', 'smoke.js'], "the deployed commit's argv runs");

  const unread = boundaries({ declare: (at) => (at === 'origin/main' ? { ok: false, error: 'no tip' } : { ok: true, declaration: shipped }) });
  const refused = await runCheck({ row: ROW, env: {}, deps: unread.deps });
  const suitesPart = refused.parts.find((p) => p.part === 'suites');
  assert.equal(suitesPart.verdict, COULD_NOT_RUN);
  assert.match(suitesPart.why, /main's tip declaration could not be read: no tip/u);
  assert.equal(unread.seen.round.length, 0);
  assert.equal(gatedByTip(shipped, tip).suites.length, 4);
});
