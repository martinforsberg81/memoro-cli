/**
 * `mc brief` — the evaluation session.
 *
 * Opens the foreground brief session — the terminal's, never tmux — standing
 * in the work root. A brief session already there is resumed where it was; with
 * none, or with `--new`, a fresh one starts with the Coding Profile and the
 * `brief` role from `canon/roles/brief.md`, and `Start the meeting.` as its
 * opening words. Nothing is gathered for it: the ground is read where it lives
 * — the page, `mc status`, `mc step` — and the role says where. Until
 * 2026-09-19 a script (`mc brief --collect`) wrote `~/mc/brief/<date>.md` and
 * handed the text over as the first words; it was a second copy of what the
 * page shows live, stale by the second question (Martin, 2026-09-19).
 *
 * It used to be the *decision* session too: it read `<area>/decisions/*.md`,
 * listed what waited on Martin, and its one written output was a
 * `**Beslut:**` line that mc regexed back out again. That apparatus is gone —
 * the whole of it, not the format. What a session decides with Martin belongs
 * in the plan it is about.
 */
import { workRoot } from '../paths.js';
import { readCanonRole, roleSourceOf } from '../roles.js';
import { openInWorkArea } from '../work-open.js';
import { scanArgs } from './flags.js';

export function usage() {
  return 'usage — mc brief [--new] [--codex|--claude] [--model <model>]\n';
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, { booleans: ['--new'], strictValues: ['--model'], toolSugar: true });
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || `unknown argument ${scanned.positional[0]}`}\n`);
    stderr.write(usage());
    return 2;
  }
  const { flags } = scanned;

  const role = readCanonRole('brief');
  if (!role?.overlay) {
    stderr.write('mc: the brief role is missing from this install — expected canon/roles/brief.md with an overlay body\n');
    return 1;
  }
  const launch = briefLaunch({ role });
  const root = workRoot();
  const opened_ = await (deps.open || openInWorkArea)({
    areaRoot: root,
    worktree: { repo: null, path: root, is_git: false },
    tool: flags.tool || role.tools?.[0] || 'claude',
    pick: flags.new ? 'new' : null,
    // NOW says "mc brief" while this is up. It stands in the work root, which
    // is nobody's area, so there is no name to give it.
    verb: 'brief',
    // What it was told it is, kept in the register the session outlives — so
    // `mc roles check brief` can say whether the text it is running on is the
    // one in `canon/roles/brief.md` today.
    roleName: role.name || 'brief',
    roleSource: roleSourceOf(role),
    model: flags.model,
    overlay: launch.overlay,
    prompt: launch.prompt,
    defaultModel: role.model,
    defaultModelTool: role.tools?.[0] || null,
  });
  if (!opened_.ok) {
    stderr.write(`mc: ${opened_.reason}${opened_.hint ? ` — ${opened_.hint}` : ''}\n`);
    return 1;
  }
  return opened_.code ?? 0;
}

/** What the session is told: the role as written, and that the meeting starts. */
export function briefLaunch({ role }) {
  return { overlay: role.overlay, prompt: 'Start the meeting.', model: role.model || null };
}
