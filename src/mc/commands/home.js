/**
 * `mc` — the front door.
 *
 * Two surfaces that list, and no more (decision mc-3): this page, and the
 * same page redrawn by `mc --watch`. Bare `mc` used to print the V1 sessions
 * table; `mc status`, `mc list` and bare `mc work` each printed a list of
 * their own. They are one page now, and it is the one a person lands on.
 *
 * What it prints is `page-collect.js`'s five sections drawn by
 * `page-render.js`. What it does after printing depends only on where it is
 * printing to:
 *
 *   - a terminal      the page, then the menu `mc work` used to carry — a
 *                     number or a name opens that workarea, and the numbers
 *                     are the ones in WORK above the prompt
 *   - a pipe, --json  the page, and exit 0. Nothing prompts, ever
 *   - --watch [n]     the page every n seconds (15 by default) until ctrl-c,
 *                     with no prompt and the terminal left as it was found
 *
 * The page is offline: it answers from `~/mc/runner/plans.json` and
 * `~/mc/runner/prs.json` and says how old the PR cache is. `--fresh` is the
 * opt-in that fetches and asks GitHub. `--offline` is still accepted and does
 * nothing — it is what the page does now.
 *
 * `--json` prints the same object the renderer takes, so the two surfaces
 * cannot drift.
 */
import { getPackageVersion } from '../../lib/version.js';
import { checkAndPrintFreshInstall } from '../first-run.js';
import { collectPage } from '../page-collect.js';
import { colourFor, columnsFor, renderPageLines } from '../page-render.js';
import { ask as askTerminal, interactive } from '../prompt.js';
import { inspectWorkArea } from '../work-area.js';
import { openArea, parseArgs, runVerb, startSomething } from './work.js';

const WATCH_SECONDS = 15;
const ESC = String.fromCharCode(27);

const USAGE = [
  'usage — mc                       the page, and at a terminal a way in',
  '        mc --watch [seconds]     the same page, redrawn',
  '        mc --json [--fresh]      the same page, as one object',
  '        mc status <name>         one project',
].join('\n');

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
  // One way to make a page, used by all three surfaces: the width and the
  // colour are read per draw, so a terminal resized under `--watch` is
  // answered on the next round.
  const page = async () => {
    const data = await collect({ fresh: opts.fresh });
    return {
      data,
      lines: renderPageLines(data, {
        columns: columnsFor(stdout),
        colour: colourFor(stdout, env),
        version,
      }),
    };
  };
  const draw = async () => (await page()).lines;

  if (opts.watch) return watch(opts.watch, { stdout, draw });

  if (opts.json) {
    stdout.write(`${JSON.stringify(await collect({ fresh: opts.fresh }), null, 2)}\n`);
    return 0;
  }
  const first = await page();
  stdout.write(`${first.lines.join('\n')}\n`);

  // A pipe, a script and `--json` see exactly the page and nothing else. A
  // person at a terminal is asked instead of being handed a grammar.
  if (!(deps.interactive || interactive)()) return 0;
  return menu(first.data, {
    stdout, stderr, page, ask: deps.ask, open: deps.openArea,
  });
}

export function parsePageArgs(argv) {
  const opts = { json: false, fresh: false, watch: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--fresh') { opts.fresh = true; continue; }
    // What the page does by default. Accepted so a habit and a script that
    // learnt it in step 2 keep working.
    if (arg === '--offline') continue;
    if (arg === '--watch') {
      const given = /^\d+$/u.test(argv[index + 1] || '');
      opts.watch = given ? Number(argv[index + 1]) : WATCH_SECONDS;
      if (given) index += 1;
      if (opts.watch < 1) return { ...opts, error: '--watch needs at least one second' };
      continue;
    }
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  return opts;
}

/* -------------------------------------------------------------------- watch */

/**
 * The same page, again, until ctrl-c.
 *
 * Redraw the lines that changed and only those. Clearing the screen every
 * fifteen seconds gives a page that flickers, loses the reader's place, and
 * throws away the one thing worth seeing: the row that moved. So the previous
 * page is kept, the new one compared against it, and the cursor sent up to
 * rewrite the differences where they already are.
 *
 * The layout has to be stable for that to hold. When workareas appear or
 * vanish the page changes shape and is drawn whole — rare, and visible when it
 * happens, which is better than a page quietly out of register.
 *
 * The cursor is hidden while it runs and put back on the way out, on ctrl-c
 * and on an ordinary exit alike: a terminal left without its cursor is the
 * kind of mess a person fixes by opening a new one.
 */
export async function watch(seconds, { stdout, draw, sleep = null, rounds = Infinity }) {
  let previous = null;
  const restore = () => { if (stdout.isTTY) stdout.write(`${ESC}[?25h`); };
  const onSignal = () => { restore(); process.exit(0); };
  process.on('SIGINT', onSignal);
  process.on('exit', restore);
  try {
    for (let round = 0; round < rounds; round += 1) {
      const lines = await draw();
      if (!stdout.isTTY || !previous || previous.length !== lines.length) {
        stdout.write(`${stdout.isTTY ? `${ESC}[?25l` : ''}${lines.join('\n')}\n`);
      } else {
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index] === previous[index]) continue;
          const up = lines.length - index;
          stdout.write(`${ESC}[${up}A\r${ESC}[2K${lines[index]}${ESC}[${up}B\r`);
        }
      }
      previous = lines;
      await (sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })))(seconds * 1000);
    }
  } finally {
    restore();
    process.off('SIGINT', onSignal);
    process.off('exit', restore);
  }
  return 0;
}

/* --------------------------------------------------------------------- menu */

const KEYS = [
  '  <n>  open it   ·   n  start something new   ·   b  brief   ·   p <name>  plan',
  '  s <name>  that project   ·   w  watch   ·   q  quit',
].join('\n');

/**
 * The way on from the page.
 *
 * The numbers are WORK's numbers — the page above the prompt is the listing,
 * so the menu has none of its own. Everything a number cannot say is a letter,
 * and anything else is read as a `mc work` command, because a prompt invites
 * one and the verbs are the same verbs. `mc work discard x`, `discard x`,
 * `discard x --apply` — the leading `mc` and `work` are stripped and the rest
 * is read exactly as it would have been from the shell. Anything else is said
 * out loud rather than swallowed, and the page is drawn again with whatever
 * changed.
 */
export async function menu(first, {
  stdout, stderr, page, ask = askTerminal, open = openArea,
}) {
  let data = first;
  for (;;) {
    const areas = data.work.areas;
    stdout.write(`\n${KEYS}\n\n`);
    const answer = ask('>', { stdout });
    if (!answer || answer === 'q') return 0;

    if (answer === 'n' || answer === 'new') return startSomething({ stdout, stderr });
    if (answer === 'b' || answer === 'brief') {
      const brief = await import('./brief.js');
      return brief.run([], { stdout, stderr });
    }
    if (answer === 'w' || answer === 'watch') {
      return watch(WATCH_SECONDS, { stdout, draw: async () => (await page()).lines });
    }

    const words = answer.split(/\s+/u).filter(Boolean);
    if (words[0] === 'p' && words.length === 2) {
      const plan = await import('./plan.js');
      return plan.run([words[1]], { stdout, stderr });
    }
    if (words[0] === 's' && words.length === 2) {
      const project = await import('./status-project.js');
      stdout.write('\n');
      await project.run([words[1]], { stdout, stderr });
      data = await redraw();
      continue;
    }

    const byNumber = areas[Number(answer) - 1];
    const byName = areas.find((area) => area.name === answer);
    if (byNumber || byName) return open((byNumber || byName).name, {}, { stdout, stderr });

    const outcome = await typed(answer, areas, { stdout, stderr, open });
    if (outcome !== null) return outcome;
    data = await redraw();
  }

  /** The page again, printed, with the rows the numbers now mean. */
  async function redraw() {
    const next = await page();
    stdout.write(`${next.lines.join('\n')}\n`);
    return next.data;
  }
}

/**
 * A line typed at the menu. Returns an exit code to leave on, or null to draw
 * the page again.
 */
export async function typed(answer, areas, { stdout, stderr, open = openArea }) {
  const words = answer.split(/\s+/u).filter(Boolean);
  if (words[0] === 'mc') words.shift();
  if (words[0] === 'work') words.shift();
  if (words.length === 0) return null;

  const sub = parseArgs(words);
  if (sub.error) {
    stderr.write(`\nmc: ${sub.error}\n`);
    return null;
  }
  // A bare word that names nothing is a typo far more often than it is a new
  // piece of work, and the page is right there to compare it against. From
  // the shell the same word still starts something, because there the name is
  // the whole statement of intent.
  //
  // Asked of the disk rather than of WORK's rows: WORK draws the areas that
  // hold a checkout, and an area made with no repository — `mc work` offers
  // exactly that — would otherwise be unreachable by the only name it has.
  if (sub.verb === 'open' && words.length === 1
    && !areas.some((area) => area.name === sub.name)
    && !inspectWorkArea(sub.name).exists) {
    stderr.write(`\nmc: nothing here called "${sub.name}" — n starts one\n`);
    return null;
  }
  if (sub.verb === 'open') return open(sub.name, sub, { stdout, stderr });
  if (sub.verb === 'list') return null;
  stdout.write('\n');
  await runVerb(sub, { stdout, stderr });
  return null;
}
