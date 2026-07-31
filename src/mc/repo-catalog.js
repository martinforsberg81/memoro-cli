import { readRegistry } from './registry.js';
import { getRepoContext, deriveRepoName, derivePublicRepoRef } from '../lib/git-context.js';
import { resolveDefaultBranch } from './git.js';

export async function listLocalRepoCatalog({
  cwd = process.cwd,
  registryReader = readRegistry,
  repoContextReader = getRepoContext,
  defaultBranchResolver = resolveDefaultBranch,
} = {}) {
  const candidates = candidateRepoDirs({ cwd, registryReader });
  const byRef = new Map();

  for (const dir of candidates) {
    const context = await repoContextReader(dir).catch(() => null);
    const repoRef = derivePublicRepoRef(context);
    if (!repoRef) continue;
    const defaultBranch = safeDefaultBranch(defaultBranchResolver, context?.toplevel || dir);
    mergeRepo(byRef, {
      repo: deriveRepoName(context),
      repo_ref: repoRef,
      branch: context.branch || null,
      workspace_ref: defaultBranch.ok ? defaultBranch.branch : null,
    });
  }

  return Array.from(byRef.values()).sort((a, b) => a.repo.localeCompare(b.repo));
}

export function candidateRepoDirs({ cwd = process.cwd, registryReader = readRegistry } = {}) {
  const dirs = [];
  addDir(dirs, typeof cwd === 'function' ? cwd() : cwd);

  let registry = null;
  try { registry = registryReader(); } catch { registry = null; }
  for (const entry of Array.isArray(registry?.entries) ? registry.entries : []) {
    addDir(dirs, entry?.primary_worktree);
    addDir(dirs, entry?.worktree_path);
  }

  return dirs;
}

function mergeRepo(byRef, repo) {
  const existing = byRef.get(repo.repo_ref);
  if (!existing || rankRepo(repo) > rankRepo(existing)) {
    byRef.set(repo.repo_ref, repo);
  }
}

function rankRepo(repo) {
  return repo.workspace_ref ? 2 : repo.branch ? 1 : 0;
}

function safeDefaultBranch(resolver, dir) {
  try {
    const result = resolver(dir);
    return result?.ok ? result : { ok: false };
  } catch {
    return { ok: false };
  }
}

function addDir(dirs, dir) {
  if (typeof dir !== 'string') return;
  const trimmed = dir.trim();
  if (!trimmed || dirs.includes(trimmed)) return;
  dirs.push(trimmed);
}
