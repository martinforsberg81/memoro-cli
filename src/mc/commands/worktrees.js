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

export function inspectWorktreeSprawl({ mcHomeDir = mcHome() } = {}) {
  const listed = listSessionHomesSync({ mcHomeDir });
  const claimed = new Map();
  const sessions = [];
  for (const entry of listed.sessions || []) {
    const workspaces = listWorkspaceAssociationsSync({
      mcHomeDir,
      mcSessionId: entry.mc_session_id,
    }).workspaces || [];
    const rows = workspaces.map((workspace) => {
      claimed.set(workspace.current_path, entry.metadata.name);
      return {
        path: workspace.current_path,
        present: existsSync(workspace.current_path),
        preferred: workspace.preferred_launch === true,
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
  const root = worktreesRoot(mcHomeDir);
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
    },
  };
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
      stdout.write(`      ${flags(workspace)} ${workspace.path}\n`);
    }
  }

  if (report.orphans.length) {
    stdout.write(`\nUNOWNED DIRECTORIES (${report.orphans.length}) — under mc's worktree root, claimed by no session\n`);
    for (const orphan of report.orphans) {
      stdout.write(`  ${flags(orphan)} ${orphan.path}${orphan.modified ? `  (${orphan.modified})` : ''}\n`);
    }
  }

  stdout.write('\nNothing here was removed. `mc end <name>` releases what a session owns.\n');
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
