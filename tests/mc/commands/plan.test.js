/**
 * `mc plan [<programme>]` — the picker, the directory a planning session gets,
 * and the prompt and overlay it is handed, assembled without starting
 * anything; plus the launch shape through a stubbed spawn: the role overlay
 * behind the shared text, the first prompt as the last word, never `--resume`.
 *
 * The one rule underneath all of it: what `mc plan` makes is never something
 * `mc run` can see. That is asserted here as a path — `plan/<programme>`, one
 * level below the work root — because it is the whole reason the directory
 * moved.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BRANCH_LINE, ensurePlanArea, openPlanAreas, planArea, planBranch, planLaunch, programmeLabel, programmeRows, run,
} from '../../../src/mc/commands/plan.js';
import { profileArgs } from '../../../src/mc/portrait.js';
import { instructionsFor, readCanonRole, sharedRoleText } from '../../../src/mc/roles.js';
import { PLAN_ROLE } from '../../../src/mc/goals.js';
import { openInWorkArea } from '../../../src/mc/work-open.js';
import { runMcCli } from '../_helpers/mc-cli.js';

function sink() {
  const out = { text: '' };
  return { out, write: (s) => { out.text += s; } };
}

const REPOS = [
  { name: 'memoro', path: '/repos/memoro' },
  { name: 'memoro-cli', path: '/repos/memoro-cli' },
];

describe('the plan role', () => {
  it('is the model and the tools, and a body of its own', () => {
    const role = readCanonRole(PLAN_ROLE);
    assert.equal(role.name, 'plan-session');
    // `fable`, not `opus` (Martin, 2026-09-04). mc passes `--model` through
    // unvalidated, so the word has to be one the tool accepts: `claude --model
    // fable` was run and resolved to `claude-fable-5-1`.
    assert.equal(role.model, 'fable');
    assert.deepEqual(role.tools, ['claude', 'codex']);
    assert.ok(role.overlay, 'the plan role has no overlay body');
  });

  /**
   * What the body is for (Martin, 2026-11-03): the programme's aim in its
   * README, and full freedom toward it, a goal's branch included. Interactive,
   * no restrictions; headless, never Martin's acts. The ban a headless plan
   * session had — no code, no commit, no publish, no `review` or `done` — and
   * its list of three allowed ends are gone.
   */
  it('says the session drives the programme toward the README aim, interactive and headless', () => {
    const told = instructionsFor('claude-code', readCanonRole(PLAN_ROLE).overlay).replace(/\s+/gu, ' ');
    assert.match(told, /~\/mc\/programs\/<programme>\/README\.md/u);
    assert.match(told, /full freedom/u);
    assert.match(told, /taking over a goal's branch and finishing the work there/u);
    assert.match(told, /A goal \(`GOAL\.json`, written with the `mc goal` verbs\) is what `mc build goal` runs\. It is a means toward the aim, not the aim itself/u);
    assert.match(told, /\*\*Interactive\.\*\*.*you have no restrictions/u);
    assert.match(told, /`mc deploy`, production data, credentials and `--admin` are Martin's acts and happen only in an interactive session\. A headless session never does them/u);
    assert.match(told, /You move a stage forward only; mc refuses a session's move back/u);
    assert.match(told, /not a runner area/u);
    for (const ban of [/Never write code/u, /no `git commit`/u, /no `mc publish`/u, /Never `--status done`/u, /end with exactly one of/u, /read it, never write in it/u]) {
      assert.doesNotMatch(told, ban);
    }
  });

  // The goal-writing rules are not restated in the role file: they are the
  // verb file `canon/roles/brief.md` carries too, pulled in at assembly.
  it('carries the goal-writing rules by reference, not by copy', () => {
    const { overlay } = readCanonRole(PLAN_ROLE);
    assert.match(overlay, /^@include goal-verb\.md$/mu);
    assert.doesNotMatch(overlay, /\*\*Written by verbs\.\*\*/u);
    const told = instructionsFor('claude-code', overlay);
    assert.match(told, /\*\*Written by verbs\.\*\*/u);
    assert.doesNotMatch(told, /@include/u);
  });

  // A body that is missing is a session told nothing, so the verb refuses
  // rather than launching — the same refusal `mc brief` and `mc worker` make.
  it('is refused when the install has no body for it', async () => {
    const stdout = sink();
    const stderr = sink();
    const code = await run(['msr-core'], {
      stdout,
      stderr,
      repos: REPOS,
      role: () => ({ name: 'plan', model: 'fable', tools: ['claude'], overlay: null }),
      ensure: () => { throw new Error('must not reach the area'); },
      open: () => { throw new Error('must not launch'); },
    });
    assert.equal(code, 1);
    assert.match(stderr.out.text, /canon\/roles\/plan-session\.md with an overlay body/u);
  });
});

describe('where a planning session lives', () => {
  // The assertion this file exists for. `mc run`'s `workareas()` and
  // `mc status`'s `areasWithCheckout()` both list top-level directories under
  // the work root that hold a checkout; a planning session is one level below
  // that, so neither can reach it — and no rule about names has to hold.
  it('is under plan/, never a workarea, on its own branch', () => {
    assert.equal(planArea('msr-core'), 'plan/msr-core');
    assert.equal(planBranch('msr-core'), 'plan/msr-core');
    assert.ok(planArea('msr-core').includes('/'), 'a planning session is not a top-level directory');
  });

  /** An isolated work root that holds `runner/layout.json` saying layout 2. */
  function layoutTwoRoot() {
    const root = mkdtempSync(join(tmpdir(), 'mc-plan-layout2-'));
    mkdirSync(join(root, 'runner'));
    writeFileSync(join(root, 'runner', 'layout.json'), '{"schema":"mc-layout","version":2}\n');
    return root;
  }

  it('in layout 2 is under programs/, on the same branch', () => {
    const env = { MC_WORK_ROOT: layoutTwoRoot() };
    assert.equal(planArea('msr-core', env), 'programs/msr-core');
    assert.equal(planBranch('msr-core'), 'plan/msr-core');
  });

  it('in layout 2 is "being planned" only where a checkout stands', () => {
    const root = layoutTwoRoot();
    const env = { MC_WORK_ROOT: root };
    // A programme's directory with only its goals in it has no checkout.
    mkdirSync(join(root, 'programs', 'goals-only', 'goals', 'g'), { recursive: true });
    writeFileSync(join(root, 'programs', 'goals-only', 'goals', 'g', 'GOAL.json'), '{}\n');
    mkdirSync(join(root, 'programs', 'planned', 'memoro'), { recursive: true });
    writeFileSync(join(root, 'programs', 'planned', 'memoro', '.git'), 'gitdir: elsewhere\n');
    assert.deepEqual(openPlanAreas(env), ['planned']);
  });

  it('in layout 2 names the programs/ directory and says where the goals are', () => {
    const env = { MC_WORK_ROOT: layoutTwoRoot() };
    const { prompt } = planLaunch({ programme: 'msr-core', repos: ['memoro'], role: readCanonRole(PLAN_ROLE), env });
    assert.match(prompt, /~\/mc\/programs\/msr-core\//u);
    assert.match(prompt, /Your programme's goals are under `goals\/`, each with its GOAL\.json and LOG\.md/u);
  });

  it('in layout 1 says nothing about goals beside the session', () => {
    const { prompt } = planLaunch({ programme: 'msr-core', repos: ['memoro'], role: readCanonRole(PLAN_ROLE), env: { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-plan-layout1-')) } });
    assert.match(prompt, /~\/mc\/plan\/msr-core\//u);
    assert.doesNotMatch(prompt, /goals are under `goals\/`/u);
  });
});

describe('the picker', () => {
  /**
   * An empty work root of this test's own, and `MC_WORK_ROOT` is the key that
   * makes it one.
   *
   * This used to name `MC_HOME`, which reads as isolation and is not:
   * `programmeRows` asks `openPlanAreas`, which resolves `MC_WORK_ROOT` and
   * falls back to `homedir()/mc` when the object it was handed carries none.
   * So the picker read the user's real `~/mc/plan/`, and the test passed only
   * while that directory was empty. It stopped being empty the first time
   * somebody ran `mc plan`, and the assertion then failed on a machine rather
   * than on a change.
   *
   * `tests/_isolate-home.mjs` cannot catch this. It points `process.env` at a
   * throwaway directory, and a caller passing its own env object never looks
   * there — the literal has to carry the key itself.
   */
  const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-plan-picker-')) };

  const read = (repo) => (repo.name === 'memoro'
    ? { programmes: ['entity-detail', 'msr-core'] }
    : { programmes: ['mc'] });

  it('offers every programme on main in either repository', () => {
    const rows = programmeRows({ repos: REPOS, env, read });
    assert.deepEqual(rows.map((r) => r.name), ['entity-detail', 'mc', 'msr-core']);
    assert.deepEqual(rows.find((r) => r.name === 'mc').repos, ['memoro-cli']);
  });

  it('labels a programme with the repositories that hold it, and counts no projects', () => {
    const rows = programmeRows({ repos: REPOS, env, read });
    assert.equal(programmeLabel(rows.find((r) => r.name === 'msr-core')), 'msr-core  —  memoro');
  });
});

const BRANCH_RULE = BRANCH_LINE;

describe('the prompt', () => {
  it('names the programme and where it stands — and waits for Martin', () => {
    const launch = planLaunch({
      programme: 'msr-core', repos: ['memoro', 'memoro-cli'], role: readCanonRole(PLAN_ROLE),
    });
    assert.match(launch.prompt, /plan session for the `msr-core` programme/u);
    // Martin 2026-11-03: the aim and the freedom, not a list of what is the runner's.
    assert.match(launch.prompt, /aim is in `~\/mc\/plan\/msr-core\/README\.md`; read it first/u);
    assert.match(launch.prompt, /full freedom toward that aim/u);
    assert.ok(!/\bonly through\b|\bnever `<project>`|the runner's\./u.test(launch.prompt), launch.prompt);
    assert.match(launch.prompt, /~\/mc\/plan\/msr-core\//u);
    assert.match(launch.prompt, /`memoro\/` and `memoro-cli\/`/u);
    assert.match(launch.prompt, /branch `plan\/msr-core`/u);
    assert.match(launch.prompt, /not a runner area/u);
    // No reading list and no report asked for: Martin opens (2026-09-13).
    assert.match(launch.prompt, /Wait for him\./u);
    assert.ok(!launch.prompt.includes('docs/project/'), launch.prompt);
    assert.ok(!/say what\s+you found/u.test(launch.prompt), launch.prompt);
    assert.equal(launch.model, 'fable');
    assert.equal(launch.overlay, readCanonRole(PLAN_ROLE).overlay);
  });

  // The assertion that keeps this prompt from growing back. None of these is
  // knowable when the session opens: how many goals the programme needs,
  // what they are called, whether a plan comes out of it at all, or by what
  // route it reaches main. A prompt that answers them in advance is guessing.
  //
  // Asserted on the prompt whole now. It used to have `canon/roles/_common.md`
  // pasted into it — the only way a role with no overlay could inherit the
  // rules every session gets — and that had to be subtracted before the guard
  // could look. The role has a body since #656, so the shared text arrives
  // through `instructionsFor` like everyone else's and this is the prompt and
  // nothing but.
  //
  // The one line exempt is the branch rule (2026-10-18, `mc-ownership`): it
  // says which name a plan's pull request may not take, not that one comes.
  it('predicts nothing about the deliverable or how it lands', () => {
    const { prompt } = planLaunch({
      programme: 'msr-core', repos: ['memoro', 'memoro-cli'], role: readCanonRole(PLAN_ROLE),
    });
    assert.ok(!prompt.includes(sharedRoleText()), 'the shared text is the overlay\'s to carry now');
    const rest = prompt.split('\n').filter((line) => line !== BRANCH_RULE).join('\n');
    for (const guess of ['PLAN.json', '<project>', 'PR', 'pull request', 'mc merge', 'push', 'programme document', 'Then stop']) {
      assert.ok(!rest.includes(guess), `the prompt should not predict "${guess}": ${prompt}`);
    }
  });

  // A planning session opened its pull request from a branch named after the
  // work and held it in a scratchpad worktree (`morning-calls`, 2026-10-14).
  it('names the session\'s own branch `plan/<slug>`, never a goal\'s', () => {
    const { prompt } = planLaunch({ programme: 'msr-core', repos: ['memoro'], role: readCanonRole(PLAN_ROLE) });
    assert.ok(prompt.split('\n').includes(BRANCH_RULE), prompt);
  });

  // The rules every role session shares reach this one the way they reach the
  // other seven: on the overlay, through the single door. Told twice is the
  // failure this replaced — the prompt pasting them in *and* the role
  // inheriting them.
  it('leaves the shared text to the overlay, and is told it exactly once', () => {
    const launch = planLaunch({
      programme: 'msr-core', repos: ['memoro', 'memoro-cli'], role: readCanonRole(PLAN_ROLE),
    });
    const told = instructionsFor('claude-code', launch.overlay);
    const shared = sharedRoleText();
    assert.ok(told.includes(shared), told);
    assert.equal(told.split(shared).length - 1, 1, 'the shared text should appear once');
    assert.ok(!launch.prompt.includes(shared), launch.prompt);
  });

  it('names only the checkout it actually got', () => {
    const launch = planLaunch({ programme: 'mc', repos: ['memoro-cli'], role: readCanonRole(PLAN_ROLE) });
    assert.match(launch.prompt, /with `memoro-cli\/` beside you/u);
    assert.ok(!launch.prompt.includes('`memoro/`'));
  });
});

describe('the launch', () => {
  it('hands over the role instructions and the prompt last, with no --resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-plan-'));
    const areaRoot = join(root, 'area');
    mkdirSync(areaRoot);
    const calls = [];
    const launch = planLaunch({ programme: 'x', repos: ['memoro'], role: readCanonRole(PLAN_ROLE) });
    const result = await openInWorkArea({
      areaRoot,
      worktree: { repo: null, path: areaRoot, is_git: false },
      tool: 'claude',
      pick: 'new',
      overlay: launch.overlay,
      prompt: launch.prompt,
      defaultModel: 'opus',
      defaultModelTool: 'claude',
      verb: 'plan',
      programme: 'x',
      register: () => () => {},
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') },
      spawn: (bin, args, options) => { calls.push({ bin, args, options }); return { status: 0 }; },
    });
    assert.equal(result.ok, true);
    const [call] = calls;
    assert.deepEqual(call.args.slice(0, 2), ['--model', 'opus']);
    assert.equal(call.args[2], '--append-system-prompt');
    // The shared text, then the role's own body — the same
    // assembly every other role session gets, which this one did not have
    // until `canon/roles/plan.md` grew one.
    assert.equal(call.args[3], instructionsFor('claude-code', launch.overlay));
    assert.ok(call.args[3].startsWith(sharedRoleText()), 'nothing in front of the shared text');
    assert.match(call.args[3], /You are the plan session for one programme/u);
    assert.equal(call.args.at(-1), launch.prompt);
    assert.ok(!call.args.includes('--resume'));
    assert.equal(call.options.stdio, 'inherit');
  });

  // `--codex` is the same launch with a different instruction channel. Asserted
  // on the argv rather than through `openInWorkArea`, because resolving the
  // codex launch needs the codex binary and a test must not depend on one.
  it('reaches codex through `-c instructions=`', () => {
    const launch = planLaunch({ programme: 'x', repos: ['memoro'], role: readCanonRole(PLAN_ROLE) });
    const args = profileArgs('codex', instructionsFor('codex', launch.overlay));
    assert.equal(args[0], '-c');
    assert.match(args[1], /^instructions=/u);
    // The same text claude gets, but for where each tool installs a skill the
    // role names: `~/.agents/skills/` for codex, `~/.claude/skills/` for claude.
    const told = JSON.parse(args[1].slice('instructions='.length));
    assert.equal(told, instructionsFor('codex', launch.overlay));
    assert.match(told, /~\/\.agents\/skills\/mc-publish-and-merge\/SKILL\.md/u);
    assert.equal(told.replaceAll('~/.agents/skills/', '~/.claude/skills/'), instructionsFor('claude-code', launch.overlay));
  });

  it('opens the programme directory itself, not one of its checkouts', async () => {
    const opened = [];
    const code = await run(['msr-core'], {
      stdout: sink(),
      stderr: sink(),
      repos: REPOS,
      ensure: () => ({ ok: true, path: '/work/plan/msr-core', repos: ['memoro', 'memoro-cli'] }),
      open: (options) => { opened.push(options); return { ok: true, code: 0 }; },
    });
    assert.equal(code, 0);
    assert.equal(opened[0].areaRoot, '/work/plan/msr-core');
    assert.equal(opened[0].worktree.path, '/work/plan/msr-core');
    assert.equal(opened[0].areaName, 'plan/msr-core');
    assert.equal(opened[0].programme, 'msr-core');
    assert.equal(opened[0].roleName, PLAN_ROLE);
    // The session already in the directory is picked up, with no intro;
    // `pick: null` is `openInWorkArea`'s "the most recent one here, else new".
    assert.equal(opened[0].pick, null);
  });

  it('--new starts another conversation instead of resuming', async () => {
    const opened = [];
    const code = await run(['msr-core', '--new'], {
      stdout: sink(),
      stderr: sink(),
      repos: REPOS,
      ensure: () => ({ ok: true, path: '/work/plan/msr-core', repos: ['memoro', 'memoro-cli'] }),
      open: (options) => { opened.push(options); return { ok: true, code: 0 }; },
    });
    assert.equal(code, 0);
    assert.equal(opened[0].pick, 'new');
  });
});

describe('what it refuses', () => {
  it('asks with no name at a terminal, and gives usage without one', async () => {
    const asked = [];
    const code = await run([], {
      stdout: sink(),
      stderr: sink(),
      repos: REPOS,
      interactive: () => true,
      choose: (options) => { asked.push(options); return null; },
      open: () => { throw new Error('should not open — nothing was chosen'); },
    });
    // Choosing nothing is a refusal, not an error to report back at them.
    assert.equal(code, 0);
    assert.equal(asked.length, 1);

    const stderr = sink();
    assert.equal(await run([], { stdout: sink(), stderr, repos: REPOS, interactive: () => false }), 2);
    assert.match(stderr.out.text, /mc plan <programme>/u);
  });

  it('refuses a reserved role name and the retired --repo', async () => {
    // `helper` is the one reserved name left: `mc helper` owns `~/mc/helper/`
    // outright, and a programme of that name would live in the same directory.
    const reserved = sink();
    assert.equal(await run(['helper'], { stdout: sink(), stderr: reserved, repos: REPOS }), 1);
    assert.match(reserved.out.text, /reserved for a role/u);

    const repo = sink();
    assert.equal(await run(['mc', '--repo', 'memoro'], { stdout: sink(), stderr: repo, repos: REPOS }), 2);
    assert.match(repo.out.text, /spans both repositories/u);
  });

  it('is listed in the help', () => {
    const r = runMcCli(['--help']);
    assert.match(r.stdout, /mc plan \[<programme>\]/u);
  });
});

/**
 * A programme nothing could be checked out for gets no directory.
 *
 * The area is made before the first checkout, because `git worktree add` wants
 * its parent to exist. When every repository fails, what is left is a folder
 * that exists only because something went wrong — and the picker would then
 * offer that programme back as one already being planned.
 */
describe('a planning area nothing could be checked out into', () => {
  const missing = (root) => [{ name: 'memoro', path: join(root, 'no-such-repo') }];
  const area = (root, programme) => join(root, 'plan', programme);

  it('is taken away again, and says why', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-plan-empty-'));
    const stderr = sink();
    const result = ensurePlanArea('nowhere', {
      repos: missing(root), env: { MC_WORK_ROOT: root }, stdout: sink(), stderr,
    });
    assert.equal(result.ok, false);
    assert.match(stderr.out.text, /nothing to plan in/u);
    assert.equal(existsSync(area(root, 'nowhere')), false);
  });

  it('is kept when it was already there', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-plan-standing-'));
    mkdirSync(area(root, 'standing'), { recursive: true });
    const result = ensurePlanArea('standing', {
      repos: missing(root), env: { MC_WORK_ROOT: root }, stdout: sink(), stderr: sink(),
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(area(root, 'standing')), true);
  });
});

describe('a standing planning checkout', () => {
  it('is attached again when the programme is reopened, and a failed attach is said and not fatal', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-plan-reattach-'));
    const checkout = join(root, 'plan', 'reopened', 'memoro');
    mkdirSync(checkout, { recursive: true });
    // A real checkout: `inspectWorktree` asks git whether it is one.
    spawnSync('git', ['init', '-q', checkout]);
    const attached = [];
    const stderr = sink();
    const result = ensurePlanArea('reopened', {
      repos: [{ name: 'memoro', path: join(root, 'no-such-repo') }],
      env: { MC_WORK_ROOT: root },
      stdout: sink(),
      stderr,
      attach: (path) => { attached.push(path); return { ok: false, state: 'failed', why: 'npm error boom' }; },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(attached, [checkout]);
    assert.match(stderr.out.text, /mc: dependencies not attached in .*memoro — npm error boom/u);
  });
});


describe('mc plan is the person’s entrance, not a session’s next action', () => {
  it('refuses every recognised session and agent before choosing or creating anything', async () => {
    for (const [cwd, extra, role] of [
      ['/outside', { MC_ROLE: PLAN_ROLE, MC_PROGRAMME: 'mc' }, 'plan session'],
      ['/outside', { MC_ROLE: 'review-session:goal' }, 'review session \\(goal\\)'],
      ['/outside', { MC_GOAL: 'mc/g' }, 'build session \\(goal\\)'],
      ['/mc/programs/mc', {}, 'plan session'],
      ['/outside', { CLAUDECODE: '1' }, 'coding-agent session'],
      ['/outside', { CODEX_THREAD_ID: 'thread' }, 'coding-agent session'],
    ]) {
      const stderr = sink();
      const code = await run(['mc'], {
        cwd, env: { MC_WORK_ROOT: '/mc', ...extra }, stderr, stdout: sink(),
        ensure: () => { throw new Error('must not create an area'); },
        open: () => { throw new Error('must not open another session'); },
      });
      assert.equal(code, 1);
      assert.match(stderr.out.text, new RegExp(`already in a ${role}`));
      for (const command of ['mc goal new', 'mc goal set', 'mc goal criterion add']) assert.ok(stderr.out.text.includes(command));
    }
  });
});
