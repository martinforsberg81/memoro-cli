import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleQueue, chooseKind, headlessArgs, helperDue, helperNote, queueFileNames, queueFileText,
  quotaSeen, readSessionOutput, sessionSettings, stepPrompt, strictQueue, tsvHeader, tsvRow,
} from '../../src/mc/run-plan.js';
import { profileArgs } from '../../src/mc/portrait.js';
import { parseRunArgs } from '../../src/mc/commands/run.js';

test('assembleQueue: queue.md order first, then plans on main it did not name, sorted', () => {
  const queue = '# round\nb\n\na\n# tail\n';
  const plans = [{ project: 'a' }, { project: 'z' }, { project: 'm' }, { project: 'z' }, { project: 'b' }];
  assert.deepEqual(assembleQueue(queue, plans), ['b', 'a', 'm', 'z']);
});

/**
 * A queued name with no plan on main is not queued at all — the runner would
 * only have logged a skip line for it, and nobody reads that (Martin,
 * 2026-08-29). `mc status` is where an unplanned workarea shows.
 */
test('assembleQueue: a name with no plan on main is dropped, not skipped', () => {
  assert.deepEqual(assembleQueue('ghost\nreal\n', [{ project: 'real' }]), ['real']);
  assert.deepEqual(assembleQueue('ghost\n', []), []);
});

/**
 * `~/mc/queue.md` is a strict list (Martin, 2026-08-29: "ett träsk — där ska
 * INTE finnas någonting annat än en lista över vad som ska köras"). The
 * 2026-08-29 file had seven comment lines and twenty names that were already
 * done or had no plan on main.
 */
test('strictQueue: names of projects that still have a step to run, and nothing else', () => {
  const text = '# the queue\n\n## Martin first\nalpha\nover\nghost\nalpha\nbeta\n';
  const plans = [{ project: 'alpha', status: 'ready' }, { project: 'beta', status: 'waiting-decision' }, { project: 'over', status: 'done' }];
  const { names, dropped } = strictQueue(text, plans);
  assert.deepEqual(names, ['alpha', 'beta'], 'a plan that is not ready still has a step ahead of it');
  assert.deepEqual(dropped, [
    { line: '# the queue', why: 'not a project name' },
    { line: '## Martin first', why: 'not a project name' },
    { line: 'over', why: 'the plan is done' },
    { line: 'ghost', why: 'no plan on main' },
    { line: 'alpha', why: 'named twice' },
  ]);
});

test('strictQueue: a blank line is not a drop worth a log line', () => {
  assert.deepEqual(strictQueue('\n\n\n', []), { names: [], dropped: [] });
});

test('queueFileText: one name per line, and an empty file when every name has run', () => {
  assert.equal(queueFileText(['a', 'b']), 'a\nb\n');
  assert.equal(queueFileText([]), '');
  assert.deepEqual(queueFileNames('a\n# no\n\nb\n'), ['a', 'b']);
});

test('chooseKind: reconcile beats everything; ready is the only thing that runs', () => {
  assert.equal(chooseKind({ plan: null, conflicts: ['x.md'] }).kind, 'reconcile');
  assert.equal(chooseKind({ plan: { status: 'ready' } }).kind, 'step');
  assert.equal(chooseKind({ plan: { status: 'done' } }).skip, 'status done');
  assert.equal(chooseKind({ plan: { status: 'blocked' } }).skip, 'status blocked');
  assert.equal(chooseKind({ plan: { status: null } }).skip, 'status missing');
});

/**
 * The runner runs plans; it does not write them (Martin, 2026-08-29). There
 * used to be a `triage` kind here that started a headless session to invent
 * the plan and land it on main by itself.
 */
test('chooseKind: no plan does nothing, and says nothing', () => {
  assert.deepEqual(chooseKind({ plan: null }), { kind: null, skip: null },
    'a null skip is a skip nobody would read — "Ingen skip-rad: vem ska läsa den!?"');
});

/**
 * And the runner has nothing to do with decisions: waiting-decision is not
 * ready, and no answered file anywhere changes that. The plan comes back by
 * being set `ready`.
 */
test('chooseKind: waiting-decision is simply not ready', () => {
  assert.deepEqual(chooseKind({ plan: { status: 'waiting-decision' } }), { kind: null, skip: 'status waiting-decision' });
  assert.deepEqual(
    chooseKind({ plan: { status: 'waiting-decision' }, answered: ['/d/a-1.md'] }),
    { kind: null, skip: 'status waiting-decision' },
    'an answered decision file is not a parameter any more',
  );
});


test('stepPrompt carries the plan text, and nothing about decisions', () => {
  const p = stepPrompt({ name: 'x', repo: 'memoro', planPath: 'docs/project/p/x/PLAN.md', planText: '---\nstatus: ready\n---\n# X', now: new Date('2026-08-29T00:00:00Z') });
  assert.match(p, /`x` workarea of memoro/u);
  assert.match(p, /decisions\/x-2026-08-29\.md/u, 'it still says where a question it cannot answer goes');
  assert.match(p, /----- PLAN\.md -----\n---\nstatus: ready/u);
  // The runner only ever starts a `ready` plan, so a step is never handed an
  // answered decision to apply (Martin, 2026-08-29).
  assert.doesNotMatch(p, /Decisions answered by Martin/u);
});

test('headlessArgs: claude is -p with json output; codex is exec --json', () => {
  const claude = headlessArgs({ toolId: 'claude-code', adapter: { modelArgs: (m) => ['--model', m] }, model: 'opus', instructions: 'PROFILE', prompt: 'do it', profileArgs });
  assert.deepEqual(claude, ['-p', 'do it', '--model', 'opus', '--permission-mode', 'auto', '--append-system-prompt', 'PROFILE', '--output-format', 'json']);
  const codex = headlessArgs({ toolId: 'codex', adapter: { modelArgs: (m) => ['-m', m] }, model: 'o3', instructions: 'PROFILE', prompt: 'do it', profileArgs });
  assert.deepEqual(codex, ['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'o3', '-c', 'instructions="PROFILE"', 'do it']);
  // Never `--full-auto`: workspace-write has no network and no writes outside
  // the working directory, so the step could not push or open its PR — and a
  // workarea's `.git` lives outside it, so it could not even commit.
  assert.equal(codex.includes('--full-auto'), false);
  // No model named means no `-m` at all — the tool's own default, not opus.
  const bare = headlessArgs({ toolId: 'codex', adapter: { modelArgs: (m) => (m ? ['-m', m] : []) }, model: null, instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(bare, ['exec', '--json', '--sandbox', 'danger-full-access', 'do it']);
});

test('readSessionOutput: claude json usage fields, dashes when absent', () => {
  const out = JSON.stringify({ subtype: 'success', num_turns: 7, session_id: 's1', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 } });
  const r = readSessionOutput({ toolId: 'claude-code', stdout: out, exitCode: 0 });
  assert.deepEqual(r, { turns: '7', session: 's1', input: '10', output: '20', cacheRead: '30', cacheWrite: '-', note: 'success', quota: false });
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: 'garbage', exitCode: 1 }).note, 'no-json');
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: '', exitCode: 142, timedOut: true }).note, 'timeout');
});

test('readSessionOutput: a quota answer is logged as quota, never success', () => {
  const out = JSON.stringify({ subtype: 'success', num_turns: 1, result: "You've hit your weekly limit · resets Aug 28 at 3pm" });
  const r = readSessionOutput({ toolId: 'claude-code', stdout: out, exitCode: 1 });
  assert.equal(r.note, 'quota');
  assert.equal(r.quota, true);
  assert.equal(quotaSeen('Rate limit reached'), true);
  assert.equal(quotaSeen('all good'), false);
  // is_error is a failure whatever the subtype says (2026-08-29: "API Error:
  // No response from API" after 83 turns came back subtype success).
  const err = JSON.stringify({ subtype: 'success', is_error: true, num_turns: 83, result: 'API Error: No response from API' });
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: err, exitCode: 1 }).note, 'failed');
  // A finished session whose prose mentions quota is success, not quota.
  const done = JSON.stringify({ subtype: 'success', num_turns: 39, result: 'PR open: the page shows quota rows of the last 24 h' });
  const d = readSessionOutput({ toolId: 'claude-code', stdout: done, exitCode: 0 });
  assert.equal(d.note, 'success');
  assert.equal(d.quota, false);
});

test('readSessionOutput: codex events give what they give', () => {
  const lines = [JSON.stringify({ type: 'thread.started', thread_id: 't9' }), 'not json', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 } })].join('\n');
  const r = readSessionOutput({ toolId: 'codex', stdout: lines, exitCode: 0 });
  assert.deepEqual(r, { turns: '-', session: 't9', input: '5', output: '3', cacheRead: '2', cacheWrite: '-', note: 'success', quota: false });
});

test('tsvRow has the shell runner\'s thirteen columns in order', () => {
  assert.equal(tsvHeader(), 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote');
  const row = tsvRow({ ts: 'T', name: 'n', kind: 'step', exit: 0, seconds: 9, pr: '12', turns: '3', input: '1', output: '2', cacheRead: '3', cacheWrite: '4', session: 's', note: 'success,merged' });
  assert.equal(row.split('\t').length, 13);
  assert.equal(row, 'T\tn\tstep\t0\t9\t12\t3\t1\t2\t3\t4\ts\tsuccess,merged');
  assert.equal(tsvRow({ ts: 'T', note: 'a\tb' }).split('\t').length, 13);
});

test('sessionSettings: frontmatter tool/model/budget_minutes with the runner defaults', () => {
  assert.deepEqual(sessionSettings({}), { tool: 'claude', model: 'opus', budgetMinutes: 90 });
  assert.deepEqual(sessionSettings({ tool: 'codex', model: 'o3', budget_minutes: '30' }), { tool: 'codex', model: 'o3', budgetMinutes: 30 });
  assert.equal(sessionSettings({ budget_minutes: 'lots' }).budgetMinutes, 90);
  // `opus` is claude's alias and nobody else's: a plan on another tool that
  // names no model gets none, and the tool picks its own.
  assert.deepEqual(sessionSettings({ tool: 'codex' }), { tool: 'codex', model: null, budgetMinutes: 90 });
});

test('parseRunArgs: defaults, flags, errors', () => {
  // `awake` defaults to true: a runner waits ten minutes between rounds and
  // this laptop sleeps after one of them on battery, so the default that keeps
  // an unattended run alive is the one nobody has to remember (stay-awake.js).
  assert.deepEqual(parseRunArgs([]), { rounds: 0, once: false, merge: true, idleSleep: 600, awake: true });
  assert.deepEqual(parseRunArgs(['--rounds', '1', '--once', '--no-merge', '--idle-sleep', '5']), { rounds: 1, once: true, merge: false, idleSleep: 5, awake: true });
  assert.equal(parseRunArgs(['--no-caffeinate']).awake, false);
  assert.match(parseRunArgs(['--rounds', 'x']).error, /whole number/u);
  assert.match(parseRunArgs(['--rounds']).error, /needs a value/u);
  assert.match(parseRunArgs(['extra']).error, /unexpected argument/u);
});

/* ------------------------------------------------------------- the helper */

const RUNS = (...rows) => [tsvHeader(), ...rows].join('\n');
const helperRow = (ts, note = 'success,0-proposals') => tsvRow({
  ts, name: 'helper', kind: 'helper', exit: 0, seconds: 120, pr: '-', note,
});

test('helperDue: not before 05:00Z, and only once per UTC day', () => {
  assert.deepEqual(helperDue({ now: new Date('2026-08-29T04:59:59Z') }), { due: false, why: 'not before 05:00Z' });
  assert.equal(helperDue({ now: new Date('2026-08-29T05:00:00Z') }).due, true);

  const today = RUNS(helperRow('2026-08-29T05:01:00Z'));
  assert.equal(helperDue({ tsv: today, now: new Date('2026-08-29T23:00:00Z') }).due, false);
  assert.match(helperDue({ tsv: today, now: new Date('2026-08-29T23:00:00Z') }).why, /already ran today/u);
  assert.equal(helperDue({ tsv: today, now: new Date('2026-08-30T05:00:00Z') }).due, true, 'a new UTC day is a new run');
});

/**
 * The row is the state, and it is written whether the run worked or not:
 * that is the whole of "a failed collect is logged and never retried within
 * the day". A step row for a project called something else must not count.
 */
test('helperDue: a failed run still closes the day, and only a helper row counts', () => {
  const failed = RUNS(helperRow('2026-08-29T05:01:00Z', 'collect-failed'));
  assert.equal(helperDue({ tsv: failed, now: new Date('2026-08-29T12:00:00Z') }).due, false);

  const steps = RUNS(tsvRow({ ts: '2026-08-29T06:00:00Z', name: 'mc-helper', kind: 'step', exit: 0, seconds: 1, pr: '-', note: 'success,merged' }));
  assert.equal(helperDue({ tsv: steps, now: new Date('2026-08-29T12:00:00Z') }).due, true);
});

test('helperNote keeps the success, shape every other row uses', () => {
  assert.equal(helperNote(null), 'collect-failed');
  assert.equal(helperNote({ ok: true, wrote: [] }), 'success,0-proposals');
  assert.equal(helperNote({ ok: true, wrote: [1, 2, 3] }), 'success,3-proposals');
  assert.equal(helperNote({ ok: false, reason: 'no-role' }), 'no-role');
  assert.equal(helperNote({ ok: false, note: 'timeout' }), 'timeout');
});
