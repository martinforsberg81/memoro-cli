/**
 * The check's three columns in deploys.tsv (src/mc/deploys.js): the migration
 * from each older header, the one write the check makes (`recordCheck`) and
 * what it leaves alone, and the lock that serialises it with every other writer.
 * In-process, a temporary work root, no clock waits: the lock's wait is passed
 * in as zero.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { executeCheck, readVerdictFile, verdictPath } from '../../src/mc/deploy-check.js';
import {
  CHECK_COLUMNS, DEPLOYED, DEPLOYS_HEADER, TAKES_BACK_COLUMNS, deploysPath, isTakeBackRow, parseDeploys, readDeploys, recordCheck,
  recordEnd, recordRefusal, recordStart, takenBackShas, takeBackRowsOf, tsvRow, withDeploysLock,
} from '../../src/mc/deploys.js';
import { deployCheckTick } from '../../src/mc/deploy-check.js';
import { lockPath } from '../../src/mc/runner-lock.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const KEY = { started: '2026-11-15T12:00:00.000Z', sha: SHA };

function workRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mc-deploys-check-'));
  mkdirSync(join(root, 'runner', 'log'), { recursive: true });
  writeFileSync(join(root, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }));
  return { root, env: { MC_WORK_ROOT: root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const upTo = (name) => DEPLOYS_HEADER.slice(0, DEPLOYS_HEADER.indexOf(name) + 1);
/** The six headers the file had before the take-back columns, oldest first. */
const OLDER = [
  upTo('pid').slice(0, -1), // before `pid`
  upTo('pid'),
  upTo('accepted_red'),
  upTo('take_back_why'),
  upTo('versions_why'),
  upTo('check_why'), // the 23-column header: before the take-back's three
];

const rowFor = (header, n) => Object.fromEntries(header.map((name) => [name, name === 'started' ? `2026-11-1${n}T12:00:00.000Z` : `${name}-${n}`]));

test('the check columns follow the versions and the take-back columns come last', () => {
  assert.deepEqual(CHECK_COLUMNS, ['check', 'check_at', 'check_why']);
  assert.deepEqual(TAKES_BACK_COLUMNS, ['takes_back', 'takes_back_sha', 'takes_back_why']);
  assert.deepEqual(DEPLOYS_HEADER.slice(-3), TAKES_BACK_COLUMNS);
  assert.equal(DEPLOYS_HEADER.length, 26);
  assert.equal(DEPLOYS_HEADER.indexOf('versions_why') + 1, DEPLOYS_HEADER.indexOf('check'));
  assert.equal(DEPLOYS_HEADER.indexOf('check_why') + 1, DEPLOYS_HEADER.indexOf('takes_back'));
});

test('a take-back row keeps its three cells, and the readers tell it and what it took back from a release', () => {
  const { env, cleanup } = workRoot();
  try {
    const release = recordStart({ sha: SHA, started: KEY.started, pid: 1 }, env);
    recordEnd(release, { outcome: DEPLOYED }, env);
    const back = recordStart({
      sha: 'b'.repeat(40), started: '2026-11-15T13:00:00.000Z', pid: 2,
      takesBack: { takes_back: KEY.started, takes_back_sha: SHA, takes_back_why: 'frontend: 3 new errors' },
    }, env);
    recordEnd(back, { outcome: 'failed', stopped_at: 'take-back' }, env);
    const rows = readDeploys(env);
    assert.equal(isTakeBackRow(rows[0]), false);
    assert.equal(isTakeBackRow(rows[1]), true);
    assert.deepEqual([rows[1].takes_back, rows[1].takes_back_sha, rows[1].takes_back_why], [KEY.started, SHA, 'frontend: 3 new errors']);
    assert.deepEqual(takenBackShas(rows), [SHA], 'a failed take-back counts too');
    assert.equal(takeBackRowsOf(rows, KEY.started).length, 1);
    assert.equal(takeBackRowsOf(rows, '2026-01-01T00:00:00.000Z').length, 0);
  } finally { cleanup(); }
});

for (const [index, header] of OLDER.entries()) {
  test(`a file with the ${index + 1}${['st', 'nd', 'rd', 'th', 'th', 'th'][index]} older header is rewritten with the current one on the next write, rows kept`, () => {
    const { env, cleanup } = workRoot();
    try {
      const rows = [rowFor(header, 1), rowFor(header, 2)];
      writeFileSync(deploysPath(env), `${header.join('\t')}\n${rows.map((r) => tsvRow(r, header)).join('\n')}\n`);
      recordRefusal({ sha: SHA, holder: 'h', note: 'n', at: '2026-11-16T00:00:00.000Z' }, env);
      const text = readFileSync(deploysPath(env), 'utf8');
      assert.equal(text.split('\n')[0], DEPLOYS_HEADER.join('\t'), 'the current header, once');
      const read = parseDeploys(text);
      assert.equal(read.length, 3);
      for (const [i, original] of rows.entries()) {
        for (const name of header) assert.equal(read[i][name], original[name], `${name} of row ${i + 1} kept`);
        for (const name of DEPLOYS_HEADER.filter((one) => !header.includes(one))) assert.equal(read[i][name], '', `${name} is empty`);
      }
      assert.equal(read[2].outcome, 'refused');
      // And a verdict can be written into a migrated row.
      const key = { started: rows[0].started, sha: rows[0].sha };
      assert.equal(recordCheck(key, { check: 'green', check_at: '2026-11-16T01:00:00.000Z', check_why: '' }, env).written, true);
      assert.equal(readDeploys(env)[0].check, 'green');
    } finally { cleanup(); }
  });
}

test('recordCheck writes the three cells of one row and leaves every other byte of the file as it was', () => {
  const { env, cleanup } = workRoot();
  try {
    const first = recordStart({ sha: SHA, started: KEY.started, pid: 1 }, env);
    recordEnd(first, { outcome: DEPLOYED, ended: '2026-11-15T12:02:00.000Z', live_commit: SHA.slice(0, 7), note: 'a\tnote' }, env);
    recordStart({ sha: 'f'.repeat(40), started: '2026-11-15T13:00:00.000Z', pid: 2 }, env);
    const before = readFileSync(deploysPath(env), 'utf8').split('\n');
    const result = recordCheck(KEY, { check: 'red', check_at: '2026-11-15T12:40:00.000Z', check_why: 'database: down' }, env);
    assert.equal(result.written, true);
    const after = readFileSync(deploysPath(env), 'utf8').split('\n');
    assert.equal(after.length, before.length);
    assert.equal(after[0], before[0]);
    assert.equal(after[2], before[2], 'the other row is byte-equal');
    const at = DEPLOYS_HEADER.indexOf('check');
    const without = (line) => line.split('\t').filter((_, i) => i < at || i >= at + 3).join('\t');
    assert.equal(without(after[1]), without(before[1]), 'every cell but the check columns is byte-equal');
    assert.deepEqual(after[1].split('\t').slice(at, at + 3), ['red', '2026-11-15T12:40:00.000Z', 'database: down']);
    assert.equal(recordCheck({ started: 'nope', sha: SHA }, { check: 'green' }, env).written, false);
    assert.match(recordCheck({ started: 'nope', sha: SHA }, { check: 'green' }, env).why, /not in deploys.tsv/u);
  } finally { cleanup(); }
});

test('recordCheck: a file that changed between its read and its write is read again, never overwritten', () => {
  const { env, cleanup } = workRoot();
  try {
    const key = recordStart({ sha: SHA, started: KEY.started, pid: 1 }, env);
    recordEnd(key, { outcome: DEPLOYED, ended: '2026-11-15T12:02:00.000Z' }, env);
    let raced = 0;
    const result = recordCheck(KEY, { check: 'green', check_at: 'now', check_why: '' }, env, {
      afterRead: () => {
        if (raced++) return;
        // A writer that did not wait for the lock: its refusal is in the file before ours is written.
        const text = readFileSync(deploysPath(env), 'utf8');
        const refusal = { started: '2026-11-15T12:30:00.000Z', ended: '2026-11-15T12:30:00.000Z', sha: 'e'.repeat(40), outcome: 'refused', note: 'raced' };
        writeFileSync(deploysPath(env), `${text}${tsvRow(refusal)}\n`);
      },
    });
    assert.equal(result.written, true);
    assert.equal(raced, 2, 'read twice');
    const rows = readDeploys(env);
    assert.deepEqual(rows.map((row) => row.outcome), ['deployed', 'refused'], 'the refusal is still there');
    assert.equal(rows[0].check, 'green');
    // A file that changes under every attempt is not written at all.
    let every = 0;
    const none = recordCheck({ started: rows[1].started, sha: rows[1].sha }, { check: 'red' }, env, {
      afterRead: () => { every += 1; appendNoise(env, every); },
    });
    assert.equal(none.written, false);
    assert.match(none.why, /changed under every attempt/u);
    assert.equal(every, 3);
    assert.equal(readDeploys(env)[1].check, '', 'nothing of ours is written');
  } finally { cleanup(); }
});

function appendNoise(env, n) {
  const text = readFileSync(deploysPath(env), 'utf8');
  writeFileSync(deploysPath(env), `${text}${tsvRow({ started: `2026-11-16T00:00:0${n}.000Z`, sha: 'd'.repeat(40), outcome: 'refused' })}\n`);
}

test('a lock held by a live pid: recordCheck throws, the verdict file stays, and the chore writes the cells later', async () => {
  const { root, env, cleanup } = workRoot();
  try {
    const key = recordStart({ sha: SHA, started: KEY.started, pid: 1 }, env);
    recordEnd(key, { outcome: DEPLOYED, ended: '2026-11-15T12:02:00.000Z' }, env);
    // Another process holds the lock: the file names a pid that is alive.
    writeFileSync(lockPath(root), String(process.pid + 1));
    const held = { alive: () => true, waitMs: 0 };
    assert.throws(() => recordCheck(KEY, { check: 'green', check_at: 'x', check_why: '' }, env, held), /held by pid/u);
    assert.equal(readDeploys(env)[0].check, '', 'nothing was written');

    // The check's entry: the verdict file is written, the row is not.
    const deps = {
      declare: () => ({ ok: true, declaration: { schema_version: 1, suites: [{ name: 's', argv: ['x'] }], environments: { prod: { base_url: 'https://p.example' } } } }),
      fetch: async (url) => ({ status: 200, text: async () => (url.endsWith('/ping-d1') ? '{"d1":"healthy"}' : JSON.stringify({ commit: SHA.slice(0, 7), commit_full: SHA })) }),
      now: () => Date.parse('2026-11-15T12:40:00.000Z'),
      sleep: async () => {},
      worktreePath: () => '/w',
      readBefore: () => ({ ok: true, survey: { total: 0, returned: 0, fingerprints: [] } }),
      readAfter: async () => ({ ok: true, survey: { total: 0, returned: 0, fingerprints: [] } }),
      suites: {
        takeHolder: async () => ({ ok: true, release: () => {} }), place: () => ({ ok: true }), worktreePath: () => '/w',
        round: async () => ({ results: [{ name: 's', ok: true }] }),
      },
      record: (k, cells, e) => recordCheck(k, cells, e, held),
    };
    const result = await executeCheck({ job: KEY, env, deps });
    assert.equal(result.written, false);
    assert.match(result.why, /held by pid/u);
    assert.equal(readVerdictFile(env, KEY.started).check, 'green');
    assert.ok(existsSync(verdictPath(env, KEY.started)));
    assert.equal(readDeploys(env)[0].check, '');

    // The lock is let go; the chore's next pass copies the verdict into the row.
    rmSync(lockPath(root));
    const tick = deployCheckTick({ env, now: () => Date.parse('2026-11-15T12:41:00.000Z'), start: () => ({ pid: null }), running: () => null });
    assert.match(tick.notes.join('\n'), /restored from its file/u);
    const row = readDeploys(env)[0];
    assert.deepEqual([row.check, row.check_why], ['green', '']);
  } finally { cleanup(); }
});

test('withDeploysLock is taken once: a writer inside it runs inside the hold, and takes no second lock', () => {
  const { root, env, cleanup } = workRoot();
  try {
    const taken = [];
    const lock = (r, fn, options) => { taken.push(options.name); return fn(); };
    withDeploysLock(env, () => {
      recordStart({ sha: SHA, started: KEY.started, pid: 1 }, env);
      recordRefusal({ sha: SHA, note: 'inside' }, env);
      recordCheck({ started: 'none', sha: SHA }, { check: 'green' }, env);
      return null;
    }, { lock, root, name: 'deploy' });
    assert.deepEqual(taken, ['deploy'], 'one lock for the admission and every writer in it');
    assert.equal(readDeploys(env).length, 2);
    // Outside it, each writer takes the lock itself, and takes it again after the first is let go.
    withDeploysLock(env, () => 1, { lock, root });
    withDeploysLock(env, () => 2, { lock, root });
    assert.equal(taken.length, 3);
  } finally { cleanup(); }
});
