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
 * built today. It stays local.
 *
 *   'landed'   the content is in main; the commits are a squash artefact
 *   'ahead'    there is work here that main does not have
 *   'unknown'  it could not be determined (conflict, old git, no base)
 *
 * The second question, for a branch whose merge conflicts, is asked of
 * GitHub by `mergedPullAtTip` below — is the branch's tip the head of a
 * merged pull request? Both the runner (`mergedAtTip`, run.js) and
 * `mc work release` (`releaseVerdict`, work-area.js) ask it here. Measured
 * 2026-09-26: release kept 29 workareas as "cannot tell"; every one had a
 * merged pull request whose head was exactly its tip.
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

/**
 * The newest pull request merged from `branch`, when its head is the
 * branch's tip: `{ number, merged_at }`. Then no commit came after the
 * landing. GitHub failing, unparsable output, no merged pull request, no
 * tip, or a different tip is `null` — a question that fails means keep.
 *
 * `gh(args)` returns `{ ok, stdout }`, the shape `deps.gh` has in run.js.
 */
export function mergedPullAtTip(dir, branch, { gh = null, tip } = {}) {
  const ask = gh || ((args) => defaultGh(dir, args));
  let asked;
  try {
    asked = ask(['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '5',
      '--json', 'number,mergedAt,headRefOid']);
  } catch { return null; }
  if (!asked?.ok) return null;
  let merged;
  try { merged = JSON.parse(String(asked.stdout || '[]')); } catch { return null; }
  if (!Array.isArray(merged) || !merged.length) return null;
  const newest = merged.reduce((a, b) => (String(b.mergedAt || '') > String(a.mergedAt || '') ? b : a));
  // A tip given as null is the caller saying it has none (run.js).
  const at = tip === undefined ? readTip(dir, branch) : tip;
  if (!at || newest.headRefOid !== at) return null;
  return { number: newest.number, merged_at: newest.mergedAt || null };
}

/**
 * The newest pull request merged from `branch`, when it landed through the
 * merger's restack: `{ number, merged_at }`. The merger (`restack`,
 * merger.js) replays a branch onto main in a worktree of its own and pushes
 * a new head, so the workarea's local tip is that head's ancestor in content
 * but not in sha, and `mergedPullAtTip` says no. 2026-10-17: `publish-handover`
 * step 6 started on `publish-handover-7` nine minutes after #929 had landed
 * from it — head 97addbd7 on the remote, aec79c2a in the workarea.
 *
 * So: the newest merged pull request's head must be `origin/<branch>` (read
 * after the caller's fetch), and the local branch must carry no commit of
 * its own that head lacks by patch, other than what origin/main already
 * has. Anything else — no remote ref, a different one, a commit left over,
 * a git or GitHub call failing — is `null`: a question that fails means keep.
 *
 * `run(args)` returns git's trimmed stdout, or null on failure.
 */
export function landedThroughRemote(dir, branch, { gh = null, run = null } = {}) {
  const git = run || ((args) => defaultGit(dir, args));
  const ask = gh || ((args) => defaultGh(dir, args));
  let asked;
  try {
    asked = ask(['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '5',
      '--json', 'number,mergedAt,headRefOid']);
  } catch { return null; }
  if (!asked?.ok) return null;
  let merged;
  try { merged = JSON.parse(String(asked.stdout || '[]')); } catch { return null; }
  if (!Array.isArray(merged) || !merged.length) return null;
  const newest = merged.reduce((a, b) => (String(b.mergedAt || '') > String(a.mergedAt || '') ? b : a));
  const remote = git(['rev-parse', `origin/${branch}`]);
  if (!remote || !newest.headRefOid || remote.trim() !== newest.headRefOid) return null;
  const own = git(['rev-list', '--no-merges', '--cherry-pick', '--right-only', `${newest.headRefOid}...${branch}`]);
  if (own === null || own === undefined) return null;
  for (const sha of String(own).split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (git(['merge-base', '--is-ancestor', sha, 'origin/main']) === null) return null;
  }
  return { number: newest.number, merged_at: newest.mergedAt || null };
}

function defaultGit(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

function defaultGh(dir, args) {
  try {
    const stdout = execFileSync('gh', args, {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000,
    });
    return { ok: true, stdout };
  } catch { return { ok: false, stdout: '' }; }
}

function readTip(dir, branch) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', branch], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}
