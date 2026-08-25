/**
 * `mc brief` — the evaluation and decision session.
 *
 * `--collect` is the script half: gather the ground into
 * `~/mc/brief/<date>.md` with no model. The bare verb does that and then
 * opens a fresh foreground session — the terminal's, never tmux, never
 * `--resume` — standing in the work root so every `../decisions/` file is
 * in reach, with the Coding Profile, the `brief` role from
 * `canon/roles/brief.md` and the brief file as its opening words. Martin
 * closes it when the decisions are done; its only writes are `**Beslut:**`
 * lines.
 */
import { collectBrief } from '../brief-collect.js';
import { workRoot } from '../paths.js';
import { readCanonRole } from '../roles.js';
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
  const { decisions, merged, opened, notes } = result.data;
  const waiting = decisions.filter((d) => !d.answered).length;
  stdout.write(`mc: ${result.path} (${seconds}s) — ${merged.length} merged, ${opened.length} open, ${waiting} waiting on you\n`);
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
