/**
 * Open a tool inside a piece of work.
 *
 * This is the whole of what mc adds to running the tool by hand: it knows which
 * directory the work lives in. The conversation is the tool's, kept in the
 * tool's own store, indexed by that directory — so mc looks it up rather than
 * remembering it. Nothing is written here. There is no runtime host, no
 * journal, no generation: the tool inherits this terminal and mc waits.
 *
 * What the second word means, when there is one:
 *   (nothing)   the most recent conversation here, or a new one if there is none
 *   new         a new one regardless
 *   <id prefix> that one, as shown by `mc work`
 */
import { spawnSync } from 'node:child_process';

import { resolveLaunch } from '../adapters/index.js';
import { listConversations } from './conversations.js';
import { log } from './logger.js';
import { loadProfile, profileArgs } from './portrait.js';

export async function openInWorkArea({
  areaRoot,
  worktree,
  tool = null,
  pick = null,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const before = listConversations(areaRoot, env);

  // A named conversation decides its own tool: asking for one by id and being
  // given a different tool's conversation would be a worse answer than either.
  let chosen = null;
  if (pick && pick !== 'new') {
    chosen = before.find((item) => item.id.startsWith(pick)) || null;
    if (!chosen) return { ok: false, reason: `no conversation here starting with ${pick}` };
  }

  // Asking for a new conversation is not asking for a different tool: the tool
  // last used here is the one meant, unless a flag says otherwise.
  const wanted = chosen?.tool || tool || before[0]?.tool || 'codex';
  const launch = resolveLaunch(wanted);
  if (!launch?.ok) return { ok: false, reason: launch?.reason || 'tool-unavailable', hint: launch?.hint };
  const toolId = launch.id;
  if (!chosen && pick !== 'new') {
    chosen = before.find((item) => item.tool === toolId) || null;
  }

  // A new conversation is handed the user's Coding Profile as it starts. A
  // resumed one already has it in its own history, so asking again would be
  // saying the same thing twice — and would be the only reason opening
  // something existing had to touch the network at all.
  const args = chosen && typeof launch.adapter?.resumeArgs === 'function'
    ? launch.adapter.resumeArgs({ sessionId: chosen.id }) || []
    : profileArgs(toolId, await loadProfile({ env }));

  log('work.open', {
    area: areaRoot,
    cwd: worktree.path,
    tool: toolId,
    bin: launch.spec.bin,
    args: args.map((arg) => (arg.length > 60 ? `${arg.slice(0, 57)}…` : arg)),
    resuming: chosen?.id || null,
    profile: !chosen && args.length > 0,
    known_here: before.length,
  });

  const result = spawn(launch.spec.bin, args, { cwd: worktree.path, stdio: 'inherit', env });
  if (result?.error) {
    log('work.open-failed', { area: areaRoot, error: result.error.message });
    return { ok: false, reason: result.error.message };
  }

  // Neither tool writes anything until the first turn, so opening one and
  // quitting leaves no conversation at all. That is not a failure, but it is
  // the difference between "it did not work" and "there was nothing to keep",
  // and mc was silent about it — so it is asked and reported.
  const after = listConversations(areaRoot, env);
  const seen = new Set(before.map((item) => item.id));
  const started = after.find((item) => !seen.has(item.id)) || null;

  log('work.closed', {
    area: areaRoot,
    tool: toolId,
    exit_code: result?.status ?? 0,
    resumed: chosen?.id || null,
    started: started?.id || null,
    kept_nothing: !chosen && !started,
  });

  return {
    ok: true,
    tool: toolId,
    conversation: chosen?.id || started?.id || null,
    resumed: Boolean(chosen),
    started: started?.id || null,
    kept_nothing: !chosen && !started,
    code: result?.status ?? 0,
  };
}
