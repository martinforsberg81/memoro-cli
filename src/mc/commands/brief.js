/**
 * `mc brief` — the evaluation session.
 *
 * `--collect` is the script half: gather the ground into
 * `~/mc/brief/<date>.md` with no model. The bare verb does that and then
 * opens a fresh foreground session — the terminal's, never tmux, never
 * `--resume` — standing in the work root, with the Coding Profile, the
 * `brief` role from `canon/roles/brief.md` and the brief file as its opening
 * words.
 *
 * It used to be the *decision* session too: it read `<area>/decisions/*.md`,
 * listed what waited on Martin, and its one written output was a
 * `**Beslut:**` line that mc regexed back out again. That apparatus is gone —
 * the whole of it, not the format. What a session decides with Martin belongs
 * in the plan it is about.
 */
import { collectBrief } from '../brief-collect.js';
import { workRoot } from '../paths.js';
import { readCanonRole, roleSourceOf } from '../roles.js';
import { openInWorkArea } from '../work-open.js';
import { scanArgs } from './flags.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, { booleans: ['--collect', '--offline'], strictValues: ['--model'], toolSugar: true });
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || `unknown argument ${scanned.positional[0]}`}\n`);
    stderr.write('usage — mc brief [--collect] [--offline] [--codex|--claude] [--model <model>]\n');
    return 2;
  }
  const { flags } = scanned;

  const t0 = Date.now();
  const result = await (deps.collect || collectBrief)({ offline: flags.offline });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const { merged, opened, proposals = [], notes } = result.data;
  const extra = proposals.length ? `, ${proposals.length} proposal${proposals.length === 1 ? '' : 's'}` : '';
  stdout.write(`mc: ${result.path} (${seconds}s) — ${merged.length} merged, ${opened.length} open${extra}\n`);
  for (const note of notes) stderr.write(`mc: ${note}\n`);
  if (flags.collect) return 0;

  const role = readCanonRole('brief');
  if (!role?.overlay) {
    stderr.write('mc: the brief role is missing from this install — expected canon/roles/brief.md with an overlay body\n');
    return 1;
  }
  const launch = briefLaunch({ path: result.path, text: result.text, role });
  const root = workRoot();
  const opened_ = await (deps.open || openInWorkArea)({
    areaRoot: root,
    worktree: { repo: null, path: root, is_git: false },
    tool: flags.tool || role.tools?.[0] || 'claude',
    pick: 'new',
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

/** What the session is told: the role as written, and the brief as its first words. */
export function briefLaunch({ path, text, role }) {
  const prompt = `This is the brief, from ${path}. Start the meeting.\n\n${text}`;
  return { overlay: role.overlay, prompt, model: role.model || null };
}
