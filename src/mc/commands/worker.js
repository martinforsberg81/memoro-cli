/**
 * `mc worker <name>` — a project folder that carries the worker role.
 *
 * The role is decided here, at creation, and sits on the area: every
 * conversation started inside — lead or agent, now or later, through
 * `mc work <name> new` or `--tmux` — inherits the worker overlay and the
 * role's model default. Inside the area it is ordinary `mc work` mechanics
 * all the way down; the only thing this command adds is the mark.
 *
 * Two refusals, both about identity:
 *
 * An existing ordinary area cannot become a worker. Its conversations were
 * started without the overlay, and a mark added afterwards would make the
 * area's future conversations disagree with its past ones about what they
 * are. A role area is born one, or it is not one.
 *
 * A worker without its definition does not get created. The area would look
 * like a role workspace and deliver none of the role, which is worse than
 * the command failing while everything is still reversible.
 */
import { createWorkArea, inspectWorkArea } from '../work-area.js';
import { workRoot } from '../paths.js';
import {
  markAreaRole, areaRoleName, canonRolesDir, readCanonRole, reservedRoleHint, reservedRoleName,
} from '../roles.js';
import { openArea } from './work.js';
import { scanArgs } from './flags.js';

const NAME = /^[A-Za-z0-9._-]{1,64}$/u;

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.name) {
    stderr.write(`mc: ${opts.error || 'which worker? mc worker <name>'}\n`);
    stderr.write('usage — mc worker <name> [task] [--model <model>] [--tmux] [--codex|--claude]\n');
    return 2;
  }
  if (reservedRoleName(opts.name)) {
    stderr.write(`mc: ${reservedRoleHint(opts.name)}\n`);
    return 1;
  }

  const area = inspectWorkArea(opts.name);
  const existingRole = area.exists ? areaRoleName(area.path) : null;
  if (area.exists && !existingRole) {
    stderr.write(`mc: ${opts.name} already exists as an ordinary area — a role is decided at creation, not acquired\n`);
    stderr.write(`mc: open it with mc work ${opts.name}, or pick a new name\n`);
    return 1;
  }
  if (existingRole && existingRole !== 'worker') {
    stderr.write(`mc: ${opts.name} carries the role "${existingRole}", not worker\n`);
    return 1;
  }

  // The definition is a creation requirement, not an opening one: an
  // existing worker area still opens when the role file has been mislaid —
  // openArea warns about the missing overlay — because blocking real work
  // over a mislaid file helps nobody. What must not happen is *creating* a
  // role area that delivers no role.
  //
  // It comes from `canon/roles/worker.md` in the package, the way `mc plan`
  // and `mc brief` read theirs. It used to come from the user's catalogue,
  // and that made the one role mc still launches depend on a directory mc
  // does not ship: a fresh machine got the area and none of the role. The
  // catalogue still wins where it defines `worker` — `areaRole` reads it
  // first — but it is no longer required for one to exist.
  if (!area.exists) {
    const role = readCanonRole('worker');
    if (!role || !role.overlay) {
      stderr.write(`mc: the worker role is missing from this install — expected ${canonRolesDir()}/worker.md with an overlay body\n`);
      stderr.write('mc: a worker area without its overlay would be an ordinary area wearing the name\n');
      return 1;
    }
    const path = createWorkArea(opts.name);
    markAreaRole(path, 'worker');
    stdout.write(`mc: ${path} — a worker area (role from ${role.path})\n`);
    stdout.write(`mc: add a repository with  mc work add ${opts.name} <repo>\n`);
  }

  // From here it is a piece of work like any other; the mark does the rest.
  if (opts.task && !opts.tmux) {
    stderr.write('mc: the task is used when starting detached (--tmux); opening interactively — say it to the tool instead\n');
  }
  return openArea(opts.name, opts, { stdout, stderr });
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--tmux'],
    strictValues: ['--model'],
    toolSugar: true,
  });
  const opts = {
    name: null, task: null, model: scanned.flags.model, tool: scanned.flags.tool,
    tmux: scanned.flags.tmux, pick: null,
  };
  if (scanned.error) return { ...opts, error: scanned.error };
  const { positional } = scanned;
  if (positional.length === 0) return opts;
  const [head, ...rest] = positional;
  if (!NAME.test(head)) return { ...opts, error: `"${head}" cannot be a directory name` };
  opts.name = head;
  // The rest of the line is the task, exactly as `mc work <name> --tmux`
  // reads it. Without --tmux the tool opens interactively and the task is
  // said there instead; `new` keeps its `mc work` meaning.
  if (rest[0] === 'new' && !opts.tmux) opts.pick = 'new';
  else if (rest.length) opts.task = rest.join(' ');
  return opts;
}
