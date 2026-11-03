/**
 * A project's number at the page's menu: an interactive session in that
 * project's runner area, belonging to the project's programme.
 *
 * The runner area is the project's own place to work — `step/<project>`, or
 * `runner/step/<project>` in layout 2 (`stepAreaName`, paths.js) — and the
 * runner makes it when it starts the project's first step. Nothing here makes
 * one: a project with no area yet says so and opens nothing, because a folder
 * made for a session is the workarea this replaced (goal mc/no-work).
 *
 * The session registers itself (`foreground.js`) with its programme, so the
 * page draws it on that programme's heading rather than in a list of its own.
 */
import { describeAge, describeSize } from './conversations.js';
import { stepAreaName, workRoot } from './paths.js';
import { interactive, select } from './prompt.js';
import { inspectWorkArea } from './work-area.js';
import { openInWorkArea } from './work-open.js';
import { toolProcesses } from './work-status.js';

/** The verb a project session registers under, beside `plan`, `brief` and `helper`. */
export const PROJECT_VERB = 'project';

/**
 * Open `project`'s runner area. `programme` is the project's, as the page
 * read it. Returns an exit code; `deps` replaces the doors a test cannot use.
 */
export async function openProject(project, {
  programme = null, stdout = process.stdout, stderr = process.stderr, env = process.env,
  inspect = inspectWorkArea, open = openInWorkArea, occupants = toolProcesses, ask = interactive, choose = select,
} = {}) {
  const root = workRoot(env);
  const areaName = stepAreaName(project, { root });
  const area = inspect(areaName, env);
  if (!area.exists) {
    stderr.write(`mc: ${project} has no runner area yet — the runner makes ${area.path} when it starts the project's first step\n`);
    return 1;
  }

  const live = ask();
  const candidates = area.worktrees.filter((item) => item.is_git);
  let worktree = candidates.length === 1 ? candidates[0] : null;
  if (!worktree && candidates.length > 1 && live) {
    worktree = choose(`\n${project} — which repository?`, candidates.map((item, index) => ({
      key: index + 1, name: item.repo, label: `${item.repo.padEnd(20)} ${item.branch || '(detached)'}`, value: item,
    })), { stdout });
    if (!worktree) return 0;
  }
  if (!worktree) worktree = { repo: null, path: area.path, is_git: false };

  // One session per workplace (D-0154): a tool already standing here — the
  // runner's step, or somebody's own — would have its branch changed under it.
  const here = [area.path, ...area.worktrees.map((item) => item.path)];
  const standing = occupants(here);
  if (standing.length) {
    const [first] = standing;
    stderr.write(`mc: ${project} is occupied — ${first.name} (pid ${first.pid}) is working in ${first.directory}\n`);
    stderr.write('mc: one session per workplace (D-0154): a second one here would change branches under the first\n');
    return 1;
  }

  let pick = null;
  if (area.conversations.length > 1 && live) {
    const items = area.conversations.map((item, index) => ({
      key: index + 1, name: item.id.slice(0, 8), label: conversationLine(item), value: item.id,
    }));
    items.push({ key: 'n', name: 'new', label: 'a new conversation', value: 'new' });
    pick = choose(`\n${project} — which conversation?`, items, { stdout });
    if (!pick) return 0;
  }

  let tool = null;
  if (area.conversations.length === 0 && live) {
    tool = choose(`\n${project} — which tool?`, [
      { key: 1, name: 'claude', label: 'claude', value: 'claude' },
      { key: 2, name: 'codex', label: 'codex', value: 'codex' },
    ], { stdout });
    if (!tool) return 0;
  }

  stderr.write(`mc: ${worktree.path}${programme ? ` — programme ${programme}` : ''}\n`);
  const opened = await open({
    areaRoot: area.path, worktree, tool, pick, env,
    verb: PROJECT_VERB, areaName, programme,
  });
  if (!opened.ok) {
    stderr.write(`mc: could not open ${project} (${opened.reason})\n`);
    if (opened.hint) stderr.write(`mc: ${opened.hint}\n`);
    return 1;
  }
  if (opened.kept_nothing) stderr.write(`mc: ${opened.tool} saved no conversation — nothing was said\n`);
  else if (opened.started) stderr.write(`mc: new ${opened.tool} conversation ${opened.started.slice(0, 8)}\n`);
  return opened.code || 0;
}

/** A conversation by how it opened: id, tool, age, size and its first words. */
export function conversationLine(item) {
  const tool = item.tool === 'claude-code' ? 'claude' : item.tool;
  const head = `${item.id.slice(0, 8)}  ${String(tool).padEnd(6)}  ${describeAge(item.updated_ms).padEnd(9)} ${describeSize(item.bytes).padStart(7)}`;
  if (!item.label) return head;
  return `${head}   ${item.label.length > 48 ? `${item.label.slice(0, 47)}…` : item.label}`;
}
