/**
 * The take-back of a release (src/mc/release-take-back.js): the gate's
 * refusals one by one, the admission that is atomic under the deploys lock, the
 * script's call and the row it leaves. Every boundary is faked: no script runs,
 * no Wrangler, no network, no production; the deploys register is a temporary
 * file, and the runner lock the real one on a temporary root.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ledgerPath, readLedger, updateLedger } from '../../src/mc/check-red-ledger.js';
import { verdictPath } from '../../src/mc/deploy-check.js';
import { deployWorktreePath } from '../../src/mc/deploy-worktree.js';
import { checkMemberKey, mainMendPrompt, readMainMends, updateMainMends } from '../../src/mc/main-repair.js';
import { deskEntries, endDesk, pendingReds, react, takeBackTick } from '../../src/mc/take-back-run.js';
import { DEPLOYS_HEADER, deploysPath, readDeploys, tsvRow } from '../../src/mc/deploys.js';
import { WRANGLER_BIN, parseVersions, takeBack, takeBackGate } from '../../src/mc/release-take-back.js';

const EARLIER_SHA = 'a'.repeat(40);
const R_SHA = 'b'.repeat(40);
const R_STARTED = '2026-11-15T10:00:00.000Z';

const earlierRow = (over = {}) => ({
  started: '2026-11-15T09:00:00.000Z', ended: '2026-11-15T09:05:00.000Z', sha: EARLIER_SHA, build: '99', holder: 'martin', outcome: 'deployed',
  live_commit: EARLIER_SHA, live_build: '99', versions_before: 'memoro:b0,memoro-tail:t0', versions_made: 'memoro:b1,memoro-tail:t1', versions_why: '',
  check: 'green', take_back: 'yes', ...over,
});
const releaseRow = (over = {}) => ({
  started: R_STARTED, ended: '2026-11-15T10:05:00.000Z', sha: R_SHA, build: '100', holder: 'martin', outcome: 'deployed',
  live_commit: R_SHA, live_build: '100', versions_before: 'memoro:b1,memoro-tail:t1', versions_made: 'memoro:b2,memoro-tail:t2', versions_why: '',
  check: 'red', check_at: '2026-11-15T10:40:00.000Z', check_why: 'errors: 3 new fingerprints', take_back: 'yes', ...over,
});

function setup(rows = [earlierRow(), releaseRow()]) {
  const root = mkdtempSync(join(tmpdir(), 'mc-take-back-'));
  mkdirSync(join(root, 'runner', 'log'), { recursive: true });
  writeFileSync(join(root, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }));
  const env = { MC_WORK_ROOT: root, MC_HOME: join(root, 'home') };
  const seed = (list) => writeFileSync(deploysPath(env), `${DEPLOYS_HEADER.join('\t')}\n${list.map((row) => tsvRow(row)).join('\n')}\n`);
  seed(rows);
  const calls = { scripts: [], holders: 0, released: 0, exports: [], before: 0 };
  const said = { workers: null };
  const deps = {
    alive: () => false,
    exists: () => true,
    exportTree(repo, sha, path, dir) {
      calls.exports.push({ repo, sha });
      mkdirSync(join(dir, 'scripts', 'release'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'release', 'take-back.mjs'), '');
      return null;
    },
    async takeHolder({ verb }) {
      calls.holders += 1;
      calls.verb = verb;
      return { ok: true, release: () => { calls.released += 1; } };
    },
    async runScript(argv, options) {
      calls.scripts.push({ argv, options });
      const workers = said.workers || argv.flatMap((arg, at) => (argv[at - 1] === '--worker' ? [arg] : [])).map((spec) => {
        const [worker, ids] = spec.split('=');
        const [from, to] = ids.split(':');
        return { worker, from, to, state: 'taken-back', serving: to, why: `rolled back from ${from}` };
      });
      return { code: workers.every((one) => one.state === 'taken-back') ? 0 : 1, stdout: `${JSON.stringify({ schema_version: 1, ok: workers.every((one) => one.state === 'taken-back'), workers })}\n`, stderr: '' };
    },
    async fetchVersion() { return { commit: EARLIER_SHA.slice(0, 7), commit_full: EARLIER_SHA, build: 99 }; },
  };
  return { root, env, deps, calls, said, seed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const run = (fixture, options = {}) => takeBack({
  by: 'runner', started: R_STARTED, repoPath: '/repo.git', env: fixture.env, deps: fixture.deps, ...options,
});

// ---------------------------------------------------------------- the gate

/** One refusal: nothing written, nothing called, no holder taken. */
async function refused(name, rows, code, pattern, options = {}, change = () => {}) {
  test(`D5: ${name}`, async () => {
    const fixture = setup(rows);
    try {
      change(fixture);
      const before = readDeploys(fixture.env).length;
      const result = await run(fixture, options);
      assert.equal(result.status, 'refused');
      assert.equal(result.code, code);
      assert.match(result.why, pattern);
      assert.equal(readDeploys(fixture.env).length, before, 'no row is written');
      assert.equal(fixture.calls.scripts.length, 0, 'the script is not run');
      assert.equal(fixture.calls.holders, 0, 'the holder is not taken');
    } finally { fixture.cleanup(); }
  });
}

await refused('no release has been deployed', [], 'no-release', /nothing to take back/u);
await refused('the last release is itself a take-back', [earlierRow(), releaseRow({ takes_back: '2026-11-15T08:00:00.000Z', takes_back_sha: 'c'.repeat(40) })],
  'is-take-back', /a take-back is not taken back/u, { by: 'verb' });
await refused('a deployed take-back row already names the release', [earlierRow(), {
  started: '2026-11-15T09:30:00.000Z', sha: EARLIER_SHA, outcome: 'deployed', takes_back: R_STARTED, takes_back_sha: R_SHA,
}, releaseRow()], 'already-taken-back', /was already taken back/u, { by: 'verb' });
await refused('versions_made names no Worker', [earlierRow(), releaseRow({ versions_made: '' })], 'no-versions-made', /names no Worker version/u);
await refused('a Worker in versions_made has no id there', [earlierRow(), releaseRow({ versions_made: 'memoro:missing' })], 'version-missing', /did not record the version it made for memoro/u);
await refused('a Worker in versions_made has no id in versions_before', [earlierRow(), releaseRow({ versions_before: 'memoro-tail:t1' })], 'version-missing', /memoro served before/u);
await refused('versions_why is not empty', [earlierRow(), releaseRow({ versions_why: 'memoro-tail before: no deployments' })], 'versions-why', /could not be read/u);
await refused('no release was deployed before it', [releaseRow()], 'no-earlier', /no commit to return to/u);
await refused('the earlier release made another version than the one before the release', [earlierRow({ versions_made: 'memoro:b9,memoro-tail:t1' }), releaseRow()],
  'earlier-differs', /production was changed between them/u);
await refused('the commit has no take-back.mjs', undefined, 'no-script', /has no scripts\/release\/take-back\.mjs/u, {}, (fixture) => {
  fixture.deps.exportTree = () => 'git archive: path not found';
});
await refused('the deploy worktree has no node_modules/.bin/wrangler', undefined, 'no-wrangler', new RegExp(WRANGLER_BIN.replace(/[/.]/gu, '\\$&'), 'u'), {}, (fixture) => {
  fixture.deps.exists = (path) => !String(path).endsWith(WRANGLER_BIN);
});

test('D5: a failed take-back row does not block the verb, which tries again, and blocks the runner, which tries once', () => {
  const failed = { started: '2026-11-15T11:00:00.000Z', sha: EARLIER_SHA, outcome: 'failed', takes_back: R_STARTED, takes_back_sha: R_SHA };
  const rows = [earlierRow(), releaseRow(), failed];
  assert.equal(takeBackGate({ rows, by: 'verb' }).ok, true);
  const runner = takeBackGate({ rows, by: 'runner' });
  assert.deepEqual([runner.ok, runner.code], [false, 'already-tried']);
});

test('D5: once a take-back is deployed it is the last release, and a take-back is not taken back', () => {
  const back = { started: '2026-11-15T11:00:00.000Z', sha: EARLIER_SHA, outcome: 'deployed', takes_back: R_STARTED, takes_back_sha: R_SHA, versions_made: 'memoro:b1,memoro-tail:t1' };
  assert.equal(takeBackGate({ rows: [earlierRow(), releaseRow(), back], by: 'verb' }).code, 'is-take-back');
  const later = releaseRow({ started: '2026-11-15T12:00:00.000Z', sha: 'c'.repeat(40), live_commit: 'c'.repeat(40), versions_before: 'memoro:b1,memoro-tail:t1', versions_made: 'memoro:b3,memoro-tail:t3' });
  const gate = takeBackGate({ rows: [earlierRow(), releaseRow(), back, later], by: 'verb' });
  assert.equal(gate.ok, true, 'a release shipped after a take-back is judged on its own');
  assert.equal(gate.earlier.started, back.started);
});

test('D5: the three conditions the runner adds — red, a reading of yes, the release asked for — and the verb\'s --despite', async () => {
  for (const [rows, code] of [
    [[earlierRow(), releaseRow({ check: 'green' })], 'not-red'],
    [[earlierRow(), releaseRow({ check: '' })], 'not-red'],
    [[earlierRow(), releaseRow({ check: 'could-not-run' })], 'not-red'],
    [[earlierRow(), releaseRow({ take_back: 'no', take_back_why: 'migration-after: 0042' })], 'reading-no'],
    [[earlierRow(), releaseRow({ take_back: '' })], 'reading-no'],
  ]) {
    const fixture = setup(rows);
    try {
      const result = await run(fixture);
      assert.deepEqual([result.status, result.code], ['refused', code]);
      assert.equal(fixture.calls.scripts.length, 0);
    } finally { fixture.cleanup(); }
  }
  const fixture = setup();
  try {
    const result = await run(fixture, { started: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual([result.status, result.code], ['refused', 'not-last']);
  } finally { fixture.cleanup(); }
});

test('the verb takes a green release back, refuses a reading of no unless --despite, and --despite never overrides the gate', async () => {
  const noRows = [earlierRow(), releaseRow({ check: 'green', take_back: 'no', take_back_why: 'migration-after: 0042 (abc)' })];
  const plain = setup(noRows);
  try {
    const result = await run(plain, { by: 'verb', started: null });
    assert.deepEqual([result.status, result.code], ['refused', 'reading-no']);
    assert.match(result.why, /--despite "<reason>"/u);
    assert.match(result.why, /migration-after: 0042/u);
  } finally { plain.cleanup(); }
  const despite = setup(noRows);
  try {
    const result = await run(despite, { by: 'verb', started: null, despite: true, reason: 'the migration is additive' });
    assert.equal(result.status, 'taken-back');
    const row = readDeploys(despite.env).at(-1);
    assert.match(row.takes_back_why, /^typed: the migration is additive/u);
    assert.match(row.takes_back_why, /despite the reading/u);
  } finally { despite.cleanup(); }
  const gated = setup([earlierRow(), releaseRow({ take_back: 'no', versions_why: 'memoro made: no id' })]);
  try {
    const result = await run(gated, { by: 'verb', started: null, despite: true, reason: 'x' });
    assert.deepEqual([result.status, result.code], ['refused', 'versions-why']);
  } finally { gated.cleanup(); }
});

// ------------------------------------------------------------ the take-back

test('a take-back runs the script from the release\'s scripts, in the deploy worktree, memoro before memoro-tail, and writes its row', async () => {
  const fixture = setup([earlierRow(), releaseRow({ versions_made: 'memoro-tail:t2,memoro:b2' })]);
  try {
    const result = await run(fixture);
    assert.equal(result.status, 'taken-back');
    assert.deepEqual(fixture.calls.exports, [{ repo: '/repo.git', sha: R_SHA }], 'the scripts are the release\'s own');
    const [{ argv, options }] = fixture.calls.scripts;
    assert.match(argv[1], /scripts\/release\/take-back\.mjs$/u);
    assert.deepEqual(argv.filter((arg, at) => argv[at - 1] === '--worker'), ['memoro=b2:b1', 'memoro-tail=t2:t1']);
    assert.ok(argv.includes('--message'));
    assert.equal(argv.includes('--dry-run'), false);
    assert.equal(options.cwd, deployWorktreePath(fixture.env));
    assert.equal(fixture.calls.verb, 'take back');
    assert.equal(fixture.calls.released, 1, 'the holder is released');

    const rows = readDeploys(fixture.env);
    const row = rows.at(-1);
    assert.equal(rows.length, 3);
    assert.equal(row.sha, EARLIER_SHA, 'the commit it returns to');
    assert.equal(row.build, '99');
    assert.equal(row.holder, `runner, check red of ${R_STARTED}`);
    assert.equal(row.outcome, 'deployed');
    assert.equal(row.stopped_at, '');
    assert.deepEqual([row.takes_back, row.takes_back_sha, row.takes_back_why], [R_STARTED, R_SHA, 'errors: 3 new fingerprints']);
    assert.deepEqual([row.take_back, row.take_back_why], ['no', 'a take-back is not taken back by itself']);
    assert.equal(row.versions_before, 'memoro:b2,memoro-tail:t2');
    assert.equal(row.versions_made, 'memoro:b1,memoro-tail:t1');
    assert.equal(row.versions_why, '');
    assert.deepEqual([row.live_commit, row.live_build], [EARLIER_SHA, '99']);
    assert.equal(row.check, '', 'the chore checks it like any deployed row');
  } finally { fixture.cleanup(); }
});

test('a script that took one Worker back and not the other leaves a failed row naming what was not', async () => {
  const fixture = setup();
  try {
    fixture.said.workers = [
      { worker: 'memoro', from: 'b2', to: 'b1', state: 'taken-back', serving: 'b1', why: 'rolled back' },
      { worker: 'memoro-tail', from: 't2', to: 't1', state: 'failed', serving: 't2', why: 'wrangler rollback exited 1' },
    ];
    const result = await run(fixture);
    assert.equal(result.status, 'failed');
    const row = readDeploys(fixture.env).at(-1);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'take-back');
    assert.equal(row.versions_made, 'memoro:b1,memoro-tail:missing');
    assert.match(row.versions_why, /memoro-tail made: failed — wrangler rollback exited 1/u);
    assert.match(row.note, /did not take every Worker back/u);
    assert.equal(row.takes_back, R_STARTED, 'a failed row still names the release, which is what the floor reads');
    assert.equal(fixture.calls.released, 1);
  } finally { fixture.cleanup(); }
});

test('a script that prints nothing readable, or exits 1 with ok false, is a failed take-back and never a taken-back one', async () => {
  for (const reply of [{ code: 0, stdout: 'not json', stderr: '' }, { code: 1, stdout: '', stderr: 'Error: boom' }, { code: null, stdout: '', stderr: '', timedOut: true }, { code: null, error: 'spawn node ENOENT', stdout: '', stderr: '' }]) {
    const fixture = setup();
    try {
      fixture.deps.runScript = async () => reply;
      const result = await run(fixture);
      assert.equal(result.status, 'failed');
      const row = readDeploys(fixture.env).at(-1);
      assert.equal(row.outcome, 'failed');
      assert.equal(row.versions_made, 'memoro:missing,memoro-tail:missing');
    } finally { fixture.cleanup(); }
  }
});

test('a script that reports ok but leaves one asked Worker out is not a taken-back release', async () => {
  const fixture = setup();
  try {
    fixture.deps.runScript = async () => ({ code: 0, stdout: `${JSON.stringify({ schema_version: 1, ok: true, workers: [{ worker: 'memoro', from: 'b2', to: 'b1', state: 'taken-back', serving: 'b1', why: '' }] })}\n`, stderr: '' });
    const result = await run(fixture);
    assert.equal(result.status, 'failed');
  } finally { fixture.cleanup(); }
});

test('production that does not answer leaves the live cells empty and the take-back deployed', async () => {
  const fixture = setup();
  try {
    fixture.deps.fetchVersion = async () => null;
    const result = await run(fixture);
    assert.equal(result.status, 'taken-back');
    const row = readDeploys(fixture.env).at(-1);
    assert.deepEqual([row.live_commit, row.live_build], ['', '']);
  } finally { fixture.cleanup(); }
});

test('--dry-run runs the script with --dry-run and writes no row', async () => {
  const fixture = setup();
  try {
    const result = await run(fixture, { by: 'verb', started: null, dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.ok, true);
    assert.equal(fixture.calls.scripts[0].argv.includes('--dry-run'), true);
    assert.equal(readDeploys(fixture.env).length, 2);
    assert.equal(fixture.calls.released, 1);
  } finally { fixture.cleanup(); }
});

test('the verb names its person on the row, and the reason it was given', async () => {
  const fixture = setup([earlierRow(), releaseRow({ check: 'green' })]);
  try {
    const result = await run(fixture, { by: 'verb', started: null, holder: 'martin', reason: 'the page is blank' });
    assert.equal(result.status, 'taken-back');
    const row = readDeploys(fixture.env).at(-1);
    assert.equal(row.holder, 'martin');
    assert.equal(row.takes_back_why, 'typed: the page is blank');
    const bare = setup([earlierRow(), releaseRow({ check: 'green' })]);
    try {
      await run(bare, { by: 'verb', started: null, holder: 'martin' });
      assert.equal(readDeploys(bare.env).at(-1).takes_back_why, 'typed: no reason');
    } finally { bare.cleanup(); }
  } finally { fixture.cleanup(); }
});

// ------------------------------------------------------------ the admission

test('D8: a row that names the release, written after the first read, makes the take-back not made — no row, no script', async () => {
  const fixture = setup();
  try {
    let holderTaken = false;
    fixture.deps.takeHolder = async () => {
      holderTaken = true;
      // The other process's row lands while this one waits for the holder.
      appendFileSync(deploysPath(fixture.env), `${tsvRow({ started: '2026-11-15T10:50:00.000Z', sha: EARLIER_SHA, outcome: 'running', pid: 1, takes_back: R_STARTED, takes_back_sha: R_SHA })}\n`);
      return { ok: true, release: () => { fixture.calls.released += 1; } };
    };
    const before = readDeploys(fixture.env).length;
    const result = await run(fixture);
    assert.equal(holderTaken, true);
    assert.equal(result.status, 'not-made');
    assert.equal(result.code, 'already-tried');
    assert.equal(readDeploys(fixture.env).length, before + 1, 'only the other process\'s row');
    assert.equal(fixture.calls.scripts.length, 0);
    assert.equal(fixture.calls.released, 1);
  } finally { fixture.cleanup(); }
});

test('D8: a release shipped after the first read is no longer the last, so nothing is taken back', async () => {
  const fixture = setup();
  try {
    fixture.deps.takeHolder = async () => {
      appendFileSync(deploysPath(fixture.env), `${tsvRow(releaseRow({ started: '2026-11-15T10:30:00.000Z', sha: 'd'.repeat(40), live_commit: 'd'.repeat(40), check: '' }))}\n`);
      return { ok: true, release: () => {} };
    };
    const result = await run(fixture);
    assert.equal(result.status, 'not-made');
    assert.equal(result.code, 'not-last');
    assert.equal(fixture.calls.scripts.length, 0);
    assert.equal(readDeploys(fixture.env).length, 3);
  } finally { fixture.cleanup(); }
});

test('D8: the eligibility is read again inside the deploys lock, not before it', async () => {
  const fixture = setup();
  try {
    const order = [];
    const realRows = fixture.deps.readRows;
    let inLock = false;
    fixture.deps.lock = (root, fn, options) => { inLock = true; order.push('lock'); try { return fn(); } finally { inLock = false; } };
    fixture.deps.readRows = () => { order.push(inLock ? 'read-in-lock' : 'read'); return readDeploys(fixture.env); };
    const result = await run(fixture);
    assert.equal(result.status, 'taken-back');
    assert.equal(realRows, undefined);
    const lockAt = order.indexOf('lock');
    assert.ok(lockAt > 0);
    assert.equal(order[lockAt + 1], 'read-in-lock', 'the first thing inside the lock is the eligibility read');
  } finally { fixture.cleanup(); }
});

test('a deploy that is running refuses the take-back, which writes nothing', async () => {
  const fixture = setup([earlierRow(), releaseRow(), { started: '2026-11-15T10:20:00.000Z', sha: 'e'.repeat(40), outcome: 'running', pid: '4242' }]);
  try {
    fixture.deps.alive = (pid) => pid === 4242;
    const result = await run(fixture);
    assert.equal(result.status, 'not-made');
    assert.equal(result.code, 'running');
    assert.equal(fixture.calls.scripts.length, 0);
    assert.equal(readDeploys(fixture.env).length, 3);
  } finally { fixture.cleanup(); }
});

test('a holder that stays busy, or a stop asked while waiting, is a take-back not made with no row', async () => {
  const busy = setup();
  try {
    busy.deps.takeHolder = async () => ({ ok: false, reason: 'the deploy worktree is held by deploy (pid 7) — waited 10 min' });
    const result = await run(busy);
    assert.deepEqual([result.status, result.code], ['not-made', 'held']);
    assert.match(result.why, /waited 10 min/u);
    assert.equal(readDeploys(busy.env).length, 2);
  } finally { busy.cleanup(); }
  const stopped = setup();
  try {
    stopped.deps.stopRequested = () => true;
    const result = await run(stopped);
    assert.deepEqual([result.status, result.code], ['not-made', 'stopped']);
    assert.equal(readDeploys(stopped.env).length, 2);
  } finally { stopped.cleanup(); }
});

test('the holder is released when the script throws', async () => {
  const fixture = setup();
  try {
    fixture.deps.runScript = async () => { throw new Error('spawn exploded'); };
    const result = await run(fixture);
    assert.equal(result.status, 'failed');
    assert.equal(fixture.calls.released, 1);
  } finally { fixture.cleanup(); }
});

test('parseVersions reads the cells as the deploy row keeps them', () => {
  assert.deepEqual(parseVersions('memoro:b2,memoro-tail:missing'), [{ worker: 'memoro', id: 'b2' }, { worker: 'memoro-tail', id: null }]);
  assert.deepEqual(parseVersions(''), []);
});

// ----------------------------------------------------- the reaction (D8, D9, D10)

const mends = (fixture) => readMainMends({ root: fixture.root, repo: 'memoro' });
const ledgerOf = (fixture) => readLedger(fixture.env).entries;
const reaction = (fixture, options = {}) => react({
  started: R_STARTED, env: fixture.env, deps: { alive: () => false, repoPath: '/repo.git', takeBackDeps: fixture.deps, pid: 4000, ...options },
});

test('D8: a red release is taken back, the repair is asked with a member for its red part, and the ledger records both', async () => {
  const fixture = setup();
  try {
    const result = await reaction(fixture);
    assert.equal(result.status, 'taken-back');
    assert.equal(fixture.calls.scripts.length, 1);
    assert.equal(fixture.calls.verb, 'take back');
    const rows = readDeploys(fixture.env);
    assert.equal(rows.at(-1).takes_back, R_STARTED);
    assert.equal(rows.at(-1).holder, `runner, check red of ${R_STARTED}`);
    const members = mends(fixture);
    assert.equal(members.length, 1);
    assert.equal(members[0].file, checkMemberKey('errors', R_STARTED));
    assert.equal(members[0].base, R_SHA);
    assert.deepEqual(members[0].check, { part: 'errors', why: '3 new fingerprints', sha: R_SHA, started: R_STARTED, verdict: verdictPath(fixture.env, R_STARTED), taken_back: true });
    const entry = ledgerOf(fixture)[R_STARTED];
    assert.deepEqual([entry.take_back, entry.desk, entry.done, entry.pid], ['taken-back', 'none', true, null]);
    assert.deepEqual(entry.repair, [members[0].id]);
  } finally { fixture.cleanup(); }
});

test('D8: a second reaction for the row exits at once while the first is alive, and after it is done', async () => {
  const fixture = setup();
  try {
    updateLedger(fixture.env, (entries) => { entries[R_STARTED] = { sha: R_SHA, parts: [], pid: 4242, repair: [], take_back: 'none', desk: 'none', reason: '', steps: [], created: 'x', done: false }; });
    const held = await reaction(fixture, { alive: (pid) => pid === 4242 });
    assert.equal(held.status, 'held');
    assert.equal(fixture.calls.scripts.length, 0);
    assert.equal(mends(fixture).length, 0);
    const first = await reaction(fixture);
    assert.equal(first.status, 'taken-back', 'a dead holder is taken over');
    const again = await reaction(fixture);
    assert.equal(again.status, 'done');
    assert.equal(fixture.calls.scripts.length, 1, 'nothing is taken back twice');
    assert.equal(mends(fixture).length, 1);
  } finally { fixture.cleanup(); }
});

test('D8: a row that is not eligible is never taken back by the runner — no, a take-back row, a later release, not red', async () => {
  const cases = [
    ['a reading of no', [earlierRow(), releaseRow({ take_back: 'no', take_back_why: 'migration-after: 0042' })], 'not-made'],
    ['an empty reading', [earlierRow(), releaseRow({ take_back: '' })], 'not-made'],
    ['a take-back row', [earlierRow(), releaseRow({ takes_back: '2026-11-15T08:00:00.000Z', takes_back_sha: 'c'.repeat(40) })], 'not-made'],
    ['a later release', [earlierRow(), releaseRow(), releaseRow({ started: '2026-11-15T10:30:00.000Z', sha: 'd'.repeat(40), check: '' })], 'not-made'],
  ];
  for (const [name, rows, status] of cases) {
    const fixture = setup(rows);
    try {
      const result = await reaction(fixture);
      assert.equal(result.status, status, name);
      assert.equal(fixture.calls.scripts.length, 0, `${name}: no script`);
      assert.equal(readDeploys(fixture.env).length, rows.length, `${name}: no row`);
      assert.equal(ledgerOf(fixture)[R_STARTED].take_back, 'not-made', name);
      assert.equal(ledgerOf(fixture)[R_STARTED].done, true, name);
      assert.equal(mends(fixture).length, 1, `${name}: the repair is still asked`);
    } finally { fixture.cleanup(); }
  }
});

test('D8: a take-back already in the register — deployed, running or failed — is never made again', async () => {
  const named = (outcome, extra = {}) => ({ started: '2026-11-15T10:50:00.000Z', sha: EARLIER_SHA, outcome, takes_back: R_STARTED, takes_back_sha: R_SHA, pid: '4242', ...extra });
  const deployed = setup([earlierRow(), releaseRow(), named('deployed')]);
  try {
    // R is no longer the last deployed row; a deployed take-back names it, so it counts as taken back.
    assert.equal((await reaction(deployed)).status, 'taken-back');
    assert.equal(deployed.calls.scripts.length, 0);
  } finally { deployed.cleanup(); }
  const running = setup([earlierRow(), releaseRow(), named('running')]);
  try {
    const result = await reaction(running, { alive: (pid) => pid === 4242 });
    assert.equal(result.status, 'untried');
    assert.equal(running.calls.scripts.length, 0);
    assert.equal(ledgerOf(running)[R_STARTED].done, false);
  } finally { running.cleanup(); }
  const failed = setup([earlierRow(), releaseRow(), named('failed', { note: 'memoro-tail was not taken back' })]);
  try {
    const result = await reaction(failed);
    assert.equal(result.status, 'failed');
    assert.equal(failed.calls.scripts.length, 0, 'the runner tries a take-back once');
    const entry = ledgerOf(failed)[R_STARTED];
    assert.equal(entry.desk, 'Martin');
    assert.match(entry.steps.join('\n'), /mc deploy take-back/u);
  } finally { failed.cleanup(); }
});

test('D8: a busy holder, STOP or UPDATE leaves the reaction untried: the entry is not done and no repair is asked', async () => {
  const busy = setup();
  try {
    busy.deps.takeHolder = async () => ({ ok: false, reason: 'the deploy worktree is held by deploy (pid 7) — waited 10 min' });
    const result = await reaction(busy);
    assert.equal(result.status, 'untried');
    assert.equal(ledgerOf(busy)[R_STARTED].done, false);
    assert.equal(ledgerOf(busy)[R_STARTED].pid, null);
    assert.equal(mends(busy).length, 0);
    busy.deps.takeHolder = async () => ({ ok: true, release: () => {} });
    assert.equal((await reaction(busy)).status, 'taken-back', 'a later pass tries again');
  } finally { busy.cleanup(); }
  const stopped = setup();
  try {
    const result = await reaction(stopped, { stopRequested: () => true });
    assert.equal(result.status, 'untried');
    assert.equal(stopped.calls.scripts.length, 0);
    assert.equal(ledgerOf(stopped)[R_STARTED].done, false);
  } finally { stopped.cleanup(); }
});

test('D10: an unreadable ledger is said, and no take-back is made and no repair asked until it reads again', async () => {
  const fixture = setup();
  try {
    writeFileSync(ledgerPath(fixture.env), '{ not json');
    const said = [];
    const result = await react({ started: R_STARTED, env: fixture.env, say: (line) => said.push(line), deps: { alive: () => false, repoPath: '/repo.git', takeBackDeps: fixture.deps } });
    assert.equal(result.status, 'ledger-unreadable');
    assert.match(said.join('\n'), /red ledger .* is not JSON/u);
    assert.equal(fixture.calls.scripts.length, 0);
    assert.equal(mends(fixture).length, 0);
    assert.equal(readFileSync(ledgerPath(fixture.env), 'utf8'), '{ not json', 'an unreadable ledger is not written over');
    assert.match(pendingReds({ env: fixture.env }).error, /not JSON/u);
    assert.deepEqual(deskEntries({ env: fixture.env }).items, [], 'the desk reads it as no entries');
    assert.match(deskEntries({ env: fixture.env }).error, /not JSON/u);
    assert.equal(takeBackTick({ env: fixture.env, start: () => { throw new Error('must not start'); } }).started.length, 0);
    writeFileSync(ledgerPath(fixture.env), JSON.stringify({ version: 2, entries: {} }));
    assert.match(pendingReds({ env: fixture.env }).error, /not a version 1 ledger/u);
  } finally { fixture.cleanup(); }
});

test('D9: the member is keyed by part and release, once-only in any state, and a second release makes its own', async () => {
  const second = '2026-11-15T12:00:00.000Z';
  const rows = [earlierRow(), releaseRow({ check_why: 'errors: 3 new fingerprints; latency: p95 up', take_back: 'no', take_back_why: 'migration-after: 1' }),
    { ...releaseRow({ started: second, sha: 'd'.repeat(40), live_commit: 'd'.repeat(40), versions_before: 'memoro:b2,memoro-tail:t2', versions_made: 'memoro:b3,memoro-tail:t3', check_why: 'errors: boom' }) }];
  const fixture = setup(rows);
  try {
    await reaction(fixture);
    const first = mends(fixture).map((entry) => entry.file).sort();
    assert.deepEqual(first, [checkMemberKey('errors', R_STARTED), checkMemberKey('latency', R_STARTED)].sort(), 'one member per red part');
    assert.equal(mends(fixture).every((entry) => entry.check.taken_back === false), true);
    await react({ started: second, env: fixture.env, deps: { alive: () => false, repoPath: '/repo.git', takeBackDeps: fixture.deps, pid: 4000 } });
    const all = mends(fixture).map((entry) => entry.file);
    assert.equal(all.length, 3);
    assert.ok(all.includes(checkMemberKey('errors', second)), 'a second red release is its own member');
    assert.notEqual(checkMemberKey('errors', second), checkMemberKey('errors', R_STARTED));
  } finally { fixture.cleanup(); }
});

test('D9: a repeat after the members landed — with the ledger populated, or lost — makes nothing new, and the ledger records the ids', async () => {
  const fixture = setup();
  try {
    await reaction(fixture);
    const ids = mends(fixture).map((entry) => entry.id);
    updateMainMends({ root: fixture.root, repo: 'memoro' }, (entries) => { for (const entry of entries) entry.state = 'landed'; });
    assert.equal((await reaction(fixture)).status, 'done');
    assert.deepEqual(mends(fixture).map((entry) => entry.id), ids, 'a populated ledger asks nothing');
    // The crash case: the members exist and are finished, and the ledger has no record of them.
    updateLedger(fixture.env, (entries) => { delete entries[R_STARTED]; });
    updateMainMends({ root: fixture.root, repo: 'memoro' }, (entries) => { entries[0].state = 'dropped'; });
    const result = await reaction(fixture);
    assert.notEqual(result.status, 'untried');
    assert.deepEqual(mends(fixture).map((entry) => entry.id), ids, 'nothing new is created');
    assert.deepEqual(ledgerOf(fixture)[R_STARTED].repair, ids, 'the ledger records the members that exist');
  } finally { fixture.cleanup(); }
});

test('D9: the check member has its own words in the prompt and is not a file for the gate', () => {
  const entry = (back) => ({ id: 'm1', file: checkMemberKey('errors', R_STARTED), base: R_SHA, finder: 'the check', check: { part: 'errors', why: '3 new fingerprints', sha: R_SHA, started: R_STARTED, verdict: '/runner/check/v.json', taken_back: back } });
  const prompt = mainMendPrompt({ repo: 'memoro', entries: [entry(true)], branch: 'mend/main-memoro-x', worktree: '/w' });
  assert.match(prompt, /production's check after the deploy of bbbbbbb/u);
  assert.match(prompt, /3 new fingerprints/u);
  assert.match(prompt, /The release was taken back/u);
  assert.match(prompt, /\/runner\/check\/v\.json/u);
  assert.match(prompt, /Do not deploy/u);
  assert.doesNotMatch(prompt, /mc gate --fresh check:/u);
  assert.match(mainMendPrompt({ repo: 'memoro', entries: [entry(false)], branch: 'b', worktree: '/w' }), /The release was not taken back/u);
});

// ------------------------------------------------------------- the desk's paths

async function deskOf(rows, change = () => {}) {
  const fixture = setup(rows);
  change(fixture);
  const result = await reaction(fixture);
  const entry = ledgerOf(fixture)[R_STARTED];
  return { fixture, result, entry, text: entry.steps.join('\n') };
}

test('D10: a reading of no, with D5 holding, gives the desk --despite and the reading, never a wrangler line', async () => {
  const { fixture, entry, text } = await deskOf([earlierRow(), releaseRow({ take_back: 'no', take_back_why: 'migration-after: 0042' })]);
  try {
    assert.equal(entry.desk, 'Martin');
    assert.match(text, /errors: 3 new fingerprints/u);
    assert.match(text, /Serving now: bbbbbbb/u);
    assert.match(text, /mc deploy take-back --despite "<reason>"/u);
    assert.match(text, /migration-after: 0042/u);
    assert.match(text, /Repair: a main-red mend is open/u);
    assert.doesNotMatch(text, /wrangler/u);
  } finally { fixture.cleanup(); }
});

test('D10: a take-back that failed gives the desk the verb and the Workers by hand, in the deploy worktree', async () => {
  const { fixture, result, entry, text } = await deskOf(undefined, (one) => {
    one.said.workers = [{ worker: 'memoro', from: 'b2', to: 'b1', state: 'taken-back', serving: 'b1', why: 'ok' }, { worker: 'memoro-tail', from: 't2', to: 't1', state: 'failed', serving: 't2', why: 'api down' }];
  });
  try {
    assert.equal(result.status, 'failed');
    assert.equal(entry.take_back, 'failed');
    assert.match(text, /To finish it: mc deploy take-back/u);
    assert.match(text, /npx wrangler rollback b1 --name memoro --message/u);
    assert.match(text, /npx wrangler rollback t1 --name memoro-tail --message/u);
    assert.match(text, new RegExp(deployWorktreePath(fixture.env).replace(/[/.]/gu, '\\$&'), 'u'));
  } finally { fixture.cleanup(); }
});

test('D10: when D5 does not hold the desk is told to ship the repair, with the hand rollback and what it leaves in the record', async () => {
  const { fixture, entry, text } = await deskOf([earlierRow(), releaseRow({ versions_why: 'memoro-tail before: no deployments' })]);
  try {
    assert.equal(entry.take_back, 'not-made');
    assert.equal(entry.desk, 'Martin');
    assert.match(text, /mc cannot take this release back/u);
    assert.match(text, /Ship the repair: mc deploy once the main-red mend has landed and a later commit is green/u);
    assert.match(text, /npx wrangler rollback b1 --name memoro/u);
    assert.match(text, /deploys\.tsv naming the release as live; the next mc deploy reads each Worker's versions from the provider/u);
  } finally { fixture.cleanup(); }
  const unknown = await deskOf([earlierRow(), releaseRow({ versions_before: 'memoro:b1', versions_made: 'memoro:b2,memoro-tail:t2' })]);
  try { assert.match(unknown.text, /npx wrangler deployments list --name memoro-tail/u); } finally { unknown.fixture.cleanup(); }
});

test('D10: a take-back row that checked red has nothing to roll back to — ship the repair', async () => {
  const { fixture, entry, text } = await deskOf([earlierRow(), releaseRow({ takes_back: '2026-11-15T08:00:00.000Z', takes_back_sha: 'c'.repeat(40) })]);
  try {
    assert.equal(entry.desk, 'Martin');
    assert.match(text, /a take-back, which is not taken back/u);
    assert.match(text, /nothing before it to roll back to/u);
  } finally { fixture.cleanup(); }
});

test('D10: a taken-back release, and a later release, put nothing on the desk', async () => {
  const back = await deskOf();
  try { assert.deepEqual([back.entry.desk, back.entry.steps], ['none', []]); } finally { back.fixture.cleanup(); }
  const later = await deskOf([earlierRow(), releaseRow(), releaseRow({ started: '2026-11-15T10:30:00.000Z', sha: 'd'.repeat(40), check: '' })]);
  try { assert.deepEqual([later.entry.take_back, later.entry.desk], ['not-made', 'none']); } finally { later.fixture.cleanup(); }
});

test('D10: a desk entry ends on a later deployed row, or when a person ends it, and not before', async () => {
  const { fixture } = await deskOf([earlierRow(), releaseRow({ take_back: 'no' })]);
  try {
    assert.equal(deskEntries({ env: fixture.env }).items.length, 1);
    assert.equal(deskEntries({ env: fixture.env }).items[0].started, R_STARTED);
    const later = [...readDeploys(fixture.env), { ...releaseRow({ started: '2026-11-15T13:00:00.000Z', sha: 'e'.repeat(40), check: '' }) }];
    const read = deskEntries({ env: fixture.env, rows: later });
    assert.deepEqual([read.items.length, read.ended], [0, [R_STARTED]]);
    takeBackTick({ env: fixture.env, start: () => ({ pid: null }) });
    assert.equal(ledgerOf(fixture)[R_STARTED].desk, 'Martin', 'only the rows on file end an entry');
    endDesk({ env: fixture.env, ended: read.ended });
    assert.equal(ledgerOf(fixture)[R_STARTED].desk, 'ended');
  } finally { fixture.cleanup(); }
  const person = await deskOf([earlierRow(), releaseRow({ take_back: 'no' })]);
  try {
    assert.deepEqual(endDesk({ env: person.fixture.env, started: R_STARTED, reason: 'handled by hand' }), [R_STARTED]);
    const entry = ledgerOf(person.fixture)[R_STARTED];
    assert.deepEqual([entry.desk, entry.ended_reason], ['ended', 'handled by hand']);
    assert.deepEqual(deskEntries({ env: person.fixture.env }).items, []);
    assert.deepEqual(endDesk({ env: person.fixture.env, started: '2020-01-01T00:00:00.000Z' }), []);
  } finally { person.fixture.cleanup(); }
});

// ------------------------------------------------------------ the chore's fallback

test('D8: the fallback begins the ledger, then starts one reaction per red row not done — never one from before it, held, or done', () => {
  const old = releaseRow({ started: '2026-11-14T10:00:00.000Z', check_at: '2026-11-14T10:40:00.000Z' });
  const fixture = setup([earlierRow(), old, releaseRow()]);
  try {
    const started = [];
    const start = ({ started: key }) => { started.push(key); return { pid: 99 }; };
    const first = takeBackTick({ env: fixture.env, start, now: () => new Date('2026-11-15T10:30:00.000Z') });
    assert.deepEqual(first.started, [], 'the first pass only begins the ledger');
    assert.equal(readLedger(fixture.env).from, '2026-11-15T10:30:00.000Z');
    const second = takeBackTick({ env: fixture.env, start, alive: () => false });
    assert.deepEqual(second.started, [R_STARTED], 'a red from before the ledger is not a reaction\'s to make');
    updateLedger(fixture.env, (entries) => { entries[R_STARTED] = { pid: 4242, done: false }; });
    assert.deepEqual(takeBackTick({ env: fixture.env, start, alive: (pid) => pid === 4242 }).started, [], 'a live reaction holds the row');
    updateLedger(fixture.env, (entries) => { entries[R_STARTED] = { pid: null, done: true }; });
    assert.deepEqual(takeBackTick({ env: fixture.env, start, alive: () => false }).started, [], 'a done entry is not started again');
    updateLedger(fixture.env, (entries) => { delete entries[R_STARTED]; });
    assert.deepEqual(takeBackTick({ env: fixture.env, start, stopRequested: () => true, alive: () => false }).started, [], 'nothing starts while STOP is asked');
    assert.deepEqual(takeBackTick({ env: fixture.env, start, updateRequested: () => true, alive: () => false }).started, [], 'nor while UPDATE is');
  } finally { fixture.cleanup(); }
});

test('C11: take-back-run.js exits 2 under MC_HEADLESS=1 before it reads or writes anything', () => {
  const fixture = setup();
  try {
    const script = fileURLToPath(new URL('../../src/mc/take-back-run.js', import.meta.url));
    const result = spawnSync(process.execPath, [script, R_STARTED], { env: { ...process.env, ...fixture.env, MC_HEADLESS: '1' }, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refused to a headless session/u);
    assert.equal(readDeploys(fixture.env).length, 2);
    assert.throws(() => readFileSync(ledgerPath(fixture.env)), /ENOENT/u);
  } finally { fixture.cleanup(); }
});
