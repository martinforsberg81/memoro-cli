/**
 * The repair of a stopped deploy: what a technical stop is, the one request and its joining, the attempts,
 * the retry's bounds, the session's and the desk's answers, and the reading line. The record is a real file
 * under a throwaway root; the runner's lock is a passthrough (the lock itself is `runner-lock.js`'s test).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  answerDeployMend, answerHeldDeployMend, classifyStop, deployMendBranch, deployMendLine, deployMendPath, deployMendReading,
  failDeployMend, gateStopCode, publishDeployMend, readDeployMends, recordRepaired, requestAcceptsRed, requestDeployRepair,
  requestHolder, retryFailed, retryHolder, retryVerdict, updateDeployMends,
} from '../../src/mc/deploy-repair.js';

let root;
const lock = (_root, fn) => fn();
const state = () => ({ root, lock });
const row = (started, extra = {}) => ({ started, sha: 'a'.repeat(40), stopped_at: 'deployer', note: 'wrangler fell over', ...extra });
const read = () => readDeployMends({ root });
const seed = (entries) => { mkdirSync(join(root, 'runner'), { recursive: true }); writeFileSync(deployMendPath(root), JSON.stringify({ version: 1, entries })); };
const entry = (extra = {}) => ({ id: 'req-1', rows: [{ started: '2026-11-15T10:00:00.000Z', holder: 'martin, 2026-11-15T10:00', accept_red: false }], state: 'queued', failures: 0, ...extra });

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'deploy-repair-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('classifyStop: what a technical stop is', () => {
  // One row per stop `mc deploy` writes (commands/deploy.js): the code a refusal sends, and the `failed` rows
  // the deployer ends with (they carry no code; their `stopped_at` names the step). Plus what no code reads as.
  const table = [
    // failed: the deployer's own stops, whatever step stopped it.
    ...['start', 'held', 'fast-forward', 'dirty', 'moved', 'disk', 'deployer'].map((step) => [`a failed row stopped at ${step}`, { outcome: 'failed', code: null }, true]),
    // refused: mc's machinery could not do its part.
    ['git worktree add failed for mc\'s own main (worktree)', { outcome: 'refused', code: 'worktree' }, true],
    ['git status failed where main is (status)', { outcome: 'refused', code: 'status' }, true],
    ['mc\'s own deploy worktree is dirty (own-dirty)', { outcome: 'refused', code: 'own-dirty' }, true],
    ['mc\'s own deploy worktree is ahead of origin/main (own-ahead)', { outcome: 'refused', code: 'own-ahead' }, true],
    ['the preparation failed (prepare)', { outcome: 'refused', code: 'prepare' }, true],
    ['the gate\'s suites could not run (suites)', { outcome: 'refused', code: 'suites' }, true],
    ['a refusal nobody classified', { outcome: 'refused', code: 'something-new' }, true],
    ['a refusal with no code at all', { outcome: 'refused' }, true],
    // refused: nothing in mc's machinery failed.
    ['a usage error (writes no row)', { outcome: 'refused', code: 'usage' }, false],
    ['--dry-run (writes no row)', { outcome: 'refused', code: 'dry-run' }, false],
    ['the headless refusal (writes no row)', { outcome: 'refused', code: 'headless' }, false],
    ['another deploy in progress (running)', { outcome: 'refused', code: 'running' }, false],
    ['a language run in progress (language)', { outcome: 'refused', code: 'language' }, false],
    ['a pick that would move production backwards (backwards)', { outcome: 'refused', code: 'backwards' }, false],
    ['a preparation replaced by a newer one (replaced)', { outcome: 'refused', code: 'replaced' }, false],
    ['a tip nobody measured (unmeasured)', { outcome: 'refused', code: 'unmeasured' }, false],
    ['a red gate suite (red)', { outcome: 'refused', code: 'red' }, false],
    ['main dirty in a worktree that is not mc\'s own (dirty)', { outcome: 'refused', code: 'dirty' }, false],
    ['main ahead in a worktree that is not mc\'s own (ahead)', { outcome: 'refused', code: 'ahead' }, false],
    ['a deployed row', { outcome: 'deployed' }, false],
  ];
  for (const [name, input, technical] of table) {
    it(`${name} is ${technical ? '' : 'not '}technical`, () => assert.equal(classifyStop(input), technical));
  }
  it('a gate whose suites could not run is `suites`, a red suite is `red`', () => {
    assert.equal(gateStopCode({ full: { state: 'green' }, exercise: { suites: [{ state: 'cannot-run' }] } }), 'suites');
    assert.equal(gateStopCode({ full: { state: 'green' }, exercise: { suites: [{ state: 'red' }, { state: 'cannot-run' }] } }), 'red');
    assert.equal(gateStopCode({ full: { state: 'red' }, exercise: { suites: [] } }), 'red');
    assert.equal(gateStopCode({ full: { state: 'unmeasured' } }), 'unmeasured');
  });
});

describe('the request', () => {
  it('a technical stop queues one request with its row and its copied logs', () => {
    const log = join(root, 'deployer.log'); writeFileSync(log, 'boom');
    const result = requestDeployRepair({ ...state(), row: row('2026-11-15T10:00:00.000Z'), holder: 'martin', logs: [{ name: 'deployer.log', path: log }, { name: 'gone.log', path: join(root, 'gone') }] });
    assert.equal(result.joined, false);
    const [request] = read();
    assert.equal(request.state, 'queued');
    assert.equal(request.rows.length, 1);
    assert.deepEqual(request.rows[0].logs, ['deployer.log']);
    assert.equal(readFileSync(join(request.rows[0].copies, 'deployer.log'), 'utf8'), 'boom');
  });

  it('a second technical stop joins the open request and never queues a second', () => {
    requestDeployRepair({ ...state(), row: row('2026-11-15T10:00:00.000Z'), holder: 'first' });
    const second = requestDeployRepair({ ...state(), row: row('2026-11-15T11:00:00.000Z'), holder: 'second', acceptRed: true });
    assert.equal(second.joined, true);
    const entries = read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].rows.length, 2);
    assert.equal(requestAcceptsRed(entries[0]), true, 'any row with --accept-red makes the request carry it');
    assert.equal(requestHolder(entries[0]), 'first', 'the first row names the holder');
    assert.match(retryHolder(entries[0]), /^runner for first, 2026-11-15T11:00:00\.000Z$/u, 'its age counts from the newest row');
  });

  it('the same row twice is one row', () => {
    requestDeployRepair({ ...state(), row: row('2026-11-15T10:00:00.000Z') });
    requestDeployRepair({ ...state(), row: row('2026-11-15T10:00:00.000Z') });
    assert.equal(read()[0].rows.length, 1);
  });

  it('a finished request does not take a later stop: that one is a new request', () => {
    seed([entry({ state: 'deployed' })]);
    requestDeployRepair({ ...state(), row: row('2026-11-16T10:00:00.000Z') });
    assert.equal(read().length, 2);
  });

  it('a failed write never throws and says what failed', () => {
    const result = requestDeployRepair({ ...state(), write: () => { throw new Error('disk full'); }, row: row('2026-11-15T10:00:00.000Z') });
    assert.match(result.skipped, /disk full/u);
    assert.equal(existsSync(deployMendPath(root)), false);
  });

  it('a failed copy still leaves the request', () => {
    const result = requestDeployRepair({ ...state(), copy: () => { throw new Error('no space'); }, row: row('2026-11-15T10:00:00.000Z'), logs: [{ name: 'a.log', path: join(root, 'a.log') }] });
    assert.equal(result.joined, false);
    assert.deepEqual(read()[0].rows[0].logs, []);
  });

  it('unreadable state is reported as unreadable, never as an empty queue', () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(deployMendPath(root), '{ not json');
    assert.ok(deployMendReading({ root }).error);
  });
});

describe('the attempts', () => {
  it('the first failed repair returns the request to the queue, the second puts it on Martin', () => {
    const first = entry({ state: 'running', prs: [{ repo: 'memoro', number: 4, state: 'open' }], waiting: 'handover' });
    failDeployMend(first, 'the PR was closed');
    assert.equal(first.state, 'queued');
    assert.equal(first.failures, 1);
    assert.deepEqual(first.prs, []);
    assert.equal(first.waiting, undefined);
    failDeployMend(first, 'again');
    assert.equal(first.state, 'Martin');
    assert.equal(first.reason, 'again');
  });

  it('a spent retry that did not ship is Martin\'s at once, and marked so it is never retried again', () => {
    const spent = entry({ state: 'retrying', retried: true, waiting: 'green' });
    retryFailed(spent, 'the deployer fell over again');
    assert.equal(spent.state, 'Martin');
    assert.equal(spent.failures, 1);
    assert.equal(spent.retried, true);
    assert.equal(spent.reason, 'the deployer fell over again');
    assert.equal(spent.waiting, undefined);
  });

  it('publish records a pull request per repository on the branch of a running request only', () => {
    const branch = deployMendBranch(entry());
    seed([entry({ state: 'running', branch })]);
    publishDeployMend({ ...state(), repo: 'memoro', branch, pr: 7 });
    publishDeployMend({ ...state(), repo: 'memoro-cli', branch, pr: 8 });
    publishDeployMend({ ...state(), repo: 'memoro', branch: 'mend/other', pr: 9 });
    assert.deepEqual(read()[0].prs, [{ repo: 'memoro', number: 7, state: 'open' }, { repo: 'memoro-cli', number: 8, state: 'open' }]);
  });

  it('the merger\'s answer lands a pull request or fails the attempt', () => {
    seed([entry({ state: 'published', prs: [{ repo: 'memoro', number: 7, state: 'open' }, { repo: 'memoro-cli', number: 8, state: 'open' }] })]);
    answerDeployMend({ ...state(), repo: 'memoro', pr: 7, landed: true });
    assert.equal(read()[0].prs[0].state, 'landed');
    assert.equal(read()[0].state, 'published');
    answerDeployMend({ ...state(), repo: 'memoro-cli', pr: 8, landed: false, reason: 'red in the queue' });
    assert.equal(read()[0].state, 'queued');
    assert.equal(read()[0].reason, 'red in the queue');
  });
});

describe('the one retry: its bounds', () => {
  const now = new Date('2026-11-15T12:00:00.000Z');
  it('an --accept-red request is never retried', () => {
    const verdict = retryVerdict({ entry: entry({ rows: [{ started: '2026-11-15T10:00:00.000Z', accept_red: true }] }), now });
    assert.match(verdict.drop, /accept-red/u);
  });
  it('a request older than 24 hours from its newest row is never retried', () => {
    const verdict = retryVerdict({ entry: entry({ rows: [{ started: '2026-11-14T11:59:00.000Z' }] }), now });
    assert.match(verdict.drop, /24 hours/u);
    assert.equal(retryVerdict({ entry: entry({ rows: [{ started: '2026-11-14T10:00:00.000Z' }, { started: '2026-11-15T09:00:00.000Z' }] }), now }).retry, true);
  });
  it('a deploy that shipped since the stop ends it unretried', () => {
    assert.match(retryVerdict({ entry: entry(), now, shippedSince: (at) => at === '2026-11-15T10:00:00.000Z' }).drop, /shipped since/u);
  });
  it('a landed repair the runner or the pick does not yet hold makes it wait, naming what it waits for', () => {
    assert.deepEqual(retryVerdict({ entry: entry(), now, contained: () => ({ ok: false, why: 'the pick lacks abc', kind: 'green' }) }), { wait: 'the pick lacks abc', waiting: 'green' });
    assert.equal(retryVerdict({ entry: entry(), now, contained: () => ({ ok: false, why: 'runner code' }) }).waiting, 'handover');
  });
  it('a request whose one retry was spent is never retried again, also after the desk requeues it', () => {
    assert.match(retryVerdict({ entry: entry({ state: 'repaired', retried: true }), now }).drop, /one retry/u);
  });
  it('otherwise it retries', () => assert.deepEqual(retryVerdict({ entry: entry(), now }), { retry: true }));
});

describe('the session says repaired', () => {
  const running = () => entry({ state: 'running', prs: [] });
  it('from the session the prompt named, it records repaired', () => {
    seed([running()]);
    const result = recordRepaired({ ...state(), id: 'req-1', reason: 'the stale lock was removed', role: 'mend-session', named: 'req-1' });
    assert.equal(result.ok, true);
    assert.equal(read()[0].state, 'repaired');
    assert.equal(read()[0].repaired_by, 'session');
  });
  for (const [name, role, named] of [['no session', undefined, undefined], ['another role', 'build-session', 'req-1'], ['a session named for another request', 'mend-session', 'req-2']]) {
    it(`from ${name} it exits 2 and writes nothing`, () => {
      seed([running()]);
      const before = readFileSync(deployMendPath(root), 'utf8');
      const result = recordRepaired({ ...state(), id: 'req-1', reason: 'x', role, named });
      assert.equal(result.ok, false);
      assert.equal(result.code, 2);
      assert.equal(readFileSync(deployMendPath(root), 'utf8'), before);
    });
  }
  it('it needs a reason, a running request and no recorded pull request', () => {
    seed([running()]);
    assert.equal(recordRepaired({ ...state(), id: 'req-1', reason: ' ', role: 'mend-session', named: 'req-1' }).code, 2);
    seed([entry({ state: 'queued' })]);
    assert.equal(recordRepaired({ ...state(), id: 'req-1', reason: 'x', role: 'mend-session', named: 'req-1' }).code, 2);
    seed([entry({ state: 'running', prs: [{ repo: 'memoro', number: 1, state: 'open' }] })]);
    assert.equal(recordRepaired({ ...state(), id: 'req-1', reason: 'x', role: 'mend-session', named: 'req-1' }).code, 2);
    assert.equal(read()[0].state, 'running');
  });
});

describe('the desk answers a request held on Martin', () => {
  const held = () => entry({ state: 'Martin', failures: 2, reason: 'two attempts failed' });
  it('requeue gives it two attempts again', () => {
    seed([held()]);
    const result = answerHeldDeployMend({ ...state(), id: 'req-1', verb: 'requeue', reason: 'the cause is known now', role: 'person' });
    assert.equal(result.ok, true);
    assert.equal(read()[0].state, 'queued');
    assert.equal(read()[0].failures, 0);
  });
  it('drop ends it and removes its copies', () => {
    seed([held()]);
    mkdirSync(join(root, 'runner', 'deploy-mend', 'req-1'), { recursive: true });
    assert.equal(answerHeldDeployMend({ ...state(), id: 'req-1', verb: 'drop', reason: 'not worth it', role: 'person' }).ok, true);
    assert.equal(read()[0].state, 'dropped');
    assert.equal(existsSync(join(root, 'runner', 'deploy-mend', 'req-1')), false);
  });
  it('anything else is refused with exit 2 and nothing written', () => {
    seed([entry({ state: 'running' })]);
    const before = readFileSync(deployMendPath(root), 'utf8');
    for (const input of [{ verb: 'requeue', reason: 'x' }, { verb: 'repaired', reason: 'x' }, { verb: 'drop', reason: '' }]) {
      assert.equal(answerHeldDeployMend({ ...state(), id: 'req-1', role: 'person', ...input }).code, 2);
    }
    assert.equal(answerHeldDeployMend({ ...state(), id: 'nope', verb: 'drop', reason: 'x', role: 'person' }).code, 2);
    assert.equal(readFileSync(deployMendPath(root), 'utf8'), before);
  });
});

describe('the reading line', () => {
  const at = { rows: [{ started: '2026-11-15T10:00:00.000Z' }] };
  const cases = [
    [{ state: 'queued' }, 'mc: a repair of the deploy of 2026-11-15 10:00 is queued'],
    [{ state: 'running' }, 'mc: a repair of the deploy of 2026-11-15 10:00 is running'],
    [{ state: 'repaired' }, 'mc: a repair of the deploy of 2026-11-15 10:00 is repaired, waiting for the handover'],
    [{ state: 'repaired', waiting: 'green' }, 'mc: a repair of the deploy of 2026-11-15 10:00 is repaired, waiting for a green commit with the fix'],
    [{ state: 'Martin' }, 'mc: a repair of the deploy of 2026-11-15 10:00 is waiting on Martin'],
    [{ state: 'not-retried', reason: 'a deploy has shipped since the stop' }, 'mc: the deploy of 2026-11-15 10:00 was repaired and not retried — a deploy has shipped since the stop'],
  ];
  for (const [extra, line] of cases) it(`${extra.state}${extra.waiting ? ' (green)' : ''}`, () => assert.equal(deployMendLine({ ...at, ...extra }), line));
  it('a finished request and no request say nothing', () => {
    assert.equal(deployMendLine({ ...at, state: 'deployed' }), null);
    assert.equal(deployMendLine(null), null);
  });
  describe('a not-retried line shows until the next deploy ships (D6)', () => {
    const ended = '2026-11-15T12:00:00.000Z';
    const notRetried = entry({ state: 'not-retried', reason: 'a deploy has shipped since the stop', ended_at: ended });
    const shipped = (at) => [{ started: at, ended: at, outcome: 'deployed' }];
    it('with no deploy shipped since it ended, it is shown', () => {
      seed([notRetried]);
      assert.equal(deployMendReading({ root, deploys: () => [] }).entry.state, 'not-retried');
      assert.equal(deployMendReading({ root, deploys: () => [{ started: '2026-11-15T13:00:00.000Z', outcome: 'failed' }] }).entry.state, 'not-retried', 'a stop is no ship');
      assert.equal(deployMendReading({ root, deploys: () => shipped('2026-11-15T11:00:00.000Z') }).entry.state, 'not-retried', 'a ship before it ended does not hide it');
    });
    it('after a deploy that shipped later, it says nothing', () => {
      seed([notRetried]);
      assert.equal(deployMendReading({ root, deploys: () => shipped('2026-11-15T13:00:00.000Z') }).entry, null);
    });
    it('an open request is shown whatever shipped', () => {
      seed([notRetried, entry({ id: 'req-2', state: 'queued' })]);
      assert.equal(deployMendReading({ root, deploys: () => shipped('2026-11-15T13:00:00.000Z') }).entry.id, 'req-2');
    });
  });

  it('updateDeployMends writes the whole file under the hold it is given', () => {
    let held = 0;
    updateDeployMends({ root, lock: (_r, fn, options) => { held += 1; assert.equal(options.name, 'deploy-mend'); return fn(); } }, (entries) => entries.push(entry()));
    assert.equal(held, 1);
    assert.equal(read().length, 1);
  });
});
