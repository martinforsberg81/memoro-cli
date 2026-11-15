/**
 * The take-back of a release (src/mc/release-take-back.js): the gate's
 * refusals one by one, the admission that is atomic under the deploys lock, the
 * script's call and the row it leaves. Every boundary is faked: no script runs,
 * no Wrangler, no network, no production; the deploys register is a temporary
 * file, and the runner lock the real one on a temporary root.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { deployWorktreePath } from '../../src/mc/deploy-worktree.js';
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
