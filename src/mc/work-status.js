/**
 * What every piece of work is doing right now.
 *
 * `mc work` answers "what is there, and let me into one of them". This answers
 * a different question, and it is the one that costs a person the most time
 * when several conversations run at once: which of them is thinking, which is
 * waiting for me, and which has been sitting untouched since this morning.
 *
 * Everything here is derived at the moment of asking, like the rest of the
 * work model. Nothing is stored, nothing is subscribed to, and no session has
 * to report in — a session that crashed, was killed, or was never started by
 * mc is described exactly as accurately as one that behaved.
 *
 * Three facts, from three places that already know them:
 *
 *   running   the operating system — a tool process whose working directory
 *             is this work, found by pid and named by ps
 *   turn      the transcript's last entry. An assistant message with nothing
 *             after it means the model has stopped and is waiting; anything
 *             else means it is still going
 *   said      the last thing the assistant actually said, which is what tells
 *             a person whether they still care about this one
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import { contextUsage, lastModel, listConversations, readTailEntries } from './conversations.js';
import { readMenu } from './menu-read.js';
import { mcHome, workRoot } from './paths.js';
import { backgroundTarget } from './work-open.js';
import { processesStandingIn } from './standing.js';
import { readSuiteLease } from './suite-lease.js';
import { dependencyTree } from './dependency-tree.js';
import { areaRoleName } from './roles.js';
import { openTaskCount } from './task-log.js';
import { inspectWorkArea, listWorkAreas } from './work-area.js';
import { readStopMark } from './work-stop-marker.js';

const run = promisify(execFile);

/**
 * Ask git about every worktree at once.
 *
 * Four questions per checkout, asked one after another, took four seconds
 * across eight areas — each one is a few hundred milliseconds against a
 * repository this size, and they were queued behind each other for no reason.
 * They do not depend on one another, so they all go at the same time.
 */
/**
 * `'missing'` when the manifest declares dependencies and there is no
 * `node_modules`; `'present'` when there is one; `null` for a directory that
 * is not a Node project or declares nothing — where the question does not
 * arise and the page should say nothing.
 */
function dependencyState(path) {
  const tree = dependencyTree(path);
  if (!tree.manifest || tree.declares === 0) return null;
  return tree.missing ? 'missing' : 'present';
}

async function gitFacts(paths) {
  const ask = async (cwd, args) => {
    try {
      const { stdout } = await run('git', ['-C', cwd, ...args], { encoding: 'utf8' });
      return stdout.trim() || null;
    } catch { return null; }
  };
  const results = await Promise.all(paths.map(async (path) => {
    // The common directory is asked here rather than in a second inspection
    // somewhere else: its parent is the repository this checkout belongs to,
    // which is what `mc repo` groups by. Two implementations of "which
    // repository is this" would be two answers the day they disagree.
    const [branch, dirty, common] = await Promise.all([
      ask(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ask(path, ['status', '--porcelain']),
      ask(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    const unmerged = branch && branch !== 'HEAD'
      ? await ask(path, ['log', '--oneline', `origin/main..${branch}`])
      : null;
    const unmergedCommits = unmerged ? unmerged.split('\n').filter(Boolean).length : 0;
    // Content, not commits (2026-08-24): squash merges leave every landed
    // branch "unmerged" by SHA forever, and the board read as disorder.
    const landed = unmergedCommits > 0
      ? await (async () => {
        const baseTree = await ask(path, ['rev-parse', 'origin/main^{tree}']);
        if (!baseTree) return 'unknown';
        const merged = await ask(path, ['merge-tree', '--write-tree', 'origin/main', branch]);
        if (!merged) return 'unknown';
        return merged === baseTree ? 'landed' : 'ahead';
      })()
      : null;
    return [path, {
      branch: branch && branch !== 'HEAD' ? branch : null,
      is_git: Boolean(branch),
      git_common_dir: common,
      uncommitted: dirty ? dirty.split('\n').filter(Boolean).length : 0,
      unmerged_commits: unmergedCommits,
      landed,
    }];
  }));
  return new Map(results);
}

/**
 * A transcript written this recently belongs to a session that is open.
 *
 * Standing in the directory is the stronger signal but not the only one: a
 * conversation can change directory after it starts — one here moved from a
 * worktree to the repository root — and then no process is found where the
 * work is, while the transcript is being written to as you read. It showed as
 * idle with "just now" beside it, which is a listing arguing with itself.
 */
const RECENT_MS = 2 * 60 * 1000;

/**
 * Which tool processes stand where, for every directory at once.
 *
 * One `lsof` and one `ps` for the whole machine rather than a pair per
 * directory. Asked per directory this took 3.3 seconds across eight areas,
 * which is fine to type once and useless for something meant to sit on a
 * second screen and refresh.
 *
 * Returns a map of directory → tool names, counted, because the count is what
 * says how many conversations in that directory are actually open.
 */
function toolsByDirectory(paths) {
  const byDirectory = new Map(paths.map((path) => [path, []]));
  for (const { directory, name } of toolProcesses(paths)) {
    if (byDirectory.has(directory)) byDirectory.get(directory).push(name);
  }
  return byDirectory;
}

/**
 * The tool processes standing in these directories: pid, name, and where.
 *
 * Shared by the status board, which only needs to count them, and by stopping
 * a piece of work, which needs to reach them.
 */
export function toolProcesses(paths) {
  const found = [];
  for (const { pid, command, directory } of processesIn(paths)) {
    // The tool itself, not the shell it was started from and not mc's own
    // background daemons — those stand here too and mean nothing about
    // whether anyone is working.
    const name = /(^|\/)claude(\s|$)/u.test(command) ? 'claude'
      : /(^|\/)codex(\s|$)/u.test(command) ? 'codex'
        : null;
    if (name) found.push({ pid, name, directory });
  }
  return found;
}

/**
 * A full test suite, running: `node --test`, `npm test`, or the contract
 * suite by name. Found the same way the tools are — by what stands in these
 * directories — so the page can say a suite is running whoever holds the
 * right to, and a suite nobody claimed is a row rather than a slow machine.
 */
const SUITE_COMMAND = /(?:^|\/|\s)node(?:\s+\S+)*\s+--test(?:\s|$)|(?:^|\s)npm\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/u;

/**
 * A shell started with `-c` carries its whole script on its command line —
 * including the `node --test` it is about to run, or has finished running.
 * Counting it made every suite two rows and left a "running suite" on the
 * board after node had exited, while the shell waited for its own cleanup.
 * The suite is the process that runs tests, not the one that typed them.
 */
const SHELL_WRAPPER = /^(?:\S*\/)?(?:zsh|bash|sh|dash|fish)\s+(?:-\S+\s+)*-c\s/u;

/** Is this command line a running suite — the runner itself, not a shell that typed it? */
export function isSuiteCommand(command) {
  return !SHELL_WRAPPER.test(command) && SUITE_COMMAND.test(command);
}

export function suiteProcesses(paths) {
  const found = [];
  for (const { pid, command, directory, elapsed } of processesIn(paths, { elapsed: true })) {
    if (!isSuiteCommand(command)) continue;
    found.push({ pid, directory, elapsed, command: command.replace(/^\S*\/(node|npm)\s/u, '$1 ').slice(0, 80) });
  }
  return found;
}

/**
 * The suites running in every work area and its worktrees, with the area
 * named. One process per row; a suite that spawned helpers shows as the
 * parent only, because the children share its command line with `--test`
 * stripped and fall outside the pattern.
 */
export async function suiteRuns({ env = process.env } = {}) {
  const areas = listWorkAreas(env);
  const byPath = new Map();
  for (const area of areas) {
    byPath.set(area.path, area.name);
    for (const worktree of area.worktrees) byPath.set(worktree.path, area.name);
  }
  return suiteProcesses([...byPath.keys()]).map((run) => ({ ...run, area: byPath.get(run.directory) || null }));
}

/**
 * Every process standing in these directories: pid, command line, where —
 * and how long it has run, when asked. One `lsof` and one `ps` for the whole
 * machine; asked per directory this took seconds.
 */
function processesIn(paths, { elapsed = false } = {}) {
  if (paths.length === 0) return [];

  // By prefix, not by exact path (standing.js): a tool started one directory
  // down was invisible to the board, to occupation and to addressing at once.
  const here = processesStandingIn(paths).map(({ pid, directory }) => [String(pid), directory]);
  if (here.length === 0) return [];

  const commands = new Map();
  try {
    const columns = elapsed ? 'pid=,etime=,command=' : 'pid=,command=';
    const ps = execFileSync('ps', ['-o', columns, '-p', [...new Set(here.map(([p]) => p))].join(',')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of ps.split('\n')) {
      const match = elapsed
        ? /^\s*(\d+)\s+(\S+)\s+(.*)$/u.exec(line)
        : /^\s*(\d+)\s+()(.*)$/u.exec(line);
      if (match) commands.set(match[1], { command: match[3], elapsed: match[2] || null });
    }
  } catch { return []; }

  const found = [];
  for (const [processId, directory] of here) {
    const known = commands.get(processId);
    if (!known) continue;
    found.push({ pid: Number(processId), command: known.command, directory, elapsed: known.elapsed });
  }
  return found;
}

/** Claude: `{type:'assistant'|'user', message:{content}}`, plus UI noise. */
function claudeTail(entries) {
  let said = null;
  let turn = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const kind = entry.type;
    if (kind !== 'assistant' && kind !== 'user') continue;
    const content = (entry.message || {}).content;
    const text = textOf(content);
    if (turn === null) turn = kind === 'assistant' && text ? 'waiting' : 'working';
    if (kind === 'assistant' && text && !said) said = text;
    if (turn !== null && said) break;
  }
  return { said, turn };
}

/** Codex: messages live under `payload`, and `task_complete` ends a turn. */
function codexTail(entries) {
  let said = null;
  let turn = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const payload = entries[i].payload || {};
    if (turn === null) {
      if (payload.type === 'task_complete') turn = 'waiting';
      else if (payload.role === 'user' || payload.type === 'function_call') turn = 'working';
    }
    if (!said && payload.role === 'assistant') {
      const text = textOf(payload.content);
      if (text) said = text;
    }
    if (turn !== null && said) break;
  }
  return { said, turn };
}

function textOf(content) {
  if (typeof content === 'string') return collapse(content);
  if (!Array.isArray(content)) return '';
  return collapse(content
    .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' '));
}

function collapse(text) {
  const clean = String(text || '').replace(/\s+/gu, ' ').trim();
  return clean.startsWith('<') ? '' : clean;
}

/**
 * Which conversations in an area are the open ones.
 *
 * The operating system can say that two claude processes stand in this
 * directory. It cannot say which conversations they hold. But a process
 * writes to exactly one transcript, so with two processes and five
 * conversations it is the two most recently written that are open — the rest
 * were closed and left behind.
 *
 * Marking every conversation in a busy area as live was the first version and
 * it read plausibly and was wrong: an area with one running tool and an old
 * finished conversation reported both as active.
 */
function markLive(conversations, running, now) {
  const budget = new Map();
  for (const name of running) budget.set(name, (budget.get(name) || 0) + 1);
  const live = new Set();
  for (const item of [...conversations].sort((a, b) => (b.updated_ms || 0) - (a.updated_ms || 0))) {
    const name = item.tool === 'claude-code' ? 'claude' : item.tool;
    const left = budget.get(name) || 0;
    // A transcript being written right now is its own proof, but it is also
    // almost certainly the process that was found — so it spends the budget
    // either way. Letting it through for free handed the spare process to the
    // next conversation down, and a session finished ten hours ago came back
    // to life on the page.
    if (now - (item.updated_ms || 0) < RECENT_MS) {
      live.add(item.id);
      if (left > 0) budget.set(name, left - 1);
      continue;
    }
    if (left <= 0) continue;
    budget.set(name, left - 1);
    live.add(item.id);
  }
  return live;
}

function describeConversation(item, live) {
  const entries = readTailEntries(item.path);
  const { said, turn } = item.tool === 'codex' ? codexTail(entries) : claudeTail(entries);
  return {
    ...item,
    said,
    turn,
    model: lastModel(item.tool, entries),
    // How full its context is, from the same tail (2026-08-24): a pane
    // prints it, but a session outside tmux has no pane, and the transcript
    // has it for both.
    context: contextUsage(item.tool, entries),
    live,
    state: !live ? 'idle' : turn === 'waiting' ? 'waiting' : 'working',
  };
}

/**
 * A short string that changes exactly when something worth waking for does.
 *
 * Not the whole report: a conversation writing another paragraph moves its
 * size and its timestamp every second, and a supervisor woken by that would
 * be woken constantly and learn nothing. What matters is a transition —
 * something stopped and is now waiting, something started, a piece of work
 * appeared or went away.
 */
export function signature(report) {
  return report.areas
    .map((area) => `${area.name}:${area.conversations.map((item) => `${item.id.slice(0, 8)}=${item.state}`).sort().join(',')}`)
    .sort()
    .join('|');
}

/**
 * Is the area's running pane in a menu? One tmux capture, read by the same
 * rule the wake guard uses, so the board and the guard cannot disagree.
 */
export function menuFor(name, env = process.env) {
  const target = backgroundTarget(name, { env });
  if (!target) return null;
  const captured = spawnSync('tmux', ['capture-pane', '-t', target, '-p'], { encoding: 'utf8' });
  if (captured.status !== 0) return null;
  const menu = readMenu(String(captured.stdout || '').replace(/\s+$/u, '').split('\n'));
  return menu ? { ...menu, target } : null;
}

export async function workStatus({ env = process.env, names = null, git: askGit = true, menu = null } = {}) {
  // The area's own listing is asked without conversations and without git:
  // both are gathered below for every area at once.
  const areas = (names?.length
    ? names.map((name) => inspectWorkArea(name, env, { conversations: false, git: false }))
    : listWorkAreas(env, { conversations: false, git: false })).filter((area) => area.exists);

  // Every directory in one question, so the cost does not grow with the
  // number of pieces of work being watched.
  const allPaths = areas.flatMap((area) => [area.path, ...area.worktrees.map((w) => w.path)]);
  const byDirectory = toolsByDirectory(allPaths);

  // And every conversation in one question too. Asked per area this spawned
  // a sqlite3 and re-scanned Claude's project directory once for each — three
  // seconds across eight areas. The lookup already matches on a path prefix,
  // so the work root asks it once and the areas are buckets.
  const root = workRoot(env);
  const everything = listConversations(root, env);
  // Waiting for a change asks this many times a minute, and the git questions
  // are all of the cost. A watcher only cares whether a conversation moved, so
  // it skips them and asks in full once something has.
  const git = askGit
    ? await gitFacts(areas.flatMap((area) => area.worktrees.map((w) => w.path)))
    : new Map();
  const now = Date.now();
  const conversationsFor = (area) => everything.filter(
    (item) => item.cwd === area.path || item.cwd.startsWith(`${area.path}/`),
  );

  const report = {
    at: new Date(now).toISOString(),
    root,
    areas: areas.map((area) => {
      const paths = [area.path, ...area.worktrees.map((worktree) => worktree.path)];
      const running = paths.flatMap((path) => byDirectory.get(path) || []);
      const found = conversationsFor(area);
      const liveIds = markLive(found, running, now);
      const conversations = found.map((item) => describeConversation(item, liveIds.has(item.id)));
      return {
        name: area.name,
        path: area.path,
        // The role the area carries, or null. A field added beside the
        // others, never one of them changed: every reader of this page keeps
        // reading exactly what it read before.
        role: areaRoleName(area.path),
        // `mc work stop` was here, and nobody has opened the area since: who
        // and when, so a conversation gone from the page reads as stopped
        // rather than as dead (KP-09). Null in every other case.
        stopped: readStopMark(area.path),
        running,
        worktrees: area.worktrees.map((worktree) => ({
          repo: worktree.repo,
          path: worktree.path,
          ...(git.get(worktree.path) || {
            branch: null, is_git: false, git_common_dir: null, uncommitted: 0, unmerged_commits: 0, landed: null,
          }),
          // Whether the manifest's dependencies have a tree to be found in.
          // A suite run without one prints a number that is not a measurement
          // (D-0152), and nothing in that number says so — this does. A field
          // beside the others, never one of them changed.
          dependencies: dependencyState(worktree.path),
        })),
        conversations,
        // A pane sitting in a menu is a session blocked on a person, and it
        // can sit there all night (2026-08-23). One capture per running area;
        // the question, when the drawing carries one, so it can be answered
        // without going to look.
        menu: running.length > 0 ? (menu || menuFor)(area.name, env) : null,
        // What a person scanning the page is looking for: is anything here
        // stopped and waiting for them?
        waiting: conversations.some((item) => item.state === 'waiting'),
        working: conversations.some((item) => item.state === 'working'),
        // Tasks this area holds that are not done — open and blocked alike,
        // since both still need somebody's attention. One file read, and
        // nothing for the common case of a session that has never had one.
        open_tasks: openTaskCount(area.name),
      };
    }),
  };
  // Counted here so a reader — a person glancing, or a session asked to keep
  // an eye on the others — does not have to walk the list to learn whether
  // anything needs them.
  report.summary = {
    areas: report.areas.length,
    waiting: report.areas.filter((area) => area.waiting).length,
    working: report.areas.filter((area) => area.working).length,
  };
  // The suite right and the suites actually running — two facts, side by
  // side, because the gap between them is the finding (D-0141, D-0155).
  const byPath = new Map();
  for (const area of report.areas) {
    byPath.set(area.path, area.name);
    for (const worktree of area.worktrees) byPath.set(worktree.path, area.name);
  }
  report.suite = {
    lease: readSuiteLease({ root: env.MC_HOME || mcHome(), now }),
    running: suiteProcesses([...byPath.keys()]).map((run) => ({ ...run, area: byPath.get(run.directory) || null })),
  };
  return report;
}
