import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MC_OWN_TREES, RUN_REFUSALS, WORKAREA_BLOCKS, WORKAREA_BLOCK_NAMES,
  AUTOCOMPACT_TOKENS, SESSION_DEFAULTS, assembleQueue, chooseKind, collectNote, describeSettings, headlessArgs, heldRepair, helperDue,
  inFlight, intakeNote, intakeQueue, landingNote, mcOwnFiles, nextBranch, nextFor, queueFileNames,
  queueFileText, quotaSeen,
  readSessionOutput, repairPrompt, sessionSettings, stackOrder, stepOfPr, stepPrompt, strictQueue,
  tsvHeader, tsvRow,
} from '../../src/mc/run-plan.js';
import { NAME_RE } from '../../src/mc/plan-schema.js';
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

/* --------------------------------------------------------------- the pick */

/**
 * `nextFor` is what replaced the round on 2026-09-08: a lane takes the first
 * name its repository's order offers that nothing is holding, and picks again
 * when that step is over. What these assert is every way a name is passed
 * over, and that the answer is a *name and a kind* rather than a list.
 */
const READY = (steps = [{ title: 'One', status: 'ready', done_when: 'x', instruction: ['do'], pr: null, blocked_by: null }]) => ({
  schema: 'mc-plan',
  version: 1,
  goal: ['One thing.'],
  contract: ['Not without Martin.'],
  out_of_scope: ['The rest.'],
  success_criteria: [{ met: false, criterion: 'It is done.', check: 'The row.' }],
  documents: [],
  steps,
});
const planRow = (project, { repo = 'memoro', plan = READY(), status = 'ready' } = {}) => ({
  repo, programme: 'prog', project, path: `docs/project/prog/${project}/PLAN.json`, legacy: false, plan, problems: [], status,
});
const world = (plans, { queueText = '', prs = [] } = {}) => ({ names: assembleQueue(queueText, plans), plans, prs });

test('nextFor: queue.md order first, then alphabetical, one repository at a time', () => {
  const plans = [planRow('alpha'), planRow('gamma'), planRow('mc-run', { repo: 'memoro-cli' })];
  const seen = world(plans, { queueText: 'gamma\n' });
  assert.deepEqual(nextFor({ repo: 'memoro', world: seen }), { name: 'gamma', kind: 'step', repo: 'memoro' });
  assert.deepEqual(nextFor({ repo: 'memoro-cli', world: seen }), { name: 'mc-run', kind: 'step', repo: 'memoro-cli' });
  // With no repository named — `mc run --once` — the whole order is one lane's.
  assert.equal(nextFor({ world: seen }).name, 'gamma');
});

test('nextFor: a name another lane is holding is passed over, and so is one this pass refused', () => {
  const seen = world([planRow('alpha'), planRow('beta')]);
  assert.equal(nextFor({ repo: 'memoro', world: seen, claimed: new Set(['alpha']) }).name, 'beta');
  assert.equal(nextFor({ repo: 'memoro', world: seen, passed: new Set(['alpha']) }).name, 'beta');
  assert.equal(nextFor({ repo: 'memoro', world: seen, claimed: new Set(['alpha', 'beta']) }), null);
});

test('nextFor: a blocked plan, a done plan and one that does not parse are not picked', () => {
  const blocked = READY([{ title: 'One', status: 'blocked', done_when: 'x', instruction: ['do'], pr: null, blocked_by: { kind: 'decision', name: 'prog-1' } }]);
  const done = READY([{ title: 'One', status: 'done', done_when: 'x', instruction: [], pr: 7, blocked_by: null }]);
  const plans = [
    planRow('a-blocked', { plan: blocked, status: 'blocked' }),
    planRow('b-done', { plan: done, status: 'done' }),
    { ...planRow('c-broken'), plan: null, problems: ['goal: at least one paragraph'], status: 'invalid' },
    planRow('d-ready'),
  ];
  assert.equal(nextFor({ repo: 'memoro', world: world(plans) }).name, 'd-ready');
});

/**
 * An open pull request is work in flight and takes its project out of the
 * pick; a held one whose repair is spent is waiting on a person and does the
 * same. A hold still owed its repair is neither — the runner starts it, and
 * what it starts is a repair.
 */
test('nextFor: in flight, held after its repair, and the repair the runner still owes', () => {
  const plans = [planRow('alpha'), planRow('beta')];
  const open = [{ repo: 'memoro', number: 9, headRefName: 'alpha-2', baseRefName: 'main', isDraft: false, title: 'Step' }];
  assert.equal(nextFor({ repo: 'memoro', world: world(plans, { prs: open }) }).name, 'beta', 'alpha is in flight');

  const held = [{ project: 'alpha', repo: 'memoro', pr: 9, branch: 'alpha-2', reason: 'two tests red', repairs: 1 }];
  assert.equal(nextFor({ repo: 'memoro', world: world(plans, { prs: open }), held }).name, 'beta', 'and its one repair is spent');

  const owed = [{ ...held[0], repairs: 0 }];
  assert.deepEqual(nextFor({ repo: 'memoro', world: world(plans, { prs: open }), held: owed }),
    { name: 'alpha', kind: 'repair', repo: 'memoro' }, 'a repair is a thing the runner starts');
});

/** The page passes its own reading, which has seen a worktree this cannot. */
test('nextFor: a caller\'s own reading decides, and the order is still the runner\'s', () => {
  const plans = [planRow('alpha'), planRow('beta')];
  const state = (name) => ({ runnable: name !== 'alpha', kind: 'step' });
  assert.equal(nextFor({ repo: 'memoro', world: world(plans), state }).name, 'beta');
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

test('chooseKind: an open pull request comes before the plan', () => {
  const open = [{ number: 11246, title: 'Step 4' }];
  assert.equal(chooseKind({ plan: record(), openPrs: open }).reason, 'in-flight');
  assert.equal(chooseKind({ plan: record(), openPrs: [] }).kind, 'step');
});

/** `<name>` is the first branch, so the next one is 2. */
test('nextBranch: the smallest number no branch is using', () => {
  assert.equal(nextBranch('action-window', ['action-window']), 'action-window-2');
  assert.equal(nextBranch('action-window', ['action-window', 'action-window-2', 'action-window-3']), 'action-window-4');
  assert.equal(nextBranch('action-window', new Set(['action-window-2'])), 'action-window-3');
  assert.equal(nextBranch('action-window'), 'action-window-2');
});

/**
 * A conflicted merge used to be the first answer here, before the plan was
 * looked at: `{ kind: 'reconcile' }`. It is not an answer at all any more —
 * the plan decides what the round does, and a conflict is something the step
 * session is told about (`stepPrompt`'s preamble, and the round in run.js).
 */
test('chooseKind: a ready first step is the only thing that runs, conflict or not', () => {
  assert.deepEqual(chooseKind({ plan: null, conflicts: ['x.md'] }), { kind: null, skip: null });
  assert.equal(chooseKind({ plan: record(), conflicts: ['x.md'] }).kind, 'step');
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


/** A three-step plan, the middle step the session's. */
function threeSteps() {
  const step = {
    title: 'The hero object', status: 'ready', done_when: 'the object draws in both themes',
    instruction: ['Draw the hero in the light theme.', 'Then the dark one, from the same tokens.'],
    comments: ['The tokens moved in #12.'], pr: null, blocked_by: null,
  };
  const plan = {
    schema: 'mc-plan',
    version: 1,
    goal: ['The front page has a hero.', 'It draws in both themes.'],
    contract: ['Tokens only, no literal colours.'],
    out_of_scope: ['The footer.'],
    success_criteria: [
      { met: true, criterion: 'The hero draws.', check: 'page.test.js renders it.' },
      { met: false, criterion: 'Both themes.', check: 'A screenshot per theme.' },
    ],
    documents: [{ label: 'The design', path: '../design.md' }],
    runner: { model: 'opus' },
    steps: [
      { title: 'The tokens', status: 'done', done_when: 'the tokens exist', instruction: ['Write the token file by hand.'], comments: [], pr: 12, blocked_by: null },
      step,
      { title: 'The footer link', status: 'ready', done_when: 'the hero links to the footer', instruction: ['Link the footer from the hero.'], comments: [], pr: null, blocked_by: null },
    ],
  };
  return { plan, step };
}

test('stepPrompt names the step, its done_when, and what the session may edit', () => {
  const { plan, step } = threeSteps();
  const p = stepPrompt({
    name: 'x',
    repo: 'memoro',
    planPath: 'docs/project/p/x/PLAN.json',
    plan,
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
  assert.doesNotMatch(p, /merge origin\/main` is in progress/u, 'no conflict, no preamble');
  assert.match(p, /"kind": "decision" \| "project", "name"/u);
  assert.match(p, /only `met` is yours/u);
  assert.match(p, /Your plan is on disk in this worktree at `docs\/project\/p\/x\/PLAN\.json`/u);
  // The runner only ever starts a plan whose first unfinished step is ready, so
  // a step is never handed an answered decision to apply (Martin, 2026-08-29).
  assert.doesNotMatch(p, /Decisions answered by Martin/u);
});

/**
 * The part of the plan the step needs, and not the file: the frozen fields and
 * the criteria in full, the session's own step in full, and every other step
 * as one line. The other steps' instructions are what made the prompt 115k
 * characters for memoro's largest plan (step-cost, step 1).
 */
test('stepPrompt carries its own step in full and every other step as one line', () => {
  const { plan, step } = threeSteps();
  const p = stepPrompt({ name: 'x', repo: 'memoro', planPath: 'docs/project/p/x/PLAN.json', plan, step, index: 1 });
  for (const text of [...plan.goal, ...plan.contract, ...plan.out_of_scope]) assert.ok(p.includes(text), text);
  assert.match(p, /----- success_criteria -----\nsuccess_criteria\[0\] · met: true\ncriterion: The hero draws\.\ncheck: page\.test\.js renders it\./u);
  assert.match(p, /success_criteria\[1\] · met: false\ncriterion: Both themes\.\ncheck: A screenshot per theme\./u);
  assert.match(p, /----- documents -----\n- The design: \.\.\/design\.md/u);
  assert.match(p, /----- runner -----\n\{"model":"opus"\}/u);
  assert.match(p, /----- Your step: steps\[1\] -----\ntitle: The hero object\nstatus: ready\ndone_when: the object draws in both themes\ninstruction:\n\nDraw the hero in the light theme\.\n\nThen the dark one, from the same tokens\.\n\ncomments:\n\nThe tokens moved in #12\.\n\npr: null\nblocked_by: null/u);
  assert.match(p, /----- The other steps -----\nsteps\[0\] · done · The tokens · done when: the tokens exist · PR #12\nsteps\[2\] · ready · The footer link · done when: the hero links to the footer$/u);
  assert.doesNotMatch(p, /Write the token file by hand/u, "steps[0]'s instruction is not in the prompt");
  assert.doesNotMatch(p, /Link the footer from the hero/u, "steps[2]'s instruction is not in the prompt");
  assert.doesNotMatch(p, /"schema"/u, 'the file itself is not in the prompt');
  // A plan without `runner` has no runner heading.
  const bare = stepPrompt({ name: 'x', repo: 'memoro', planPath: 'p', plan: { ...plan, runner: undefined }, step, index: 1 });
  assert.doesNotMatch(bare, /----- runner -----/u);
});

/**
 * What `reconcile` used to be told, told to the session that is going to read
 * that code anyway. The body below the preamble is untouched — the step, its
 * `done_when` and the plan boundary are all still exactly true.
 */
test('stepPrompt: a conflicted worktree is a preamble, and the step is still the job', () => {
  const { plan } = threeSteps();
  const step = { ...plan.steps[1], done_when: 'it draws' };
  plan.steps[1] = step;
  const p = stepPrompt({
    name: 'x', repo: 'memoro', planPath: 'docs/project/p/x/PLAN.json', plan,
    step, index: 1, conflicts: ['src/a.js', 'docs/project/p/x/PLAN.json'],
    now: new Date('2026-09-04T00:00:00Z'),
  });
  assert.match(p, /^A `git merge origin\/main` is in progress in this worktree and stopped on\nconflicts in: src\/a\.js docs\/project\/p\/x\/PLAN\.json\n/u);
  assert.match(p, /It is the first thing you\ndo and not the job/u);
  assert.match(p, /Your step is `steps\[1\]` — 2, "The hero object"/u, 'the body is the same body');
  assert.match(p, /Done when: it draws/u);
  assert.match(p, /----- Your step: steps\[1\] -----\ntitle: The hero object/u);
});

test('headlessArgs: claude is -p with json output; codex is exec --json', () => {
  const claude = headlessArgs({ toolId: 'claude-code', adapter: { modelArgs: (m) => ['--model', m] }, model: 'opus', instructions: 'PROFILE', prompt: 'do it', profileArgs });
  assert.deepEqual(claude, ['-p', 'do it', '--model', 'opus', '--permission-mode', 'acceptEdits', '--autocompact', String(AUTOCOMPACT_TOKENS), '--append-system-prompt', 'PROFILE', '--output-format', 'json']);
  assert.equal(AUTOCOMPACT_TOKENS, 150_000);
  // The helper and intake turns opt out: step-cost's contract leaves them be.
  const helper = headlessArgs({ toolId: 'claude-code', adapter: { modelArgs: (m) => ['--model', m] }, model: 'opus', instructions: 'PROFILE', prompt: 'do it', profileArgs, autocompact: null });
  assert.equal(helper.includes('--autocompact'), false);
  const codex = headlessArgs({ toolId: 'codex', adapter: { modelArgs: (m) => ['-m', m] }, model: 'o3', instructions: 'PROFILE', prompt: 'do it', profileArgs });
  assert.deepEqual(codex, ['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'o3', '-c', 'instructions="PROFILE"', 'do it']);
  assert.equal(codex.includes('--autocompact'), false, 'codex has no such flag');
  // Never `--full-auto`: workspace-write has no network and no writes outside
  // the working directory, so the step could not push or open its PR — and a
  // workarea's `.git` lives outside it, so it could not even commit.
  assert.equal(codex.includes('--full-auto'), false);
  // No model named means no `-m` at all — the tool's own default, not opus.
  const bare = headlessArgs({ toolId: 'codex', adapter: { modelArgs: (m) => (m ? ['-m', m] : []) }, model: null, instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(bare, ['exec', '--json', '--sandbox', 'danger-full-access', 'do it']);
});

/**
 * Ruling 18: a step runs on sonnet at medium effort with an opus advisor. The
 * flags are the adapter's, so this goes through the real claude adapter — a
 * fixture that spelled them would pass with a flag claude does not take.
 */
test('headlessArgs: claude gets --model, --effort and --advisor, and none when unset', async () => {
  const adapter = await import('../../src/adapters/claude-code.js');
  const args = headlessArgs({ toolId: 'claude-code', adapter, model: 'sonnet', effort: 'medium', advisor: 'opus', instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(args.slice(0, 8), ['-p', 'do it', '--model', 'sonnet', '--effort', 'medium', '--advisor', 'opus']);
  assert.equal(args[8], '--permission-mode');
  const repair = headlessArgs({ toolId: 'claude-code', adapter, model: 'opus', effort: null, advisor: null, instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(repair.slice(0, 5), ['-p', 'do it', '--model', 'opus', '--permission-mode']);
  assert.deepEqual(adapter.advisorArgs('off'), [], '`off` is no advisor, not an advisor called off');
  // Codex takes neither, whatever it is handed.
  const codex = headlessArgs({ toolId: 'codex', adapter: { modelArgs: (m) => ['-m', m], effortArgs: () => ['--effort', 'x'], advisorArgs: () => ['--advisor', 'y'] }, model: 'o3', effort: 'high', advisor: 'opus', instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(codex, ['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'o3', 'do it']);
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
test('tsvRow has the shell runner\'s thirteen columns in order, then the landing\'s own time, then the model', () => {
  assert.equal(tsvHeader(), 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\tland_seconds\tmodel');
  const row = tsvRow({ ts: 'T', name: 'n', kind: 'step', exit: 0, seconds: 9, pr: '12', turns: '3', input: '1', output: '2', cacheRead: '3', cacheWrite: '4', session: 's', note: 'success,merged', landSeconds: 1830, model: 'sonnet' });
  assert.equal(row.split('\t').length, 15);
  assert.equal(row, 'T\tn\tstep\t0\t9\t12\t3\t1\t2\t3\t4\ts\tsuccess,merged\t1830\tsonnet');
  assert.equal(tsvRow({ ts: 'T', note: 'a\tb' }).split('\t').length, 15);
  assert.match(tsvRow({ ts: 'T', note: 'timeout' }), /\ttimeout\t-\t-$/u, 'a step that never reached a landing says so, and a row with no model a dash');
});

test('sessionSettings: tool and budget_minutes from the plan, with the runner defaults', () => {
  assert.equal(sessionSettings({}).tool, 'claude');
  assert.equal(sessionSettings({}).budgetMinutes, 90);
  assert.deepEqual(sessionSettings({ tool: 'codex', model: 'o3', budget_minutes: '30' }), { tool: 'codex', model: 'o3', effort: null, advisor: null, budgetMinutes: 30 });
  assert.equal(sessionSettings({ budget_minutes: 'lots' }).budgetMinutes, 90);
});

/**
 * Ruling 18 (2026-09-11): opus at high effort on every turn was what a step
 * cost, so a step is sonnet at medium with opus as its advisor. A repair keeps
 * opus with neither flag. Each key resolves step over plan over default on its
 * own, so a step naming only its effort keeps the plan's model.
 */
test('sessionSettings: step and repair defaults, plan and step overrides, advisor off, codex getting none', () => {
  assert.deepEqual(SESSION_DEFAULTS.step, { model: 'sonnet', effort: 'medium', advisor: 'opus' });
  assert.deepEqual(sessionSettings({}), { tool: 'claude', model: 'sonnet', effort: 'medium', advisor: 'opus', budgetMinutes: 90 });
  assert.deepEqual(sessionSettings(undefined, null, { kind: 'repair' }), { tool: 'claude', model: 'opus', effort: null, advisor: null, budgetMinutes: 90 });

  // The plan overrides the default key by key.
  assert.deepEqual(sessionSettings({ model: 'opus' }), { tool: 'claude', model: 'opus', effort: 'medium', advisor: 'opus', budgetMinutes: 90 });
  assert.deepEqual(sessionSettings({ effort: 'high', advisor: 'sonnet' }, null, { kind: 'repair' }), { tool: 'claude', model: 'opus', effort: 'high', advisor: 'sonnet', budgetMinutes: 90 });

  // The step overrides the plan, again key by key.
  const plan = { model: 'opus', effort: 'low', advisor: 'opus' };
  assert.deepEqual(sessionSettings(plan, { effort: 'xhigh' }), { tool: 'claude', model: 'opus', effort: 'xhigh', advisor: 'opus', budgetMinutes: 90 });
  assert.deepEqual(sessionSettings(plan, { model: 'haiku', effort: null }), { tool: 'claude', model: 'haiku', effort: 'low', advisor: 'opus', budgetMinutes: 90 });

  // `off` at any level is no advisor, and a step can turn off the plan's.
  assert.equal(sessionSettings({ advisor: 'off' }).advisor, null);
  assert.equal(sessionSettings({}, { advisor: 'off' }).advisor, null);
  assert.equal(sessionSettings({ advisor: 'off' }, { advisor: 'opus' }).advisor, 'opus');

  // `sonnet`, `medium` and `opus` are claude's: codex gets no model it did not
  // name, and no effort or advisor even when one is named.
  assert.deepEqual(sessionSettings({ tool: 'codex' }), { tool: 'codex', model: null, effort: null, advisor: null, budgetMinutes: 90 });
  assert.deepEqual(sessionSettings({ tool: 'codex', effort: 'high', advisor: 'opus' }, { model: 'o3' }), { tool: 'codex', model: 'o3', effort: null, advisor: null, budgetMinutes: 90 });
});

test('describeSettings: what the starting line says a session runs on', () => {
  assert.equal(describeSettings('claude', sessionSettings({})), 'claude sonnet · effort medium · advisor opus');
  assert.equal(describeSettings('claude', sessionSettings({}, null, { kind: 'repair' })), 'claude opus');
  assert.equal(describeSettings('codex', sessionSettings({ tool: 'codex' })), 'codex own default model');
});

test('parseRunArgs: defaults, flags, errors', () => {
  // `awake` defaults to true: a runner waits ten minutes between rounds and
  // this laptop sleeps after one of them on battery, so the default that keeps
  // an unattended run alive is the one nobody has to remember (stay-awake.js).
  assert.deepEqual(parseRunArgs([]), { once: false, merge: true, idleSleep: 600, awake: true, verb: 'run' });
  assert.deepEqual(parseRunArgs(['--once', '--no-merge', '--idle-sleep', '5']), { once: true, merge: false, idleSleep: 5, awake: true, verb: 'run' });
  assert.equal(parseRunArgs(['--no-caffeinate']).awake, false);
  assert.match(parseRunArgs(['--idle-sleep', 'x']).error, /whole number of seconds/u);
  assert.match(parseRunArgs(['--idle-sleep']).error, /needs a value/u);
  assert.match(parseRunArgs(['extra']).error, /unexpected argument/u);
});

/**
 * `--rounds N` went with the round on 2026-09-08: a lane takes the next step
 * and picks again, so there is no pass over the queue to count. It is answered
 * by name — the form `mc-cut` gave a retired verb — rather than as an
 * unexpected argument, because the flag was in somebody's muscle memory and in
 * every `mc run start` line ever written down.
 */
test('parseRunArgs: --rounds is retired, and says what to type instead', () => {
  for (const argv of [['--rounds', '3'], ['--rounds=3'], ['--rounds'], ['start', '--rounds', '3']]) {
    assert.match(parseRunArgs(argv).error, /a round no longer exists/u, argv.join(' '));
    assert.match(parseRunArgs(argv).error, /`mc run --once` takes one/u, argv.join(' '));
  }
});

test('parseRunArgs: the three orders, and the flags start carries through', () => {
  assert.deepEqual(parseRunArgs(['stop']), { verb: 'stop', force: false });
  assert.deepEqual(parseRunArgs(['stop', '--force']), { verb: 'stop', force: true });
  assert.deepEqual(parseRunArgs(['--update']), { verb: 'update' });

  // `start` is the run, in the background: its flags are parsed here so a typo
  // is answered at the terminal rather than in a log nobody is watching, and
  // passed on untouched because the background runner is the same runner.
  const start = parseRunArgs(['start', '--no-merge', '--idle-sleep', '30']);
  assert.equal(start.verb, 'start');
  assert.equal(start.merge, false);
  assert.equal(start.idleSleep, 30);
  assert.deepEqual(start.pass, ['--no-merge', '--idle-sleep', '30']);
  assert.match(parseRunArgs(['start', '--idle-sleep', 'x']).error, /whole number of seconds/u);

  // An order to a runner that is already up takes nothing else: every flag it
  // could take is a property that runner already has.
  assert.match(parseRunArgs(['--update', '--idle-sleep', '2']).error, /one order on its own/u);
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

/**
 * Both notes put the outcome first, because `summariseRuns` reads a note that
 * does not start with `success` as a failure — and every helper row written
 * before 2026-09-05 read `memoro,success,0-proposals`, which it counted as one.
 */
test('collectNote and intakeNote keep the success, shape every other row uses', () => {
  const digest = (delta) => ({ data: { delta } });
  assert.equal(collectNote({ repo: 'memoro', digest: null }), 'collect-failed,memoro');
  assert.equal(collectNote({ repo: 'memoro', digest: digest({ first: true }) }), 'success,memoro,first-digest');
  assert.equal(collectNote({ repo: 'memoro-cli', digest: digest({ first: false, fingerprints: [1, 2] }) }), 'success,memoro-cli,2-new');

  assert.equal(intakeNote(null), 'turn-missing');
  assert.equal(intakeNote({ ok: true, wrote: [] }), 'success,0-proposals');
  assert.equal(intakeNote({ ok: true, wrote: [1, 2, 3] }), 'success,3-proposals');
  assert.equal(intakeNote({ ok: false, reason: 'no-role' }), 'no-role');
  assert.equal(intakeNote({ ok: false, note: 'timeout' }), 'timeout');
});

/**
 * The order the inbox drains in. By the date the name carries and not by the
 * name itself: the collector's two generations of filename sort wrongly against
 * each other as strings, which would put every memoro digest ahead of every
 * memoro-cli one whatever day either was written.
 */
test('intakeQueue is oldest first by the date in the name, with dateless names last', () => {
  assert.deepEqual(intakeQueue([
    'errors-memoro-cli-2026-08-31.md',
    'screenshot.png',
    'errors-memoro-2026-09-04.md',
    '.DS_Store',
    'errors-2026-08-29.md',
    'note.md',
  ]), [
    'errors-2026-08-29.md',
    'errors-memoro-cli-2026-08-31.md',
    'errors-memoro-2026-09-04.md',
    // No date in the name, so under its own name, after everything dated.
    'note.md',
    'screenshot.png',
  ]);
  assert.deepEqual(intakeQueue([]), []);
  assert.deepEqual(intakeQueue(['.hidden']), [], 'a dotfile is not an inbox item');
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

/* ------------------------------------------------------------------ repair */

/**
 * A pull request the runner would not land gets one repair session before it
 * becomes a person's. `inFlight` refuses the project either way; the
 * difference is that a repair is somebody doing something about it, and the
 * second round says who is expected to act.
 */
const heldEntry = (over = {}) => ({
  project: 'm', repo: 'memoro', pr: 9, branch: 'm', reason: 'two tests red',
  note: 'open,gate-red', since: '2026-09-03T10:00:00Z', repairs: 0, ...over,
});
const openPr = (number, head) => ({ number, headRefName: head, baseRefName: 'main' });

test('heldRepair: a held pull request with no repair yet is a repair session', () => {
  const entries = [heldEntry()];
  const openPrs = [openPr(9, 'm')];
  const choice = heldRepair({ entries, openPrs, project: 'm', repo: 'memoro' });
  assert.equal(choice.kind, 'repair');
  assert.equal(choice.entry.pr, 9);
  assert.equal(choice.entry.branch, 'm');

  // Another project's hold, and another repository's #9, are not this one's.
  assert.equal(heldRepair({ entries, openPrs, project: 'other', repo: 'memoro' }), null);
  assert.equal(heldRepair({ entries, openPrs, project: 'm', repo: 'memoro-cli' }), null);
  // And a hold whose pull request is not open is not one either — the round
  // reconciles the file, but a lane that could not ask GitHub does not act on
  // a stale entry.
  assert.equal(heldRepair({ entries, openPrs: [openPr(10, 'm-2')], project: 'm', repo: 'memoro' }), null);
  assert.equal(heldRepair({ entries, openPrs: [], project: 'm', repo: 'memoro' }), null);
});

test('heldRepair: the branch comes off GitHub when the entry names none', () => {
  const choice = heldRepair({ entries: [heldEntry({ branch: null })], openPrs: [openPr(9, 'm-4')], project: 'm', repo: 'memoro' });
  assert.equal(choice.entry.branch, 'm-4');
});

test('heldRepair: a pull request already repaired once is the brief\'s, and says so', () => {
  const choice = heldRepair({ entries: [heldEntry({ repairs: 1 })], openPrs: [openPr(9, 'm')], project: 'm', repo: 'memoro' });
  assert.equal(choice.kind, null);
  assert.equal(choice.reason, 'held-after-repair');
  assert.equal(choice.skip, '#9 is held before merge after a repair — the brief\'s');
});

/**
 * A session told `sql:pr-ci — exit 1` and nothing else guesses: on 2026-09-03
 * three rounds were retried on a stale head before anybody knew why. The
 * prompt carries every red test by name and what a failed command gate
 * printed.
 */
test('repairPrompt: the pull request, the branch, the reason, and everything the gate saw', () => {
  const prompt = repairPrompt({
    name: 'm',
    repo: 'memoro',
    pr: 11274,
    branch: 'm-2',
    reason: '2 tests red: tests/a.test.js, tests/b.test.js',
    note: 'open,gate-red',
    red: ['tests/a.test.js > one', 'tests/b.test.js > two'],
    gates: [{ name: 'sql:pr-ci', output: 'admission missing for 0042_x.sql' }],
  });
  assert.match(prompt, /`m` workarea of memoro/u);
  assert.match(prompt, /on branch\n`m-2`, whose pull request #11274 the runner would not land/u);
  assert.match(prompt, /2 tests red: tests\/a\.test\.js/u);
  assert.match(prompt, /The 2 tests the gate found red, all of them:\n {2}tests\/a\.test\.js > one\n {2}tests\/b\.test\.js > two/u);
  assert.match(prompt, /The gate `sql:pr-ci` failed\. What it printed:\n {2}admission missing for 0042_x\.sql/u);
  assert.match(prompt, /Make it green and push to the same branch/u);
  assert.match(prompt, /do not delete or skip a test to pass/u);
  assert.match(prompt, /set the step this pull request carries to `blocked`|Set the step this pull/u);
  assert.match(prompt, /the one repair session this pull request gets/u);
  assert.doesNotMatch(prompt, /plan boundary/u, 'the trespass paragraph is for a trespass');
});

test('repairPrompt: a plan trespass is told which change to undo', () => {
  const prompt = repairPrompt({
    name: 'm', repo: 'memoro', pr: 9, branch: 'm', note: 'plan-trespass',
    reason: 'the session changed more of the plan than its step: goal: a step session does not change it',
  });
  assert.match(prompt, /goal: a step session does not change it/u);
  assert.match(prompt, /The problems above are the plan boundary/u);
  assert.match(prompt, /undo the change to any step that\nis not the one this pull request carries/u);
});

test('stepOfPr: the step that names the pull request, and the deliverable one before it does', () => {
  const { plan } = record({
    steps: [
      { title: 'one', status: 'done', done_when: 'a', instruction: [], pr: 501, blocked_by: null },
      { title: 'two', status: 'done', done_when: 'b', instruction: [], pr: 502, blocked_by: null },
      { title: 'three', status: 'ready', done_when: 'c', instruction: ['do'], pr: null, blocked_by: null },
    ],
  });
  assert.equal(stepOfPr(plan, 502), 1, 'the step whose session already wrote its own pr');
  assert.equal(stepOfPr(plan, 503), 2, 'before that edit has landed, the step the runner would hand out');
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

/**
 * Which refusals block a step on `main` and which the lane waits out — the
 * distinction ruling 17 turns on, held as a list rather than as a habit.
 *
 * The blocking ones are facts a person has to act on: nothing the runner does
 * next changes them, so meeting one again in ten minutes is the failure this
 * project exists to end. The rest are about this moment — the network, the
 * quota, a pull request somebody is still working on — and there the lane
 * waits and asks the same question again.
 */
test('WORKAREA_BLOCKS: the persistent refusals, under names a plan can carry', () => {
  assert.deepEqual(Object.keys(WORKAREA_BLOCKS).sort(),
    ['branch', 'dirty', 'held-after-repair', 'role-missing', 'sync', 'tool-missing', 'worktree']);
  // Every key is a word the runner already refuses in, so the two lists cannot
  // drift into naming different things.
  const refusals = RUN_REFUSALS.map((item) => item.reason);
  for (const reason of Object.keys(WORKAREA_BLOCKS)) assert.ok(refusals.includes(reason), `${reason} is a refusal`);
  // And every name is a name by the schema's own rule — a blocker name that is
  // not one is a plan nothing can look up (plan-schema.js).
  for (const name of WORKAREA_BLOCK_NAMES) assert.match(name, NAME_RE);
  // The transient ones, named here so that adding one to the map is a test
  // failure rather than a project parked on a bad network.
  for (const reason of ['stop', 'prs-unknown', 'in-flight']) {
    assert.equal(WORKAREA_BLOCKS[reason], undefined, `${reason} is about this moment, not about the project`);
  }
});

// `lanes` and its `--total` form are parsed and printed in
// tests/mc/commands/run-lanes.test.js, beside the verb they belong to.
