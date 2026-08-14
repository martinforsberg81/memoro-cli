/**
 * `mc pm` / `mc pm-helper` — the one door into a singleton role.
 *
 * Grown out of `mc supervisor`, which established the shape: one named
 * workspace, no worktree, resume-or-create, attach rather than duplicate.
 * Two things evolve here. The role text moves out of the code and into the
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
  attachBackground, backgroundTarget, clearTrustDialog, startInBackground,
} from '../work-open.js';
import { scanArgs } from './flags.js';

export async function runRoleSingleton(roleName, argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, { booleans: ['--no-attach'], strictValues: ['--model'] });
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || `unexpected arg: ${scanned.positional[0]}`}\n`);
    stderr.write(`usage — mc ${roleName} [--model <model>] [--no-attach]\n`);
    return 2;
  }
  const attach = !scanned.flags['no-attach'] && interactive();

  // 1. Running? Then that is where it is. Attaching twice is safe — tmux
  // mirrors the session — which is precisely why the conversation lives
  // there and not in whichever terminal asked first.
  const running = backgroundTarget(roleName);
  if (running) {
    if (scanned.flags.model) {
      stderr.write(`mc: the ${roleName} is already running — a live conversation cannot change model\n`);
      stderr.write(`mc: attach without --model, or stop it first: mc work stop ${roleName}\n`);
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

  // 2 or 3: the newest claude conversation decides which. Resume carries
  // the model the transcript records (flag outranks it); a first
  // conversation starts on the flag, else the role's default.
  const latest = listConversations(path).find((item) => item.tool === 'claude-code') || null;
  const resumeModel = latest ? (scanned.flags.model || conversationModel(latest)) : null;

  const started = startInBackground({
    name: roleName,
    areaRoot: path,
    worktree: { repo: null, path, is_git: false },
    tool: 'claude',
    model: scanned.flags.model,
    overlay: latest ? null : role?.overlay || null,
    defaultModel: role?.model || null,
    defaultModelTool: 'claude',
    conversation: latest ? { id: latest.id, model: resumeModel } : null,
  });
  if (!started.ok) {
    stderr.write(`mc: could not start the ${roleName} (${started.reason})\n`);
    if (started.hint) stderr.write(`mc: ${started.hint}\n`);
    return 1;
  }
  log('role.singleton-start', {
    role: roleName, target: started.target, resumed: latest?.id || null,
    model: resumeModel || scanned.flags.model || role?.model || null,
  });
  const trust = clearTrustDialog(started.target);
  if (trust.answered) stdout.write('mc: answered Claude\'s folder-trust question for it\n');
  stderr.write(latest
    ? `mc: ${roleName} — resuming ${latest.id.slice(0, 8)}\n`
    : `mc: ${roleName} — a new conversation, told what it is\n`);

  if (!attach) {
    stdout.write(`mc: the ${roleName} is running as ${started.target} — attach with  mc ${roleName}\n`);
    return 0;
  }
  stderr.write('mc: ctrl-b d leaves it running\n');
  const joined = attachBackground(started.target);
  return joined.ok ? (joined.code || 0) : 1;
}
