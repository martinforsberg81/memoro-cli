/**
 * `mc worktrees [--json]`
 *
 * What is lying around, and who it belongs to.
 *
 * This is the question mc existed to answer and never did: sessions, branches
 * and worktrees accumulate, half of them dormant, and nothing says which
 * belongs to what or which is safe to remove. Read-only — it removes nothing
 * and changes nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome, worktreesRoot } from '../paths.js';
import { listSessionHomesSync } from '../session-home.js';
import { listWorkspaceAssociationsSync } from '../workspace-record.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) { stderr.write(`mc: ${opts.error}\n`); return 2; }

  const mcHomeDir = deps.mcHomeDir || mcHome();
  const report = inspectWorktreeSprawl({ mcHomeDir });
  if (opts.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  render(report, stdout);
  return 0;
}

/**
 * Ownership, as the model actually defines it.
 *
 * A session's workspace may hold several worktrees and branches. But a
 * worktree belongs to at most one session, and a branch to at most one
 * worktree and one session. Only something that satisfies that is a thing a
 * session may release.
 *
 * Two kinds fail the test and must never be released:
 *   shared   — claimed by more than one session, so owned by none
 *   external — outside mc's worktree root: a checkout the user brought
 *
 * On the machine this was written for, the primary checkout is claimed by 46
 * sessions. Releasing "the session's worktrees" without this distinction
 * would have deleted the user's own repository, 46 times over.
 */
function classify({ path, claimants, worktreeRoot }) {
  if (claimants > 1) return 'shared';
  if (!path.startsWith(`${worktreeRoot}/`)) return 'external';
  return 'owned';
}

export function inspectWorktreeSprawl({ mcHomeDir = mcHome() } = {}) {
  const listed = listSessionHomesSync({ mcHomeDir });
  const claimed = new Map();
  const claimCounts = new Map();
  for (const entry of listed.sessions || []) {
    for (const workspace of listWorkspaceAssociationsSync({
      mcHomeDir, mcSessionId: entry.mc_session_id,
    }).workspaces || []) {
      claimCounts.set(
        workspace.current_path,
        (claimCounts.get(workspace.current_path) || 0) + 1,
      );
    }
  }
  const worktreeRoot = worktreesRoot(mcHomeDir);
  const sessions = [];
  for (const entry of listed.sessions || []) {
    const workspaces = listWorkspaceAssociationsSync({
      mcHomeDir,
      mcSessionId: entry.mc_session_id,
    }).workspaces || [];
    const rows = workspaces.map((workspace) => {
      claimed.set(workspace.current_path, entry.metadata.name);
      const claimants = claimCounts.get(workspace.current_path) || 1;
      return {
        path: workspace.current_path,
        present: existsSync(workspace.current_path),
        preferred: workspace.preferred_launch === true,
        claimants,
        ownership: classify({ path: workspace.current_path, claimants, worktreeRoot }),
        ...gitFacts(workspace.current_path),
      };
    });
    sessions.push({
      name: entry.metadata.name,
      mc_session_id: entry.mc_session_id,
      lifecycle: entry.projection.lifecycle,
      runtime_state: entry.projection.runtime_state,
      workspaces: rows,
    });
  }

  const orphans = [];
  const root = worktreeRoot;
  let repos = [];
  try { repos = readdirSync(root); } catch { repos = []; }
  for (const repo of repos) {
    let entries = [];
    try { entries = readdirSync(join(root, repo)); } catch { continue; }
    for (const name of entries) {
      const path = join(root, repo, name);
      if (claimed.has(path)) continue;
      let modified = null;
      try { modified = statSync(path).mtime.toISOString().slice(0, 10); } catch { /* unreadable */ }
      orphans.push({ path, repo, name, modified, ...gitFacts(path) });
    }
  }

  return {
    sessions: sessions.sort((a, b) => a.name.localeCompare(b.name)),
    orphans: orphans.sort((a, b) => a.path.localeCompare(b.path)),
    summary: {
      sessions: sessions.length,
      open: sessions.filter((item) => item.lifecycle === 'open').length,
      archived: sessions.filter((item) => item.lifecycle !== 'open').length,
      workspaces: sessions.reduce((total, item) => total + item.workspaces.length, 0),
      missing_workspaces: sessions.reduce(
        (total, item) => total + item.workspaces.filter((w) => !w.present).length,
        0,
      ),
      orphan_directories: orphans.length,
      owned: countOwnership(sessions, 'owned'),
      shared: countOwnership(sessions, 'shared'),
      external: countOwnership(sessions, 'external'),
    },
  };
}

function countOwnership(sessions, kind) {
  const seen = new Set();
  for (const session of sessions) {
    for (const workspace of session.workspaces) {
      if (workspace.ownership === kind) seen.add(workspace.path);
    }
  }
  return seen.size;
}

/** Branch, dirtiness and unmerged commits — never a mutation. */
function gitFacts(path) {
  if (!existsSync(join(path, '.git'))) return { git: false };
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', path, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return null; }
  };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const unmerged = branch && branch !== 'HEAD'
    ? git(['log', '--oneline', `origin/main..${branch}`])
    : null;
  return {
    git: true,
    branch: branch || null,
    dirty: dirty ? dirty.split('\n').filter(Boolean).length : 0,
    upstream: upstream || null,
    unmerged_commits: unmerged ? unmerged.split('\n').filter(Boolean).length : 0,
  };
}

function render(report, stdout) {
  const { summary } = report;
  stdout.write(`mc worktrees · ${summary.sessions} sessions · ${summary.workspaces} workspaces · ${summary.orphan_directories} unowned directories\n\n`);

  const dormant = report.sessions.filter((item) => (
    item.lifecycle !== 'open' || item.runtime_state === 'exited' || item.runtime_state === 'none'
  ));
  stdout.write(`SESSIONS (${report.sessions.length}, of which ${dormant.length} are not running)\n`);
  for (const session of report.sessions) {
    const state = session.lifecycle === 'open' ? session.runtime_state : session.lifecycle;
    stdout.write(`  ${session.name.padEnd(30)} ${String(state).padEnd(12)}\n`);
    for (const workspace of session.workspaces) {
      const mark = workspace.ownership === 'owned' ? ' ' : workspace.ownership === 'shared' ? '~' : 'x';
      stdout.write(`    ${mark} ${flags(workspace)} ${workspace.path}\n`);
    }
  }

  if (report.orphans.length) {
    stdout.write(`\nUNOWNED DIRECTORIES (${report.orphans.length}) — under mc's worktree root, claimed by no session\n`);
    for (const orphan of report.orphans) {
      stdout.write(`  ${flags(orphan)} ${orphan.path}${orphan.modified ? `  (${orphan.modified})` : ''}\n`);
    }
  }

  stdout.write(`\nOWNERSHIP   ${summary.owned} releasable · ${summary.shared} shared (~) · ${summary.external} brought by you (x)\n`);
  stdout.write('Only a directory under mc\'s root, claimed by exactly one session, is a\n');
  stdout.write('thing a session may release. Nothing here was removed.\n');
}

function flags(item) {
  if (!item.present && item.present !== undefined) return 'missing ';
  if (!item.git) return 'plain   ';
  const marks = [];
  if (item.dirty) marks.push(`${item.dirty} uncommitted`);
  if (item.unmerged_commits) marks.push(`${item.unmerged_commits} unmerged`);
  const branch = item.branch ? item.branch : '(detached)';
  return `${branch}${marks.length ? ` [${marks.join(', ')}]` : ''}`;
}

export function parseArgs(argv) {
  const opts = { json: false };
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  return opts;
}
