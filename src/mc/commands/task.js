/**
 * `mc task` — the tracked orders (designnote §6, D-0113).
 *
 *   mc task list [<session>] [--json]
 *   mc task done <id>
 *   mc task block <id> "<reason>"
 *
 * Creation is not here: a task is opened by `mc work send <name> "…" --task`,
 * in the same action as the order it tracks. This is where a task is read
 * and where its two possible movements happen. `<id>` takes any prefix that
 * matches exactly one task, the same rule `mc work --resume` uses for a
 * conversation id.
 */
import { describeAge } from '../conversations.js';
import {
  blockTask, listOpenTasks, markTaskDone, openTasks,
} from '../task-log.js';
import { scanArgs } from './flags.js';

const VERBS = ['list', 'done', 'block'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }

  if (opts.verb === 'list') return list(opts, { stdout });

  if (opts.verb === 'done') {
    const outcome = markTaskDone(opts.id);
    if (!outcome.ok) return lookupFailed(outcome, opts.id, stderr);
    if (outcome.already) {
      stdout.write(`mc: ${short(outcome.task.id)} was already done\n`);
      return 0;
    }
    stdout.write(`mc: ${short(outcome.task.id)} done — ${outcome.task.session}\n`);
    return 0;
  }

  const outcome = blockTask(opts.id, opts.reason);
  if (!outcome.ok) {
    if (outcome.reason === 'already-done') {
      stderr.write(`mc: ${opts.id} is already done — nothing left to block\n`);
      return 1;
    }
    return lookupFailed(outcome, opts.id, stderr);
  }
  stdout.write(`mc: ${short(outcome.task.id)} blocked — ${outcome.task.session} — ${outcome.task.reason}\n`);
  return 0;
}

function list(opts, { stdout }) {
  const tasks = (opts.session ? openTasks(opts.session) : listOpenTasks())
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));

  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: true, tasks: tasks.map(withAge) }, null, 2)}\n`);
    return 0;
  }
  if (tasks.length === 0) {
    stdout.write(opts.session ? `mc: no open tasks for ${opts.session}\n` : 'mc: no open tasks anywhere\n');
    return 0;
  }
  const showSession = !opts.session;
  for (const task of tasks) stdout.write(`${row(task, { showSession })}\n`);
  return 0;
}

/** The age a script would want — a plain number of milliseconds since the last line for this id. */
function withAge(task, now = Date.now()) {
  return { ...task, age_ms: Math.max(0, now - Date.parse(task.updated_at)) };
}

function row(task, { showSession, now = Date.now() } = {}) {
  const age = describeAge(Date.parse(task.updated_at), now);
  const head = showSession ? `${task.session.padEnd(18)} ${short(task.id)}` : short(task.id);
  const detail = task.state === 'blocked' && task.reason ? `${task.reason} — ${task.text}` : task.text;
  return `${head}  ${task.state.padEnd(7)} ${age.padEnd(10)} ${detail}`;
}

function short(id) {
  return id.slice(0, 8);
}

function lookupFailed(outcome, id, stderr) {
  if (outcome.reason === 'ambiguous') {
    stderr.write(`mc: "${id}" matches more than one task — be more specific:\n`);
    for (const task of outcome.matches) stderr.write(`      ${task.id}  ${task.session}\n`);
    return 1;
  }
  stderr.write(`mc: no task called "${id}" — mc task list finds them\n`);
  return 1;
}

function usage() {
  return [
    'usage — mc task list [<session>] [--json]\n',
    '        mc task done <id>\n',
    '        mc task block <id> "<reason>"\n',
  ].join('');
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json'] });
  const opts = {
    verb: 'list', session: null, id: null, reason: '', json: scanned.flags.json,
  };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];
  if (VERBS.includes(positional[0])) opts.verb = positional.shift();

  if (opts.verb === 'list') {
    opts.session = positional.shift() || null;
    if (positional.length) return { ...opts, error: `mc task list takes one session (${positional[0]})` };
    return opts;
  }

  opts.id = positional.shift() || null;
  if (!opts.id) return { ...opts, error: `which task? mc task ${opts.verb} <id>` };

  if (opts.verb === 'block') {
    opts.reason = positional.join(' ');
    if (!opts.reason) {
      return { ...opts, error: 'what is it blocked on? mc task block <id> "<reason>" — the reason is what makes it readable' };
    }
    return opts;
  }

  if (positional.length) return { ...opts, error: `mc task done takes one task (${positional[0]})` };
  return opts;
}
