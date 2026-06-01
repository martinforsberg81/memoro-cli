/**
 * Tests for the §12e PreToolUse hook integration.
 *
 * Pattern split (per drev-3+4 lesson "test-only the --json path"):
 *   - Pure helpers (renderHookScript, withMcEntriesInserted,
 *     withMcEntriesRemoved) get in-process unit tests with no I/O.
 *   - installHook / uninstallHook get integration tests against a real
 *     tmpdir worktree, so we cover the file-mode + JSON round-trip
 *     paths the user actually sees.
 *   - The hook script itself is executed via bash with a hand-built
 *     stdin payload + manifest. This is the load-bearing assertion:
 *     "the script Claude Code installs actually denies the right
 *     paths and silently allows the rest."
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  installHook,
  uninstallHook,
  renderHookScript,
  withMcEntriesInserted,
  withMcEntriesRemoved,
  settingsPathFor,
  hookScriptPathFor,
} from '../../../src/mc/vault/hook.js';

// ──────────────────────────────────────────────────────────────────
// Pure-helper unit tests
// ──────────────────────────────────────────────────────────────────

describe('renderHookScript', () => {
  it('bakes in the manifest path with single-quote escaping', () => {
    const script = renderHookScript({
      manifestPath: '/tmp/manifests/sess-x.json',
      sessionId: 'sess-x',
    });
    assert.match(script, /MANIFEST='\/tmp\/manifests\/sess-x\.json'/);
    assert.match(script, /^#!\/usr\/bin\/env bash/);
    // Generic denial message — must not mention the path or token.
    assert.match(script, /managed vault path/);
  });

  it('throws on missing args', () => {
    assert.throws(() => renderHookScript({ sessionId: 'x' }), /manifestPath/);
    assert.throws(() => renderHookScript({ manifestPath: '/x' }), /sessionId/);
  });
});

describe('withMcEntriesInserted', () => {
  it('inserts Bash + Read entries on an empty settings object', () => {
    const out = withMcEntriesInserted({}, '/wt/.claude/hooks/x.sh');
    assert.equal(out.hooks.PreToolUse.length, 2);
    const matchers = out.hooks.PreToolUse.map((e) => e.matcher).sort();
    assert.deepEqual(matchers, ['Bash', 'Read']);
    for (const e of out.hooks.PreToolUse) {
      assert.equal(e._mc_vault_managed, true);
      assert.equal(e.hooks[0].command, '/wt/.claude/hooks/x.sh');
    }
  });

  it('preserves existing non-mc entries (memoro case)', () => {
    const existing = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/block-prod-wrangler.sh' }],
          },
        ],
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'post.sh' }] },
        ],
      },
    };
    const out = withMcEntriesInserted(existing, '/wt/mc.sh');
    // Memoro's existing entry preserved verbatim.
    assert.deepEqual(
      out.hooks.PreToolUse[0],
      existing.hooks.PreToolUse[0],
      'pre-existing PreToolUse entry must be untouched',
    );
    // Both mc entries appended.
    assert.equal(out.hooks.PreToolUse.length, 3);
    // PostToolUse and permissions preserved.
    assert.deepEqual(out.hooks.PostToolUse, existing.hooks.PostToolUse);
    assert.deepEqual(out.permissions, existing.permissions);
  });

  it('is idempotent — re-inserting replaces in place, never duplicates', () => {
    const once = withMcEntriesInserted({}, '/wt/mc.sh');
    const twice = withMcEntriesInserted(once, '/wt/mc.sh');
    assert.equal(twice.hooks.PreToolUse.length, 2);
  });

  it('updates the command when the script path changes', () => {
    const once = withMcEntriesInserted({}, '/wt/old.sh');
    const twice = withMcEntriesInserted(once, '/wt/new.sh');
    assert.equal(twice.hooks.PreToolUse.length, 2);
    for (const e of twice.hooks.PreToolUse) {
      assert.equal(e.hooks[0].command, '/wt/new.sh');
    }
  });
});

describe('withMcEntriesRemoved', () => {
  it('removes only managed entries', () => {
    const after = withMcEntriesInserted({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook.sh' }] },
        ],
      },
    }, '/wt/mc.sh');
    const stripped = withMcEntriesRemoved(after);
    assert.equal(stripped.hooks.PreToolUse.length, 1);
    assert.equal(stripped.hooks.PreToolUse[0].hooks[0].command, 'user-hook.sh');
  });

  it('drops empty PreToolUse + hooks containers', () => {
    const after = withMcEntriesInserted({}, '/wt/mc.sh');
    const stripped = withMcEntriesRemoved(after);
    assert.deepEqual(stripped, {});
  });

  it('is a no-op on settings without mc entries', () => {
    const original = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
    };
    const stripped = withMcEntriesRemoved(original);
    assert.equal(stripped, original); // returns input as-is for the no-op
  });
});

// ──────────────────────────────────────────────────────────────────
// Filesystem integration: install / uninstall
// ──────────────────────────────────────────────────────────────────

describe('installHook + uninstallHook (filesystem)', () => {
  let root;
  let worktree;
  let manifestPath;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-hook-test-'));
    worktree = join(root, 'wt');
    mkdirSync(worktree, { recursive: true });
    manifestPath = join(root, 'manifest.json');
  });
  after(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('case 1: no .claude/settings.json in worktree → creates one', async () => {
    const sessionId = 'sess-a';
    const res = await installHook({ worktreePath: worktree, sessionId, manifestPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.settingsCreated, true);
    const settings = JSON.parse(readFileSync(res.installedSettingsPath, 'utf8'));
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assert.ok(existsSync(res.hookScriptPath));
    // Script executable bit set.
    const mode = statSync(res.hookScriptPath).mode & 0o777;
    assert.equal((mode & 0o100) >> 6, 1, `script must be executable (mode=${mode.toString(8)})`);
  });

  it('case 2: settings.json exists but no hooks key → adds hooks section', async () => {
    const settingsPath = settingsPathFor(worktree);
    mkdirSync(join(worktree, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));

    const res = await installHook({ worktreePath: worktree, sessionId: 'sess-b', manifestPath });
    assert.equal(res.ok, true);
    assert.equal(res.settingsCreated, false);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // Permissions preserved.
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
    assert.equal(settings.hooks.PreToolUse.length, 2);
  });

  it('case 3: settings.json with existing hooks → adds without modifying existing', async () => {
    const settingsPath = settingsPathFor(worktree);
    mkdirSync(join(worktree, '.claude'), { recursive: true });
    const original = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/block-prod-wrangler.sh' }] },
        ],
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'post.sh' }] },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original));

    const res = await installHook({ worktreePath: worktree, sessionId: 'sess-c', manifestPath });
    assert.equal(res.ok, true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // The original user entry is the FIRST element (we append).
    assert.deepEqual(settings.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
    assert.equal(settings.hooks.PreToolUse.length, 3);
    assert.deepEqual(settings.hooks.PostToolUse, original.hooks.PostToolUse);
  });

  it('uninstall: file mc created with only mc entries → deleted outright', async () => {
    const sessionId = 'sess-d';
    const r1 = await installHook({ worktreePath: worktree, sessionId, manifestPath });
    assert.equal(r1.ok, true);
    assert.equal(r1.settingsCreated, true);

    const r2 = await uninstallHook({
      worktreePath: worktree, sessionId, settingsCreatedByMc: true,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.settingsRemoved, true);
    assert.equal(existsSync(settingsPathFor(worktree)), false, 'settings.json must be deleted');
    assert.equal(existsSync(hookScriptPathFor(worktree, sessionId)), false, 'hook script must be deleted');
  });

  it('uninstall: pre-existing settings.json → byte-identical pre/post', async () => {
    const settingsPath = settingsPathFor(worktree);
    mkdirSync(join(worktree, '.claude'), { recursive: true });
    const originalText = JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'user.sh' }] },
        ],
      },
    }, null, 2) + '\n';
    writeFileSync(settingsPath, originalText);

    const sessionId = 'sess-e';
    const r1 = await installHook({ worktreePath: worktree, sessionId, manifestPath });
    assert.equal(r1.ok, true);
    assert.equal(r1.settingsCreated, false);

    // After install, file content has the mc entries.
    const afterInstall = readFileSync(settingsPath, 'utf8');
    assert.notEqual(afterInstall, originalText, 'install should change settings.json');

    const r2 = await uninstallHook({
      worktreePath: worktree, sessionId, settingsCreatedByMc: false,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.settingsRemoved, false, 'must NOT delete pre-existing file');

    // Byte-identical comparison.
    const afterUninstall = readFileSync(settingsPath, 'utf8');
    assert.equal(afterUninstall, originalText,
      'settings.json must be byte-identical to its pre-install state');
  });

  it('install + uninstall are idempotent', async () => {
    const sessionId = 'sess-f';
    const r1 = await installHook({ worktreePath: worktree, sessionId, manifestPath });
    assert.equal(r1.ok, true);
    const r2 = await installHook({ worktreePath: worktree, sessionId, manifestPath });
    assert.equal(r2.ok, true);
    const settings = JSON.parse(readFileSync(r1.installedSettingsPath, 'utf8'));
    // Still exactly 2 mc entries.
    assert.equal(settings.hooks.PreToolUse.length, 2);

    const u1 = await uninstallHook({
      worktreePath: worktree, sessionId, settingsCreatedByMc: true,
    });
    assert.equal(u1.ok, true);
    const u2 = await uninstallHook({
      worktreePath: worktree, sessionId, settingsCreatedByMc: true,
    });
    assert.equal(u2.ok, true, 'second uninstall is a no-op, never errors');
  });

  it('worktreePath missing → ok:false', async () => {
    const res = await installHook({
      worktreePath: join(root, 'does-not-exist'),
      sessionId: 'x', manifestPath,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'worktree-missing');
  });

  it('refuses to clobber a malformed settings.json', async () => {
    const settingsPath = settingsPathFor(worktree);
    mkdirSync(join(worktree, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ not json');

    const res = await installHook({
      worktreePath: worktree, sessionId: 'sess-bad', manifestPath,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'settings-malformed');
  });
});

// ──────────────────────────────────────────────────────────────────
// Hook-script execution: does the bash actually deny / allow?
// ──────────────────────────────────────────────────────────────────

function runHookScript(scriptPath, stdinJson) {
  const result = spawnSync('bash', [scriptPath], {
    input: typeof stdinJson === 'string' ? stdinJson : JSON.stringify(stdinJson),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('hook script behaviour', () => {
  let root;
  let worktree;
  let manifestPath;
  let scriptPath;

  before(async () => {
    // Skip the whole suite if jq isn't on $PATH (CI sanity).
    const jqProbe = spawnSync('jq', ['--version'], { encoding: 'utf8' });
    if (jqProbe.status !== 0) return; // describe.skip-equivalent

    root = mkdtempSync(join(tmpdir(), 'mc-hook-script-'));
    worktree = join(root, 'wt');
    mkdirSync(worktree, { recursive: true });
    manifestPath = join(root, 'manifest.json');
    // Write a manifest that says we materialised /tmp/mc-fake-credentials.json
    writeFileSync(manifestPath, JSON.stringify({
      schema: 1,
      sessionId: 'sess-hook',
      materialised: [
        { tool: 'claude', label: 'a', location: { type: 'file', path: '/tmp/mc-fake-credentials.json' } },
        { tool: 'codex',  label: 'b', location: { type: 'file', path: '/tmp/mc-fake-auth.json' } },
      ],
    }));
    const r = await installHook({ worktreePath: worktree, sessionId: 'sess-hook', manifestPath });
    assert.equal(r.ok, true);
    scriptPath = r.hookScriptPath;
  });
  after(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('denies Read of a materialised file_path', () => {
    if (!scriptPath) return; // jq absent
    const res = runHookScript(scriptPath, {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/mc-fake-credentials.json' },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /"permissionDecision": "deny"/);
    assert.match(res.stdout, /managed vault path/);
    // Generic message must NOT include the actual path.
    assert.ok(!res.stdout.includes('/tmp/mc-fake-credentials.json'),
      'denial reason must not echo the matched path');
  });

  it('denies Bash command referencing a materialised path', () => {
    if (!scriptPath) return;
    const res = runHookScript(scriptPath, {
      tool_name: 'Bash',
      tool_input: { command: 'cat /tmp/mc-fake-auth.json' },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /"permissionDecision": "deny"/);
  });

  it('allows silently for unrelated paths', () => {
    if (!scriptPath) return;
    const res = runHookScript(scriptPath, {
      tool_name: 'Read',
      tool_input: { file_path: '/home/user/README.md' },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', `expected silent allow, got: ${res.stdout}`);
  });

  it('fail-open when manifest is missing', () => {
    if (!scriptPath) return;
    rmSync(manifestPath, { force: true });
    const res = runHookScript(scriptPath, {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/mc-fake-credentials.json' },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    // Restore for downstream tests in case run order shifts.
    writeFileSync(manifestPath, JSON.stringify({
      schema: 1, sessionId: 'sess-hook', materialised: [],
    }));
  });
});
