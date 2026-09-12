/**
 * `mc step` — where a step stands, said by the one who knows.
 *
 *   mc step                                  this session's step, from MC_STEP
 *   mc step <project>                        every step of a project
 *   mc step failed [<project> <n>] --reason "…"     the session gave up
 *   mc step blocked [<project> <n>] --on <decision> [--reason "…"]
 *   mc step ready <project> <n> [--reason "…"]      a person starts it again
 *   mc step done <project> <n> [--pr <n>]           landed by hand
 *
 * State lives in the register (`register.js`), not in the plan on main, so
 * a transition is one write here and never a pull request. A step session
 * knows which step it is from `MC_STEP=<project>:<index>` in its environment
 * (set by `mc run`), and a person names the project and the step number.
 *
 * `ready` is refused while the step's pull request is still open: the way
 * back from a failed step is to land or close that pull request first, and
 * a step set ready over an open one would be run again on top of it.
 */
import { spawnSync } from 'node:child_process';

import { currentIndex, listEntries, parseStepEnv, readEntry, updateStep } from '../register.js';
import { workRoot } from '../paths.js';
import { defaultRepos } from '../brief-collect.js';
import { scanArgs } from './flags.js';

const STATES = new Set(['failed', 'blocked', 'ready', 'done']);

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const now = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const io = { read: deps.read, write: deps.write, lock: deps.lock };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];

  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--reason', '--on', '--pr'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;

  // A reading, not a change.
  if (!positional.length || !STATES.has(positional[0])) {
    const target = positional[0] ? { project: positional[0], index: null } : parseStepEnv(env.MC_STEP);
    if (!target) { stderr.write('mc: which project? mc step <project>, or MC_STEP in a runner session\n'); return 2; }
    const entry = readEntry(root, target.project, io);
    if (!entry) { stderr.write(`mc: ${target.project} is not in the register — nothing on main has been read into it yet\n`); return 1; }
    if (flags.json) { stdout.write(`${JSON.stringify(entry, null, 2)}\n`); return 0; }
    for (const line of entryLines(entry, target.index)) stdout.write(`${line}\n`);
    return 0;
  }

  const [status, ...rest] = positional;
  const target = resolveTarget(rest, env);
  if (!target) { stderr.write('mc: which step? mc step <status> <project> <n>, or MC_STEP in a runner session\n'); return 2; }
  const entry = readEntry(root, target.project, io);
  if (!entry) { stderr.write(`mc: ${target.project} is not in the register\n`); return 1; }
  const index = target.index ?? currentIndex(entry);
  if (index < 0 || index >= entry.steps.length) { stderr.write(`mc: ${target.project} has no step ${index + 1}\n`); return 2; }
  const step = entry.steps[index];

  const patch = { status };
  if (status === 'failed') {
    if (!flags.reason) { stderr.write('mc: a failed step says why — --reason "…"\n'); return 2; }
    patch.reason = flags.reason;
    patch.comment = `Failed on ${now}: ${flags.reason}`;
  }
  if (status === 'blocked') {
    if (!flags.on) { stderr.write('mc: a blocked step names what it waits for — --on <decision-or-project>\n'); return 2; }
    patch.blocked_by = { kind: /^[a-z0-9][a-z0-9-]*$/u.test(flags.on) ? 'decision' : 'decision', name: flags.on };
    patch.reason = flags.reason || null;
    if (flags.reason) patch.comment = `Blocked on ${now}: ${flags.reason}`;
  }
  if (status === 'ready') {
    if (step.pr && (deps.prState || prState)(entry.repo, step.pr, env) === 'OPEN') {
      stderr.write(`mc: #${step.pr} is still open — land it or close it first; a step set ready over an open pull request is run again on top of it\n`);
      return 1;
    }
    patch.reason = null;
    patch.pr = null;
    if (flags.reason) patch.comment = `Set ready on ${now}: ${flags.reason}`;
  }
  if (status === 'done') {
    patch.pr = flags.pr ? Number(flags.pr) : step.pr;
    patch.reason = null;
  }
  try {
    const next = updateStep({ root, project: target.project, index, patch, now, ...io });
    stdout.write(`mc: ${target.project} step ${index + 1} — ${step.status} → ${next.steps[index].status}\n`);
    return 0;
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
}

/** `<project> <n>` from the line, or the session's own step from MC_STEP. */
function resolveTarget(rest, env) {
  if (rest.length >= 1) {
    const index = rest[1] != null ? Number(rest[1]) - 1 : null;
    if (rest[1] != null && !(Number.isInteger(index) && index >= 0)) return null;
    return { project: rest[0], index };
  }
  return parseStepEnv(env.MC_STEP);
}

/** What GitHub says of a pull request: OPEN, MERGED, CLOSED — or null when it cannot be asked. */
function prState(repo, pr, env) {
  const path = defaultRepos(env).find((item) => item.name === repo)?.path;
  if (!path) return null;
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'state', '-q', '.state'], { cwd: path, encoding: 'utf8', env });
  return r.status === 0 ? String(r.stdout || '').trim() || null : null;
}

const MARK = { done: '✓', ready: '▸', running: '●', failed: '✗', blocked: '■' };

function entryLines(entry, only = null) {
  const lines = [`${entry.project} — ${[entry.repo, entry.programme].filter(Boolean).join(' · ')}${entry.plan ? ` · ${entry.plan}` : ''}`];
  entry.steps.forEach((step, index) => {
    if (only != null && index !== only) return;
    const bits = [];
    if (step.pr) bits.push(`#${step.pr}`);
    if (step.branch) bits.push(step.branch);
    if (step.status === 'blocked' && step.blocked_by) bits.push(`on ${step.blocked_by.kind} ${step.blocked_by.name}`);
    if (step.status === 'running' && step.session?.pid) bits.push(`pid ${step.session.pid} since ${step.session.started || '?'}`);
    if (step.attempts) bits.push(`${step.attempts} merge attempt${step.attempts === 1 ? '' : 's'}`);
    lines.push(`  ${MARK[step.status] || '·'} ${String(index + 1).padStart(2)}  ${step.status.padEnd(8)} ${bits.join(' · ')}`);
    if (step.reason) lines.push(`        ${step.reason}`);
  });
  return lines;
}

export function listAll(root, io = {}) {
  return listEntries(root, io);
}

export function usage() {
  return [
    'usage — mc step                                   this session\'s step (MC_STEP)\n',
    '        mc step <project> [--json]                 every step of a project\n',
    '        mc step failed [<project> <n>] --reason "…"\n',
    '        mc step blocked [<project> <n>] --on <name> [--reason "…"]\n',
    '        mc step ready <project> <n> [--reason "…"]\n',
    '        mc step done <project> <n> [--pr <n>]\n',
  ].join('');
}
