/**
 * A repository, seen whole: what main is, what is in the air against it, who
 * is standing on it, and whether the installation on this machine is in step.
 *
 * The board (`mc status`) answers "what is each piece of work doing". This
 * answers the other question people were assembling by hand out of `git`,
 * `gh`, `mc status` and memory: what is happening *to this repository* — and
 * how far behind main every open branch has drifted, which is the fact that
 * makes a green run from yesterday's baseline look as old as it is.
 *
 * Everything is derived at the moment of asking, like the rest of the work
 * model, and the worktree section is the board's own inspection regrouped —
 * not a second implementation that can drift from it. The only thing this
 * writes anywhere is a `git fetch`, and `--offline` removes even that.
 */
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { mcHome } from './paths.js';
import { readLease } from './repo-lease.js';
import { readCombinedSnapshot } from './repo-snapshot.js';
import { watcherState } from './repo-watch.js';
import { resolveRepository } from './work-area.js';
import { workStatus } from './work-status.js';

const run = promisify(execFile);

/** How long any one git or gh call may take before it counts as absent. */
const CALL_MS = 30_000;

/** Open pull requests read per repository. Beyond this the view says so. */
const PR_LIMIT = 50;

/**
 * The repositories mc can see: every one a piece of work has a worktree on,
 * plus whatever this machine's own installation is linked to.
 *
 * Derived from the board, so a repository appears here for exactly the reason
 * it appears on the status page — and disappears the same way.
 */
export function reposFromBoard(board) {
  const byRoot = new Map();
  for (const area of board.areas || []) {
    for (const worktree of area.worktrees || []) {
      if (!worktree.git_common_dir) continue;
      const root = dirname(worktree.git_common_dir);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push({
        area: area.name,
        repo: worktree.repo,
        path: worktree.path,
        branch: worktree.branch,
        uncommitted: worktree.uncommitted,
        unmerged_commits: worktree.unmerged_commits,
      });
    }
  }
  return byRoot;
}

/**
 * Installations that run straight from a checkout.
 *
 * On this machine `mc` is a symlink into a working tree, so `git pull` there
 * *is* the deploy — which is why the view has a deploy section at all. An
 * ordinary npm install resolves into `node_modules`, which is no repository,
 * and then there is nothing to report and none is shown.
 *
 * The first match on PATH wins, exactly as the shell would resolve it.
 */
export function sourceLinkedInstallations(env = process.env) {
  const byRoot = new Map();
  const dirs = String(env.PATH || '').split(delimiter).filter(Boolean);
  for (const command of ['mc', 'memoro-cli', 'memoro']) {
    const bin = dirs.map((dir) => join(dir, command)).find(executable);
    if (!bin) continue;
    let source = null;
    try { source = realpathSync(bin); } catch { continue; }
    const root = topLevel(dirname(source));
    if (!root || byRoot.has(root)) continue;
    byRoot.set(root, { command, bin, source, root });
  }
  return [...byRoot.values()];
}

/**
 * The whole view, one repository or all of them.
 *
 * `board` is injectable so a caller that already has the status page does not
 * pay for it twice; nothing else about the shape changes.
 */
export async function repoStatus({
  env = process.env, names = null, offline = false, cwd = process.cwd(), board = null,
} = {}) {
  const page = board || await workStatus({ env });
  const byRoot = reposFromBoard(page);
  const installs = new Map(sourceLinkedInstallations(env).map((item) => [item.root, item]));
  for (const root of installs.keys()) if (!byRoot.has(root)) byRoot.set(root, []);

  const wanted = names?.length ? [] : [...byRoot.keys()];
  const unknown = [];
  for (const name of names || []) {
    const root = matchRepo(name, [...byRoot.keys()], { cwd, env });
    if (!root) { unknown.push(name); continue; }
    if (!byRoot.has(root)) byRoot.set(root, []);
    if (!wanted.includes(root)) wanted.push(root);
  }

  const repos = await Promise.all(wanted.sort().map((root) => gatherRepo({
    root,
    worktrees: byRoot.get(root) || [],
    install: installs.get(root) || null,
    offline,
  })));

  return {
    at: new Date().toISOString(),
    offline,
    // The one-shot answer. `mc repo watch` gives this field a second value.
    mode: 'computed',
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
    unknown,
  };
}

/**
 * The view as anyone should ask for it: the snapshot when there is one, the
 * count when there is not — and always which of the two it was.
 *
 * This is what makes the answer cheap for everybody. A watcher round costs a
 * fetch, a gh round and an inspection of every checkout; reading its snapshot
 * costs one file read, whoever is asking and however often. A person, the PM,
 * the board and a worker can all ask at once and the machine does the work
 * once a minute rather than once per question.
 *
 * The one rule the reader must not break is pretending an old answer is a
 * current one: past three rounds the page says STALE and says how to start
 * the watcher, and with no snapshot at all it counts for itself and says that
 * is what it did. The view never refuses.
 */
export async function repoView({
  env = process.env, names = null, offline = false, cwd = process.cwd(),
  root = mcHome(), now = Date.now(),
} = {}) {
  const snapshot = readCombinedSnapshot({ root, now });
  const watcher = watcherState({ root, now });
  const fromSnapshot = snapshot.kind === 'present' ? pick(snapshot.value.repos, names) : null;

  // A name the snapshot has never heard of is a question it cannot answer, so
  // the whole answer is counted instead of half-read and half-counted. The
  // count knows every repository mc can see; the picture only knows the ones
  // that existed when it was taken, so it never gets to call a name unknown.
  if (fromSnapshot && !fromSnapshot.missed.length) {
    return {
      at: new Date(now).toISOString(),
      offline: Boolean(snapshot.value.offline),
      mode: 'snapshot',
      updated_at: snapshot.at,
      age_ms: snapshot.age_ms,
      interval_ms: snapshot.interval_ms,
      stale: snapshot.stale,
      watcher: { running: watcher.running, pid: watcher.pid },
      // Every section here is a minute old by design — except this one. A
      // lease is read to decide whether to start a round right now, and a
      // picture from before somebody claimed it would send two rounds at the
      // same repository. It costs one file read, so it is always current.
      repos: fromSnapshot.repos.map((repo) => ({ ...repo, lease: readLease(repo.path, { root, now }) })),
      unknown: fromSnapshot.unknown,
    };
  }

  const computed = await repoStatus({ env, names, offline, cwd });
  return {
    ...computed,
    updated_at: computed.at,
    age_ms: 0,
    interval_ms: snapshot.kind === 'present' ? snapshot.interval_ms : null,
    stale: false,
    watcher: { running: watcher.running, pid: watcher.pid },
  };
}

/** The repositories a snapshot can answer for, and the names it cannot. */
function pick(repos, names) {
  const all = Array.isArray(repos) ? repos : [];
  if (!names?.length) return { repos: all, unknown: [], missed: [] };
  const chosen = [];
  const missed = [];
  for (const name of names) {
    const match = all.find((repo) => repo.name === name || repo.path === name);
    if (match) { if (!chosen.includes(match)) chosen.push(match); continue; }
    missed.push(name);
  }
  return { repos: chosen, unknown: [], missed };
}

/**
 * Turn what the user typed into one of the repositories mc knows.
 *
 * The same rule as `mc work add`: a name is looked up against the clones on
 * this machine rather than resolved against the current directory first. A
 * path still wins when it is one, and standing inside a repository and typing
 * nothing means that one.
 */
export function matchRepo(input, roots, { cwd = process.cwd(), env = process.env } = {}) {
  const known = roots.find((root) => basename(root) === input || root === input);
  if (known) return known;
  const found = resolveRepository(input, { cwd, env });
  return found.ok ? found.path : null;
}

async function gatherRepo({ root, worktrees, install, offline }) {
  const base = await baseRef(root);
  const fetched = offline || !base ? null : await fetchQuiet(root, base);
  // `--offline` means the network, not only the fetch: asking gh would reach
  // GitHub just as surely, and a flag that half-holds is worse than none.
  const [main, pullRequests] = await Promise.all([
    mainHead(root, base),
    offline
      ? { degraded: 'not asked — --offline', items: [] }
      : openPullRequests(root, base),
  ]);
  return {
    name: basename(root),
    path: root,
    main: {
      ref: base,
      ...main,
      fetched: offline ? false : Boolean(fetched),
      degraded: mainDegraded({ base, main, offline, fetched }),
    },
    pull_requests: pullRequests,
    worktrees: worktrees.sort((a, b) => `${a.area}${a.repo}`.localeCompare(`${b.area}${b.repo}`)),
    deploy: install ? await deployState(root, base, install) : null,
    lease: readLease(root),
  };
}

function mainDegraded({ base, main, offline, fetched }) {
  if (!base) return 'no origin/main here';
  if (!main.id) return `nothing at ${base} yet`;
  if (offline) return 'not fetched — --offline';
  if (!fetched) return 'could not reach the remote — this is the last it saw';
  return null;
}

/** What this repository calls its main line, asked rather than assumed. */
async function baseRef(root) {
  const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head;
  return await git(root, ['rev-parse', '--verify', 'origin/main']) ? 'origin/main' : null;
}

/**
 * Refresh every remote-tracking branch, not only main.
 *
 * How far behind main a pull request has drifted is the point of the view,
 * and with the branch's own ref present that is a local count rather than an
 * API call per pull request.
 */
async function fetchQuiet(root, base) {
  const remote = base.split('/')[0];
  return run('git', ['-C', root, 'fetch', '--quiet', remote], { timeout: CALL_MS })
    .then(() => true, () => false);
}

async function mainHead(root, base) {
  if (!base) return { id: null, subject: null, at: null };
  const line = await git(root, ['log', '-1', '--format=%H%x1f%s%x1f%cI', base]);
  if (!line) return { id: null, subject: null, at: null };
  const [id, subject, at] = line.split('\u001f');
  return { id, subject: subject || null, at: at || null };
}

/**
 * The open pull requests, and how far behind main each one is.
 *
 * gh is asked once for the list; the drift is counted locally against the ref
 * the fetch above just refreshed. A pull request from a fork has no such ref,
 * so that one — and only that one — costs a compare call.
 *
 * gh missing, unauthenticated, or offline is not a refusal: the section says
 * why it is empty and the rest of the view stands.
 */
async function openPullRequests(root, base) {
  const listed = await gh(root, [
    'pr', 'list', '--state', 'open', '--limit', String(PR_LIMIT),
    '--json', 'number,title,headRefName,headRefOid,isDraft,updatedAt',
  ]);
  if (!listed.ok) return { degraded: listed.reason, items: [] };
  let raw = [];
  try { raw = JSON.parse(listed.stdout || '[]'); } catch { return { degraded: 'gh returned something unreadable', items: [] }; }
  const items = await Promise.all(raw.map(async (pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    head: pr.headRefOid,
    draft: Boolean(pr.isDraft),
    updated_at: pr.updatedAt || null,
    behind_main: await behindMain(root, base, pr.headRefOid),
  })));
  return {
    degraded: raw.length >= PR_LIMIT ? `only the first ${PR_LIMIT} are shown` : null,
    items: items.sort((a, b) => a.number - b.number),
  };
}

async function behindMain(root, base, head) {
  if (!base || !head) return null;
  const local = await git(root, ['rev-list', '--count', `${head}..${base}`]);
  if (local !== null) return Number(local);
  // A head this checkout has never seen — a fork, or a branch pushed after
  // the fetch. GitHub can still answer, and one call for one pull request is
  // a price worth paying to keep the column honest.
  const branch = base.slice(base.indexOf('/') + 1);
  const compared = await gh(root, ['api', `repos/{owner}/{repo}/compare/${branch}...${head}`, '--jq', '.behind_by']);
  if (!compared.ok) return null;
  const value = Number(String(compared.stdout).trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Is what is installed on this machine what main says it should be?
 *
 * Counted both ways: behind main is the ordinary case after someone merges,
 * ahead of it means the checkout is carrying something unpushed — which is
 * worth seeing, because that installation is what every `mc` on this machine
 * is actually running.
 */
async function deployState(root, base, install) {
  const installed = await git(root, ['rev-parse', 'HEAD']);
  const behind = base ? await git(root, ['rev-list', '--count', `HEAD..${base}`]) : null;
  const ahead = base ? await git(root, ['rev-list', '--count', `${base}..HEAD`]) : null;
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    command: install.command,
    bin: install.bin,
    source: install.source,
    branch: branch && branch !== 'HEAD' ? branch : null,
    installed,
    behind_main: behind === null ? null : Number(behind),
    ahead_main: ahead === null ? null : Number(ahead),
    in_step: behind === '0' && ahead === '0',
  };
}

async function git(cwd, args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: CALL_MS });
    return stdout.trim() || null;
  } catch { return null; }
}

async function gh(cwd, args) {
  try {
    const { stdout } = await run('gh', args, { cwd, encoding: 'utf8', timeout: CALL_MS });
    return { ok: true, stdout };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'gh is not installed' };
    return { ok: false, reason: firstLine(error) };
  }
}

function firstLine(error) {
  const text = error?.stderr?.toString?.() || error?.message || String(error);
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 120) || 'gh could not answer';
}

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function topLevel(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}
