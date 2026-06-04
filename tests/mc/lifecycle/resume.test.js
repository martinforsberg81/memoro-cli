/**
 * TDD spec for `mc resume <name>` (§2).
 *
 * Per the plan §2:
 *   mc resume <name>
 *     cd to worktree, then launch the stored tool. Claude gets its native
 *     --resume flag; Codex must not, because an empty Codex launch can
 *     open Codex's own resume picker instead of the mc worktree session.
 *
 * Per §2b, `mc resume` emits a `cd <worktree>` directive on fd 3
 * *before* launching the tool (so the launched tool's cwd is correct).
 *
 * We test resume in `--no-launch` mode: implementation honours the flag
 * by emitting the cd directive and returning without spawning the tool.
 * This isolates resume's contract (resolve name → emit cd → look up
 * tool) from the tool-spawning machinery.
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry, REGISTRY_REL_PATH } from '../_helpers/registry-fixture.js';
import { launchResumeSession, parseArgs, resumableEntries } from '../../../src/mc/commands/resume.js';
import * as claudeAdapter from '../../../src/adapters/claude-code.js';
import * as codexAdapter from '../../../src/adapters/codex.js';

describe('mc resume <name>', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'resume' }); });
  after(() => { repo?.cleanup(); });

  test('without a name lists mc sessions across tools instead of opening a tool-native picker', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'from-claude',
        branch: 'sess/from-claude',
        tool: 'claude',
        worktree_path: '/tmp/from-claude',
      }),
      makeEntry({
        name: 'from-codex',
        branch: 'sess/from-codex',
        tool: 'codex',
        worktree_path: '/tmp/from-codex',
      }),
    ]);
    const r = runMc(['resume'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.match(r.stdout, /mc sessions available to resume/);
    assert.match(r.stdout, /from-claude/);
    assert.match(r.stdout, /claude/);
    assert.match(r.stdout, /from-codex/);
    assert.match(r.stdout, /codex/);
    assert.match(r.stdout, /mc resume <name>/);
    assert.doesNotMatch(r.stdout + r.stderr, /Codex.*Resume session|Resume session/i);
  });

  test('without a name --json lists all mc sessions across tools', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'a', tool: 'claude', branch: 'sess/a' }),
      makeEntry({ name: 'b', tool: 'codex', branch: 'sess/b' }),
    ]);
    const r = runMc(['resume', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.deepEqual(j.entries.map((e) => [e.name, e.tool]), [
      ['a', 'claude'],
      ['b', 'codex'],
    ]);
  });

  test('resumableEntries is tool-agnostic and sorted by name', () => {
    const entries = resumableEntries({
      entries: [
        makeEntry({ name: 'z', tool: 'codex' }),
        makeEntry({ name: 'a', tool: 'claude' }),
      ],
    });
    assert.deepEqual(entries.map((e) => [e.name, e.tool]), [
      ['a', 'claude'],
      ['z', 'codex'],
    ]);
  });

  test('rejects unknown name', () => {
    const r = runMc(['resume', 'nope', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown|not.found|no such/i);
  });

  test('--json reports the resolved tool + worktree path', () => {
    git(repo.dir, 'branch sess/r main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'r');
    addWorktree(repo.dir, wt, 'sess/r');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'r', branch: 'sess/r', worktree_path: wt, tool: 'claude',
    })]);
    const r = runMc(['resume', 'r', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}`);
    assert.equal(j.name, 'r');
    assert.equal(j.tool, 'claude');
    assert.equal(j.worktree_path, wt);
  });

  test('--codex updates the stored session tool before relaunch', () => {
    git(repo.dir, 'branch sess/r main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'r');
    addWorktree(repo.dir, wt, 'sess/r');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'r', branch: 'sess/r', worktree_path: wt, tool: 'claude',
    })]);
    const r = runMc(['resume', 'r', '--codex', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.tool, 'codex');

    const reg = JSON.parse(readFileSync(join(repo.mcHome, REGISTRY_REL_PATH), 'utf8'));
    assert.equal(reg.entries.find((e) => e.name === 'r')?.tool, 'codex');
  });

  test('tool flags reject conflicts and unknown values', () => {
    assert.match(parseArgs(['r', '--tool', 'claude', '--codex']).error, /conflicting/);
    assert.match(parseArgs(['r', '--tool']).error, /requires a value/);
  });

  test('prelaunch uses the registry tool adapter and reexecs mc with --resume', async () => {
    const materialiseCalls = [];
    const spawnCalls = [];
    const status = await launchResumeSession({
      entry: {
        name: 'data',
        tool: 'claude',
        label: 'identity cleanup',
        worktree_path: '/tmp/memoro-resume-data',
      },
      env: { PATH: '/bin', MC_GROUNDING_TOOL: 'codex' },
      execPath: '/usr/bin/node-test',
      mcBin: '/repo/src/bin-mc.js',
      stderr: { write() {} },
      deps: {
        materialiseVaultBeforeLaunch: async (arg) => {
          materialiseCalls.push(arg);
          return { ok: true, materialised: [], skipped: [] };
        },
        spawnSync: (cmd, args, opts) => {
          spawnCalls.push({ cmd, args, opts });
          return { status: 0 };
        },
      },
    });

    assert.equal(status, 0);
    assert.equal(materialiseCalls.length, 1);
    assert.equal(materialiseCalls[0].sessionId, 'data');
    assert.equal(materialiseCalls[0].worktreePath, '/tmp/memoro-resume-data');
    assert.deepEqual(materialiseCalls[0].adapters, [claudeAdapter]);
    assert.notDeepEqual(materialiseCalls[0].adapters, [codexAdapter]);

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, '/usr/bin/node-test');
    assert.deepEqual(spawnCalls[0].args, ['/repo/src/bin-mc.js', '--resume']);
    assert.equal(spawnCalls[0].opts.cwd, '/tmp/memoro-resume-data');
    assert.equal(spawnCalls[0].opts.env.MC_SESSION_NAME, 'data');
    assert.equal(spawnCalls[0].opts.env.MC_VAULT_STARTUP_DONE, '1');
    assert.equal(spawnCalls[0].opts.env.MC_GROUNDING_TOOL, 'claude-code');
    assert.equal(spawnCalls[0].opts.env.MC_GROUNDING_FOCUS, 'identity cleanup');
  });

  test('prelaunch uses a resume-overridden codex tool', async () => {
    const materialiseCalls = [];
    const spawnCalls = [];
    const status = await launchResumeSession({
      entry: {
        name: 'data',
        tool: 'codex',
        label: 'identity cleanup',
        worktree_path: '/tmp/memoro-resume-data',
      },
      env: { PATH: '/bin', MC_GROUNDING_TOOL: 'claude-code' },
      execPath: '/usr/bin/node-test',
      mcBin: '/repo/src/bin-mc.js',
      stderr: { write() {} },
      deps: {
        materialiseVaultBeforeLaunch: async (arg) => {
          materialiseCalls.push(arg);
          return { ok: true, materialised: [], skipped: [] };
        },
        spawnSync: (cmd, args, opts) => {
          spawnCalls.push({ cmd, args, opts });
          return { status: 0 };
        },
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(materialiseCalls[0].adapters, [codexAdapter]);
    assert.deepEqual(spawnCalls[0].args, ['/repo/src/bin-mc.js']);
    assert.equal(spawnCalls[0].opts.env.MC_GROUNDING_TOOL, 'codex');
  });
});
