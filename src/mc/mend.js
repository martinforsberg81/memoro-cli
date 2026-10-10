/**
 * The mend — one short session for a red the change itself caused, before
 * anyone is told it is red (ruling 37).
 *
 * Until then every red answer went to `markRed` and, for a step, through
 * `redPatch` to the step's next session (ruling 30): a whole step session,
 * started from the plan, for what was often one conflicting file or one test
 * the change broke. Now such a red is set aside as `mending` (merge-queue.js)
 * so the lane goes on, and a session of its own — role `mend`, in a worktree
 * of its own on the branch — gets one try at it. A push puts the job back in
 * line at its old place and a full round measures it like any other job;
 * anything else is red as before, with what the mend said.
 *
 * The mend never merges, never force-pushes, never touches `main` and edits
 * no `PLAN.json`: the role says so, and the merger measures whatever it
 * pushed by the same round.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import { runTool } from './child-async.js';
import { profileArgs } from './portrait.js';
import { readEntry } from './register.js';
import { instructionsFor, readCanonRole } from './roles.js';
import { headlessArgs, readSessionOutput, sessionResult, TIMEOUT_EXIT } from './run-plan.js';

/**
 * The stops where the fault is in the change: it conflicts with main, its
 * tests or the gates it reaches are red, it changes what is derived outside
 * its own files, or its project-log row is wrong. Everything else — `fetch`,
 * `pr`, `killed`, `threw`, `busy`, `drift`, the deploy wait — is the machine's,
 * and a session on the branch cannot fix it.
 */
export const MEND_STOPS = Object.freeze([
  'merge', 'restack', 'red', 'selected-gate', 'pr-tests', 'extra-gate', 'derived-outside', 'project-log',
]);

/**
 * Mend sessions running at once. An 8 GB M1 already runs a memoro suite of
 * seven lanes; a second session with its own suite beside it is what makes
 * the round's own timings lie.
 */
export const MEND_AT_ONCE = 1;

/**
 * A mend's wall clock. Rounds were 3-15 min (2026-10-09/10), and a mend that
 * takes longer than a step session is the step's work, not a mend.
 */
export const MEND_MINUTES = 20;

export const MEND_ROLE = 'mend';

/** Round lines from `merger.log` the prompt carries for the job. */
const LOG_LINES = 40;

/**
 * Whether this red gets its one mend: a stop in `MEND_STOPS`, on a job that
 * has a branch and has not been mended. A `red` whose every red file is red
 * on main too is main's, not the branch's to fix.
 */
export function mayMend(job, report) {
  if (!job?.branch || job.mended) return false;
  if (!report || report.ok || !MEND_STOPS.includes(report.stopped_at)) return false;
  if (report.stopped_at === 'red') {
    const red = redFilesOf(report);
    const onMain = new Set(report.main_red?.red_on_main || []);
    if (red.length && red.every((file) => onMain.has(file))) return false;
  }
  return true;
}

/** The red files the round named: on the report, or on its candidate. */
export function redFilesOf(report) {
  return [...new Set([...(report?.red_files || []), ...(report?.candidate?.red_files || [])])];
}

/** The paths a conflict names: git's `Merge conflict in <path>`, and the restack's `conflicts in a b —`. */
export function conflictPaths(reason) {
  const text = String(reason || '');
  const paths = [...text.matchAll(/Merge conflict in (\S+)/gu)].map((match) => match[1]);
  const listed = /conflicts in (.+?)(?: — |$)/u.exec(text);
  if (listed) paths.push(...listed[1].split(/\s+/u).filter(Boolean));
  return [...new Set(paths)];
}

/** The head of the branch the round measured, when the report says it. */
export function measuredHead(job, report) {
  if (Number(report?.pr?.number) === Number(job.pr) && report.pr.head_sha) return report.pr.head_sha;
  return (report?.prs || []).find((item) => Number(item?.number) === Number(job.pr))?.head_sha || null;
}

/** Where a job's mend stands: `~/mc/runner/mend/<repo>-<pr>`, never the step's workarea. */
export function mendDir(root, job) {
  return join(root, 'runner', 'mend', `${job.repo}-${job.pr}`);
}

/** The last round lines in `merger.log` that are this job's. */
export function jobLogLines(text, job, max = LOG_LINES) {
  const mine = new RegExp(`\\s${escape(job.repo)}(?: #\\d+)* #${job.pr}(?: #\\d+)*:`, 'u');
  return String(text || '').split('\n').filter((line) => mine.test(line)).slice(-max);
}
const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * What the mend session is told. The rules are the role's; this is the job:
 * which pull request, where the round stopped and why, and — for a step — what
 * the step was for, from the plan on `origin/main`.
 */
export function mendPrompt({ job, report, title = null, step = null, log = [] }) {
  const branch = job.branch;
  const stop = report?.stopped_at || 'unknown';
  const red = redFilesOf(report);
  const conflicts = conflictPaths(report?.reason);
  const conflict = stop === 'merge' || stop === 'restack';
  const out = [
    `You are mending ${job.repo} #${job.pr}${title ? ` — ${title}` : ''}, branch \`${branch}\`.`,
    `The worktree you stand in is \`origin/${branch}\`, detached. The merger measured it and it did not land:`,
    '',
    `    stopped at: ${stop}`,
    `    reason: ${report?.reason || 'the round said nothing'}`,
  ];
  if (red.length) out.push(`    red files: ${red.join(' ')}`);
  if (conflicts.length) out.push(`    conflicts in: ${conflicts.join(' ')}`);
  if (step) {
    out.push('', `It is ${job.step.project} step ${job.step.index + 1}${step.title ? `, "${step.title}"` : ''}. What it was for:`, '');
    if (step.done_when) out.push(`done_when: ${step.done_when}`, '');
    if (step.instruction) out.push('instruction:', '', String(step.instruction).trim());
  }
  out.push('', '----- THE ROUND, AS merger.log HAS IT -----', log.length ? log.join('\n') : '_no lines for this job_', '');
  out.push(
    'Your task: make the change land as its author meant.',
    conflict
      ? '- Merge `origin/main` into the branch (`git fetch -q origin && git merge origin/main`) and resolve every conflict keeping both intents — never take a side because it is quicker.'
      : '- Merge `origin/main` into the branch first if it is behind and that is where the red comes from.',
    '- Where the change\'s own tests are red, fix the change; never skip, weaken or delete a test.',
    `- Run ${red.length ? `the red files (\`node --test ${red.join(' ')}\`)` : 'the red files'} or the repository's suite command until they are green.`,
    `- Commit, then \`git push origin HEAD:${branch}\`. No force.`,
    '- Edit no `PLAN.json`.',
    '- If it cannot be fixed here, push nothing and say why in your last line.',
    '',
    'End with one line saying what you did.',
  );
  return out.join('\n');
}

/* ----------------------------------------------------------------- session */

// The mend's session, with its pid as soon as there is one: the queue entry
// keeps it, so a merger that restarts knows nobody is mending any more.
function realSession({ bin, args, cwd, timeoutMs, env, onPid = () => {} }) {
  return new Promise((resolve) => {
    let child = null;
    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    try { child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) {
      resolve({ status: 1, stdout: '', stderr: String(error?.message || error), timedOut: false });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    if (child.pid) onPid(child.pid);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => done({ status: 1, stdout: '', stderr: String(error?.message || error), timedOut: false }));
    child.on('close', (code) => done({
      status: timedOut ? TIMEOUT_EXIT : (code ?? 1),
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      timedOut,
    }));
  });
}

const realGit = async (cwd, args) => {
  const r = await runTool('git', ['-C', cwd, ...args]);
  return { ok: r.status === 0, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
};

const realRead = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

/** What a session's environment must not hand the mend: it is nobody's step session. */
const SESSION_ENV = ['MC_STEP', 'MC_PROJECT', 'MC_REPO', 'MC_WORKAREA'];

/** The step's own words from the plan on `origin/main`, or null. */
async function stepOnMain(root, job, git, read) {
  if (!job.step) return null;
  const plan = readEntry(root, job.step.project, { read })?.plan;
  if (!plan) return null;
  const shown = await git(job.repo_path, ['show', `origin/main:${plan}`]);
  if (!shown.ok) return null;
  try {
    const step = JSON.parse(shown.stdout)?.steps?.[job.step.index];
    return step ? { title: step.title ?? null, done_when: step.done_when ?? null, instruction: step.instruction ?? null } : null;
  } catch { return null; }
}

const firstLine = (text) => String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
const lastLine = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) || '';

/**
 * One mend: a worktree on the branch, the session, and what it came to.
 * Returns `{ outcome, line, read, status, seconds }` — `outcome` is `pushed`
 * when the branch on origin moved past the head the round measured, else
 * `nothing`, `timed out` or `failed`. Never throws; the worktree is removed
 * in every case.
 */
export async function runMend({ root, job, report, deps = {} }) {
  const now = deps.now || (() => new Date());
  const git = deps.git || realGit;
  const read = deps.read || realRead;
  const env = { ...(deps.env || process.env) };
  for (const key of SESSION_ENV) delete env[key];
  const t0 = now().getTime();
  const seconds = () => Math.round((now().getTime() - t0) / 1000);
  const failed = (line) => ({ outcome: 'failed', line, read: null, status: null, seconds: seconds() });

  const role = (deps.role || readCanonRole)(MEND_ROLE);
  if (!role?.overlay) return failed(`canon/roles/${MEND_ROLE}.md is missing from this install`);
  const launch = (deps.launch || resolveLaunch)(role.tools?.[0] || 'claude');
  if (!launch?.ok) return failed(launch?.hint || launch?.reason || 'no tool to run the mend');

  const dir = mendDir(root, job);
  const repo = job.repo_path;
  const branch = job.branch;
  if (!(await git(repo, ['fetch', '-q', 'origin'])).ok) return failed('git fetch failed');
  let measured = measuredHead(job, report);
  if (!measured) {
    const tip = await git(repo, ['rev-parse', `origin/${branch}`]);
    if (!tip.ok) return failed(`origin/${branch} is not there`);
    measured = tip.stdout;
  }
  // A worktree left by a mend that died with its merger.
  if (existsSync(dir)) {
    await git(repo, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dirname(dir), { recursive: true });
  if (!(await git(repo, ['worktree', 'add', '-q', '--detach', dir, `origin/${branch}`])).ok) return failed('git worktree add failed');
  try {
    const step = await stepOnMain(root, job, git, read);
    const log = jobLogLines(read(deps.logPath || join(root, 'runner', 'log', 'merger.log')), job);
    const prompt = mendPrompt({ job, report, title: report?.pr?.title || null, step, log });
    const args = headlessArgs({
      // `stream: false`: one short answer on its own wall clock, as the
      // intake turn has it.
      toolId: launch.id, adapter: launch.adapter, model: role.model, effort: 'medium',
      instructions: instructionsFor(launch.id, role.overlay), prompt, profileArgs, autocompact: null, stream: false,
    });
    const result = await (deps.session || realSession)({
      bin: launch.spec.bin, args, cwd: dir, timeoutMs: (deps.minutes ?? MEND_MINUTES) * 60_000, env, onPid: deps.onPid || (() => {}),
    });
    const said = readSessionOutput({
      toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut, now: now(),
    });
    const text = String(sessionResult(result.stdout)?.result || '');
    const remote = await git(repo, ['ls-remote', 'origin', `refs/heads/${branch}`]);
    const head = remote.ok ? remote.stdout.split(/\s+/u)[0] || null : null;
    const moved = Boolean(head) && head !== measured;
    const outcome = moved ? 'pushed' : result.timedOut ? 'timed out' : result.status !== 0 ? 'failed' : 'nothing';
    return {
      outcome, line: moved ? firstLine(text) : lastLine(text || result.stderr), read: said, status: result.status, seconds: seconds(),
    };
  } catch (error) {
    return failed(String(error?.message || error));
  } finally {
    await git(repo, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The red reason a mend that did not push leaves: the round's, and what came of the mend. */
export function mendedReason(reason, { outcome, line }) {
  const tail = outcome === 'nothing' ? `the mend pushed nothing${line ? `: ${line}` : ''}`
    : outcome === 'timed out' ? 'the mend timed out' : 'the mend failed';
  return `${reason} — ${tail}`;
}

/**
 * The mends waiting and running, in answer order: at most `atOnce` at a time,
 * the rest held in memory. `start(job, report)` resolves once that job's mend
 * is settled — run, and `settle` called with its result. `idle()` resolves
 * when none runs or waits; `stop()` drops the waiting ones (their entries stay
 * `mending`, and the next merger puts them back in line).
 */
export function mendLine({ run, settle, atOnce = MEND_AT_ONCE }) {
  const waiting = [];
  let running = 0;
  let idlers = [];
  const pump = () => {
    while (running < atOnce && waiting.length) {
      const { job, report, resolve } = waiting.shift();
      running += 1;
      (async () => {
        let result = null;
        try { result = await run(job, report); } catch (error) { result = { outcome: 'failed', line: String(error?.message || error) }; }
        try { await settle(job, report, result); } catch { /* the settle says its own failures */ }
        running -= 1;
        resolve(result);
        pump();
      })();
    }
    if (!running && !waiting.length) { const was = idlers; idlers = []; for (const one of was) one(); }
  };
  return {
    start(job, report) {
      return new Promise((resolve) => { waiting.push({ job, report, resolve }); pump(); });
    },
    busy: () => running > 0 || waiting.length > 0,
    running: () => running,
    idle() {
      if (!running && !waiting.length) return Promise.resolve();
      return new Promise((resolve) => { idlers.push(resolve); });
    },
    stop() {
      for (const { resolve } of waiting.splice(0)) resolve(null);
      pump();
    },
  };
}
