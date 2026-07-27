/**
 * TDD spec for `mc list` and its filters (§2 + §9a + §9d).
 *
 * The list command surfaces the registry, optionally enriched with
 * derived fields via `--rich`. Tests feed a fixed registry via
 * `${MC_HOME}/registry.json` and assert on the JSON output's shape.
 *
 * Filters covered (§9d):
 *   --awaiting       sessions whose last asst msg is a question
 *   --idle [--since] no activity since N (default 6h)
 *   --safe-to-end    SAFE_TO_END verdict from §9a
 *   --has-unmerged   ahead > 0 and not phantom
 *   --active         live heartbeat or transcript activity < 5m
 *   --names          machine-friendly: one name per line, suitable for
 *                    piping to other mc commands
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';
import { run as runList } from '../../../src/mc/commands/list.js';
import {
  buildSessionListView,
  fetchActiveCodingSessions,
  fetchActiveCodingSessionsWithLocalBroker,
  renderSessionListHuman,
} from '../../../src/mc/session-list.js';

function isoMinutesAgo(min) {
  return new Date(Date.now() - min * 60_000).toISOString();
}

// One fixture used by most tests — covers every state we care about.
function buildFixture() {
  return [
    makeEntry({
      name: 'awaiting-q',
      branch: 'sess/awaiting-q',
      open_question: true,
      last_assistant_text: 'Want me to proceed with option A or B?',
      last_activity: isoMinutesAgo(30),
      session_state: 'idle',
      safety_verdict: 'NEEDS_REVIEW',
      dirty_files: 0,
      ahead: 0,
    }),
    makeEntry({
      name: 'safe',
      branch: 'sess/safe',
      open_question: false,
      last_activity: isoMinutesAgo(60),
      session_state: 'dead',
      safety_verdict: 'SAFE_TO_END',
      dirty_files: 0,
      ahead: 0,
    }),
    makeEntry({
      name: 'unmerged',
      branch: 'sess/unmerged',
      last_activity: isoMinutesAgo(120),
      session_state: 'idle',
      safety_verdict: 'HAS_UNMERGED_WORK',
      dirty_files: 0,
      ahead: 3,
    }),
    makeEntry({
      name: 'active-now',
      branch: 'sess/active-now',
      last_activity: isoMinutesAgo(1),
      session_state: 'live',
      safety_verdict: 'IS_ACTIVE_NOW',
    }),
    makeEntry({
      name: 'phantom',
      branch: 'sess/phantom',
      last_activity: isoMinutesAgo(240),
      session_state: 'dead',
      safety_verdict: 'IS_SQUASH_PHANTOM',
      ahead: 1,
    }),
    makeEntry({
      name: 'really-idle',
      branch: 'sess/really-idle',
      last_activity: isoMinutesAgo(60 * 24), // 1 day ago
      session_state: 'idle',
      safety_verdict: 'SAFE_TO_END',
    }),
    makeEntry({
      name: 'missing-worktree',
      branch: 'sess/missing-worktree',
      session_state: 'idle',
      safety_verdict: 'SAFE_TO_END',
      worktree_missing: true,
    }),
    makeEntry({
      name: 'iso-x',
      branch: 'iso/parent-abc',
      kind: 'isolation',
      parent: 'parent',
      session_state: 'idle',
      safety_verdict: 'SAFE_TO_END',
    }),
  ];
}

describe('mc list', () => {
  let mcHome;
  before(() => {
    mcHome = mkdtempSync(join(tmpdir(), 'mc-list-'));
    writeRegistry(mcHome, buildFixture());
  });
  after(() => { rmSync(mcHome, { recursive: true, force: true }); });

  test('--json returns an array of entries with stable fields', () => {
    const r = runMc(['list', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}`);
    assert.ok(Array.isArray(j.entries), 'output must have .entries[]');
    // Default `mc list` hides isolation worktrees (§2 "only user-created
    // work-sessions") and missing-worktree registry entries. 8 fixture
    // entries → 6 work entries surfaced.
    const names = j.entries.map(e => e.name);
    assert.ok(!names.includes('iso-x'),
      `iso entries should be hidden by default; got ${names.join(',')}`);
    assert.ok(!names.includes('missing-worktree'),
      `missing worktrees should be hidden by default; got ${names.join(',')}`);
    assert.equal(j.entries.length, 6);
    // Every entry must carry at least name + branch + safety_verdict.
    for (const e of j.entries) {
      assert.ok(typeof e.name === 'string');
      assert.ok(typeof e.branch === 'string');
      assert.ok(typeof e.safety_verdict === 'string');
    }
  });

  test('human output renders active server sessions first and local stopped sessions second', async () => {
    const stdout = [];
    const stderr = [];
    const status = await runList([], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      checkAndPrintFreshInstall: async () => false,
      scanDaemons: () => ({ orphan: [], stale: [] }),
      readRegistry: () => ({ entries: [
        makeEntry({
          name: 'active-local',
          branch: 'sess/active-local',
          tool: 'codex',
          coding_session_id: 'sess_active',
          session_state: 'live',
        }),
        makeEntry({
          name: 'local-dead',
          branch: 'sess/local-dead',
          tool: 'claude',
          coding_session_id: 'sess_dead',
          session_state: 'dead',
        }),
      ] }),
      fetchLocalBrokerSessions: async () => ({
        ok: true,
        sessions: [{ coding_session_id: 'sess_active' }],
        warning: null,
      }),
      fetchActiveSessions: async () => ({
        ok: true,
        sessions: [{
          coding_session_id: 'sess_active',
          label: 'active-local',
          repo: 'memoro',
          branch: 'main',
          machine_id: 'host-a',
          source: 'codex',
          idle_seconds: 0,
          received_at: new Date().toISOString(),
        }],
      }),
    });
    assert.equal(status, 0);
    assert.equal(stderr.join(''), '');
    const out = stdout.join('');
    assert.match(out, /Active sessions/);
    assert.match(out, /1\. active-local\s+active\s+codex/);
    assert.match(out, /Local sessions/);
    assert.match(out, /2\. local-dead\s+local\s+claude/);
    const localSection = out.split('Local sessions')[1];
    assert.doesNotMatch(localSection, /active-local/);
  });

  test('--json demotes registry-live sessions with no live local session to stale', async () => {
    const stdout = [];
    const stderr = [];
    const status = await runList(['--json'], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      checkAndPrintFreshInstall: async () => false,
      readRegistry: () => ({ entries: [
        makeEntry({
          name: 'ghost',
          coding_session_id: 'sess_ghost',
          session_state: 'live',
          safety_verdict: 'IS_ACTIVE_NOW',
        }),
        makeEntry({
          name: 'alive',
          coding_session_id: 'sess_alive',
          session_state: 'live',
          safety_verdict: 'IS_ACTIVE_NOW',
        }),
      ] }),
      fetchLocalBrokerSessions: async () => ({
        ok: true,
        sessions: [{ coding_session_id: 'sess_alive' }],
        warning: null,
      }),
    });
    assert.equal(status, 0);
    const j = parseJsonOrNull(stdout.join(''));
    const ghost = j.entries.find((e) => e.name === 'ghost');
    const alive = j.entries.find((e) => e.name === 'alive');
    // Dead PTY: never presented as live, and IS_ACTIVE_NOW cannot stand.
    assert.equal(ghost.session_state, 'stale');
    assert.equal(ghost.safety_verdict, 'SAFE_TO_END');
    // Broker-confirmed session keeps its stored state and verdict.
    assert.equal(alive.session_state, 'live');
    assert.equal(alive.safety_verdict, 'IS_ACTIVE_NOW');
    assert.match(stderr.join(''), /1 session\(s\) marked live in the registry/);
    assert.match(stderr.join(''), /mc storage repair --apply/);
  });

  test('--json escalates a stored SAFE_TO_END that fresh git facts contradict', async () => {
    const stdout = [];
    const stderr = [];
    const status = await runList(['--json'], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      checkAndPrintFreshInstall: async () => false,
      readRegistry: () => ({ entries: [
        makeEntry({
          name: 'dirty-safe',
          session_state: 'idle',
          safety_verdict: 'SAFE_TO_END',
          dirty_files: 300,
          ahead: 0,
        }),
        makeEntry({
          name: 'ahead-safe',
          session_state: 'idle',
          safety_verdict: 'SAFE_TO_END',
          dirty_files: 0,
          ahead: 2,
        }),
      ] }),
      fetchLocalBrokerSessions: async () => ({ ok: true, sessions: [], warning: null }),
    });
    assert.equal(status, 0);
    const j = parseJsonOrNull(stdout.join(''));
    assert.equal(j.entries.find((e) => e.name === 'dirty-safe').safety_verdict, 'NEEDS_REVIEW');
    assert.equal(j.entries.find((e) => e.name === 'ahead-safe').safety_verdict, 'HAS_UNMERGED_WORK');
  });

  test('human output soft-degrades when active-session fetch fails', async () => {
    const stdout = [];
    const stderr = [];
    const status = await runList([], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      checkAndPrintFreshInstall: async () => false,
      scanDaemons: () => ({ orphan: [], stale: [] }),
      readRegistry: () => ({ entries: [
        makeEntry({
          name: 'local-dead',
          branch: 'sess/local-dead',
          tool: 'claude',
          session_state: 'dead',
        }),
      ] }),
      fetchActiveSessions: async () => ({
        ok: false,
        sessions: [],
        warning: 'active sessions unavailable: offline',
      }),
    });
    assert.equal(status, 0);
    assert.match(stderr.join(''), /active sessions unavailable: offline/);
    const out = stdout.join('');
    assert.match(out, /Active sessions/);
    assert.match(out, /\(none\)/);
    assert.match(out, /1\. local-dead\s+local\s+claude/);
  });

  test('default human output lists local broker sessions as active', async () => {
    const stdout = [];
    const stderr = [];
    const status = await runList([], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      checkAndPrintFreshInstall: async () => false,
      scanDaemons: () => ({ orphan: [], stale: [] }),
      readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
      getSecret: async () => 'token',
      memoroFetch: async () => ({ ok: true, sessions: [] }),
      requestBroker: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return {
          ok: true,
          sessions: [{
            id: 'sess_action',
            name: 'action-v2',
            tool: 'codex',
            repo: 'memoro',
            branch: 'sess/action-v2',
            cwd: '/Users/me/.memoro/mc/worktrees/memoro/action-v2',
            last_output_at: new Date(Date.now() - 10_000).toISOString(),
            session_state: 'live',
            attachable: true,
          }],
        };
      },
      readRegistry: () => ({ entries: [
        makeEntry({
          name: 'action-v2',
          branch: 'sess/action-v2',
          repo_slug: 'memoro',
          coding_session_id: 'sess_action',
          tool: 'codex',
          session_state: 'live',
        }),
      ] }),
    });

    assert.equal(status, 0);
    assert.equal(stderr.join(''), '');
    const out = stdout.join('');
    assert.match(out, /Active sessions/);
    assert.match(out, /1\. action-v2\s+active\s+codex\s+memoro\s+sess\/action-v2/);
    assert.match(out, /Local sessions[\s\S]*\(none\)/);
  });

  test('active lookup merges local broker sessions when cloud has none', async () => {
    const res = await fetchActiveCodingSessionsWithLocalBroker({
      deps: {
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getSecret: async () => 'token',
        memoroFetch: async () => ({ ok: true, sessions: [] }),
        requestBroker: async () => ({
          ok: true,
          sessions: [{
            id: 'sess_trip',
            name: 'trip-v2',
            tool: 'codex',
            repo: 'memoro',
            branch: 'sess/trip-v2',
            session_state: 'live',
            attachable: true,
          }],
        }),
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.warning, null);
    assert.equal(res.sessions.length, 1);
    assert.equal(res.sessions[0].coding_session_id, 'sess_trip');
    assert.equal(res.sessions[0].label, 'trip-v2');
  });

  test('active lookup fails closed on malformed successful HTTP bodies', async () => {
    const common = {
      readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
      getSecret: async () => 'token',
    };
    for (const body of [{}, { ok: false }, { ok: true, sessions: null }]) {
      const result = await fetchActiveCodingSessions({
        deps: { ...common, memoroFetch: async () => body },
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.sessions, []);
      assert.match(result.warning, /invalid Memoro response/);
    }
  });

  test('active/local dedupe does not hide a same-label session from another repo', () => {
    const view = buildSessionListView({
      activeSessions: [{
        coding_session_id: 'sess_remote',
        label: 'data',
        repo: 'memoro',
        branch: 'sess/data',
        source: 'codex',
      }],
      localEntries: [
        makeEntry({
          name: 'data',
          repo_slug: 'memoro-cli',
          branch: 'sess/data',
          coding_session_id: null,
          tool: 'claude',
        }),
      ],
    });
    assert.equal(view.active.length, 1);
    assert.equal(view.local.length, 1);
    assert.equal(view.local[0].name, 'data');
  });

  test('active/local dedupe matches same repo and branch even when active label is missing', () => {
    const view = buildSessionListView({
      activeSessions: [{
        coding_session_id: 'sess_remote',
        repo: 'memoro-cli',
        branch: 'sess/dev',
        source: 'codex',
      }],
      localEntries: [
        makeEntry({
          name: 'dev',
          repo_slug: 'memoro-cli',
          branch: 'sess/dev',
          coding_session_id: null,
          tool: 'codex',
        }),
      ],
    });
    assert.equal(view.active.length, 1);
    assert.equal(view.local.length, 0);
  });

  test('active sessions without labels render branch as the display name', () => {
    const view = buildSessionListView({
      activeSessions: [{
        coding_session_id: 'sess_remote',
        repo: 'memoro-cli',
        branch: 'sess/dev',
        source: 'codex',
      }],
      localEntries: [],
    });
    const out = renderSessionListHuman({ view });
    assert.match(out, /1\. sess\/dev\s+active\s+codex/);
    assert.match(out, /id=sess_remote/);
  });

  test('human output hides active-session excerpts by default', () => {
    const view = buildSessionListView({
      activeSessions: [{
        coding_session_id: 'sess_remote',
        label: 'active-local',
        repo: 'memoro-cli',
        branch: 'sess/dev',
        source: 'codex',
        last_assistant_excerpt: 'raw \x1b[0 q terminal [0 q chatter',
      }],
      localEntries: [],
    });
    const out = renderSessionListHuman({ view });
    assert.match(out, /1\. active-local\s+active\s+codex/);
    assert.doesNotMatch(out, /terminal/);
    assert.doesNotMatch(out, /\[0 q/);
  });

  test('optional active-session excerpts are sanitized before rendering', () => {
    const view = buildSessionListView({
      activeSessions: [{
        coding_session_id: 'sess_remote',
        label: 'active-local',
        repo: 'memoro-cli',
        branch: 'sess/dev',
        source: 'codex',
        last_assistant_excerpt: 'Need \x1b[0 q clean [0 q text',
      }],
      localEntries: [],
    });
    const out = renderSessionListHuman({ view, includeExcerpts: true });
    assert.match(out, /Need\s+clean\s+text/);
    assert.doesNotMatch(out, /\x1b/);
    assert.doesNotMatch(out, /\[0 q/);
  });

  test('--all includes isolation worktrees with kind flag', () => {
    const r = runMc(['list', '--all', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    const iso = j.entries.find(e => e.name === 'iso-x');
    assert.ok(iso, 'iso-x should be present with --all');
    assert.equal(iso.kind, 'isolation');
    assert.ok(j.entries.find(e => e.name === 'missing-worktree'),
      'missing worktree entries should be present with --all');
  });

  test('--rich exposes the derived fields from §9a', () => {
    const r = runMc(['list', '--rich', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    const e = j.entries.find(x => x.name === 'awaiting-q');
    assert.ok(e);
    // Required derived fields per §9a.
    assert.ok('last_user_msg' in e || 'last_assistant_text' in e,
      'rich entry must include last_user_msg or last_assistant_text');
    assert.ok('open_question' in e);
    assert.ok('last_activity' in e);
    assert.ok('safety_verdict' in e);
  });

  // §9d filters ----------------------------------------------------------------

  test('--awaiting returns only sessions with an open question', () => {
    const r = runMc(['list', '--awaiting', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    const names = j.entries.map(e => e.name);
    assert.deepEqual(names, ['awaiting-q']);
  });

  test('--safe-to-end returns only SAFE_TO_END verdicts', () => {
    const r = runMc(['list', '--safe-to-end', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    const names = j.entries.map(e => e.name).sort();
    // active-now qualifies: its registry "live" has no broker session
    // (stale), and its git facts are clean — same demotion mc status
    // already applied to stale IS_ACTIVE_NOW.
    assert.deepEqual(names, ['active-now', 'really-idle', 'safe']);
  });

  test('--has-unmerged returns ahead-and-not-phantom only', () => {
    const r = runMc(['list', '--has-unmerged', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    const names = j.entries.map(e => e.name);
    assert.deepEqual(names, ['unmerged'],
      `phantom (also ahead=1) must be excluded; got ${names.join(',')}`);
  });

  test('--active returns live or recently-active sessions', () => {
    const r = runMc(['list', '--active', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    const names = j.entries.map(e => e.name);
    assert.deepEqual(names, ['active-now']);
  });

  test('--idle defaults to 6h cutoff', () => {
    const r = runMc(['list', '--idle', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    const names = j.entries.map(e => e.name);
    // Only `really-idle` is idle ≥ 6h. Others either active or < 6h.
    assert.ok(names.includes('really-idle'),
      `really-idle should appear; got ${names.join(',')}`);
    assert.ok(!names.includes('active-now'),
      'active-now must not appear');
  });

  test('--idle --since 30m widens the window', () => {
    const r = runMc(['list', '--idle', '--since', '30m', '--json'], {
      env: { MC_HOME: mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    const names = j.entries.map(e => e.name);
    // 30m threshold: awaiting-q (30m), safe (60m), unmerged (120m),
    // phantom (240m), really-idle (1d) → all idle. active-now excluded.
    assert.ok(!names.includes('active-now'),
      'active-now must be excluded from --idle');
    assert.ok(names.includes('really-idle'));
    assert.ok(names.includes('safe'));
  });

  test('--names emits one bare name per line (machine-friendly)', () => {
    const r = runMc(['list', '--safe-to-end', '--names'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const lines = r.stdout.split('\n').map(l => l.trim()).filter(Boolean).sort();
    assert.deepEqual(lines, ['active-now', 'really-idle', 'safe']);
  });
});
