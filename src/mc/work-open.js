/**
 * Open a tool inside a piece of work.
 *
 * This is the whole of what mc adds to running the tool by hand: it knows which
 * directory the work lives in. The conversation is the tool's, kept in the
 * tool's own store, indexed by that directory — so mc looks it up rather than
 * remembering it. The tool inherits this terminal and mc waits. Linux SSH
 * entrances of the person roles are served by a provider-owned persistent
 * session instead (see `session-entrance.js`): Claude's background daemon,
 * Codex's own app-server.
 *
 * Conversation selection (`pick`):
 *   (nothing)   the most recent conversation here, or a new one if there is none
 *   new         a new one regardless
 *   true        choose from compatible conversations
 *   <id prefix> that one, as the conversation picker shows it
 *
 * `prompt` is the conversation's opening words, given to a new conversation
 * only: both tools take it as the last positional argument. A resumed
 * conversation already has its own history and is not spoken over — unless
 * the caller hands a `resumePrompt`, which lands as a reply to wherever that
 * conversation stopped. Nothing hands one today: `mc brief` resumes where the
 * session was, as `mc helper` does.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { interactive, select } from './prompt.js';
import { resolveLaunch } from '../adapters/index.js';
import { trustClaudeFolder } from './claude-trust.js';
import { SESSION_IDENTITY_ENV, normalizeSessionRole, sessionLaunchEnvironment } from './session-role.js';
import { conversationIdentityReader, conversationModel, launchIdentityMarker, listConversations } from './conversations.js';
import { log } from './logger.js';
import { workAreaName, workAreaPath, workRoot } from './paths.js';
import { instructionsFor, roleRecord, textDigest } from './roles.js';
import { profileArgs } from './portrait.js';
import { askToolToLeave } from './work-stop.js';
import { registerForeground } from './foreground.js';
import { OWNERLESS_HINT, ownerOf } from './session-owner.js';
import { clearStopMark } from './work-stop-marker.js';
import { interactiveWorkspaceDirectories } from './interactive-workspace.js';
import { interactiveAccessOptions } from './interactive-access.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { PROVIDER_API_ENV_NAMES, scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { entersPersistentSession, prepareSessionEntrance } from './session-entrance.js';

/** Provider mechanics of a persistent entrance, by launch id; loaded only when one is used. */
const PERSISTENT_DRIVERS = {
  'claude-code': async () => (await import('./claude-background.js')).claudeBackgroundDriver(),
  codex: async () => (await import('./codex-sessions.js')).codexSessionDriver(),
};

export async function interactiveLaunchPlan({
  areaRoot,
  conversationRoots = [areaRoot],
  worktree,
  tool = null,
  pick = null,
  resumeTool = null,
  choose = select,
  isInteractive = interactive,
  stdout = process.stdout,
  model = null,
  overlay = null,
  prompt = null,
  resumePrompt = null,
  defaultModel = null,
  defaultModelTool = null,
  // Which verb opened this, and in which area — the two words NOW needs to
  // name the session while it is up. A caller that says nothing registers
  // nothing: this is what the verbs know and the opener does not.
  verb = null,
  areaName = null,
  // Which role the overlay came from, and out of which catalogue. The opener
  // is handed the text and could never say what it was; the register that
  // outlives this launch has to (see `roleRecord`).
  roleName = null,
  programme = null,
  roleSource = null,
  // The role's prompt-cache TTL (ruling 40); a launch without a role is an hour.
  cache = '1h',
  env = process.env,
  stderr = process.stderr,
  onProvider = () => {},
  resolved = async () => ({}),
  conversations = listConversations,
  identify = conversationIdentityReader(),
  resolve = resolveLaunch,
  billingRoute = billingRouteNow,
  liveConversation = async () => null,
} = {}) {
  // Every session belongs to a programme or a desk (session-owner.js); one mc
  // would start for nobody is refused before anything is looked up or spawned.
  if (!ownerOf({ verb, area: areaName, programme })) return { ok: false, reason: 'no owner', hint: OWNERLESS_HINT };
  const before = [...new Map(conversationRoots.flatMap(root => conversations(root, env))
    .sort((a, b) => (b.updated_ms || 0) - (a.updated_ms || 0))
    .map(item => [`${item.tool}:${item.id}`, item])).values()];

  // A named conversation decides its own tool: asking for one by id and being
  // given a different tool's conversation would be a worse answer than either.
  let chosen = null;
  let liveIdentity = null;
  if (typeof pick === 'string' && pick !== 'new') {
    const matches = before.filter((item) => item.id.startsWith(pick));
    if (matches.length > 1) return { ok: false, reason: `ambiguous conversation prefix ${pick}; use a longer id` };
    chosen = matches[0] || null;
    if (!chosen) {
      const live = await liveConversation(pick);
      if (live?.error) return { ok: false, reason: live.error };
      chosen = live?.conversation || null;
      liveIdentity = live?.identity || null;
    }
    if (!chosen) return { ok: false, reason: `no conversation here starting with ${pick}` };
  }

  const requestedRole = normalizeSessionRole(roleName || (verb === 'plan' ? 'plan' : null));
  const requestedProgramme = programme || null;
  const guarded = Boolean(requestedRole || requestedProgramme);
  const compatible = (identity) => identity && requestedRole
    && identity.role === requestedRole && identity.programme === requestedProgramme;
  const freshRoute = verb === 'plan' ? `mc plan ${programme} --new` : 'select new to start a fresh session';
  const decision = (item, identity, action) => {
    log('work.resume-decision', {
      requested_role: requestedRole, requested_programme: requestedProgramme,
      identified_role: identity?.role || null, identified_programme: identity?.programme || null,
      evidence: identity?.source || null, conversation: item?.id || null,
      tool: item?.tool || null, decision: action,
    });
    return `requested role=${requestedRole || 'unknown'} programme=${requestedProgramme || 'none'}; `
      + `identified role=${identity?.role || 'unknown'} programme=${identity ? identity.programme || 'none' : 'unknown'}`;
  };
  if (pick === true) {
    const candidates = before.filter((item) => (!resumeTool || item.tool === (resumeTool === 'claude' ? 'claude-code' : resumeTool))
      && (!guarded || compatible(identify(item))));
    if (!candidates.length) return { ok: false, reason: 'no compatible conversation here to resume' };
    const items = candidates.map((item, index) => ({
      key: index + 1, name: item.id, value: item.id,
      label: `${item.id}  ${item.tool}  ${new Date(item.updated_ms || 0).toISOString()}  ${String(item.label || '(no title)').replace(/\s+/gu, ' ').slice(0, 160)}`,
    }));
    if (!isInteractive(env)) {
      for (const item of items) stdout.write(`${item.label}\n`);
      return { ok: false, reason: 'choose a conversation with --resume <id> in a terminal' };
    }
    const id = choose('which conversation?', items, { stdout });
    if (!id) return { ok: true, code: 0, cancelled: true };
    chosen = candidates.find((item) => item.id === id) || null;
    if (!chosen) return { ok: false, reason: 'the selected conversation is not available' };
  }
  if (chosen && guarded) {
    let identity = liveIdentity || identify(chosen);
    if (!compatible(identity)) {
      // Joining a live provider uses its proven current launch identity, not
      // possibly incomplete transcript evidence. A start still needs provenance.
      const live = await liveConversation(chosen.id);
      if (live?.conversation?.id === chosen.id && compatible(live.identity)) identity = live.identity;
    }
    if (!compatible(identity)) {
      const explanation = decision(chosen, identity, 'refuse');
      return { ok: false, reason: `cannot resume ${chosen.id}: ${explanation}`, hint: freshRoute };
    }
    decision(chosen, identity, 'resume');
  }

  // A tool flag still selects the provider; a named id still selects its own.
  const wanted = chosen?.tool || tool || before[0]?.tool || 'codex';
  const launch = resolve(wanted);
  if (!launch?.ok) return { ok: false, reason: launch?.reason || 'tool-unavailable', hint: launch?.hint };
  const toolId = launch.id;
  onProvider(launch.shortName);
  // Resolve a named conversation before choosing its transport. The callback
  // may join a live session, or exclude conversations already held by one.
  const entrance = await resolved({ launch, before, chosen });
  if (entrance.result) return entrance.result;
  const held = entrance.held || new Set();
  if (!chosen && pick !== 'new') {
    for (const item of before.filter((candidate) => candidate.tool === toolId && !held.has(candidate.id))) {
      if (!guarded) { chosen = item; break; }
      const identity = identify(item);
      if (compatible(identity)) {
        chosen = item;
        decision(item, identity, 'resume');
        break;
      }
      const explanation = decision(item, identity, 'exclude');
      stderr.write(`mc: not resuming ${item.id}: ${explanation}. Looking for a compatible conversation; otherwise starting fresh.\n`);
    }
  }
  if (!chosen && guarded) decision(null, null, pick === 'new' ? 'fresh-requested' : 'fresh');

  // A role-aware resume is allowed only after historical identity is proven.
  // Native instruction configuration is supplied on each such launch; a user
  // reply cannot change historical developer authority.
  //
  // The model rides along at both moments. New: whatever `--model` said,
  // else the area's role default — but only for the tool the role's defaults
  // are written for; a Claude model name handed to a codex launch is a
  // launch error wearing a role. Resumed: the flag if there is one,
  // otherwise what the transcript says the conversation was already running
  // on, and nothing else — a resume should land where the conversation was,
  // and the role default is a start-of-life setting, not a resume setting.
  // In a role's area the overlay rides on whichever instruction channel the
  // chosen tool takes at launch; an ordinary area has neither overlay nor
  // default, and launches with no instructions at all.
  const roleDefault = defaultModel && (!defaultModelTool || launch.shortName === defaultModelTool)
    ? defaultModel
    : null;
  const planning = verb === 'plan';
  const chosenModel = planning
    ? (model || (launch.id === 'codex' ? 'gpt-6.1-sol' : 'opus'))
    : chosen ? (model || conversationModel(chosen)) : (model || roleDefault);
  const resuming = chosen && typeof launch.adapter?.resumeArgs === 'function';
  if (chosen && !resuming) return { ok: false, reason: `cannot resume a ${toolId} conversation with this adapter` };
  // Claude's append-system-prompt is launch configuration, not transcript
  // history: supply it on compatible resumes too. Codex uses its native
  // developer instruction setting (ordinary resume text cannot replace it).
  const roleInstructions = resuming && !guarded ? null : instructionsFor(toolId, overlay);
  const instructions = toolId === 'codex' && guarded && roleInstructions
    ? `${roleInstructions}\n\n${launchIdentityMarker({ role: requestedRole, programme: requestedProgramme })}`
    : roleInstructions;
  const handed = toolId === 'codex' && guarded && instructions
    ? ['-c', `developer_instructions=${JSON.stringify(instructions)}`]
    : (resuming && toolId !== 'claude-code' ? [] : profileArgs(toolId, instructions));
  const launchedId = !resuming && guarded && handed.length && toolId === 'claude-code' ? randomUUID() : null;
  // No CLAUDE.md, AGENTS.md or memory, and the role's TTL: on a resume too,
  // including the role-aware instruction configuration.
  const session = [...sessionSwitches(launch, cache), ...(planning ? launch.adapter?.effortArgs?.('medium') ?? [] : [])];
  const resumed = resuming ? launch.adapter.resumeArgs({ sessionId: chosen.id, model: chosenModel }) || [] : [];
  const baseArgs = resuming
    ? [...resumeWith(toolId, resumed, [...handed, ...session]), ...(resumePrompt ? [resumePrompt] : [])]
    : [...(launch.adapter?.modelArgs?.(chosenModel) ?? []), ...handed, ...session, ...(launchedId ? launch.adapter.newSessionArgs({ sessionId: launchedId }) : []), ...(prompt ? [prompt] : [])];

  const args = interactiveArgs(launch, baseArgs, { areaRoot, cwd: worktree.path, env });
  const provider = launch.id === 'codex' ? 'codex' : 'claude';
  const billing = billingRoute(provider, { env });
  // An interactive session's grant names no model: `/model` inside it changes
  // the model, and a grant on the launch model answered every request after
  // that switch `403 model unavailable for session` (2026-10-29). The grant
  // still names the provider, expires and counts requests.
  const toolLaunch = gatewayLaunch({ provider, model: null, bin: launch.spec.bin, args, billing: billing.billing });

  const record = {
    verb, area: areaName, programme, tool: launch.shortName || toolId, model: chosenModel || null, env,
    // Record only the instructions actually handed to this launch.
    role: roleRecord({
      name: roleName,
      source: roleSource,
      overlay,
      instructions,
    }),
  };
  const identity = sessionLaunchEnvironment({ env, cwd: worktree.path, role: roleName || requestedRole, programme });
  const openEvent = {
    area: areaRoot,
    cwd: worktree.path,
    tool: toolId,
    bin: launch.spec.bin,
    argc: args.length,
    resuming: chosen?.id || null,
    model: chosenModel || null,
    overlay: Boolean(overlay),
    // The register goes when the session does; the log is the one record of
    // which role text this launch handed over that is still there tomorrow.
    role: requestedRole,
    programme: requestedProgramme,
    launched_id: launchedId,
    instruction_channel: handed.length ? (toolId === 'codex' && guarded ? 'developer_instructions' : toolId === 'claude-code' ? 'append-system-prompt' : 'instructions') : null,
    role_digest: textDigest(instructions),
    prompt: resuming ? Boolean(resumePrompt) : Boolean(prompt),
    instructions: handed.length > 0,
    known_here: before.length,
  };
  return { ok: true, launch, tool: toolId, chosen, before, args, model: chosenModel,
    instructions, billing, identity, record, toolLaunch, openEvent };

}

/** One provider decision; every start, persistent or not, uses interactiveLaunchPlan. */
export async function openInWorkArea(options = {}) {
  const { env = process.env, platform = process.platform, isInteractive = interactive,
    background, spawn = spawnSync, register = registerForeground, onProvider, trust = trustClaudeFolder, ...rest } = options;
  const eligible = entersPersistentSession({ env, platform, isInteractive, verb: options.verb });
  let entrance;
  try {
    const plan = await interactiveLaunchPlan({ ...rest, env, isInteractive, onProvider,
      liveConversation: rest.liveConversation || (async prefix => {
        if (!eligible) return null;
        const { findBackgroundConversation } = await import('./claude-background.js');
        return findBackgroundConversation({ ...options, env }, prefix);
      }),
      resolved: async ({ launch, before, chosen }) => {
        if (!eligible || !(launch.id in PERSISTENT_DRIVERS)) return {};
        const settings = { ...options, env, launch, before, chosen };
        entrance = background ? await background(settings)
          : await prepareSessionEntrance(settings, await PERSISTENT_DRIVERS[launch.id]());
        return entrance;
      },
    });
    if (!plan.launch) return plan;
    if (plan.launch.id === 'claude-code') {
      // Every folder mc opens Claude in is trusted first (claude-trust.js).
      const trusted = trust(options.worktree.path, { env });
      if (!trusted.ok || trusted.changed) log(trusted.ok ? 'work.claude-trusted' : 'work.claude-trust-failed', trusted);
    }
    clearStopMark(options.areaRoot);
    if (entrance) return await entrance.start(plan);
    log('work.open', plan.openEvent);
    const release = register(plan.record);
    let result;
    try {
      result = spawn(plan.toolLaunch.bin, plan.toolLaunch.args, {
        cwd: options.worktree.path, stdio: 'inherit', env: scrubProviderApiKeysFromEnv(plan.identity),
      });
    } finally { release(); }
    if (result?.error) {
      log('work.open-failed', { area: options.areaRoot, error: result.error.message });
      return { ok: false, reason: result.error.message };
    }
    const after = listConversations(options.areaRoot, env);
    const seen = new Set(plan.before.map(item => item.id));
    const started = after.find(item => !seen.has(item.id)) || null;
    log('work.closed', { area: options.areaRoot, tool: plan.tool, exit_code: result?.status ?? 0,
      resumed: plan.chosen?.id || null, started: started?.id || null, kept_nothing: !plan.chosen && !started });
    return { ok: true, tool: plan.tool, conversation: plan.chosen?.id || started?.id || null,
      resumed: Boolean(plan.chosen), started: started?.id || null,
      kept_nothing: !plan.chosen && !started, code: result?.status ?? 0 };
  } finally { await entrance?.release?.(); }
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
export function backgroundTarget(name, { run = null, env = process.env, path = null } = {}) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  const target = `mc-${name}`;
  if (tmux(['has-session', '-t', target]).status === 0) return target;
  return discoveredTarget(name, { tmux, env, path });
}

/**
 * The address of a session that was not started by mc, found by where it
 * stands.
 *
 * Nine sessions ran in tmux sessions called `clean`, `ops`, `vocab`, … —
 * started outside mc's naming — and every wake sent to them
 * delivered the file and never tried to knock, reporting "nothing is running"
 * (D-0136). They were running the whole time, in panes tmux could name. So
 * when `mc-<name>` does not exist, the panes are asked where they stand: one
 * whose current path is the area, or under it, is the area's address. No
 * bind file, nothing to keep in step — a pane that moves stops being found,
 * which is also true.
 *
 * The pane is addressed by its id (`%7`) unless it is the single active pane
 * of its session, where the session's own name reads better in a message.
 *
 * `name` is the name without its kind (`foo`, not `work/foo`); the area it
 * stands for is the one `workAreaName` names, unless the
 * caller already knows the `path` — a role home, which is neither.
 */
export function discoveredTarget(name, { tmux, env = process.env, path: known = null } = {}) {
  const area = known || workAreaPath(workAreaName(name, { root: workRoot(env) }).name, env);
  const listed = tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_active}\t#{session_windows}\t#{window_panes}\t#{pane_current_path}']);
  if (listed?.status !== 0) return null;
  for (const line of String(listed.stdout || '').split('\n')) {
    const [session, pane, active, windows, panes, path] = line.split('\t');
    if (!session || !path) continue;
    if (path !== area && !path.startsWith(`${area}/`)) continue;
    return active === '1' && windows === '1' && panes === '1' ? session : pane;
  }
  return null;
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
  roleName = null,
  programme = null,
  cache = '1h',
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

  const command = launchCommand(launch, {
    task, model, overlay, defaultModel, defaultModelTool, conversation, roleName, programme, cache,
    areaRoot, cwd: worktree.path, env,
  });

  const created = tmux(['new-session', '-d', '-s', target, '-c', worktree.path, command]);
  if (created.status !== 0) {
    return { ok: false, reason: (created.stderr || 'tmux refused to start it').trim() };
  }
  clearStopMark(areaRoot);
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

/** What a session carries, new or resumed: its tools first, then the adapter's settings. */
function sessionSwitches(launch, cache) {
  return [...(launch.adapter?.toolArgs?.() ?? []), ...(launch.adapter?.sessionArgs?.({ cache }) ?? [])];
}

/** All interactive entry points pass through the adapter, including resumes. */
function interactiveArgs(launch, args, context) {
  const options = interactiveAccessOptions(launch.spec, interactiveWorkspaceDirectories(context));
  return launch.spec.args(args, options);
}

/**
 * A resume's argv with the session switches in it. Codex's `resume` takes its
 * options before the session id it ends on (`codex resume [OPTIONS]
 * [SESSION_ID]`, see `resumeArgs`); claude takes them anywhere.
 */
function resumeWith(toolId, resumed, session) {
  if (!resumed.length || !session.length) return [...resumed, ...session];
  if (toolId === 'codex') return [...resumed.slice(0, -1), ...session, resumed[resumed.length - 1]];
  return [...resumed, ...session];
}

/**
 * The one command line a tool is started on, however the pane is made.
 *
 * Creating a session and replacing what runs in one are the same launch seen
 * twice, and the day they disagree is the day a replaced conversation quietly
 * loses its instructions or its model. So the argv is built here, once.
 */
function launchCommand(launch, {
  task = null,
  model = null,
  overlay = null,
  defaultModel = null,
  defaultModelTool = null,
  conversation = null,
  roleName = null,
  programme = null,
  cache = '1h',
  areaRoot,
  cwd,
  env = process.env,
} = {}) {
  // The role default follows the role's tool here too (see openInWorkArea).
  const roleDefault = defaultModel && (!defaultModelTool || launch.shortName === defaultModelTool)
    ? defaultModel
    : null;
  // A conversation to resume changes everything about the argv: its history
  // already holds any overlay, and the model — resolved by
  // the caller, flag over transcript — rides on the resume flags.
  const session = sessionSwitches(launch, cache);
  const baseArgs = conversation
    ? [
      ...resumeWith(launch.id, launch.adapter?.resumeArgs?.({ sessionId: conversation.id, model: conversation.model || null }) || [], session),
    ]
    : [
      ...(launch.adapter?.modelArgs?.(model || roleDefault) ?? []),
      ...profileArgs(launch.id, instructionsFor(launch.id, overlay)),
      ...session,
    ];
  // A task goes in either way. On a new conversation it is the opening words;
  // on a resumed one it lands as a reply to wherever that conversation
  // stopped — which is what somebody asking for both at once is asking for.
  // Nothing combined them before this, so no existing launch changes shape.
  if (task) baseArgs.push(task);
  const provider = launch.id === 'codex' ? 'codex' : 'claude';
  const billing = billingRouteNow(provider, { env });
  // No model on the grant, as in `openInWorkArea`: `/model` must keep working.
  const toolLaunch = gatewayLaunch({ provider, model: null, bin: launch.spec.bin, args: interactiveArgs(launch, baseArgs, { areaRoot, cwd, env }), billing: billing.billing });
  const args = [toolLaunch.bin, ...toolLaunch.args];
  // tmux runs its command through a shell, so the instructions — kilobytes of
  // prose, with quotes and newlines in it — has to survive
  // quoting, and so does everything beside it on the line. Claude has no
  // --append-system-prompt-file to point at instead.
  const unset = [...PROVIDER_API_ENV_NAMES.filter((name) => Object.hasOwn(env, name)), ...SESSION_IDENTITY_ENV];
  const childEnv = sessionLaunchEnvironment({ env, cwd, role: roleName, programme });
  const identity = SESSION_IDENTITY_ENV.filter((key) => childEnv[key]).map((key) => `${key}=${childEnv[key]}`);
  return ['env', ...unset.flatMap((name) => ['-u', name]), ...identity, ...args].map(shellQuote).join(' ');
}

/**
 * Replace what runs in a session, without replacing the session.
 *
 * A handoff kills a conversation and starts another in its place. Killing the
 * tmux session and making a new one would do that mechanically and throw every
 * attached client out of the room — and the case this exists for is the person
 * sitting in the pane watching. `respawn-window` keeps the session, its name
 * and its window, and swaps only the process inside: whoever is attached stays
 * attached and sees the successor boot.
 *
 * Two ways to end the predecessor, and the caller says which:
 *
 *   graceful   ask the tool to leave by its own front door first, so Claude's
 *              SessionEnd hooks run and the last turn is saved. The window is
 *              pinned with `remain-on-exit` for the length of that wait — a
 *              tool that does exit takes the only window of the session with
 *              it otherwise, which is exactly the eviction this avoids.
 *   abrupt     respawn straight away. `-k` kills what is there. The turn in
 *              flight is lost; every turn before it is already on disk.
 *
 * The window is measured, never assumed: `base-index` is a tmux setting, and a
 * user who sets it to 1 has no window 0 to respawn.
 */
export function respawnInBackground({
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
  roleName = null,
  programme = null,
  cache = '1h',
  graceful = true,
  env = process.env,
  run = null,
  wait = null,
} = {}) {
  const launch = resolveLaunch(tool);
  if (!launch?.ok) return { ok: false, reason: launch?.reason || 'tool-unavailable', hint: launch?.hint };
  const target = `mc-${name}`;
  const tmux = run || ((args, options = {}) => spawnSync('tmux', args, { encoding: 'utf8', ...options }));

  if (tmux(['has-session', '-t', target]).status !== 0) return { ok: false, reason: 'not-running', target };
  const listed = tmux(['list-windows', '-t', target, '-F', '#{window_index}']);
  const index = String(listed?.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)[0];
  if (listed?.status !== 0 || !index) {
    return { ok: false, reason: (listed?.stderr || `tmux named no window in ${target}`).trim(), target };
  }
  const window = `${target}:${index}`;
  const command = launchCommand(launch, {
    task, model, overlay, defaultModel, defaultModelTool, conversation, roleName, programme, cache,
    areaRoot, cwd: worktree.path, env,
  });

  // Written before the respawn, not after: the abrupt path is mc replacing the
  // pane it is itself running in, and it does not outlive the next call.
  log('work.background-respawn', {
    area: areaRoot,
    target,
    window,
    tool: launch.id,
    graceful,
    model: (conversation ? conversation.model : model) || null,
    resuming: conversation?.id || null,
    task: Boolean(task),
  });

  if (graceful) {
    tmux(['set-option', '-w', '-t', window, 'remain-on-exit', 'on']);
    askToolToLeave(window, { run: tmux, wait });
  }
  const spawned = tmux(['respawn-window', '-k', '-t', window, '-c', worktree.path, command]);
  // Back to how the user's tmux behaves everywhere else: a pane that exits from
  // here on closes its window, as it would in a session mc never touched.
  if (graceful) tmux(['set-option', '-w', '-t', window, 'remain-on-exit', 'off']);
  if (spawned?.status !== 0) {
    return { ok: false, reason: (spawned?.stderr || 'tmux refused to respawn it').trim(), target, window };
  }
  clearStopMark(areaRoot);
  return { ok: true, target, window, tool: launch.id, resumed: conversation?.id || null, graceful };
}

/**
 * Is the caller sitting inside the very session it is about to replace?
 *
 * It decides whether the predecessor can be asked to leave politely: a command
 * typed inside the pane cannot outlive its own exit, so there is nobody left to
 * wait for the tool and respawn afterwards. Answered by asking tmux which
 * session this client belongs to — `$TMUX` alone only says "some tmux".
 */
export function insideSession(target, { env = process.env, run = null } = {}) {
  if (!env.TMUX) return false;
  const tmux = run || ((args, options = {}) => spawnSync('tmux', args, { encoding: 'utf8', ...options }));
  const args = ['display-message', '-p'];
  if (env.TMUX_PANE) args.push('-t', env.TMUX_PANE);
  args.push('#{session_name}');
  const asked = tmux(args);
  if (asked?.status !== 0) return false;
  return String(asked.stdout || '').trim() === target;
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
