/**
 * `mc plan <name>` — the prompt and overlay a planning session is handed,
 * assembled without starting anything, and the launch shape through a
 * stubbed spawn: role overlay behind the profile, the first prompt as the
 * last word, never `--resume`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { planLaunch, run } from '../../../src/mc/commands/plan.js';
import { profileArgs } from '../../../src/mc/portrait.js';
import { instructionsFor, readCanonRole } from '../../../src/mc/roles.js';
import { openInWorkArea } from '../../../src/mc/work-open.js';
import { runMcCli } from '../_helpers/mc-cli.js';

function sink() {
  const out = { text: '' };
  return { out, write: (s) => { out.text += s; } };
}

describe('the plan role', () => {
  it('ships with mc, for claude first, and says what a PLAN.md is', () => {
    const role = readCanonRole('plan');
    assert.equal(role.name, 'plan');
    assert.equal(role.model, 'opus');
    assert.deepEqual(role.tools, ['claude', 'codex']);
    assert.match(role.overlay, /docs\/project\/<programme>\/<name>\/PLAN\.md/u);
    assert.match(role.overlay, /Plan: <name>/u);
    assert.match(role.overlay, /\*\*Beslut:\*\*/u);
    assert.match(role.overlay, /Never create a parallel programme/u);
    // The role's last instruction: a plan PR is documentation, so it lands
    // itself instead of waiting for a click.
    assert.match(role.overlay, /mc merge <repo> <pr> --docs/u);
  });

  it('assembles a first prompt that names the workarea, the repository and the PR', () => {
    const launch = planLaunch({ name: 'gate-word', repo: 'memoro', role: readCanonRole('plan') });
    assert.match(launch.prompt, /`gate-word` workarea of memoro/u);
    assert.match(launch.prompt, /docs\/project\/<programme>\/gate-word\/PLAN\.md/u);
    assert.match(launch.prompt, /"Plan: gate-word"/u);
    // …and ends with the docs merge, naming the repository it runs in, so
    // the plan is on main before the session is closed.
    assert.match(launch.prompt, /mc merge memoro <pr> --docs/u);
    assert.match(launch.prompt.split('\n').at(-1), /--docs/u);
    assert.equal(launch.model, 'opus');
  });
});

describe('the launch', () => {
  it('puts the overlay behind the profile and the prompt last, with no --resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-plan-'));
    const areaRoot = join(root, 'area');
    mkdirSync(areaRoot);
    const calls = [];
    const launch = planLaunch({ name: 'x', repo: 'memoro', role: readCanonRole('plan') });
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
    const launch = planLaunch({ name: 'x', repo: 'memoro', role: readCanonRole('plan') });
    const args = profileArgs('codex', instructionsFor('codex', 'PROFILE', launch.overlay));
    assert.equal(args[0], '-c');
    assert.match(args[1], /^instructions=/u);
    const body = JSON.parse(args[1].slice('instructions='.length));
    assert.match(body, /^PROFILE\n\n---\n\nYou are the planning session/u);
    assert.match(body, /docs\/project\/<programme>\/<name>\/PLAN\.md/u);
    assert.match(body, /mc merge <repo> <pr> --docs/u);
  });

  it('refuses without a name, and refuses a reserved role name', async () => {
    const stderr = sink();
    assert.equal(await run([], { stdout: sink(), stderr }), 2);
    assert.match(stderr.out.text, /mc plan <name>/u);
    const reserved = sink();
    assert.equal(await run(['pm'], { stdout: sink(), stderr: reserved }), 1);
    assert.match(reserved.out.text, /reserved for a role/u);
  });

  it('is listed in the help', () => {
    const r = runMcCli(['--help']);
    assert.match(r.stdout, /mc plan <name>/u);
  });
});
