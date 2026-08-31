/**
 * `mc plan [<programme>]` — the picker, the directory a planning session gets,
 * and the prompt and overlay it is handed, assembled without starting
 * anything; plus the launch shape through a stubbed spawn: role overlay behind
 * the profile, the first prompt as the last word, never `--resume`.
 *
 * The one rule underneath all of it: what `mc plan` makes is never something
 * `mc run` can see. That is asserted here as a path — `plan/<programme>`, one
 * level below the work root — because it is the whole reason the directory
 * moved.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  planArea, planBranch, planLaunch, programmeLabel, programmeRows, run,
} from '../../../src/mc/commands/plan.js';
import { profileArgs } from '../../../src/mc/portrait.js';
import { instructionsFor, readCanonRole } from '../../../src/mc/roles.js';
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
  it('ships with mc, for claude first, and says what a PLAN.json is', () => {
    const role = readCanonRole('plan');
    assert.equal(role.name, 'plan');
    assert.equal(role.model, 'opus');
    assert.deepEqual(role.tools, ['claude', 'codex']);
    assert.match(role.overlay, /docs\/project\/<programme>\/<project>\/PLAN\.json/u);
    assert.match(role.overlay, /\*\*Beslut:\*\*/u);
    assert.match(role.overlay, /Never create a parallel programme/u);
    // The role's last instruction: a plan PR is documentation, so it lands
    // itself instead of waiting for a click.
    assert.match(role.overlay, /mc merge <repo> <pr> --docs/u);
  });

  // The role is what a session actually reads, so the decoupling has to be in
  // it and not only in the prompt: a programme, not a workarea; and the
  // workarea a project gets is the runner's to make, never this session's.
  it('is written for a programme, and disclaims the workarea', () => {
    const { overlay } = readCanonRole('plan');
    assert.match(overlay, /You are the planning session for one \*\*programme\*\*/u);
    assert.match(overlay, /~\/mc\/plan\/<programme>\//u);
    assert.match(overlay, /This is not a workarea/u);
    assert.match(overlay, /you never make one's workarea|you make neither|Make a workarea/u);
    assert.match(overlay, /`Plan: <programme>`/u);
    // The questions it raises live with the session, not in a workarea.
    assert.match(overlay, /~\/mc\/plan\/<programme>\/decisions\//u);
    // And nothing in it still points a session at a project workarea's filing.
    assert.ok(!overlay.includes('HANDOFF.md'), 'the role no longer reads a workarea handoff');
    assert.ok(!/\.\.\/inbox\//u.test(overlay), 'the role no longer reads a workarea inbox');
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
});

describe('the picker', () => {
  const read = (repo) => (repo.name === 'memoro'
    ? {
      programmes: ['entity-detail', 'msr-core'],
      plans: [
        { programme: 'msr-core', project: 'msr-track-1', status: 'ready' },
        { programme: 'msr-core', project: 'msr-track-3', status: 'done' },
      ],
    }
    : { programmes: ['mc'], plans: [{ programme: 'mc', project: 'mc-cut', status: 'done' }] });

  it('offers every programme on main in either repository', () => {
    const rows = programmeRows({ repos: REPOS, env: { MC_HOME: '/nowhere' }, read });
    assert.deepEqual(rows.map((r) => r.name), ['entity-detail', 'mc', 'msr-core']);
    assert.deepEqual(rows.find((r) => r.name === 'mc').repos, ['memoro-cli']);
  });

  // A programme whose projects have all been archived holds only its own
  // document on main — `listPlans` cannot see it, and it is exactly the one
  // the next piece of that work belongs under.
  it('keeps a programme whose projects are all gone', () => {
    const rows = programmeRows({ repos: REPOS, env: { MC_HOME: '/nowhere' }, read });
    const empty = rows.find((r) => r.name === 'entity-detail');
    assert.equal(empty.projects, 0);
    assert.match(programmeLabel(empty), /no projects on main/u);
  });

  it('counts what is unfinished, and says when everything is done', () => {
    const rows = programmeRows({ repos: REPOS, env: { MC_HOME: '/nowhere' }, read });
    assert.match(programmeLabel(rows.find((r) => r.name === 'msr-core')), /2 projects, 1 unfinished/u);
    assert.match(programmeLabel(rows.find((r) => r.name === 'mc')), /1 project, all done/u);
  });
});

describe('the prompt', () => {
  it('names the programme, both checkouts and the branch — and no workarea', () => {
    const launch = planLaunch({
      programme: 'msr-core', repos: ['memoro', 'memoro-cli'], role: readCanonRole('plan'),
    });
    assert.match(launch.prompt, /planning session for the `msr-core` programme/u);
    assert.match(launch.prompt, /~\/mc\/plan\/msr-core\//u);
    assert.match(launch.prompt, /`memoro\/` and `memoro-cli\/`/u);
    assert.match(launch.prompt, /branch `plan\/msr-core`/u);
    assert.match(launch.prompt, /not a workarea/u);
    // The project it writes is a file, not a directory it makes here: the
    // name goes to the runner, and the runner makes the workarea.
    assert.match(launch.prompt, /docs\/project\/msr-core\/<project>\/PLAN\.json/u);
    assert.match(launch.prompt.replace(/\n/gu, ' '), /you make neither/u);
    assert.match(launch.prompt.replace(/\n/gu, ' '), /the runner will later call that project's branch and its workarea/u);
    assert.match(launch.prompt, /"Plan: msr-core"/u);
    // …and the last thing it is told is the docs merge, so the plan is on
    // main before the session is closed, not sitting in a PR the runner
    // cannot queue behind.
    const last = launch.prompt.split('\n\n').at(-1);
    assert.match(last, /mc merge <repo> <pr> --docs/u);
    assert.match(last, /Then stop\.$/u);
    assert.equal(launch.model, 'opus');
  });

  it('names only the checkout it actually got', () => {
    const launch = planLaunch({ programme: 'mc', repos: ['memoro-cli'], role: readCanonRole('plan') });
    assert.match(launch.prompt, /with `memoro-cli\/` beside you/u);
    assert.ok(!launch.prompt.includes('`memoro/`'));
  });
});

describe('the launch', () => {
  it('puts the overlay behind the profile and the prompt last, with no --resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-plan-'));
    const areaRoot = join(root, 'area');
    mkdirSync(areaRoot);
    const calls = [];
    const launch = planLaunch({ programme: 'x', repos: ['memoro'], role: readCanonRole('plan') });
    const result = await openInWorkArea({
      areaRoot,
      worktree: { repo: null, path: areaRoot, is_git: false },
      tool: 'claude',
      pick: 'new',
      overlay: launch.overlay,
      prompt: launch.prompt,
      defaultModel: 'opus',
      defaultModelTool: 'claude',
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') },
      spawn: (bin, args, options) => { calls.push({ bin, args, options }); return { status: 0 }; },
      loadProfile: async () => 'PROFILE',
    });
    assert.equal(result.ok, true);
    const [call] = calls;
    assert.deepEqual(call.args.slice(0, 2), ['--model', 'opus']);
    assert.equal(call.args[2], '--append-system-prompt');
    assert.match(call.args[3], /^PROFILE\n\n---\n\nYou are the planning session/u);
    assert.equal(call.args.at(-1), launch.prompt);
    assert.ok(!call.args.includes('--resume'));
    assert.equal(call.options.stdio, 'inherit');
  });

  // `--codex` is the same launch with a different instruction channel. Asserted
  // on the argv rather than through `openInWorkArea`, because resolving the
  // codex launch needs the codex binary and a test must not depend on one.
  it('reaches codex through `-c instructions=`, role text and all', () => {
    const launch = planLaunch({ programme: 'x', repos: ['memoro'], role: readCanonRole('plan') });
    const args = profileArgs('codex', instructionsFor('codex', 'PROFILE', launch.overlay));
    assert.equal(args[0], '-c');
    assert.match(args[1], /^instructions=/u);
    const body = JSON.parse(args[1].slice('instructions='.length));
    assert.match(body, /^PROFILE\n\n---\n\nYou are the planning session/u);
    assert.match(body, /PLAN\.json/u);
    assert.match(body, /mc merge <repo> <pr> --docs/u);
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
    const reserved = sink();
    assert.equal(await run(['pm'], { stdout: sink(), stderr: reserved, repos: REPOS }), 1);
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
