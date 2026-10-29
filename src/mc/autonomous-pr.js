/** Durable refusal, independent of readable PLAN/STATE. No review door exists
 * yet: these PRs cannot enter either the merger or the docs shortcut. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { realLock } from './register.js';
import { repoNameOf } from './repos.js';
import { workRoot } from './paths.js';
import { programsPlans } from './plan-source.js';
import { projectForBranch } from './project-prs.js';

export const AUTONOMOUS_PR_MARK = '<!-- mc-autonomous: review-required -->';
const digest = value => createHash('sha256').update(value).digest('hex');
const directory = (root, repo) => join(root, 'runner', 'autonomous-prs', digest(repo));

/** Ordinary publication cannot silently downgrade a known v2 branch to v1
 * just because the caller lacks a runner environment. */
export function autonomousBranchHeld({ root, repo, branch }) {
  try {
    readFileSync(join(directory(root, repo), `${digest(branch)}.json`), 'utf8');
    return true;
  } catch (error) { if (error.code !== 'ENOENT') return true; }
  const plans = programsPlans({ home: join(root, 'programs') }).filter(item => item.repo === repo);
  const project = projectForBranch(branch, plans.map(item => item.project));
  const found = plans.find(item => item.project === project);
  if (!found) return false;
  try { return JSON.parse(found.text).version === 2; } catch { return false; }
}

export function markAutonomousPr({ root, repo, branch, programme, project, pr = null }) {
  const path = join(directory(root, repo), `${digest(branch)}.json`);
  return realLock(root, () => {
    let previous = null;
    try { previous = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = { schema: 'mc-autonomous-pr', version: 1, repo, branch, programme, project, pr };
    if (previous && pr === null) next.pr = previous.pr;
    if (previous && (['repo', 'branch', 'programme', 'project'].some(key => previous[key] !== next[key])
      || (previous.pr !== null && previous.pr !== next.pr))) throw new Error('autonomous PR ownership cannot change');
    writeJsonAtomic(path, next);
    return next;
  }, { strict: true });
}

export async function autonomousMergeDoor({ repoPath, pr, gh, root = workRoot(), view = null }) {
  const refused = reason => ({ checked: true, ok: false, stop: 'autonomous-review-required', problems: [reason] });
  let known = [];
  const repo = repoNameOf(repoPath);
  try {
    const dir = directory(root, repo);
    known = readdirSync(dir).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(join(dir, file), 'utf8')));
    if (known.some(item => item?.schema !== 'mc-autonomous-pr' || item.version !== 1 || item.repo !== repo
      || typeof item.branch !== 'string' || !item.branch || (item.pr !== null && (!Number.isSafeInteger(item.pr) || item.pr < 1)))) throw new Error('invalid marker');
  } catch (error) {
    if (error.code !== 'ENOENT') return refused('autonomous PR registry is unreadable; merge authority is unknown');
  }
  if (known.some(item => item.pr === Number(pr))) return refused('autonomous PR awaits the independent review door; nothing may merge');
  if (!view && gh) {
    try {
      const response = await gh(['pr', 'view', String(pr), '--json', 'headRefName,body'], { cwd: repoPath });
      if (response?.status === 0 || response?.ok === true) view = JSON.parse(response.stdout);
    } catch { /* legacy unknown PRs retain their old behavior */ }
  }
  if (view?.body?.includes(AUTONOMOUS_PR_MARK) || known.some(item => item.branch === view?.headRefName)
    || (view?.headRefName && autonomousBranchHeld({ root, repo, branch: view.headRefName }))) {
    return refused('autonomous PR awaits the independent review door; nothing may merge');
  }
  if (!view?.headRefName && known.some(item => item.pr === null)) return refused('an autonomous publication is unresolved and GitHub ownership is unknown');
  return { checked: false, ok: true, problems: [] };
}
