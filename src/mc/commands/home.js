/**
 * `mc` — the front door.
 *
 * One surface that lists, and no more (decision mc-3, sharpened 2026-08-29:
 * `--watch` went — a page redrawn on a timer is not a live page, and the
 * real one comes later). Bare `mc` used to print the V1 sessions
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

const USAGE = [
  'usage — mc                       the page, and at a terminal a way in',
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
  // One way to make a page, used by both surfaces: the width and the
  // colour are read per draw.
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
  const opts = { json: false, fresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--fresh') { opts.fresh = true; continue; }
    // What the page does by default. Accepted so a habit and a script that
    // learnt it in step 2 keep working.
    if (arg === '--offline') continue;
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  return opts;
}

/* --------------------------------------------------------------------- menu */

const KEYS = [
  '  <n>  open it   ·   n  start something new   ·   b  brief   ·   p <name>  plan',
  '  s <name>  that project   ·   q  quit',
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
    // Both WORK lists, in the order the page numbered them: an unplanned
    // workarea is under its own heading, not out of reach.
    const areas = [...data.work.areas, ...(data.work.unplanned || [])];
    stdout.write(`\n${KEYS}\n\n`);
    const answer = ask('>', { stdout });
    if (!answer || answer === 'q') return 0;

    if (answer === 'n' || answer === 'new') return startSomething({ stdout, stderr });
    if (answer === 'b' || answer === 'brief') {
      const brief = await import('./brief.js');
      return brief.run([], { stdout, stderr });
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

    // By the number printed beside the row, not by position: the two lists
    // are numbered through, and the page is the listing.
    const byNumber = areas.find((area) => area.number === Number(answer));
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
