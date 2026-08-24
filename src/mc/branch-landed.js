/**
 * Did this branch's content land in main — whatever the SHAs say?
 *
 * mc counted "unmerged" as commits (`origin/main..branch`), and every merge
 * here is a squash: the branch's commits never appear on main, so every
 * branch that HAS landed reads as if it had not, forever. Measured
 * 2026-08-24: fourteen MSR areas showed "unmerged" on the board; twelve had
 * merged PRs, nothing uncommitted, and their content verified in main —
 * and the board's arithmetic read as disorder to the person it exists for.
 * `mc work release` refused to clean the same twelve on the same count.
 *
 * So the question is asked of content, locally and without the network:
 * `git merge-tree --write-tree origin/main <branch>`. A branch whose merge
 * against main reproduces main's own tree adds nothing main lacks — that is
 * what "landed" means after a squash. A different tree is real work sitting
 * here. A conflict is a question this function cannot answer, and it says
 * so instead of guessing — the same three-way honesty as everything else
 * built today:
 *
 *   'landed'   the content is in main; the commits are a squash artefact
 *   'ahead'    there is work here that main does not have
 *   'unknown'  it could not be determined (conflict, old git, no base)
 */
import { execFileSync } from 'node:child_process';

export function branchLanded(dir, branch, { base = 'origin/main', run = null } = {}) {
  const git = run || ((args) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return null; }
  });
  const baseTree = git(['rev-parse', `${base}^{tree}`]);
  if (!baseTree) return 'unknown';
  const merged = git(['merge-tree', '--write-tree', base, branch]);
  if (!merged) return 'unknown';
  return merged === baseTree ? 'landed' : 'ahead';
}
