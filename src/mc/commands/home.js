/**
 * `mc` — the front door.
 *
 * One surface that lists, and no more (decision mc-3, sharpened 2026-08-29:
 * `--watch` went — a page redrawn on a timer is not a live page, and the
 * real one comes later; that later is `page-live.js`). Bare `mc` used to
 * print the V1 sessions table; `mc status`, `mc list` and bare `mc work` each
 * printed a list of their own. They are one page now, and it is the one a
 * person lands on.
 *
 * What it prints is `page-collect.js`'s five sections drawn by
 * `page-render.js`. What it does after printing depends only on where it is
 * printing to:
 *
 *   - a terminal      the page, then the menu `mc work` used to carry — a
 *                     number or a name opens that project's workarea, making
 *                     one if it has none, and the numbers are the ones in
 *                     PROJECTS above the prompt. The page stays true while
 *                     the menu waits: every 30 seconds the rows that changed
 *                     are rewritten where they stand
 *   - a pipe, --json  the page, and exit 0. Nothing prompts, ever, and
 *                     nothing loops — the fork is `interactive()` below and
 *                     there is no second opinion about it
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
import { LIVE_MIN_COLUMNS, liveReader, plainReader } from '../page-live.js';
import { colourFor, columnsFor, renderPageLines } from '../page-render.js';
import { interactive } from '../prompt.js';
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
  // person at a terminal is asked instead of being handed a grammar — and
  // only there does anything refresh, because this is the only place that
  // knows there is a terminal to refresh.
  if (!(deps.interactive || interactive)()) return 0;
  const reader = deps.reader || readerFor({ stdout, lines: first.lines, page });
  return menu(first.data, {
    stdout, stderr, page, reader, open: deps.openArea,
  });
}

/**
 * Live, or the page as it always was.
 *
 * Narrower than `columnsFor`'s floor and every row of the page wraps, which
 * makes every row of the live loop's arithmetic wrong; there the page is
 * printed once and read the old way rather than written to the wrong rows.
 */
export function readerFor({ stdout, lines, page }) {
  if (Number(stdout.columns) >= LIVE_MIN_COLUMNS) return liveReader({ stdout, lines, page });
  return plainReader({ stdout });
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
  '  <n>  open it   ·   n  start something new   ·   b  brief   ·   p  plan a programme',
  '  s <name>  that project   ·   q  quit',
].join('\n');

/**
 * The way on from the page.
 *
 * The numbers are PROJECTS' numbers — the page above the prompt is the
 * listing, so the menu has none of its own. Everything a number cannot say is a letter,
 * and anything else is read as a `mc work` command, because a prompt invites
 * one and the verbs are the same verbs. `mc work discard x`, `discard x`,
 * `discard x --apply` — the leading `mc` and `work` are stripped and the rest
 * is read exactly as it would have been from the shell. Anything else is said
 * out loud rather than swallowed, and the page is drawn again with whatever
 * changed.
 *
 * The reading is a `reader` rather than a call, because at a terminal it is
 * two things at once: the line being typed, and the page above it refreshing
 * while it is (`page-live.js`). The menu owns what is printed under the page
 * — it hands the reader that block so a frame that has to reprint can put it
 * back — and the reader owns everything from the prompt onwards.
 */
export async function menu(first, {
  stdout, stderr, page, reader, open = openArea,
}) {
  let data = first;
  for (;;) {
    // Everything PROGRAMMES numbered, in the order it numbered it: every
    // project of every programme, then the workareas no project explains,
    // which are under their own heading but not out of reach. Opening a
    // project that has no workarea yet is what creates one — `openArea` has
    // always done that, and it is why a project can be a row before a folder
    // is.
    const areas = [
      ...data.programmes.programmes.flatMap((group) => group.projects),
      ...(data.programmes.unplanned?.shown || []),
    ];
    const answer = await reader.ask(`\n${KEYS}\n\n`, '>');
    if (!answer || answer === 'q') return 0;

    if (answer === 'n' || answer === 'new') return startSomething({ stdout, stderr });
    if (answer === 'b' || answer === 'brief') {
      const brief = await import('./brief.js');
      return brief.run([], { stdout, stderr });
    }

    const words = answer.split(/\s+/u).filter(Boolean);
    // `p` alone is as good an answer as `p <programme>`: `mc plan` asks which
    // programme when it is not told, and the page is exactly the place
    // somebody would rather be shown the list than have to remember a name.
    if (words[0] === 'p' && words.length <= 2) {
      const plan = await import('./plan.js');
      return plan.run(words.slice(1), { stdout, stderr });
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

  /**
   * The page again, printed, with the rows the numbers now mean.
   *
   * Through the reader rather than to the stream: something has printed under
   * the last frame — a project, a verb's output — so the page is somewhere
   * else on the screen now, and the reader is what has to be told.
   */
  async function redraw() {
    const next = await page();
    reader.show(next.lines);
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
  // Asked of the disk rather than of the page's rows: PROJECTS draws projects
  // and the folders that hold a checkout, and an area made with no repository
  // — `mc work` offers exactly that — would otherwise be unreachable by the
  // only name it has.
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
