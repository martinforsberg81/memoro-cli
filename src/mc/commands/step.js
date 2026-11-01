/**
 * `mc step` — where a step stands, said by the one who knows.
 *
 *   mc step                                  this session's step, from MC_STEP
 *   mc step <project>                        every step of a project
 *   mc step failed [<project> <n>] --reason "…"     the session gave up
 *   mc step blocked [<project> <n>] --on <decision> | --on-project <project> [--reason "…"]
 *   mc step blocked [<project> <n>] --until <iso> | --after-deploy [<m>] [--hours <h>] [--reason "…"]
 *   mc step note [<project> <n>] "…"                a paragraph for the next reader
 *   mc step ready <project> <n> [--answer "…"]      a person starts it again (--reason is the same)
 *   mc step done <project> <n> [--pr <n>]           landed by hand
 *
 * State lives in the register (`register.js`), not in the plan on main, so
 * a transition is one write here and never a pull request. A step session
 * knows which step it is from `MC_STEP=<project>:<index>` in its environment
 * (set by `mc run`), and a person names the project and the step number.
 *
 * `ready` is refused while the step's pull request is still open: the way
 * back from a failed step is to land or close that pull request first, and
 * a step set ready over an open one would be run again on top of it. A
 * `blocked` step is the exception: it was parked on a question, and its one
 * open pull request that changes files is the work to go on from. It is
 * written on the step with the answer (`answered`), and the runner goes back
 * to its branch as for a step the merger sent back. An open
 * pull request on the step's branch that changes no file — a blocked
 * session's placeholder for its question — is closed instead: the runner
 * starts nothing while a project has one open, so it held settings-polish
 * step 6 twice after its decision was ruled (#13442, #13599). One that does
 * change files is refused by number. A step that has landed is refused too:
 * it is done, and `mc step done` says so.
 *
 * `--until` and `--after-deploy` (ruling 35) block a step on a wait the
 * runner releases by itself (`step-release.js`): a moment, or an earlier
 * step's deploy plus `--hours`. Only memoro deploys, so `--after-deploy` is
 * refused for a step in any other repository. In a plan with a review step (the
 * branch flow) `--after-deploy` is refused too: such a plan lands once, at its review.
 */
import { spawnSync } from 'node:child_process';

import { run as runGit } from '../git.js';
import { currentIndex, listEntries, parseStepEnv, readEntry, updateStep } from '../register.js';
import { workRoot } from '../paths.js';
import { defaultRepos, listPlans } from '../brief-collect.js';
import { branchFlow, NAME_RE, readPlanText } from '../plan-schema.js';
import { findPlan } from '../plan-source.js';
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
  const scanned = scanArgs(args, { booleans: ['--json'], strictValues: ['--reason', '--answer', '--on', '--on-project', '--pr', '--until', '--hours'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  // `--answer` is `--reason` for a step set ready: the words a person gives the
  // question the step was parked on.
  const answer = flags.answer ?? flags.reason ?? null;

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
  if (flags.answer != null && status !== 'ready') { stderr.write('mc: --answer goes with mc step ready\n'); return 2; }
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
  if (status === 'blocked' && afterDeploy && branchFlow((deps.planOf || planOf)(env, target.project))) {
    stderr.write('mc: a plan with a review step lands once, at its end — a check that needs the deploy is not a criterion here; leave it out of this plan\n');
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
    if (step.landed) {
      const sha7 = String(step.landed.sha || '?').slice(0, 7);
      stderr.write(`mc: ${target.project} step ${index + 1} landed as ${sha7} into ${step.landed.into || 'main'}${step.landed.at ? ` on ${step.landed.at}` : ''} — it is done, not ready: mc step done ${target.project} ${index + 1}. Work it left undone is a new step in the plan.\n`);
      return 1;
    }
    // A step parked on a question keeps the work its session left: the one
    // open pull request on its branch is written on the step, and the runner
    // goes back to that branch (`placeBranch`) with the answer in the prompt.
    // Refusing here left note-window step 5 parked behind its own #13931,
    // which nobody was working on (2026-10-20).
    const parked = step.status === 'blocked';
    const blocker = step.blocked_by;
    const onDecision = parked && blocker?.kind === 'decision';
    const pinnedOpen = step.pr ? (deps.prState || prState)(entry.repo, step.pr, env) === 'OPEN' : false;
    if (pinnedOpen && !parked) {
      stderr.write(`mc: #${step.pr} is still open — land it or close it first; a step set ready over an open pull request is run again on top of it\n`);
      return 1;
    }
    const held = step.branch ? (deps.branchPrs || branchPrs)(entry.repo, step.branch, env) : [];
    const working = held.filter((pr) => pr.changedFiles !== 0);
    const kept = parked
      ? (pinnedOpen ? [{ number: step.pr }] : working.length === 1 ? working : [])
      : [];
    if (kept.length) {
      patch.status = 'ready';
      patch.pr = Number(kept[0].number);
      patch.reason = null;
      patch.answered = { name: step.blocked_by?.name || null, answer: answer || null, at: now };
      if (answer) patch.comment = `Set ready on ${now}: ${answer}`;
      stdout.write(`mc: #${patch.pr} stays open on ${step.branch || 'its branch'} — the next session goes on from it\n`);
    } else if (working.length) {
      stderr.write(`mc: ${working.map((pr) => `#${pr.number}`).join(', ')} on ${step.branch} ${working.length === 1 ? 'is' : 'are'} open and change${working.length === 1 ? 's' : ''} files — land or close ${working.length === 1 ? 'it' : 'them'} first\n`);
      return 1;
    }
    for (const pr of held.filter((p) => p.changedFiles === 0)) {
      const why = kept.length
        ? `Closed by mc step ready: ${target.project} step ${index + 1} goes on from #${patch.pr}, and this pull request changes no file.`
        : `Closed by mc step ready: ${target.project} step ${index + 1} starts again from main, and this pull request changes no file.`;
      if (!(deps.closePr || closePr)(entry.repo, pr.number, step.branch, why, env)) {
        stderr.write(`mc: #${pr.number} on ${step.branch} changes no file but could not be closed — close it, then mc step ready again\n`);
        return 1;
      }
      stdout.write(`mc: closed #${pr.number} — it changed no file, and an open pull request keeps the runner from starting the step\n`);
    }
    if (!kept.length) {
      patch.reason = null;
      patch.pr = null;
      // A step parked on a decision keeps the answer even with no pull request:
      // the next session is handed it (`answeredPreamble`). `ready` does not
      // clear it (register.js `patchStep`).
      patch.answered = onDecision ? { name: blocker.name || null, answer: answer || null, at: now } : null;
      if (answer) patch.comment = `Set ready on ${now}: ${answer}`;
    }
    if (onDecision && !answer) stderr.write(`mc: ${target.project} step ${index + 1} was parked on the decision ${blocker.name} and no --answer was given — the next session starts without it\n`);
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

/**
 * The parsed plan `mc project` holds for a project under `~/mc/programs/`, or
 * null: found by the project's name, as `findPlan` finds a project's plan.
 */
function planOf(env, project) {
  const held = findPlan(defaultRepos(env), project);
  return held ? readPlanText(held.text).plan : null;
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
      && runGit(path, ['merge-base', '--is-ancestor', sha, rowSha], { stdio: 'ignore' }).status === 0),
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

/** The open pull requests on a branch, each with how many files it changes; [] when gh cannot say. */
function branchPrs(repo, branch, env) {
  const path = defaultRepos(env).find((item) => item.name === repo)?.path;
  if (!path) return [];
  const r = spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,changedFiles'], { cwd: path, encoding: 'utf8', env });
  if (r.status !== 0) return [];
  try { return JSON.parse(r.stdout || '[]'); } catch { return []; }
}

/** Close a pull request and delete its branch; true when the close went through. */
function closePr(repo, pr, branch, comment, env) {
  const path = defaultRepos(env).find((item) => item.name === repo)?.path;
  if (!path) return false;
  const closed = spawnSync('gh', ['pr', 'close', String(pr), '--comment', comment], { cwd: path, encoding: 'utf8', env });
  if (closed.status !== 0) return false;
  runGit(path, ['push', '--quiet', 'origin', '--delete', branch], { env });
  return true;
}

const MARK = { done: '✓', ready: '▸', running: '●', failed: '✗', blocked: '■' };

/** A `ready` step's interrupted record, as one line (ruling 33). */
function interruptedLine(record, nowMs) {
  const id = record.session_id ? String(record.session_id).slice(0, 8) : '?';
  const tokens = record.context_tokens == null ? '?' : String(record.context_tokens);
  return `interrupted ${record.at || '?'} · ${record.tool || '?'} session ${id}${record.billing === 'credits' ? ' on credits' : ''} · last activity ${ago(record.last_activity, nowMs)} · ${tokens} tokens`;
}

/** A `ready` step's answer, as one line: its first line, cut to 80 characters. */
function answeredLine(answered) {
  const first = answered.answer ? String(answered.answer).split('\n')[0] : '(no answer given)';
  const cut = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return `answered ${answered.name || 'a decision'}: ${cut}`;
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
    if (step.status === 'running' && step.session?.billing === 'credits') bits.push('on credits');
    if (step.status === 'ready' && step.interrupted) bits.push(interruptedLine(step.interrupted, nowMs));
    if (step.status === 'ready' && step.answered) bits.push(answeredLine(step.answered));
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
    '        mc step ready <project> <n> [--answer "…"]\n',
    '        mc step done <project> <n> [--pr <n>]\n',
  ].join('');
}
