/** Retained inspection workspace safety; the runner has no planner launcher. */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { STABLE_ID_RE } from './goal-contract.js';
import { writeJsonAtomic } from './atomic-write.js';

/** Never adopt, reset or merge a builder/foreground tree. Detached, clean,
 * runner-owned checkouts are refreshed from each repository's current main. */
export function ensureProgrammePlanWorkspace({ root, programme, repos, git }) {
  if (!STABLE_ID_RE.test(programme) || !repos.length) throw new Error('planner workspace needs a programme and repositories');
  const path = join(root, 'runner', 'plans', programme);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const marker = join(path, 'WORKSPACE.json');
  const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : { version: 1, heads: {} };
  if (previous.version !== 1 || !previous.heads || typeof previous.heads !== 'object' || Array.isArray(previous.heads)
    || Object.entries(previous.heads).some(([name, head]) => !STABLE_ID_RE.test(name) || !/^[a-f0-9]{40}$/u.test(head))) throw new Error('planner workspace ownership is unreadable; preserve it for recovery');
  const checked = [];
  for (const repo of repos) {
    if (!STABLE_ID_RE.test(repo.name)) throw new Error('invalid planner repository name');
    const run = (cwd, args) => {
      const result = git(cwd, args);
      if (!result.ok) throw new Error(`planner checkout ${repo.name}: git ${args[0]} failed`);
      return result.stdout.trim();
    };
    run(repo.path, ['fetch', '-q', 'origin']);
    const cwd = join(path, repo.name);
    if (!existsSync(cwd)) run(repo.path, ['worktree', 'add', '--detach', cwd, 'origin/main']);
    const common = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    if (run(cwd, common) !== run(repo.path, common) || realpathSync(run(cwd, ['rev-parse', '--show-toplevel'])) !== realpathSync(cwd)
      || run(cwd, ['branch', '--show-current']) || run(cwd, ['status', '--porcelain'])) throw new Error('planner checkout is not its clean detached worktree; preserve it for recovery');
    if (run(cwd, ['rev-parse', 'HEAD']) !== (previous.heads[repo.name] || run(repo.path, ['rev-parse', 'origin/main']))) throw new Error('planner inspection head changed; preserve it for recovery');
    run(cwd, ['checkout', '--detach', 'origin/main']);
    const head = run(cwd, ['rev-parse', 'HEAD']);
    previous.heads[repo.name] = head; writeJsonAtomic(marker, previous);
    checked.push({ name: repo.name, path: cwd, head });
  }
  return { path, repos: checked };
}

export async function runProgrammePlan() {
  // The durable event queue is retained, but this installation has no safe
  // headless queue consumer yet. Do not launch the obsolete planner envelope.
  return 'skipped:planner-unavailable';
}
