import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MC_OWN_TREES, assembleQueue, chooseKind, headlessArgs, helperDue, helperNote, inFlight,
  landingNote, mcOwnFiles, nextBranch, queueFileNames, queueFileText, quotaSeen,
  readSessionOutput, sessionSettings, stackOrder, stepPrompt, strictQueue, tsvHeader, tsvRow,
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
  const plans = [{ project: 'alpha', status: 'ready' }, { project: 'beta', status: 'blocked' }, { project: 'over', status: 'done' }];
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

/**
 * A plan record as `planOf` builds it: the parsed plan, or the reason there
 * isn't one. `status` used to be a field the runner trusted; it is the state of
 * the first unfinished step now, so a fixture makes that step.
 */
function record({ status = 'ready', steps } = {}) {
  const stopped = status === 'blocked';
  return {
    path: 'docs/project/p/x/PLAN.json',
    legacy: false,
    problems: [],
    plan: {
      schema: 'mc-plan',
      version: 1,
      goal: ['One thing.'],
      contract: ['Not without Martin.'],
      out_of_scope: ['Everything else.'],
      success_criteria: [{ met: false, criterion: 'It is done.', check: 'The gate is green.' }],
      documents: [],
      steps: steps || [{
        title: 'The one step',
        status,
        done_when: 'the rail draws',
        instruction: status === 'done' ? [] : ['Do it.'],
        pr: null,
        blocked_by: stopped ? { kind: 'decision', name: 'p-1' } : null,
      }],
    },
  };
}

/**
 * The rule this project exists for, proved without spending a session: an
 * open pull request ends the project's round whatever the plan says. On
 * 2026-09-02T04:33 a 120-minute Opus session rebuilt `action-window` step 4
 * while step 4's work was open as #11241.
 */
test('inFlight: an open pull request beats a ready plan, and names itself', () => {
  const open = [{ number: 11241, title: 'Step 4', headRefName: 'action-window' }];
  const flight = inFlight(open);
  assert.equal(flight.kind, null);
  assert.equal(flight.reason, 'in-flight');
  assert.equal(flight.skip, '#11241 is open (Step 4) — not starting a step');
  assert.deepEqual(flight.prs, open);
  assert.equal(inFlight([]), null);
  assert.equal(inFlight(), null);
});

test('inFlight: a draft counts as open, and the rest are counted', () => {
  assert.equal(
    inFlight([{ number: 9, title: 'Half', isDraft: true }, { number: 10, title: 'Other' }]).skip,
    '#9 is open (draft: Half) (+1 more) — not starting a step',
  );
});

test('chooseKind: an open pull request comes before the plan and before a conflict', () => {
  const open = [{ number: 11246, title: 'Step 4' }];
  assert.equal(chooseKind({ plan: record(), openPrs: open }).reason, 'in-flight');
  assert.equal(chooseKind({ plan: record(), conflicts: ['x.md'], openPrs: open }).reason, 'in-flight');
  assert.equal(chooseKind({ plan: record(), openPrs: [] }).kind, 'step');
});

/** `<name>` is the first branch, so the next one is 2. */
test('nextBranch: the smallest number no branch is using', () => {
  assert.equal(nextBranch('action-window', ['action-window']), 'action-window-2');
  assert.equal(nextBranch('action-window', ['action-window', 'action-window-2', 'action-window-3']), 'action-window-4');
  assert.equal(nextBranch('action-window', new Set(['action-window-2'])), 'action-window-3');
  assert.equal(nextBranch('action-window'), 'action-window-2');
});

test('chooseKind: reconcile beats everything; a ready first step is the only thing that runs', () => {
  assert.equal(chooseKind({ plan: null, conflicts: ['x.md'] }).kind, 'reconcile');
  const ready = chooseKind({ plan: record() });
  assert.equal(ready.kind, 'step');
  assert.equal(ready.index, 0);
  assert.equal(ready.step.title, 'The one step');
  assert.equal(chooseKind({ plan: record({ status: 'done' }) }).skip, 'every step is done');
  assert.equal(chooseKind({ plan: record({ status: 'blocked' }) }).reason, 'blocked');
});

/**
 * The whole admission test, before a session is spent. `status: ready` in a
 * frontmatter used to be all of it, so a plan missing what the role names could
 * still cost ninety minutes.
 */
test('chooseKind: a plan that does not parse, and one still written as markdown, are both refused', () => {
  const broken = record();
  delete broken.plan.out_of_scope;
  const refused = chooseKind({ plan: { ...broken, plan: null, problems: ['out_of_scope: at least one entry'] } });
  assert.equal(refused.kind, null);
  assert.equal(refused.reason, 'unparseable');
  assert.match(refused.skip, /out_of_scope/u);

  const legacy = chooseKind({ plan: { path: 'docs/project/p/x/PLAN.md', legacy: true, plan: null, problems: [] } });
  assert.equal(legacy.reason, 'unmigrated');
  assert.match(legacy.skip, /migrate it to PLAN\.json/u);
});

/** Steps are an order: a later ready step does not jump a stopped one. */
test('chooseKind: the first unfinished step decides, and it is not skipped past', () => {
  const plan = record({
    steps: [
      { title: 'One', status: 'done', done_when: 'x', instruction: [], pr: 1, blocked_by: null },
      { title: 'Two', status: 'blocked', done_when: 'y', instruction: ['do'], pr: null, blocked_by: { kind: 'decision', name: 'p-2' } },
      { title: 'Three', status: 'ready', done_when: 'z', instruction: ['do'], pr: null, blocked_by: null },
    ],
  });
  const choice = chooseKind({ plan });
  assert.equal(choice.kind, null);
  assert.equal(choice.skip, 'step 2 is blocked on decision p-2');
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
 * And the runner has nothing to do with decisions: blocked is not
 * ready, and no answered file anywhere changes that. The plan comes back by
 * being set `ready`.
 */
test('chooseKind: blocked is simply not ready', () => {
  const waiting = chooseKind({ plan: record({ status: 'blocked' }) });
  assert.equal(waiting.kind, null);
  assert.equal(waiting.skip, 'step 1 is blocked on decision p-1');
  assert.deepEqual(
    chooseKind({ plan: record({ status: 'blocked' }), answered: ['/d/a-1.md'] }),
    waiting,
    'an answered decision file is not a parameter any more',
  );
});


test('stepPrompt names the step, its done_when, and what the session may edit', () => {
  const step = { title: 'The hero object', status: 'ready', done_when: 'the object draws in both themes', instruction: ['Do it.'], pr: null, blocked_by: null };
  const p = stepPrompt({
    name: 'x',
    repo: 'memoro',
    planPath: 'docs/project/p/x/PLAN.json',
    planText: '{"schema":"mc-plan"}',
    step,
    index: 1,
    now: new Date('2026-08-29T00:00:00Z'),
  });
  assert.match(p, /`x` workarea of memoro/u);
  assert.match(p, /Your step is `steps\[1\]` — 2, "The hero object"/u);
  assert.match(p, /Done when: the object draws in both themes/u);
  // The boundary is in the prompt as well as the role, because it is what the
  // runner checks on the way back in.
  assert.match(p, /not\nanother step, not the goal, the contract or the scope/u);
  assert.match(p, /set this step to\n`blocked` with `blocked_by:/u, 'it still says how to stop on a question it cannot answer');
  // The two shapes the prompt never stated, and the two a session got wrong on
  // 2026-09-02: `action-window` wrote a `blocked_by` that was not
  // `{ kind, name }` at 10:18, and `msr-track-3` rewrote a criterion's own text
  // at 12:27. Both are checked on the way back in, so both are said here.
  assert.match(p, /its\n`comments` — an array of paragraph strings/u);
  assert.match(p, /"kind": "decision" \| "project", "name"/u);
  assert.match(p, /only `met` is yours/u);
  assert.match(p, /----- PLAN\.json -----\n\{"schema":"mc-plan"\}/u);
  // The runner only ever starts a plan whose first unfinished step is ready, so
  // a step is never handed an answered decision to apply (Martin, 2026-08-29).
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

/**
 * The shell runner's thirteen, and `land_seconds` appended after them: the
 * gate costs 20–35 minutes on memoro where the old `gh pr merge` cost
 * seconds, and a reader of runs.tsv can only see where a night went if the
 * session's time and the landing's are not added up into one cell. Appended
 * and not inserted beside `seconds`, because the header is written once, when
 * the file is created, and the one on this machine still carries thirteen.
 */
test('tsvRow has the shell runner\'s thirteen columns in order, then the landing\'s own time', () => {
  assert.equal(tsvHeader(), 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\tland_seconds');
  const row = tsvRow({ ts: 'T', name: 'n', kind: 'step', exit: 0, seconds: 9, pr: '12', turns: '3', input: '1', output: '2', cacheRead: '3', cacheWrite: '4', session: 's', note: 'success,merged', landSeconds: 1830 });
  assert.equal(row.split('\t').length, 14);
  assert.equal(row, 'T\tn\tstep\t0\t9\t12\t3\t1\t2\t3\t4\ts\tsuccess,merged\t1830');
  assert.equal(tsvRow({ ts: 'T', note: 'a\tb' }).split('\t').length, 14);
  assert.match(tsvRow({ ts: 'T', note: 'timeout' }), /\ttimeout\t-$/u, 'a step that never reached a landing says so');
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
  assert.deepEqual(parseRunArgs([]), { rounds: 0, once: false, merge: true, idleSleep: 600, awake: true, verb: 'run' });
  assert.deepEqual(parseRunArgs(['--rounds', '1', '--once', '--no-merge', '--idle-sleep', '5']), { rounds: 1, once: true, merge: false, idleSleep: 5, awake: true, verb: 'run' });
  assert.equal(parseRunArgs(['--no-caffeinate']).awake, false);
  assert.match(parseRunArgs(['--rounds', 'x']).error, /whole number/u);
  assert.match(parseRunArgs(['--rounds']).error, /needs a value/u);
  assert.match(parseRunArgs(['extra']).error, /unexpected argument/u);
});

test('parseRunArgs: the three orders, and the flags start carries through', () => {
  assert.deepEqual(parseRunArgs(['stop']), { verb: 'stop', force: false });
  assert.deepEqual(parseRunArgs(['stop', '--force']), { verb: 'stop', force: true });
  assert.deepEqual(parseRunArgs(['--update']), { verb: 'update' });

  // `start` is the run, in the background: its flags are parsed here so a typo
  // is answered at the terminal rather than in a log nobody is watching, and
  // passed on untouched because the background runner is the same runner.
  const start = parseRunArgs(['start', '--no-merge', '--rounds', '3']);
  assert.equal(start.verb, 'start');
  assert.equal(start.merge, false);
  assert.equal(start.rounds, 3);
  assert.deepEqual(start.pass, ['--no-merge', '--rounds', '3']);
  assert.match(parseRunArgs(['start', '--rounds', 'x']).error, /whole number/u);

  // An order to a runner that is already up takes nothing else: every flag it
  // could take is a property that runner already has.
  assert.match(parseRunArgs(['--update', '--rounds', '2']).error, /one order on its own/u);
  assert.match(parseRunArgs(['stop', 'now']).error, /unexpected argument/u);
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

/* --------------------------------------------------------------- landing */

const pr = (number, headRefName, baseRefName = 'main') => ({ number, headRefName, baseRefName });

test('stackOrder: one pull request aimed at main is the whole answer', () => {
  assert.deepEqual(stackOrder([]), { ok: true, order: [] });
  const one = pr(77, 'alpha');
  assert.deepEqual(stackOrder([one]), { ok: true, order: [one] });
});

test('stackOrder: a stack is bottom first, whatever order GitHub listed it in', () => {
  const bottom = pr(1, 'm');
  const middle = pr(2, 'm-2', 'm');
  const top = pr(3, 'm-3', 'm-2');
  assert.deepEqual(stackOrder([top, bottom, middle]).order, [bottom, middle, top]);
});

/**
 * The four shapes that are not a stack, and #11250 is the first of them: a
 * pull request based on the branch of #11249, which the runner squash-merged
 * into that branch and logged `success,merged` while main received nothing.
 */
test('stackOrder: what is not a stack lands nothing, and says which', () => {
  const alone = stackOrder([pr(11250, 'msr-track-3-capture', 'msr-track-3-capture-command')]);
  assert.equal(alone.ok, false);
  assert.match(alone.reason, /#11250 is aimed at msr-track-3-capture-command — none of them is aimed at main/u);

  const two = stackOrder([pr(1, 'm'), pr(2, 'm-2')]);
  assert.equal(two.ok, false);
  assert.match(two.reason, /both aimed at main — two stacks, not one/u);

  const fork = stackOrder([pr(1, 'm'), pr(2, 'm-2', 'm'), pr(3, 'm-3', 'm')]);
  assert.equal(fork.ok, false);
  assert.match(fork.reason, /#2 and #3 are both aimed at m — a fork, not a stack/u);

  const cycle = stackOrder([pr(1, 'm'), pr(2, 'm-2', 'm-3'), pr(3, 'm-3', 'm-2')]);
  assert.equal(cycle.ok, false);
  assert.match(cycle.reason, /the bases form a cycle/u);

  const twice = stackOrder([pr(1, 'm'), pr(2, 'm')]);
  assert.equal(twice.ok, false);
  assert.match(twice.reason, /#1 and #2 are both on m/u);
});

test('stackOrder: a base outside the list is not a stack even when one is aimed at main', () => {
  const stray = stackOrder([pr(1, 'm'), pr(2, 'm-2', 'somebody-else')]);
  assert.equal(stray.ok, false);
  assert.match(stray.reason, /#2 is aimed at somebody-else, which is neither main nor another open pull request's branch/u);
});

/**
 * `merged_into` and `off_default` are what the round reports and what the
 * runner reads. Its own "the call returned zero" is not evidence that
 * anything landed on main — a round on #363 said "merged as 7dcbf96" and was
 * right, into the stacked base it was aimed at, and everyone read "on main".
 */
test('landingNote: a merge that did not land on main is not recorded as merged', () => {
  assert.equal(landingNote({ merged: true, merged_into: 'main', default_branch: 'main' }), 'merged');
  assert.equal(landingNote({ merged: true, merged_into: 'msr-track-3', default_branch: 'main', off_default: true }), 'off-main');
  assert.equal(landingNote({ merged: true, merged_into: 'msr-track-3', off_default: false }), 'off-main', 'the base is read even when the round did not flag it');
});

test('landingNote: a red gate is the pull request left open, and says so', () => {
  assert.equal(landingNote({ merged: false, stopped_at: 'red', reason: 'two tests are red' }), 'open,gate-red');
  assert.equal(landingNote({ merged: false, stopped_at: 'lease', reason: 'held' }), 'open,gate-lease');
  assert.equal(landingNote({ merged: false, stopped_at: 'drift' }), 'open,gate-drift');
  assert.equal(landingNote({ merged: false }), 'open,gate-unknown');
  assert.equal(landingNote(null), 'open');
});

test('mcOwnFiles: the two trees a running runner is already holding, and nothing beside them', () => {
  assert.deepEqual(MC_OWN_TREES, ['src/mc/', 'canon/'], 'a third tree needs a line in docs/technical/mc-run.md too');
  assert.deepEqual(mcOwnFiles(['src/mc/run.js', 'docs/technical/mc-run.md']), ['src/mc/run.js']);
  assert.deepEqual(mcOwnFiles(['canon/roles/step.md']), ['canon/roles/step.md']);
  // Prefixes, not substrings: the near misses are real paths in this
  // repository, and each of them would buy a fresh process for nothing.
  assert.deepEqual(mcOwnFiles(['src/mcp/server.js', 'src/adapters/index.js', 'canonical.md', 'tests/mc/run.test.js']), []);
  // GitHub answers `{ path }` objects; the runner asks for the paths. Both
  // shapes, so neither caller has to remember which it holds.
  assert.deepEqual(mcOwnFiles([{ path: 'src/mc/run.js' }, { path: 'README.md' }]), ['src/mc/run.js']);
  assert.deepEqual(mcOwnFiles(null), [], 'no answer is not a reason to hand over');
  assert.deepEqual(mcOwnFiles([undefined, '']), []);
});
