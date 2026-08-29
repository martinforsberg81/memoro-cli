/**
 * `mc status` — every piece of work, and what it is doing right now.
 *
 * `mc work` is the way in: it lists what exists and lets you open one. This is
 * the way to stand back. When four conversations run at once the question is
 * never "what is there" — it is which one has stopped and is waiting for a
 * decision from me, and which is still going so I can leave it alone.
 *
 * Waiting comes first, because that is the only line on the page that is
 * costing time while it is read. Working comes next. Everything idle sits at
 * the bottom, one line each, still there but not asking for anything.
 *
 * `--json` is the same page for a model rather than a person, and `--wait`
 * blocks until something moves. A session asked to keep an eye on the others
 * runs those two, and needs no cooperation from the sessions it watches —
 * nothing reports in, so a session that crashed reads exactly as accurately
 * as one that did not.
 */
import { getPackageVersion } from '../../lib/version.js';
import { renderLines } from '../status-render.js';
import { signature, workStatus } from '../work-status.js';

/**
 * The board. It carried a watchers row until the `mc watch` programme went
 * away with the PM (decision mc-1): the row named three daemons, two of
 * which no longer exist. `mc repo watch status` answers for the one that
 * does.
 */
async function board(options) {
  return workStatus(options);
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc status [--json]\n');
    stderr.write('        mc status --watch [seconds]     redraw continuously\n');
    stderr.write('        mc status --wait [seconds] [--timeout <seconds>]\n');
    stderr.write('                                        block until something moves\n');
    return 2;
  }

  if (opts.wait) return waitForChange(opts, { stdout });

  const page = async () => renderLines(await board(), {
    columns: stdout.columns || 100,
    colour: Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined,
    version: await getPackageVersion().catch(() => ''),
  });

  if (!opts.watch) {
    if (opts.json) {
      stdout.write(`${JSON.stringify(await board(), null, 2)}\n`);
      return 0;
    }
    stdout.write(`${(await page()).join('\n')}\n`);
    return 0;
  }
  return watch(opts, { stdout, page });
}

/**
 * Redraw the lines that changed, and only those.
 *
 * Clearing the screen every fifteen seconds gives a page that flickers, loses
 * the reader's place, and throws away the one thing worth seeing: the row that
 * moved. So the previous page is kept, the new one compared against it, and
 * the cursor sent up to rewrite the differences where they already are.
 *
 * The layout has to be stable for that to hold. When work areas appear or
 * vanish the page changes shape and is drawn whole — rare, and visible when it
 * happens, which is better than a page quietly out of register.
 */
export async function watch(opts, { stdout, page }) {
  const ESC = String.fromCharCode(27);
  let previous = null;
  const restore = () => { if (stdout.isTTY) stdout.write(`${ESC}[?25h`); };
  process.on('SIGINT', () => { restore(); process.exit(0); });
  process.on('exit', restore);

  for (;;) {
    if (opts.json) {
      stdout.write(`${JSON.stringify(await board())}\n`);
    } else {
      const lines = await page();
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
    }
    await new Promise((resolve) => { setTimeout(resolve, opts.watch * 1000); });
  }
}

/**
 * Block until something moves, then say what it is.
 *
 * This is what a supervising session runs. Polling a status page costs a turn
 * every time round whether or not anything happened, and most of the time
 * nothing has — so the loop belongs here, where it costs a subprocess, not
 * there, where it costs a model.
 *
 * The comparison skips git, which is nearly all the cost of a full report,
 * and asks in full only once a conversation has actually moved.
 */
async function waitForChange(opts, { stdout }) {
  const before = signature(await board({ git: false }));
  const deadline = opts.timeout ? Date.now() + opts.timeout * 1000 : null;
  for (;;) {
    await new Promise((resolve) => { setTimeout(resolve, opts.wait * 1000); });
    const now = await board({ git: false });
    if (signature(now) !== before) {
      const report = await board();
      stdout.write(opts.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${renderLines(report, {
          columns: stdout.columns || 100,
          colour: Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined,
          version: await getPackageVersion().catch(() => ''),
        }).join('\n')}\n`);
      return 0;
    }
    // A watcher that also wants to look up every so often regardless says so
    // with --timeout, and gets told plainly that nothing changed rather than
    // being handed a report it has already seen.
    if (deadline && Date.now() >= deadline) {
      stdout.write(opts.json ? `${JSON.stringify({ changed: false, waited: opts.timeout })}\n` : 'nothing changed\n');
      return 3;
    }
  }
}

export function parseArgs(argv) {
  const opts = { json: false, watch: 0, wait: 0, timeout: 0 };
  const seconds = (argv, index, fallback) => (
    /^\d+$/u.test(argv[index + 1] || '') ? Number(argv[index + 1]) : fallback
  );
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--watch' || arg === '--wait') {
      const given = /^\d+$/u.test(argv[index + 1] || '');
      opts[arg === '--watch' ? 'watch' : 'wait'] = seconds(argv, index, arg === '--watch' ? 15 : 3);
      if (given) index += 1;
      continue;
    }
    if (arg === '--timeout') {
      if (!/^\d+$/u.test(argv[index + 1] || '')) return { ...opts, error: '--timeout needs seconds' };
      opts.timeout = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  return opts;
}
