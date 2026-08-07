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
import { loadProfile, profileArgs, readCached as loadProfileSync } from './portrait.js';

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

/**
 * Start a conversation nobody is sitting in front of.
 *
 * The point is not a second way for the user to work — a terminal window is
 * better for that in every respect. The point is a conversation that another
 * session can talk to. A tool that owns a terminal can only be typed into by
 * the person at that terminal: `do script` into Terminal.app never reaches a
 * running TUI, and System Events keystrokes are refused without accessibility
 * permission and would steal focus even with it. tmux is the one channel that
 * exists, and here it is plumbing the user never looks at.
 *
 * Two things an unattended conversation cannot do for itself:
 *
 * The trust dialog. Claude asks whether it may work in a directory it has not
 * seen, and there is nobody to answer. mc created that directory, from the
 * user's own repository, moments earlier — so mc answers it, and says it did.
 *
 * A task. A worker started with nothing to do sits at an empty prompt for as
 * long as it is left there, which is the most expensive way to do nothing.
 */
export function startInBackground({
  name,
  areaRoot,
  worktree,
  tool = 'claude',
  task = null,
  env = process.env,
  run = null,
} = {}) {
  const launch = resolveLaunch(tool);
  if (!launch?.ok) return { ok: false, reason: launch?.reason || 'tool-unavailable', hint: launch?.hint };
  const target = `mc-${name}`;
  const tmux = run || ((args, options = {}) => spawnSync('tmux', args, { encoding: 'utf8', ...options }));

  if (tmux(['has-session', '-t', target]).status === 0) {
    return { ok: false, reason: 'already-running', target };
  }

  const args = [launch.spec.bin, ...profileArgs(launch.id, loadProfileSync(env))];
  if (task) args.push(task);
  // tmux runs its command through a shell, so the profile — a few kilobytes of
  // the user's own prose, with quotes and newlines in it — has to survive
  // quoting. Claude has no --append-system-prompt-file to point at instead.
  const command = args.map(shellQuote).join(' ');

  const created = tmux(['new-session', '-d', '-s', target, '-c', worktree.path, command]);
  if (created.status !== 0) {
    return { ok: false, reason: (created.stderr || 'tmux refused to start it').trim() };
  }
  log('work.background-start', { area: areaRoot, target, tool: launch.id, task: Boolean(task) });
  return { ok: true, target, tool: launch.id };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/**
 * Answer the one question a worker cannot answer for itself.
 *
 * Claude asks whether it may work in a directory it has not seen before, and
 * an unattended session sits on that question forever — the first background
 * worker started this way did nothing for forty seconds and had produced no
 * transcript at all, because it was still asking.
 *
 * Only this dialog, only in the seconds right after mc started it, and only
 * in a directory mc itself just created. Anything else on that screen is left
 * alone.
 */
export function clearTrustDialog(target, { attempts = 12, run = null, sleep = null } = {}) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  const wait = sleep || ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    wait(1000);
    const pane = tmux(['capture-pane', '-t', target, '-p']);
    if (pane.status !== 0) return { asked: false, reason: 'gone' };
    const text = pane.stdout || '';
    if (/trust this folder/iu.test(text)) {
      tmux(['send-keys', '-t', target, 'Enter']);
      log('work.background-trust-answered', { target });
      return { asked: true, answered: true };
    }
    // A prompt with no dialog above it means it is up and listening.
    if (/❯/u.test(text)) return { asked: false };
  }
  return { asked: false, reason: 'never-settled' };
}
