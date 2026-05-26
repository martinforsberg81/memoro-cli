/**
 * In-memory worktree registry fixture for tests.
 *
 * The plan (§9a / §10e) calls for a registry storing per-worktree
 * metadata: name, branch, kind (work/isolation/etc.), parent, tool,
 * model chain, last activity, dirty count, ahead count, etc.
 *
 * The CLI reads this from `${MC_HOME}/registry.json` (one source of
 * truth) — `git worktree list` remains authoritative for "what
 * worktrees exist" per §7, but derived fields come from the registry +
 * adapter probes.
 *
 * Tests build a fixture JSON with the shape the spec promises, then
 * stuff it at `${MC_HOME}/registry.json` before invoking `mc list …`.
 *
 * Schema judgment call: the plan never names the file. Going with
 * `registry.json` at the root of `MC_HOME` for simplicity. The
 * implementation session can pick a different path; tests will adapt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const REGISTRY_REL_PATH = 'registry.json';

/**
 * Build a single registry entry with sensible defaults. Override any
 * field via the patch arg.
 */
export function makeEntry(patch = {}) {
  return {
    name: 'sample',
    branch: 'sess/sample',
    worktree_path: '/tmp/nonexistent',
    repo_slug: 'memoro',
    kind: 'work',          // work | isolation | spawn | fanout-phase | …
    parent: null,
    tool: 'claude',
    model_chain: ['claude-sonnet-4.6'],
    created_at: '2026-05-25T10:00:00Z',
    last_activity: '2026-05-25T10:00:00Z',
    last_user_msg: null,
    last_assistant_text: null,
    session_state: 'idle',  // live | idle | dead | no-session-yet
    dirty_files: 0,
    ahead: 0,
    behind: 0,
    open_question: false,
    safety_verdict: 'SAFE_TO_END',
    ...patch,
  };
}

/**
 * Write a registry file at `${mcHome}/registry.json` with the given
 * entries.
 */
export function writeRegistry(mcHome, entries) {
  const path = join(mcHome, REGISTRY_REL_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ entries }, null, 2));
  return path;
}
