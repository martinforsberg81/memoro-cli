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
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ensurePlanArea, planArea, planBranch, planLaunch, programmeLabel, programmeRows, run,
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
  // Frontmatter and nothing else. The role used to carry an overlay that told
  // the session what to deliver and how to land it; none of that is knowable
  // when the session opens, so what a planning session is told is the first
  // prompt and only the first prompt.
  it('is the model and the tools, with no prose behind it', () => {
    const role = readCanonRole('plan');
    assert.equal(role.name, 'plan');
    assert.equal(role.model, 'opus');
    assert.deepEqual(role.tools, ['claude', 'codex']);
    assert.equal(role.overlay, null);
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
  it('names the programme, where it stands, and what to read — and stops', () => {
    const launch = planLaunch({
      programme: 'msr-core', repos: ['memoro', 'memoro-cli'], role: readCanonRole('plan'),
    });
    assert.match(launch.prompt, /planning session for the `msr-core` programme/u);
    assert.match(launch.prompt, /~\/mc\/plan\/msr-core\//u);
    assert.match(launch.prompt, /`memoro\/` and `memoro-cli\/`/u);
    assert.match(launch.prompt, /branch `plan\/msr-core`/u);
    assert.match(launch.prompt, /not a workarea/u);
    // The two things to read, and they are the only instruction there is.
    assert.match(launch.prompt, /docs\/project\/README\.md/u);
    assert.match(launch.prompt, /docs\/project\/msr-core\//u);
    assert.equal(launch.model, 'opus');
    assert.equal(launch.overlay, null);
  });

  // The assertion that keeps this prompt from growing back. None of these is
  // knowable when the session opens: how many projects the programme needs,
  // what they are called, whether a plan comes out of it at all, or by what
  // route it reaches main. A prompt that answers them in advance is guessing.
  it('predicts nothing about the deliverable or how it lands', () => {
    const { prompt } = planLaunch({
      programme: 'msr-core', repos: ['memoro', 'memoro-cli'], role: readCanonRole('plan'),
    });
    for (const guess of ['PLAN.json', '<project>', 'PR', 'pull request', 'mc merge', 'push', 'programme document', 'Then stop']) {
      assert.ok(!prompt.includes(guess), `the prompt should not predict "${guess}": ${prompt}`);
    }
  });

  it('names only the checkout it actually got', () => {
    const launch = planLaunch({ programme: 'mc', repos: ['memoro-cli'], role: readCanonRole('plan') });
    assert.match(launch.prompt, /with `memoro-cli\/` beside you/u);
    assert.ok(!launch.prompt.includes('`memoro/`'));
  });
});

describe('the launch', () => {
  it('hands over the profile and the prompt last, with no --resume', async () => {
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
    // The profile alone: there is no role overlay to ride behind it.
    assert.equal(call.args[3], 'PROFILE');
    assert.equal(call.args.at(-1), launch.prompt);
    assert.ok(!call.args.includes('--resume'));
    assert.equal(call.options.stdio, 'inherit');
  });

  // `--codex` is the same launch with a different instruction channel. Asserted
  // on the argv rather than through `openInWorkArea`, because resolving the
  // codex launch needs the codex binary and a test must not depend on one.
  it('reaches codex through `-c instructions=`', () => {
    const launch = planLaunch({ programme: 'x', repos: ['memoro'], role: readCanonRole('plan') });
    const args = profileArgs('codex', instructionsFor('codex', 'PROFILE', launch.overlay));
    assert.equal(args[0], '-c');
    assert.match(args[1], /^instructions=/u);
    assert.equal(JSON.parse(args[1].slice('instructions='.length)), 'PROFILE');
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
