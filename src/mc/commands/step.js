/**
 * `mc step` — where a step stands, said by the one who knows.
 *
 *   mc step                                  this session's step, from MC_STEP
 *   mc step <project>                        every step of a project
 *   mc step failed [<project> <n>] --reason "…"     the session gave up
 *   mc step blocked [<project> <n>] --on <decision> | --on-project <project> [--reason "…"]
 *   mc step blocked [<project> <n>] --until <iso> | --after-deploy [<m>] [--hours <h>] [--reason "…"]
 *   mc step note [<project> <n>] "…"                a paragraph for the next reader
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
 *
 * `--until` and `--after-deploy` (ruling 35) block a step on a wait the
 * runner releases by itself (`step-release.js`): a moment, or an earlier
 * step's deploy plus `--hours`. Only memoro deploys, so `--after-deploy` is
 * refused for a step in any other repository.
 */
import { spawnSync } from 'node:child_process';

import { currentIndex, listEntries, parseStepEnv, readEntry, updateStep } from '../register.js';
import { workRoot } from '../paths.js';
import { defaultRepos, listPlans } from '../brief-collect.js';
import { NAME_RE } from '../plan-schema.js';
import { readDeploys } from '../deploys.js';
import { ago, describeWait } from '../step-release.js';
import { scanArgs } from './flags.js';

const STATES = new Set(['failed', 'blocked', 'ready', 'done', 'note']);

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const now = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const io = { read: deps.read, write: deps.write, lock: deps.lock };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];

  // `--after-deploy` takes a step number when one follows it, and none
  // otherwise: the step before is the default.
  const args = [...argv];
  let afterDeploy = null;
  const at = args.indexOf('--after-deploy');
  if (at >= 0) {
    afterDeploy = /^\d+$/u.test(args[at + 1] || '') ? Number(args[at + 1]) : 'previous';
    args.splice(at, afterDeploy === 'previous' ? 1 : 2);
  }
  const scanned = scanArgs(args, { booleans: ['--json'], strictValues: ['--reason', '--on', '--on-project', '--pr', '--until', '--hours'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;

  // A reading, not a change.
  if (!positional.length || !STATES.has(positional[0])) {
    const target = positional[0] ? { project: positional[0], index: null } : parseStepEnv(env.MC_STEP);
    if (!target) { stderr.write('mc: which project? mc step <project>, or MC_STEP in a runner session\n'); return 2; }
    const entry = readEntry(root, target.project, io);
    if (!entry) { stderr.write(`mc: ${target.project} is not in the register — nothing on main has been read into it yet\n`); return 1; }
    if (flags.json) { stdout.write(`${JSON.stringify(entry, null, 2)}\n`); return 0; }
    const context = entry.steps.some(waitsByItself) ? waitContext(entry, Date.parse(now), deps, env) : null;
    for (const line of entryLines(entry, target.index, Date.parse(now), context)) stdout.write(`${line}\n`);
    return 0;
  }

  const [status, ...line] = positional;
  // A note's text is the last word on the line; the rest names the step.
  const note = status === 'note' ? line.pop() : null;
  if (status === 'note' && !(note && note.trim()) ) { stderr.write('mc: a note says something — mc step note [<project> <n>] "…"\n'); return 2; }
  const rest = line;
  const target = resolveTarget(rest, env);
  if (!target) { stderr.write('mc: which step? mc step <status> <project> <n>, or MC_STEP in a runner session\n'); return 2; }
  const entry = readEntry(root, target.project, io);
  if (!entry) { stderr.write(`mc: ${target.project} is not in the register\n`); return 1; }
  const index = target.index ?? currentIndex(entry);
  if (index < 0 || index >= entry.steps.length) { stderr.write(`mc: ${target.project} has no step ${index + 1}\n`); return 2; }
  const step = entry.steps[index];

  const patch = status === 'note' ? { comment: note.trim() } : { status };
  if (status === 'failed') {
    if (!flags.reason) { stderr.write('mc: a failed step says why — --reason "…"\n'); return 2; }
    patch.reason = flags.reason;
    patch.comment = `Failed on ${now}: ${flags.reason}`;
  }
  if (status !== 'blocked' && (flags.until || afterDeploy || flags.hours)) {
    stderr.write('mc: --until, --after-deploy and --hours block a step — mc step blocked\n');
    return 2;
  }
  if (status === 'blocked' && (flags.until || afterDeploy)) {
    const blocker = waitBlocker({ flags, afterDeploy, index, repo: entry.repo, nowMs: Date.parse(now) });
    if (blocker.error) { stderr.write(`mc: ${blocker.error}\n`); return 2; }
    patch.blocked_by = blocker;
    patch.reason = flags.reason || null;
    if (flags.reason) patch.comment = `Blocked on ${now}: ${flags.reason}`;
  } else if (status === 'blocked') {
    const name = flags.on || flags['on-project'];
    if (!name || (flags.on && flags['on-project']) || flags.hours) { stderr.write('mc: a blocked step names the one thing it waits for — --on <decision>, --on-project <project>, --until <iso> or --after-deploy [<n>]\n'); return 2; }
    // The same shape the plan schema holds a blocker's name to: a sentence
    // here made the page call the whole plan unparseable (2026-09-18).
    if (!NAME_RE.test(name)) { stderr.write(`mc: "${name}" is not a name — lower-case letters, digits and hyphens; what it waits for in more words goes in --reason\n`); return 2; }
    if (flags['on-project']) {
      const known = (deps.projects || projectsOnMain)(env);
      if (known && !known.includes(name)) { stderr.write(`mc: no project ${name} has a plan on main — a step blocked on it would wait for ever\n`); return 1; }
    }
    patch.blocked_by = { kind: flags.on ? 'decision' : 'project', name };
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
    stdout.write(status === 'note'
      ? `mc: ${target.project} step ${index + 1} — noted\n`
      : `mc: ${target.project} step ${index + 1} — ${step.status} → ${next.steps[index].status}\n`);
    return 0;
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
}

/**
 * The `time` or `deploy` blocker `--until` or `--after-deploy` asks for, or
 * `{ error }`. Exactly one of the four blocking flags is given. The name is
 * made from the fields, because a name is lower-case with no colons
 * (`NAME_RE`): `until-20261014-0800`, `deploy-step-3-24h`.
 */
function waitBlocker({ flags, afterDeploy, index, repo, nowMs }) {
  const given = [flags.on, flags['on-project'], flags.until, afterDeploy].filter(Boolean).length;
  if (given !== 1) return { error: 'a blocked step waits for one thing — one of --on, --on-project, --until or --after-deploy' };
  if (flags.until) {
    if (flags.hours) return { error: '--hours goes with --after-deploy' };
    const at = Date.parse(flags.until);
    if (!Number.isFinite(at)) return { error: `"${flags.until}" is not a time — --until takes an ISO instant, like 2026-10-14T08:00Z` };
    if (at <= nowMs) return { error: `${flags.until} has passed — a step blocked until then would be released at once` };
    const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    return { kind: 'time', name: `until-${iso.slice(0, 10).replace(/-/gu, '')}-${iso.slice(11, 16).replace(':', '')}`, at: iso };
  }
  if (repo !== 'memoro') return { error: `${repo || 'this repository'} has no deploy — mc deploy deploys memoro` };
  const step = afterDeploy === 'previous' ? index : afterDeploy;
  if (!(Number.isInteger(step) && step >= 1 && step < index + 1)) {
    return { error: `--after-deploy waits on a step before this one (step ${index + 1})${step === 0 && afterDeploy === 'previous' ? ', and the first step has none' : ''}` };
  }
  const blocker = { kind: 'deploy', name: `deploy-step-${step}`, step, hours: 0 };
  if (flags.hours != null) {
    const hours = Number(flags.hours);
    if (!(flags.hours.trim() && Number.isFinite(hours) && hours >= 0)) return { error: `--hours ${flags.hours} — a number of 0 or more` };
    blocker.hours = hours;
    if (hours) blocker.name = `deploy-step-${step}-${String(hours).replace('.', '-')}h`;
  }
  return blocker;
}

/** A wait the runner releases by itself, and `describeWait` can say the time of. */
function waitsByItself(step) {
  return step.status === 'blocked' && (step.blocked_by?.kind === 'time' || step.blocked_by?.kind === 'deploy');
}

/**
 * What `describeWait` needs for this project: the clock, its register steps,
 * the deploy log, and whether a landed sha is in a deployed one — asked of
 * the repository's checkout.
 */
function waitContext(entry, nowMs, deps, env) {
  const path = defaultRepos(env).find((item) => item.name === entry.repo)?.path;
  return {
    now: new Date(nowMs),
    stepsOf: () => entry.steps,
    deploys: deps.deploys ? deps.deploys() : readDeploys(env),
    contains: deps.contains || ((sha, rowSha) => !!path
      && spawnSync('git', ['merge-base', '--is-ancestor', sha, rowSha], { cwd: path, stdio: 'ignore' }).status === 0),
  };
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

/** Every project with a plan on a repo's main, or null when none could be read. */
function projectsOnMain(env) {
  const names = defaultRepos(env).flatMap((repo) => { try { return listPlans(repo).map((plan) => plan.project); } catch { return []; } });
  return names.length ? names : null;
}

/** What GitHub says of a pull request: OPEN, MERGED, CLOSED — or null when it cannot be asked. */
function prState(repo, pr, env) {
  const path = defaultRepos(env).find((item) => item.name === repo)?.path;
  if (!path) return null;
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'state', '-q', '.state'], { cwd: path, encoding: 'utf8', env });
  return r.status === 0 ? String(r.stdout || '').trim() || null : null;
}

const MARK = { done: '✓', ready: '▸', running: '●', failed: '✗', blocked: '■' };

/** A `ready` step's interrupted record, as one line (ruling 33). */
function interruptedLine(record, nowMs) {
  const id = record.session_id ? String(record.session_id).slice(0, 8) : '?';
  const tokens = record.context_tokens == null ? '?' : String(record.context_tokens);
  return `interrupted ${record.at || '?'} · ${record.tool || '?'} session ${id} · last activity ${ago(record.last_activity, nowMs)} · ${tokens} tokens`;
}

function entryLines(entry, only = null, nowMs = Date.now(), context = null) {
  const lines = [`${entry.project} — ${[entry.repo, entry.programme].filter(Boolean).join(' · ')}${entry.plan ? ` · ${entry.plan}` : ''}`];
  entry.steps.forEach((step, index) => {
    if (only != null && index !== only) return;
    const bits = [];
    if (step.pr) bits.push(`#${step.pr}`);
    if (step.branch) bits.push(step.branch);
    if (step.status === 'blocked' && step.blocked_by) {
      bits.push(context && waitsByItself(step) ? describeWait(step, context) : `on ${step.blocked_by.kind} ${step.blocked_by.name}`);
    }
    if (step.status === 'running' && step.session?.pid) bits.push(`pid ${step.session.pid} since ${step.session.started || '?'}`);
    if (step.status === 'ready' && step.interrupted) bits.push(interruptedLine(step.interrupted, nowMs));
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
    '        mc step blocked [<project> <n>] --on <decision> | --on-project <project> [--reason "…"]\n',
    '        mc step blocked [<project> <n>] --until <iso> | --after-deploy [<m>] [--hours <h>] [--reason "…"]\n',
    '        mc step note [<project> <n>] "…"\n',
    '        mc step ready <project> <n> [--reason "…"]\n',
    '        mc step done <project> <n> [--pr <n>]\n',
  ].join('');
}
