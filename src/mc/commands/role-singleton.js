/**
 * `mc pm` / `mc pm-helper` — the one door into a singleton role.
 *
 * Grown out of `mc supervisor` (removed once `mc pm` replaced it), which
 * established the shape: one named workspace, no worktree, resume-or-create,
 * attach rather than duplicate.
 * Two things evolved. The role text moves out of the code and into the
 * role catalogue, delivered like any role overlay. And the conversation
 * always lives in tmux (the `mc work --tmux` mechanics): `mc supervisor`
 * opened the tool in whichever terminal asked, so two terminals asking got
 * two processes on one transcript — exactly the split-brain the singleton
 * exists to prevent. Here the running conversation is a background session
 * both terminals attach to, and tmux carries the exactly-one guarantee.
 *
 * The semantics, in order (design note §6):
 *
 *   1. Running?               attach. Never a second instance.
 *   2. Closed or crashed?     restart in the role home — resume the newest
 *                             conversation, on the model its transcript
 *                             records; the boot sequence in the overlay does
 *                             the rest (state.md, sanity checks).
 *   3. Does not exist?        create: role home layout (§7), git init for
 *                             the PM, a new conversation told what it is.
 *
 * All three mean "take me to the role", and for a long time there was no way
 * to say the other thing — *start over*. A handoff at a natural boundary is
 * how this system keeps its costs down, and the role with the longest life of
 * all could not perform one: `mc pm` resumed, every time, silently. So a
 * second word decides, in the grammar `mc work <name>` already uses:
 *
 *   mc <role> new             a new conversation. Whatever is running is
 *                             ended and replaced in the same window, so an
 *                             attached client rides across the handoff and
 *                             watches the successor boot. Nothing is deleted:
 *                             the predecessor's transcript stays on disk, and
 *                             the successor is told the one line that reaches
 *                             it.
 *   mc <role> <conversation>  that conversation, by id prefix. The way back
 *                             from a handoff — after one, the newest is the
 *                             successor, so without this the predecessor is
 *                             unreachable through mc the moment it exists.
 *
 * Every start makes the home whole first (idempotent): a crash that tore a
 * directory away is repaired by the next start, not discovered by the role
 * mid-thought.
 *
 * Singleton roles are claude-only (design note §5) and have no worktrees
 * (K3.2) — code the PM wants read is by definition an errand for the helper
 * or an agent.
 */
import { conversationModel, listConversations } from '../conversations.js';
import { log } from '../logger.js';
import { workAreaPath } from '../paths.js';
import { interactive } from '../prompt.js';
import { ensureRoleHome } from '../role-home.js';
import { areaRoleName, markAreaRole, readRole, rolesDir } from '../roles.js';
import { createWorkArea, inspectWorkArea } from '../work-area.js';
import {
  attachBackground, backgroundTarget, clearTrustDialog, insideSession,
  respawnInBackground, startInBackground,
} from '../work-open.js';
import { scanArgs } from './flags.js';

export async function runRoleSingleton(roleName, argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, { booleans: ['--no-attach'], strictValues: ['--model'] });
  const usage = `usage — mc ${roleName} [new | <conversation id>] [--model <model>] [--no-attach]\n`;
  if (scanned.error || scanned.positional.length > 1) {
    stderr.write(`mc: ${scanned.error || `unexpected arg: ${scanned.positional[1]}`}\n`);
    stderr.write(usage);
    return 2;
  }
  const asked = scanned.positional[0] || null;
  const attach = !scanned.flags['no-attach'] && interactive();

  // 1. Running? Then that is where it is. Attaching twice is safe — tmux
  // mirrors the session — which is precisely why the conversation lives
  // there and not in whichever terminal asked first.
  const running = backgroundTarget(roleName);
  if (running && !asked) {
    if (scanned.flags.model) {
      stderr.write(`mc: the ${roleName} is already running — a live conversation cannot change model\n`);
      stderr.write(`mc: attach without --model, or start a fresh one: mc ${roleName} new --model <model>\n`);
      return 1;
    }
    stderr.write(`mc: joining the ${roleName} — it is already running\n`);
    if (!attach) {
      stdout.write(`mc: running as ${running} — attach with  mc ${roleName}\n`);
      return 0;
    }
    stderr.write('mc: ctrl-b d leaves it running\n');
    const joined = attachBackground(running);
    return joined.ok ? (joined.code || 0) : 1;
  }
  // A named conversation against a live one is the one thing a singleton
  // cannot do: two conversations in one role home is the split-brain this
  // design exists to prevent. It says so rather than attaching to the
  // conversation that happens to be running, which would be answering a
  // question nobody asked. `new` is the exception, and it is the point.
  //
  // The id is checked first, though: an unknown one used to be answered with
  // "stop it first", which sends somebody to kill their PM to discover a typo.
  // An error that costs a conversation to read is worse than the mistake.
  if (running && asked !== 'new') {
    const homePath = workAreaPath(roleName);
    const here = listConversations(homePath).filter((item) => item.tool === 'claude-code');
    if (!here.some((item) => item.id.startsWith(asked))) {
      return noSuchConversation(stderr, roleName, homePath, asked);
    }
    stderr.write(`mc: the ${roleName} is running (${running}) — one conversation at a time\n`);
    stderr.write(`mc: join what is running:  mc ${roleName}\n`);
    stderr.write(`mc: or stop it first:  mc work stop ${roleName}  — then  mc ${roleName} ${asked}\n`);
    return 1;
  }

  const path = workAreaPath(roleName);
  const area = inspectWorkArea(roleName);
  const marked = area.exists ? areaRoleName(area.path) : null;
  if (area.exists && !marked) {
    // The pre-reservation carve-out cuts the other way here: an ordinary
    // area wearing the name stays ordinary — a role is decided at creation.
    stderr.write(`mc: ${path} already exists as an ordinary area — it cannot become the ${roleName}\n`);
    stderr.write(`mc: open it with  mc work ${roleName}, or move it aside and run mc ${roleName} again\n`);
    return 1;
  }
  if (marked && marked !== roleName) {
    stderr.write(`mc: ${path} carries the role "${marked}", not ${roleName}\n`);
    return 1;
  }

  // What is on record here, newest first. Singleton roles are claude-only, so
  // a codex transcript in the home is somebody else's and never a candidate.
  const known = listConversations(path).filter((item) => item.tool === 'claude-code');

  // Which conversation this is about, decided before anything is created,
  // started or replaced. An id that matches nothing is an error with a way
  // forward — never a brand new conversation with the id as its opening
  // words, which is what the same mistake cost `mc work --tmux` a transcript.
  let resume = null;
  if (asked && asked !== 'new') {
    const chosen = known.find((item) => item.id.startsWith(asked)) || null;
    if (!chosen) return noSuchConversation(stderr, roleName, path, asked);
    // Only the flag decides the model (M1 decision 2, 2026-08-14: nothing new
    // may depend on transcript-derived model persistence). claude-code resumes
    // a conversation on its own model anyway, which is what makes that free.
    resume = { id: chosen.id, model: scanned.flags.model || null };
  } else if (!asked) {
    const latest = known[0] || null;
    if (latest) resume = { id: latest.id, model: scanned.flags.model || conversationModel(latest) };
  }
  // Whom a new conversation succeeds. `new` never resumes; the predecessor is
  // there so the successor can be handed the way back to it.
  const predecessor = asked === 'new' ? known[0] || null : null;

  const role = readRole(roleName);
  if (!area.exists) {
    // 3. Creation needs the definition: a role home without its overlay
    // would be a workspace wearing the name and delivering none of it.
    if (!role || !role.overlay) {
      stderr.write(`mc: no ${roleName} role is defined — expected ${rolesDir()}/${roleName}.md with an overlay body\n`);
      return 1;
    }
    createWorkArea(roleName);
    markAreaRole(path, roleName);
    stdout.write(`mc: ${path} — the ${roleName}'s home (role from ${role.path})\n`);
  } else if (!role || !role.overlay) {
    stderr.write(`mc: the ${roleName} role definition is missing from ${rolesDir()} — restarting without a fresh overlay\n`);
  }

  // The home is made whole on every start, first boot or not.
  const home = ensureRoleHome(roleName, path);
  if (home.created.length) stdout.write(`mc: home layout — created ${home.created.join(', ')}\n`);
  if (home.git_failed) {
    stderr.write(`mc: could not version the ${roleName} home (${home.git_failed}) — the state files are unprotected until this is fixed\n`);
  }

  const launch = {
    name: roleName,
    areaRoot: path,
    worktree: { repo: null, path, is_git: false },
    tool: 'claude',
    // A new conversation starts on the flag, else the role's default — never
    // on what the predecessor happened to be running. Inheriting that would be
    // the old session reaching into the new one, which is the one thing a
    // deliberate handoff is spending a boot to avoid.
    model: scanned.flags.model,
    overlay: resume ? null : role?.overlay || null,
    defaultModel: role?.model || null,
    defaultModelTool: 'claude',
    conversation: resume,
    // One factual line, and only for a successor: the id and the command that
    // reaches it. The rest of what the role is comes from the overlay, and
    // saying it twice would be mc writing the role's instructions.
    task: predecessor ? `Predecessor: ${predecessor.id} — reach it with  mc ${roleName} ${predecessor.id}` : null,
  };

  if (running) {
    // Replacing the pane rather than the session, so that whoever is attached
    // stays attached. Politely when somebody else can do the waiting; from
    // inside the role's own session there is nobody to wait, because the turn
    // running this command is the one being replaced.
    const inside = insideSession(running);
    log('role.singleton-new', {
      role: roleName,
      target: running,
      predecessor: predecessor?.id || null,
      graceful: !inside,
      model: scanned.flags.model || role?.model || null,
    });
    if (inside) {
      // Said before the respawn, because there is no after: this process is
      // in the pane that is about to be replaced.
      stderr.write(`mc: replacing the ${roleName} from inside its own session — this conversation ends here, and the turn in flight goes with it\n`);
      if (predecessor) stderr.write(`mc: it stays on disk — mc ${roleName} ${predecessor.id.slice(0, 8)} reaches it\n`);
    }
    const respawned = respawnInBackground({ ...launch, graceful: !inside });
    if (!respawned.ok) {
      stderr.write(`mc: could not replace the ${roleName} (${respawned.reason})\n`);
      if (respawned.hint) stderr.write(`mc: ${respawned.hint}\n`);
      return 1;
    }
    stderr.write(`mc: ${roleName} — a new conversation in ${respawned.window}, told what it is\n`);
    if (predecessor) {
      stderr.write(`mc: the one it succeeds is ${predecessor.id.slice(0, 8)} — nothing was deleted; mc ${roleName} ${predecessor.id.slice(0, 8)} reaches it\n`);
    }
    if (!attach) {
      stdout.write(`mc: the ${roleName} is running as ${respawned.target} — attach with  mc ${roleName}\n`);
      return 0;
    }
    stderr.write('mc: ctrl-b d leaves it running\n');
    const joined = attachBackground(respawned.target);
    return joined.ok ? (joined.code || 0) : 1;
  }

  const started = startInBackground(launch);
  if (!started.ok) {
    stderr.write(`mc: could not start the ${roleName} (${started.reason})\n`);
    if (started.hint) stderr.write(`mc: ${started.hint}\n`);
    return 1;
  }
  log(asked === 'new' ? 'role.singleton-new' : 'role.singleton-start', {
    role: roleName, target: started.target, resumed: resume?.id || null,
    predecessor: predecessor?.id || null,
    model: resume?.model || scanned.flags.model || role?.model || null,
  });
  const trust = clearTrustDialog(started.target);
  if (trust.answered) stdout.write('mc: answered Claude\'s folder-trust question for it\n');
  stderr.write(resume
    ? `mc: ${roleName} — resuming ${resume.id.slice(0, 8)}\n`
    : `mc: ${roleName} — a new conversation, told what it is\n`);
  if (predecessor) {
    stderr.write(`mc: the one it succeeds is ${predecessor.id.slice(0, 8)} — nothing was deleted; mc ${roleName} ${predecessor.id.slice(0, 8)} reaches it\n`);
  }

  if (!attach) {
    stdout.write(`mc: the ${roleName} is running as ${started.target} — attach with  mc ${roleName}\n`);
    return 0;
  }
  stderr.write('mc: ctrl-b d leaves it running\n');
  const joined = attachBackground(started.target);
  return joined.ok ? (joined.code || 0) : 1;
}

/** One wording for an id that names nothing, wherever the question is asked. */
function noSuchConversation(stderr, roleName, path, asked) {
  stderr.write(`mc: no conversation in the ${roleName}'s home starts with ${asked}\n`);
  stderr.write(`mc: mc work lists what is there — the home is ${path}\n`);
  return 1;
}
