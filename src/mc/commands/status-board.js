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
 * `--json` is the same page for a model rather than a person. A session that
 * is asked to keep an eye on the others reads that, and it needs no
 * cooperation from the sessions it is watching — nothing reports in, so a
 * session that crashed reads exactly as accurately as one that did not.
 */
import { describeAge, describeSize } from '../conversations.js';
import { workRoot } from '../paths.js';
import { workStatus } from '../work-status.js';

const MARK = { waiting: '◆', working: '●', idle: ' ' };
const RANK = { waiting: 0, working: 1, idle: 2 };

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc status [--json] [--watch [seconds]]\n');
    return 2;
  }

  if (!opts.watch) {
    const report = await workStatus();
    stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : render(report, stdout.columns || 100));
    return 0;
  }

  // Watching writes whole frames rather than diffing, so a terminal that is
  // resized or scrolled recovers on the next one.
  for (;;) {
    const report = await workStatus();
    const frame = opts.json ? `${JSON.stringify(report)}\n` : render(report, stdout.columns || 100);
    stdout.write(opts.json ? frame : `[H[2J${frame}`);
    await new Promise((resolve) => { setTimeout(resolve, opts.watch * 1000); });
  }
}

function state(area) {
  if (area.waiting) return 'waiting';
  if (area.working) return 'working';
  return 'idle';
}

export function render(report, columns = 100) {
  const areas = [...report.areas].sort((a, b) => (
    RANK[state(a)] - RANK[state(b)] || a.name.localeCompare(b.name)
  ));
  const waiting = areas.filter((area) => state(area) === 'waiting').length;
  const working = areas.filter((area) => state(area) === 'working').length;

  const out = [];
  const counts = [
    waiting ? `${waiting} waiting for you` : null,
    working ? `${working} working` : null,
    `${areas.length} in all`,
  ].filter(Boolean).join('  ·  ');
  out.push(`\n${workRoot()}${' '.repeat(Math.max(2, columns - workRoot().length - counts.length - 2))}${counts}\n`);

  for (const area of areas) {
    const mark = MARK[state(area)];
    const where = area.worktrees.length
      ? area.worktrees.map((worktree) => [
        worktree.repo,
        worktree.branch || '(detached)',
        worktree.uncommitted ? `${worktree.uncommitted} uncommitted` : null,
        worktree.unmerged_commits ? `${worktree.unmerged_commits} unmerged` : null,
      ].filter(Boolean).join('  ')).join('   ·   ')
      : 'no repository';
    out.push(`\n  ${mark} ${area.name.padEnd(26)} ${where}`);
    for (const item of area.conversations) {
      const head = `      ${item.state.padEnd(8)} ${item.tool === 'claude-code' ? 'claude' : item.tool}  ${item.id.slice(0, 8)}  ${describeAge(item.updated_ms).padEnd(9)}${describeSize(item.bytes).padStart(8)}`;
      out.push(head);
      // The last thing it said is the whole point of the page: it is what
      // tells you whether this one still needs you without opening it.
      if (item.said) {
        const room = Math.max(30, columns - 10);
        const said = item.said.length > room ? `${item.said.slice(0, room - 1)}…` : item.said;
        out.push(`         ${said}`);
      }
    }
  }
  out.push('');
  return `${out.join('\n')}\n`;
}

export function parseArgs(argv) {
  const opts = { json: false, watch: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--watch') {
      const next = argv[index + 1];
      if (next && /^\d+$/u.test(next)) { opts.watch = Number(next); index += 1; } else opts.watch = 5;
      continue;
    }
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  return opts;
}
