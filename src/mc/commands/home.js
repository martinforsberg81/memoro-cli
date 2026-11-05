/**
 * `mc` — the front door.
 *
 * One surface that lists, and no more (decision mc-3, sharpened 2026-08-29:
 * `--watch` went — a page redrawn on a timer is not a live page, and the
 * real one comes later; that later is `page-live.js`). Bare `mc` used to
 * print the V1 sessions table; `mc status`, `mc list` and the workarea verb
 * each printed a list of their own. They are one page now, and it is the one
 * a person lands on.
 *
 * What it prints is `page-collect.js`'s five sections drawn by
 * `page-render.js`. What it does after printing depends only on where it is
 * printing to:
 *
 *   - a terminal      the page, then a menu — a goal's number shows the
 *                     goal (`mc goal show`), and the numbers are the ones in
 *                     PROGRAMMES above the prompt. The page stays true while
 *                     the menu waits: every 30 seconds the rows that changed
 *                     are rewritten where they stand
 *   - a pipe, --json  the page, and exit 0. Nothing prompts, ever, and
 *                     nothing loops — the fork is `interactive()` below and
 *                     there is no second opinion about it
 *
 * Every print fetches `origin/main` first (ruling 20); the goals are read
 * from `~/mc/programs/`. `prs.json` comes from cache with its age; at a terminal the page
 * refills it itself when it is five minutes old (`freshFor`), `f` at the menu
 * and `--fresh` ask GitHub now, and a pipe reads the cache as it is.
 * `--offline` skips the fetch.
 *
 * `--json` prints the same object the renderer takes, so the two surfaces
 * cannot drift.
 */
import { spawnSync } from 'node:child_process';

import { getPackageVersion } from '../../lib/version.js';
import { run as runGit } from '../git.js';
import { checkAndPrintFreshInstall } from '../first-run.js';
import { PRS_STALE_SECONDS } from '../page-cache.js';
import { collectPage } from '../page-collect.js';
import { CLEAR_ALL } from '../page-frame.js';
import { LIVE_MIN_COLUMNS, RESTART, liveReader, plainReader } from '../page-live.js';
import { colourFor, columnsFor, renderPageLines } from '../page-render.js';
import { interactive } from '../prompt.js';
import { childEnv, mcCheckout } from '../run-control.js';
import { RETIRED_VERBS, retiredLines } from '../../mc-verbs.js';

const USAGE = [
  'usage — mc                       the page, and at a terminal a way in',
  '        mc --json [--fresh|--offline]   the same page, as one object',
].join('\n');

export function usage() {
  return USAGE;
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const opts = parsePageArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(`${USAGE}\n`);
    return 2;
  }

  // A fresh install lands here first, so the hint belongs here — on stderr,
  // so `--json` stays parseable. It costs one `existsSync` on every machine
  // that has ever run `mc new`; only a genuinely fresh one asks the keychain.
  await (deps.checkAndPrintFreshInstall || checkAndPrintFreshInstall)();

  const collect = deps.collect || collectPage;
  const version = await getPackageVersion().catch(() => '');
  // Whether the page expands phases, finished work and dormant programmes into
  // line. It lives here rather than in the menu because the live loop refreshes
  // through this same closure (`page-live.js`): a frame that did not know the
  // mode would fold them again, thirty seconds after somebody asked to see
  // them.
  let expand = false;
  // At a terminal the page keeps its own pull requests current: every draw,
  // the live loop's included, asks GitHub when the cache is older than five
  // minutes (page-collect.js, `fresh: 'stale'`). A pipe reads the cache as it
  // always has, so a script reaches the network only when it asks to. `f` at
  // the menu asks now, once (`freshOnce`).
  //
  // One ask per five minutes per open page whatever the answer was: a `gh`
  // that fails — a locked keychain, no network — must not be asked again on
  // every thirty-second redraw (2026-09-20: a modal per ask).
  const live = (deps.interactive || interactive)();
  let freshOnce = false;
  let askedAt = -Infinity;
  const clock = deps.clock || (() => Date.now());
  // The commit mc is running from, read when the page starts and again at
  // every draw. Node read its module graph once, at start, so a page left open
  // while `~/mc/self` fast-forwards goes on drawing with the old code: on
  // 2026-10-26 a page started the morning before showed codex-models as
  // `invalid — steps[2].kind: unknown key` a day after the review kind had
  // landed. A page whose commit has moved starts again instead (`restartPage`),
  // the way `mc run --update` hands the runner over.
  const commitOf = deps.commit || codeCommit;
  const startedOn = live ? commitOf() : null;
  let movedTo = null;
  // One way to make a page, used by both surfaces: the width and the
  // colour are read per draw.
  const page = async () => {
    const fresh = freshFor({ opts, live, once: freshOnce, now: clock(), askedAt });
    freshOnce = false;
    const data = await collect({ fresh, offline: opts.offline });
    if (data?.caches?.prs?.asked) askedAt = clock();
    const now = startedOn ? commitOf() : null;
    if (now && now !== startedOn) movedTo = now;
    return {
      data,
      restart: movedTo !== null,
      key: pageKey(data),
      lines: renderPageLines(data, {
        columns: columnsFor(stdout),
        colour: colourFor(stdout, env),
        version,
        expand,
      }),
    };
  };
  if (opts.json) {
    stdout.write(`${JSON.stringify(await collect({ fresh: opts.fresh, offline: opts.offline }), null, 2)}\n`);
    return 0;
  }
  const first = await page();
  stdout.write(`${first.lines.join('\n')}\n`);

  // A pipe, a script and `--json` see exactly the page and nothing else. A
  // person at a terminal is asked instead of being handed a grammar — and
  // only there does anything refresh, because this is the only place that
  // knows there is a terminal to refresh.
  if (!live) return 0;
  const reader = deps.reader || readerFor({ stdout, lines: first.lines, page, key: first.key });
  return menu(first.data, {
    stdout, stderr, page, reader, expand: (on) => { expand = on; }, fresh: () => { freshOnce = true; },
    restart: () => (deps.restartPage || restartPage)({ stdout, env, from: startedOn, to: movedTo }),
  });
}

/** The commit of the checkout mc runs from, or null: not a checkout, or git did not answer. */
export function codeCommit({ checkout = mcCheckout(), spawn = (_git, args) => runGit(undefined, args) } = {}) {
  if (!checkout) return null;
  const out = spawn('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return out.status === 0 ? String(out.stdout).trim() || null : null;
}

/**
 * `mc` again, on the code that is on disk now, in this terminal, with the
 * same arguments.
 *
 * The process is replaced (`process.execve`), not waited on: a child under a
 * waiting parent left one parked `mc` per restart, and after a day of
 * fast-forwards in `~/mc/self` a tab held a chain of them. Replaced, only the
 * newest page's process is left. The shell wrapper's fd 3 does not survive
 * the exec: Node marks every inherited descriptor close-on-exec at startup
 * (`uv_disable_stdio_inheritance`) and its `execve` clears that only for 0-2.
 * Nothing in mc writes fd 3 since `emitCd` went (#561), so nothing a person
 * sees is lost; the new image is started without `--emit-shell-directives`
 * and without `MC_EMIT_SHELL_DIRECTIVES` (`childEnv`), so it makes no claim
 * on a descriptor it does not hold. Anything that writes fd 3 again owns
 * carrying it across this exec.
 * A replaced process runs no `finally` and no `exit` handler, which is why
 * the live reader's `ask` has given the terminal back (timer, resize
 * listener, raw mode, `/dev/tty`) before `menu` calls this.
 *
 * At a terminal the screen and the scrollback are cleared first, so the tab
 * holds one page rather than one more per restart. A stdout that is not a TTY
 * gets the line it always got. Where `execve` is missing (Node 22 before
 * 22.15) or throws, mc waits on a child as it did before and leaves with its
 * code.
 */
export function restartPage({
  stdout, env = process.env, from, to, spawn = spawnSync, argv = process.argv, execve = process.execve,
}) {
  const short = (sha) => String(sha || '').slice(0, 8);
  const tty = stdout.isTTY === true;
  stdout.write(`${tty ? CLEAR_ALL : '\n'}mc: mc moved from ${short(from)} to ${short(to)} under this page — starting it again on the new code\n`);
  if (typeof execve === 'function') {
    try {
      const args = argv.slice(1).filter((arg) => arg !== '--emit-shell-directives');
      execve(process.execPath, [process.execPath, ...args], childEnv(env));
      // Never reached on a real exec; a test's `execve` returns here.
      return 0;
    } catch { /* the child below, as before */ }
  }
  const run = (fds) => spawn(process.execPath, argv.slice(1), { stdio: ['inherit', 'inherit', 'inherit', ...fds], env });
  let child = null;
  try {
    child = run(env.MC_EMIT_SHELL_DIRECTIVES === '1' ? [3] : []);
  } catch {
    child = run([]);
  }
  if (child?.error) child = run([]);
  return child?.status ?? 1;
}

/**
 * What one draw asks of GitHub: everything under `--fresh` or after `f`;
 * at a terminal, a stale cache's refill (`'stale'`) at most once per
 * `PRS_STALE_SECONDS` since this page last asked, however that ask went;
 * otherwise nothing.
 */
export function freshFor({ opts, live, once = false, now, askedAt = -Infinity }) {
  if (opts.fresh || once) return true;
  if (!live || opts.offline) return false;
  return now - askedAt >= PRS_STALE_SECONDS * 1000 ? 'stale' : false;
}

/**
 * Live, or the page as it always was.
 *
 * Narrower than `columnsFor`'s floor and every row of the page wraps, which
 * makes every row of the live loop's arithmetic wrong; there the page is
 * printed once and read the old way rather than written to the wrong rows.
 */
export function readerFor({ stdout, lines, page, key = null }) {
  if (Number(stdout.columns) >= LIVE_MIN_COLUMNS) return liveReader({ stdout, lines, page, key });
  return plainReader({ stdout });
}

/**
 * Where every goal stands, as one string: the facts PROGRAMMES draws that a
 * person acts on, and none of the clocks beside them.
 *
 * The live loop compares it between frames. PROGRAMMES is the top of a page
 * that is taller than most terminals, so its rows are the ones that scroll out
 * of reach, and a stage or status that changed up there is the one change worth printing
 * the page again for (page-live.js, `draw`). A planning session's age
 * changes every minute and is deliberately not in it.
 */
export function pageKey(data) {
  const goals = (data?.programmes?.programmes || []).flatMap((group) => group.goals || []);
  const goalKey = goals
    .map((g) => [g.programme, g.name, g.stage, g.status, g.phase, g.title, g.held ? 1 : 0, g.criteria?.met ?? '', g.criteria?.all ?? '', g.running ? 1 : 0].join(':'))
    .join('|');
  const foreground = (data?.programmes?.programmes || []).flatMap((group) => [
    ...(group.planning_sessions || []), ...(group.sessions || []),
  ]);
  // Activity is now above the prompt too. Identity/check-ins force a whole
  // redraw when off-screen; a clock tick alone still does not.
  const activityKey = [...(data?.runner?.sessions || []), ...foreground]
    .filter((s) => s.pid || s.goal || s.name || s.area)
    .map((s) => [s.goal || s.name || s.area, s.kind || s.verb, s.repo, s.pid, s.started, s.tool, s.model, s.check_ins || 0].join(':')).sort().join('|');
  return [goalKey, activityKey].filter(Boolean).join('|');
}

export function parsePageArgs(argv) {
  const opts = { json: false, fresh: false, offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--fresh') { opts.fresh = true; continue; }
    if (arg === '--offline') { opts.offline = true; continue; }
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  return opts;
}

/* --------------------------------------------------------------------- menu */

const KEYS = [
  '  <n>  show that goal   ·   a  all / collapse   ·   m  manager',
  '  p  plan a programme   ·   f  fresh from GitHub   ·   q  quit',
  '  start  ·  stop [--force]  ·  update [--force]   the runner, from here',
].join('\n');

/**
 * The runner's switch, typed at the menu: `start`, `stop`, `update` — with
 * `--force` where the verb takes it — and the same with `run` or `mc run` in
 * front. The answer is printed under the page and the page is drawn again, so
 * the STEPS section shows what the order did without a second terminal
 * (asked for 2026-10-10).
 *
 * Only a bare `stop` is the runner's. A bare `run` is not offered — a foreground runner inside the
 * page would hold the menu for the rest of the day.
 */
export function runnerOrder(answer) {
  const words = answer.split(/\s+/u).filter(Boolean);
  if (words[0] === 'mc') words.shift();
  if (words[0] === 'run') words.shift();
  const [verb, ...rest] = words;
  if (!['start', 'stop', 'update', '--update', 'lanes'].includes(verb)) return null;
  if (verb === 'stop' && rest.some((word) => !word.startsWith('-'))) return null;
  return [verb, ...rest];
}

/** `mc goal <argv>` — the goal verbs, loaded when a goal's number is typed. */
async function showGoalVerb(argv, io) {
  const goal = await import('./goal.js');
  return goal.run(argv, io);
}

/**
 * The way on from the page.
 *
 * The numbers are the page's — the page above the prompt is the listing, so the
 * menu has none of its own. A goal's number shows it (`mc goal show`). `a`
 * draws the dormant programmes too. Everything a number cannot say is a
 * letter. Anything else is said out loud rather than swallowed, and the page
 * is drawn again with whatever changed.
 *
 * The reading is a `reader` rather than a call, because at a terminal it is
 * two things at once: the line being typed, and the page above it refreshing
 * while it is (`page-live.js`). The menu owns what is printed under the page
 * — it hands the reader that block so a frame that has to reprint can put it
 * back — and the reader owns everything from the prompt onwards.
 */
export async function menu(first, {
  stdout, stderr, page, reader, expand = () => {},
  // Asks the next draw to go to GitHub for the pull requests (`f`).
  fresh = () => {},
  // `mc run <verb>` — a dependency so a test drives the menu without a runner.
  runOrder = null,
  // `mc goal <verb>` for a goal's number — a dependency, as runOrder is, so a
  // test drives the menu without a goal on disk.
  showGoal = null,
  // The page on newer code, when a frame said mc moved under it (`RESTART`).
  restart = () => 0,
}) {
  let data = first;
  // Off, and a redraw away from on. `a` is a way of looking rather than a verb:
  // it changes what the next page draws and nothing else, which is why the flag
  // is set on the caller's closure and the page is simply asked for again.
  let all = false;
  for (;;) {
    // Every goal PROGRAMMES numbered, reached by its number.
    const goals = data.programmes.programmes.flatMap((group) => group.goals || []);
    const answer = await reader.ask(`\n${KEYS}\n\n`, '>');
    if (answer === RESTART) return restart();
    if (!answer || answer === 'q') return 0;

    // The page again with every phase, finished goal and dormant programme. `a`
    // again folds them.
    if (answer === 'a' || answer === 'all') {
      all = !all;
      expand(all);
      data = await redraw();
      continue;
    }
    // The page again with every pull request asked of GitHub now, rather than
    // when the cache is next five minutes old.
    if (answer === 'f' || answer === 'fresh') {
      fresh();
      data = await redraw();
      continue;
    }
    if (['m', 'manager', 'b', 'brief'].includes(answer)) {
      const manager = await import('./manager.js');
      return manager.run([], { stdout, stderr });
    }

    const order = runnerOrder(answer);
    if (order) {
      const verb = await import('./run.js');
      stdout.write('\n');
      await (runOrder || verb.run)(order, { stdout, stderr });
      data = await redraw();
      continue;
    }

    const words = answer.split(/\s+/u).filter(Boolean);
    // `p` alone is as good an answer as `p <programme>`: `mc plan` asks which
    // programme when it is not told, and the page is exactly the place
    // somebody would rather be shown the list than have to remember a name.
    if (words[0] === 'p' && words.length <= 2) {
      const plan = await import('./plan.js');
      return plan.run(words.slice(1), { stdout, stderr });
    }

    // A goal's number shows the goal, and the page is drawn again under the
    // prompt: a goal is looked at, not opened.
    const goal = goals.find((item) => item.number === Number(answer));
    if (goal) {
      stdout.write('\n');
      await (showGoal || showGoalVerb)(['show', `${goal.programme}/${goal.name}`], { stdout, stderr });
      data = await redraw();
      continue;
    }

    typed(answer, { stderr });
    data = await redraw();
  }

  /**
   * The page again, printed, with the rows the numbers now mean.
   *
   * Through the reader rather than to the stream: something has printed under
   * the last frame — a goal, a verb's output — so the page is somewhere
   * else on the screen now, and the reader is what has to be told.
   */
  async function redraw() {
    const next = await page();
    reader.show(next.lines, next.key);
    return next.data;
  }
}

/**
 * A line typed at the menu that is none of the above: said out loud, and the
 * page is drawn again. A retired verb (`RETIRED_VERBS`) gets the line the
 * shell gives it (`retiredLines`).
 */
export function typed(answer, { stderr }) {
  const words = answer.split(/\s+/u).filter(Boolean);
  if (words[0] === 'mc') words.shift();
  if (words.length === 0) return;
  if (RETIRED_VERBS.includes(words[0])) {
    stderr.write(`\n${retiredLines(words[0]).join('\n')}\n`);
    return;
  }
  stderr.write(`\nmc: nothing here called "${words.join(' ')}" — a goal's number shows it\n`);
}
