/**
 * TDD spec for `mc status <name>` (§9a).
 *
 * Per the plan §9a, `mc status <name>` returns the derived fields for a
 * single session, with a safety verdict ∈ {
 *   SAFE_TO_END,
 *   NEEDS_REVIEW,
 *   HAS_UNMERGED_WORK,
 *   IS_ACTIVE_NOW,
 *   IS_SQUASH_PHANTOM
 * }.
 *
 * Tests pre-seed the registry with each verdict and confirm `mc status`
 * surfaces it verbatim.
 *
 * Open-question heuristic (also tested here, since `mc status` reports
 * the open-question flag): ends with `?`, or contains "Vill du" /
 * "Want me to" / "A or B" / numbered choices. Implementation may
 * fall back to a small LLM call when ambiguous; the heuristic-only
 * cases are what we lock down here.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';
import { makeTempRepo, git, addWorktree } from '../_helpers/git-fixture.js';
import { run as runStatus } from '../../../src/mc/commands/status.js';

describe('mc status <name>', () => {
  let mcHome;
  let repoPolicyWorktree;
  before(() => {
    mcHome = mkdtempSync(join(tmpdir(), 'mc-status-'));
    repoPolicyWorktree = mkdtempSync(join(tmpdir(), 'mc-status-policy-wt-'));
    mkdirSync(join(repoPolicyWorktree, '.mc'), { recursive: true });
    writeFileSync(join(repoPolicyWorktree, '.mc', 'policy.json'), JSON.stringify({
      permissions: { profile: 'repo-trusted', network: 'enabled' },
    }));
    writeFileSync(join(repoPolicyWorktree, '.mc', 'local.json'), JSON.stringify({
      defaultTool: 'codex',
      permissions: { approval: 'untrusted' },
    }));
    writeRegistry(mcHome, [
      makeEntry({
        name: 'safe',
        safety_verdict: 'SAFE_TO_END',
        dirty_files: 0,
        ahead: 0,
        session_state: 'dead',
        last_assistant_text: 'All done. Branch merged.',
      }),
      makeEntry({
        name: 'review',
        safety_verdict: 'NEEDS_REVIEW',
        dirty_files: 2,
        last_assistant_text: 'I have made changes — please review.',
      }),
      makeEntry({
        name: 'unmerged',
        safety_verdict: 'HAS_UNMERGED_WORK',
        ahead: 4,
        dirty_files: 0,
      }),
      makeEntry({
        name: 'active',
        safety_verdict: 'IS_ACTIVE_NOW',
        session_state: 'live',
      }),
      makeEntry({
        name: 'phantom',
        safety_verdict: 'IS_SQUASH_PHANTOM',
        ahead: 1,
        dirty_files: 0,
      }),
      makeEntry({
        name: 'question-qmark',
        last_assistant_text: 'Should I update the schema?',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'question-vill-du',
        last_assistant_text: 'Vill du att jag fortsätter med detta?',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'question-want-me',
        last_assistant_text: 'Want me to push the changes now?',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'question-a-or-b',
        last_assistant_text: 'Should I go with A or B?',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'question-numbered',
        last_assistant_text: 'Options:\n  1. Add a guard\n  2. Refactor caller\n  3. Hold',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'no-question',
        last_assistant_text: 'Changes have been committed.',
        open_question: false,
        safety_verdict: 'SAFE_TO_END',
      }),
      makeEntry({
        name: 'codex-session',
        tool: 'codex',
        safety_verdict: 'IS_ACTIVE_NOW',
      }),
      makeEntry({
        name: 'repo-policy',
        tool: 'codex',
        worktree_path: repoPolicyWorktree,
        safety_verdict: 'SAFE_TO_END',
      }),
    ]);
  });
  after(() => {
    rmSync(mcHome, { recursive: true, force: true });
    rmSync(repoPolicyWorktree, { recursive: true, force: true });
  });

  for (const verdict of [
    'SAFE_TO_END', 'NEEDS_REVIEW', 'HAS_UNMERGED_WORK',
    'IS_ACTIVE_NOW', 'IS_SQUASH_PHANTOM',
  ]) {
    const name = {
      SAFE_TO_END: 'safe',
      NEEDS_REVIEW: 'review',
      HAS_UNMERGED_WORK: 'unmerged',
      IS_ACTIVE_NOW: 'active',
      IS_SQUASH_PHANTOM: 'phantom',
    }[verdict];

    test(`reports ${verdict} for the ${name} fixture`, () => {
      const r = runMc(['status', name, '--json'], { env: { MC_HOME: mcHome } });
      assert.equal(r.status, 0, `stderr:${r.stderr}`);
      const j = parseJsonOrNull(r.stdout);
      assert.ok(j, `expected JSON, got: ${r.stdout}`);
      assert.equal(j.name, name);
      assert.equal(j.safety_verdict, verdict);
    });
  }

  test('returns required derived fields', () => {
    const r = runMc(['status', 'review', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    for (const k of [
      'name', 'branch', 'safety_verdict', 'dirty_files', 'ahead',
      'last_activity', 'session_state', 'tool', 'relaunch_command',
      'effective_policy', 'work_status',
    ]) {
      assert.ok(k in j, `field ${k} missing from status output`);
    }
  });

  test('includes dev servers owned by the session worktree', async () => {
    const stdout = [];
    const code = await runStatus(['with-dev', '--json'], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: () => {} },
      findEntry: () => makeEntry({
        name: 'with-dev',
        worktree_path: '/tmp/with-dev',
        session_state: 'idle',
      }),
      readConfig: async () => ({}),
      fetchBrokerStatus: async () => ({ ok: true, sessions: [] }),
      fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
      listDevServers: async () => [{
        instance_id: 'dev-with-dev',
        session_name: 'with-dev',
        worktree_path: '/tmp/with-dev',
        state: 'ready',
      }],
    });

    assert.equal(code, 0);
    assert.deepEqual(parseJsonOrNull(stdout.join('')).dev_servers, {
      summary: { total: 1, ready: 1, starting: 0, unhealthy: 0, orphan: 0 },
      servers: [{
        instance_id: 'dev-with-dev',
        session_name: 'with-dev',
        worktree_path: '/tmp/with-dev',
        state: 'ready',
      }],
    });
  });

  test('stale live registry state is downgraded when active lookup succeeds', async () => {
    const stdout = [];
    const stderr = [];
    const code = await runStatus(['stale-live', '--json'], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      findEntry: () => makeEntry({
        name: 'stale-live',
        branch: 'sess/stale-live',
        coding_session_id: 'sess_stale_live',
        session_state: 'live',
        safety_verdict: 'IS_ACTIVE_NOW',
      }),
      readConfig: async () => ({}),
      fetchBrokerStatus: async () => ({ ok: true, sessions: [] }),
      fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
    });

    assert.equal(code, 0);
    assert.equal(stderr.join(''), '');
    const j = parseJsonOrNull(stdout.join(''));
    assert.equal(j.session_state, 'idle');
    assert.equal(j.reachability, 'stale');
    assert.equal(j.safety_verdict, 'SAFE_TO_END');
    assert.equal(j.active_session, null);
    assert.equal(j.work_status.status, 'resting');
  });

  test('active lookup can mark an idle registry entry as reachable', async () => {
    const stdout = [];
    const code = await runStatus(['reachable', '--json'], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: () => {} },
      findEntry: () => makeEntry({
        name: 'reachable',
        branch: 'sess/reachable',
        coding_session_id: 'sess_reachable1',
        session_state: 'idle',
      }),
      readConfig: async () => ({}),
      fetchBrokerStatus: async () => ({ ok: true, sessions: [] }),
      fetchActiveSessions: async () => ({
        ok: true,
        sessions: [{
          coding_session_id: 'sess_reachable1',
          label: 'reachable',
          repo: 'memoro',
          branch: 'sess/reachable',
          machine_id: 'host-a',
          idle_seconds: 0,
        }],
      }),
    });

    assert.equal(code, 0);
    const j = parseJsonOrNull(stdout.join(''));
    assert.equal(j.session_state, 'live');
    assert.equal(j.reachability, 'reachable');
    assert.equal(j.active_session.coding_session_id, 'sess_reachable1');
    assert.equal(j.work_status.status, 'active');
  });

  test('local broker reachability wins before cloud active lookup', async () => {
    const stdout = [];
    const code = await runStatus(['local-broker', '--json'], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: () => {} },
      findEntry: () => makeEntry({
        name: 'local-broker',
        branch: 'sess/local-broker',
        worktree_path: '/tmp/local-broker-worktree',
        coding_session_id: 'sess_local_live',
        session_state: 'live',
      }),
      readConfig: async () => ({}),
      fetchBrokerStatus: async () => ({
        ok: true,
        sessions: [{
          id: 'sess_local_live',
          cwd: '/tmp/local-broker-worktree',
          session_state: 'live',
          attachable: true,
          exit: null,
          last_output_at: '2026-06-09T12:00:00.000Z',
        }],
      }),
      fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
    });

    assert.equal(code, 0);
    const j = parseJsonOrNull(stdout.join(''));
    assert.equal(j.session_state, 'live');
    assert.equal(j.reachability, 'reachable');
    assert.equal(j.active_session.coding_session_id, 'sess_local_live');
  });

  test('local broker status rejects same label when coding IDs and repos differ', async () => {
    const stdout = [];
    const code = await runStatus(['identity-mismatch', '--json'], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: () => {} },
      findEntry: () => makeEntry({
        name: 'identity-mismatch',
        branch: 'sess/identity-mismatch',
        worktree_path: '/tmp/target-worktree',
        coding_session_id: 'sess_target',
        session_state: 'live',
        safety_verdict: 'IS_ACTIVE_NOW',
      }),
      readConfig: async () => ({}),
      fetchBrokerStatus: async () => ({
        ok: true,
        sessions: [{
          id: 'sess_other',
          coding_session_id: 'sess_other',
          name: 'identity-mismatch',
          cwd: '/tmp/other-worktree',
          session_state: 'live',
          attachable: true,
          exit: null,
        }],
      }),
      fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
    });

    assert.equal(code, 0);
    const body = parseJsonOrNull(stdout.join(''));
    assert.equal(body.session_state, 'idle');
    assert.equal(body.reachability, 'stale');
    assert.equal(body.active_session, null);
  });

  test('surfaces session tool + relaunch command in JSON', () => {
    const r = runMc(['status', 'codex-session', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.tool, 'codex');
    assert.equal(j.relaunch_command, 'mc open codex-session');
    assert.equal(j.effective_policy.permissions.rendered_for, 'codex');
    assert.equal(j.effective_policy.adapter_support.tool, 'codex');
    assert.equal(j.effective_policy.adapter_support.permissions.workspace, 'supported');
    assert.equal(j.effective_policy.adapter_support.permissions.network, 'unsupported');
    assert.equal(j.effective_policy.adapter_support.permissions.approval, 'supported');
    assert.equal(j.effective_policy.secrets.vault_required, false);
    assert.equal(j.effective_policy.secrets.native_auth_owned_by_tool, true);
    assert.deepEqual(j.effective_policy.secrets.materialisation_targets, []);
  });

  test('human output includes tool + relaunch command', () => {
    const r = runMc(['status', 'codex-session'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.match(r.stdout, /tool\s+codex/);
    assert.match(r.stdout, /relaunch\s+mc open codex-session/);
    assert.match(r.stdout, /policy\s+codex: native auth owned by tool; no vault target/);
    assert.match(r.stdout, /permissions unsupported: profile, network, secrets/);
  });

  test('status observes branch drift without overwriting the session branch', () => {
    const repo = makeTempRepo({ name: 'status-observe' });
    try {
      git(repo.dir, 'branch sess/observe main');
      const wt = join(repo.mcHome, 'worktrees', 'repo', 'observe');
      addWorktree(repo.dir, wt, 'sess/observe');
      git(wt, 'checkout -q -b scratch/status');
      writeRegistry(repo.mcHome, [makeEntry({
        name: 'observe',
        branch: 'sess/observe',
        worktree_path: wt,
        tool: 'codex',
      })]);

      const r = runMc(['status', 'observe', '--json'], { env: { MC_HOME: repo.mcHome } });
      assert.equal(r.status, 0, `stderr:${r.stderr}`);
      const j = parseJsonOrNull(r.stdout);
      assert.equal(j.branch, 'scratch/status');
      assert.equal(j.session_branch, 'sess/observe');
      assert.equal(j.current_branch, 'scratch/status');
      assert.equal(j.original_branch, 'sess/observe');
    } finally {
      repo.cleanup();
    }
  });

  test('Claude status reports legacy Anthropic vault target', () => {
    const r = runMc(['status', 'safe', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.effective_policy.permissions.rendered_for, 'claude');
    assert.equal(j.effective_policy.secrets.vault_required, true);
    assert.deepEqual(j.effective_policy.secrets.materialisation_targets, [{
      tool: 'claude',
      provider: 'anthropic',
      source: 'legacy-provider-mapping',
      target_auth_mode: 'api_key',
    }]);
  });

  test('status reads repo policy from the session worktree', () => {
    const r = runMc(['status', 'repo-policy', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.effective_policy.permissions.source, 'repo');
    assert.equal(j.effective_policy.permissions.profile, 'repo-trusted');
    assert.equal(j.effective_policy.permissions.network, 'enabled');
    assert.equal(j.effective_config.defaultTool.value, 'codex');
    assert.equal(j.effective_config.defaultTool.source, '.mc/local.json');
    assert.equal(j.effective_config.permissions.profile.value, 'repo-trusted');
    assert.equal(j.effective_config.permissions.profile.source, '.mc/policy.json');
    assert.equal(j.effective_config.permissions.approval.value, 'untrusted');
    assert.equal(j.effective_config.permissions.approval.source, '.mc/local.json');
  });

  test('unknown name → non-zero exit + error', () => {
    const r = runMc(['status', 'does-not-exist', '--json'], { env: { MC_HOME: mcHome } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not.found|unknown|no such/i);
  });

  // Open-question heuristic — §9a + the hint in the prompt brief.
  for (const name of [
    'question-qmark',
    'question-vill-du',
    'question-want-me',
    'question-a-or-b',
    'question-numbered',
  ]) {
    test(`open_question flag is true for ${name}`, () => {
      const r = runMc(['status', name, '--json'], { env: { MC_HOME: mcHome } });
      assert.equal(r.status, 0, `stderr:${r.stderr}`);
      const j = parseJsonOrNull(r.stdout);
      assert.equal(j.open_question, true);
    });
  }

  test('open_question is false when the assistant did not pose a question', () => {
    const r = runMc(['status', 'no-question', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.open_question, false);
  });
});
