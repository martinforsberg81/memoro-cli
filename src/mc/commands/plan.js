/**
 * `mc plan <name>` — a planning session that ends in a PLAN.json.
 *
 * How new work enters the system: every plan is written here, with Martin in
 * the session. The runner does not write plans — it runs `ready` ones (Martin,
 * 2026-08-29). A fresh, ordinary foreground
 * session — the terminal's, `stdio: 'inherit'`, never tmux, never
 * `--resume` — opens in the workarea with the `plan` role from
 * `canon/roles/plan.md` behind the Coding Profile, and a first prompt that
 * asks for `docs/project/<programme>/<name>/PLAN.json` as a PR. The result is
 * the file; the conversation is meant to be closed right after.
 *
 * The workarea is made if it is missing: `~/mc/<name>/<repo>` as a worktree
 * on branch `<name>` from origin/main, exactly what `mc work add <name>
 * <repo> --from origin/main` does.
 */
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

import { addWorktree, createWorkArea, inspectWorkArea, resolveRepository } from '../work-area.js';
import { openInWorkArea } from '../work-open.js';
import { readCanonRole, reservedRoleHint, reservedRoleName } from '../roles.js';
import { scanArgs } from './flags.js';

const NAME = /^[A-Za-z0-9._-]{1,64}$/u;
export const DEFAULT_REPO = 'memoro';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.name) {
    stderr.write(`mc: ${opts.error || 'plan what? mc plan <name>'}\n`);
    stderr.write('usage — mc plan <name> [--repo memoro|memoro-cli] [--codex|--claude] [--model <model>]\n');
    return 2;
  }
  if (reservedRoleName(opts.name)) {
    stderr.write(`mc: ${reservedRoleHint(opts.name)}\n`);
    return 1;
  }

  const role = readCanonRole('plan');
  if (!role?.overlay) {
    stderr.write('mc: the plan role is missing from this install — expected canon/roles/plan.md with an overlay body\n');
    return 1;
  }

  // The area, and a worktree in the repository asked for. An existing area
  // is used as it is; a missing one is made from origin/main so the plan
  // starts from what is actually on main, not from a stale local branch.
  let area = inspectWorkArea(opts.name);
  let worktree = area.exists ? area.worktrees.find((item) => item.is_git && item.repo === opts.repo) : null;
  if (!worktree) {
    const found = resolveRepository(opts.repo);
    if (!found.ok) {
      stderr.write(`mc: no repository "${opts.repo}" — looked at ${found.tried.join(', ')}\n`);
      return 1;
    }
    if (!area.exists) createWorkArea(opts.name);
    const fetched = (deps.git || ((args) => spawnSync('git', args, { stdio: 'ignore' })))(['-C', found.path, 'fetch', '-q', 'origin']);
    if (fetched?.status !== 0) stderr.write(`mc: git fetch in ${found.path} failed — origin/main may be stale\n`);
    const added = addWorktree({ name: opts.name, repo: found.path, branch: opts.name, from: 'origin/main' });
    if (!added.ok) {
      stderr.write(`mc: could not add ${opts.repo} to ${opts.name} (${added.reason})\n`);
      return 1;
    }
    stdout.write(`mc: ${added.path} on ${added.branch}${added.base ? ` from ${added.base}` : ''}\n`);
    area = inspectWorkArea(opts.name);
    worktree = area.worktrees.find((item) => item.path === added.path) || { repo: opts.repo, path: added.path, is_git: true };
  }

  const launch = planLaunch({ name: opts.name, repo: basename(worktree.repo || opts.repo), role });
  const result = await (deps.open || openInWorkArea)({
    areaRoot: area.path,
    worktree,
    tool: opts.tool || role.tools?.[0] || 'claude',
    pick: 'new',
    verb: 'plan',
    areaName: opts.name,
    model: opts.model,
    overlay: launch.overlay,
    prompt: launch.prompt,
    defaultModel: role.model,
    defaultModelTool: role.tools?.[0] || null,
  });
  if (!result.ok) {
    stderr.write(`mc: ${result.reason}${result.hint ? ` — ${result.hint}` : ''}\n`);
    return 1;
  }
  return result.code ?? 0;
}

/**
 * What the session is told, assembled without starting anything: the role
 * overlay as written, and the first prompt naming the workarea, the
 * repository and the deliverable.
 *
 * The last line is the docs merge, not "and stop": a plan PR touches only
 * `docs/`, so it is `mc merge <repo> <pr> --docs`' case, and the runner
 * cannot queue a project whose plan is still sitting in an open PR. The
 * role says the same thing; the prompt is the word that comes last.
 */
export function planLaunch({ name, repo, role }) {
  const prompt = [
    `You are working in the \`${name}\` workarea of ${repo} (this worktree; origin/main is its base).`,
    `There is no \`docs/project/*/${name}/PLAN.json\` yet, or it needs rethinking.`,
    'Start by reading what already exists — docs/project/ here, the open "Plan:" PRs, the workarea\'s ../HANDOFF.md and ../inbox/ if present, the old plan under docs/plans/ they point to — and say what you found.',
    `Then talk it through with Martin and write \`docs/project/<programme>/${name}/PLAN.json\` as described in your role, and open a PR titled "Plan: ${name}".`,
    `Land that PR yourself — it is documentation only: \`mc merge ${repo} <pr> --docs\`. If it refuses, leave the PR open and say why. Then stop.`,
  ].join('\n');
  return { overlay: role.overlay, prompt, model: role.model || null };
}

function parseArgs(argv) {
  const scanned = scanArgs(argv, { values: ['--repo'], strictValues: ['--model'], toolSugar: true });
  if (scanned.error) return { error: scanned.error };
  const words = scanned.positional;
  if (words.length > 1) return { error: `unexpected argument ${words[1]}` };
  const name = words[0] || null;
  if (name && !NAME.test(name)) return { error: `not a valid name: ${name}` };
  return {
    name,
    repo: scanned.flags.repo || DEFAULT_REPO,
    model: scanned.flags.model || null,
    tool: scanned.flags.tool || null,
  };
}
