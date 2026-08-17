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
import { conversationModel, listConversations } from './conversations.js';
import { log } from './logger.js';
import { instructionsFor } from './roles.js';
import { loadProfile, profileArgs, readCached as loadProfileSync } from './portrait.js';

export async function openInWorkArea({
  areaRoot,
  worktree,
  tool = null,
  pick = null,
  model = null,
  overlay = null,
  defaultModel = null,
  defaultModelTool = null,
  env = process.env,
  spawn = spawnSync,
  loadProfile: readProfile = loadProfile,
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
  //
  // The model rides along at both moments. New: whatever `--model` said,
  // else the area's role default — but only for the tool the role's defaults
  // are written for; a Claude model name handed to a codex launch is a
  // launch error wearing a role. Resumed: the flag if there is one,
  // otherwise what the transcript says the conversation was already running
  // on, and nothing else — a resume should land where the conversation was,
  // and the role default is a start-of-life setting, not a resume setting.
  // In a role's area the overlay rides behind the profile (`instructionsFor`
  // keeps it Claude-only); an ordinary area has neither overlay nor default,
  // and launches exactly as it always has.
  const roleDefault = defaultModel && (!defaultModelTool || launch.shortName === defaultModelTool)
    ? defaultModel
    : null;
  const chosenModel = chosen ? (model || conversationModel(chosen)) : (model || roleDefault);
  const resuming = chosen && typeof launch.adapter?.resumeArgs === 'function';
  const profile = resuming
    ? []
    : profileArgs(toolId, instructionsFor(toolId, await readProfile({ env }), overlay));
  const args = resuming
    ? launch.adapter.resumeArgs({ sessionId: chosen.id, model: chosenModel }) || []
    : [...(launch.adapter?.modelArgs?.(chosenModel) ?? []), ...profile];

  log('work.open', {
    area: areaRoot,
    cwd: worktree.path,
    tool: toolId,
    bin: launch.spec.bin,
    args: args.map((arg) => (arg.length > 60 ? `${arg.slice(0, 57)}…` : arg)),
    resuming: chosen?.id || null,
    model: chosenModel || null,
    overlay: !resuming && Boolean(overlay) && toolId === 'claude-code',
    profile: profile.length > 0,
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
/**
 * Is this piece of work already running somewhere, and can we go to it?
 *
 * The same conversation can be entered two ways: started in the background
 * for another session to drive, and joined from a terminal when a person
 * wants to see it. That is only true if joining goes to the one that is
 * running. Resuming it a second time starts another process on the same
 * transcript, which is two writers on one file and one of them is wrong.
 */
export function backgroundTarget(name, { run = null } = {}) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  const target = `mc-${name}`;
  return tmux(['has-session', '-t', target]).status === 0 ? target : null;
}

/** Give this terminal to the running session until the user detaches. */
export function attachBackground(target, { run = null, env = process.env } = {}) {
  const attach = run || ((args) => spawnSync('tmux', args, { stdio: 'inherit', env }));
  log('work.background-attach', { target });
  const result = attach(['attach-session', '-t', target]);
  return { ok: !result?.error, code: result?.status ?? 0, reason: result?.error?.message };
}

/**
 * What a session mc creates should feel like when somebody attaches to it.
 *
 * These are comfort, not plumbing: a person who attaches expects the wheel to
 * scroll and does not expect a green bar across the bottom announcing a tmux
 * they never asked for. Set on the session — `-t <target>` — and never with
 * `-g`. The user's own tmux, and their own sessions, are theirs; mc changing a
 * global option would reach every session on the machine, which is a thing a
 * tool has no business doing to fix the look of its own.
 *
 * `history-limit` is the honest exception, and it is set anyway. tmux fixes a
 * pane's scrollback when the pane is created, so this does not enlarge the one
 * `new-session` just made — verified against tmux 3.6b: the first pane stays
 * at 2000 while a window opened later in the same session gets 50000. It is
 * here because it costs nothing, it is right for every pane opened in the
 * session afterwards, and the alternative — creating the session, setting the
 * option, then respawning the pane — throws away the pane's history to buy
 * scrollback, which is the wrong trade.
 */
const SESSION_OPTIONS = Object.freeze([
  ['mouse', 'on'],
  ['status', 'off'],
  ['history-limit', '50000'],
]);

export function startInBackground({
  name,
  areaRoot,
  worktree,
  tool = 'claude',
  task = null,
  model = null,
  overlay = null,
  defaultModel = null,
  defaultModelTool = null,
  conversation = null,
  env = process.env,
  run = null,
  loadProfile: readProfile = loadProfileSync,
} = {}) {
  const launch = resolveLaunch(tool);
  if (!launch?.ok) return { ok: false, reason: launch?.reason || 'tool-unavailable', hint: launch?.hint };
  const target = `mc-${name}`;
  const tmux = run || ((args, options = {}) => spawnSync('tmux', args, { encoding: 'utf8', ...options }));

  if (tmux(['has-session', '-t', target]).status === 0) {
    return { ok: false, reason: 'already-running', target };
  }

  // The role default follows the role's tool here too (see openInWorkArea).
  const roleDefault = defaultModel && (!defaultModelTool || launch.shortName === defaultModelTool)
    ? defaultModel
    : null;
  // A conversation to resume changes everything about the argv: its history
  // already holds the profile and any overlay, and the model — resolved by
  // the caller, flag over transcript — rides on the resume flags.
  const args = conversation
    ? [
      launch.spec.bin,
      ...(launch.adapter?.resumeArgs?.({ sessionId: conversation.id, model: conversation.model || null }) || []),
    ]
    : [
      launch.spec.bin,
      ...(launch.adapter?.modelArgs?.(model || roleDefault) ?? []),
      ...profileArgs(launch.id, instructionsFor(launch.id, readProfile(env), overlay)),
    ];
  // A task goes in either way. On a new conversation it is the opening words;
  // on a resumed one it lands as a reply to wherever that conversation
  // stopped — which is what somebody asking for both at once is asking for.
  // Nothing combined them before this, so no existing launch changes shape.
  if (task) args.push(task);
  // tmux runs its command through a shell, so the profile — a few kilobytes of
  // the user's own prose, with quotes and newlines in it — has to survive
  // quoting, and so does everything beside it on the line. Claude has no
  // --append-system-prompt-file to point at instead.
  const command = args.map(shellQuote).join(' ');

  const created = tmux(['new-session', '-d', '-s', target, '-c', worktree.path, command]);
  if (created.status !== 0) {
    return { ok: false, reason: (created.stderr || 'tmux refused to start it').trim() };
  }
  // Straight after creation, and the result is not checked: a session that
  // runs but kept its status bar is a working session, and refusing to start a
  // conversation over the look of it would be the tail wagging the dog.
  for (const [option, value] of SESSION_OPTIONS) tmux(['set-option', '-t', target, option, value]);
  log('work.background-start', {
    area: areaRoot,
    target,
    tool: launch.id,
    model: (conversation ? conversation.model : model) || null,
    resuming: conversation?.id || null,
    task: Boolean(task && !conversation),
  });
  return { ok: true, target, tool: launch.id, resumed: conversation?.id || null };
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
