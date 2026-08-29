/**
 * `mc run` — the runner, inside mc.
 *
 * One round is one pass over the queue; one step is one fresh headless
 * session in one workarea, then the merge of the PR it opened. The runner
 * decides nothing with a model: it reads files, runs git and gh, starts the
 * session through the launch adapter and waits for it. No inbox, no knock,
 * no watcher — it is the parent of the process it starts.
 *
 * One thing that is not a step rides along: `mc helper`, once per calendar
 * day at the top of the first round after 05:00Z, logged in runs.tsv under
 * its own kind. It opens no worktree and touches no branch — it reads
 * production, writes a digest and proposals into `~/mc/intake/`, and that is
 * all. `runHelperDay` below is the whole of it.
 *
 * Every process boundary is a dependency on `deps`, so the round can be
 * driven in a test with a fake git, gh, tmux and session and no network.
 * The rules themselves live in run-plan.js.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import { writeJsonAtomic } from './atomic-write.js';
import { defaultRepos, listPlans, parsePlanFrontmatter, planFields, showBatch } from './brief-collect.js';
import { collectHelper, describeDigest, unreadableSections } from './helper-collect.js';
import { describeTurn, runHelperTurn } from './helper-turn.js';
import { workRoot } from './paths.js';
import { loadProfile, profileArgs } from './portrait.js';
import { readCanonRole } from './roles.js';
import { addWorktree } from './work-area.js';
import {
  HELPER_KIND, HELPER_NAME, QUOTA_SLEEP_MS, TIMEOUT_EXIT, assembleQueue, chooseKind, headlessArgs,
  helperDue, helperNote, readSessionOutput, reconcilePrompt, sessionSettings, stepPrompt, tsvHeader,
  tsvRow,
} from './run-plan.js';

export const REPO_NAMES = ['memoro', 'memoro-cli'];

/* ------------------------------------------------------------ real deps */

function sh(cmd, args, { cwd, timeout = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function realDeps(env = process.env) {
  return {
    env,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    git: (cwd, args) => sh('git', ['-C', cwd, ...args]),
    gh: (cwd, args) => sh('gh', args, { cwd }),
    tmuxHas: (name) => sh('tmux', ['has-session', '-t', name]).ok,
    exists: existsSync,
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    list: (path) => { try { return readdirSync(path); } catch { return []; } },
    write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
    append: (path, text) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, text); },
    // The two files that say a runner is here and a step is in flight. Whole
    // or not at all: `mc status` reads them while they are being written.
    writeJson: (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
    remove: (path) => { try { rmSync(path, { force: true }); } catch { /* already gone */ } },
    pid: process.pid,
    addWorktree,
    profile: () => loadProfile({ env }),
    role: readCanonRole,
    launch: resolveLaunch,
    // The two halves of `mc helper`, so a round can be driven in a test with
    // no production behind it and no model in it.
    collect: (options) => collectHelper({ env, ...options }),
    helperTurn: (options) => runHelperTurn({ env, ...options }),
    // The session: the adapter's binary with the headless argument list,
    // stdin closed (claude -p reads a piped stdin and would eat it), a
    // wall-clock cap after which it is killed and logged as a timeout.
    session: ({ bin, args, cwd, timeoutMs }) => {
      const r = spawnSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 256 << 20, env });
      const timedOut = r.error?.code === 'ETIMEDOUT' || (r.status == null && r.signal === 'SIGTERM');
      return { status: timedOut ? TIMEOUT_EXIT : (r.status ?? 1), stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : ''), timedOut };
    },
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

/* --------------------------------------------------------------- runner */

export function createRunner({
  merge = true, deps = realDeps(),
} = {}) {
  const root = workRoot(deps.env);
  const paths = {
    queue: join(root, 'queue.md'),
    log: join(root, 'runner', 'log'),
    runs: join(root, 'runner', 'log', 'runs.tsv'),
    runnerLog: join(root, 'runner', 'log', 'runner.log'),
    stop: join(root, 'runner', 'STOP'),
    // What is running, for anyone who asks. runner.json says a runner is
    // here and names the pid to test; current.json exists only while a step
    // is in flight. runs.tsv gets its row when the step is over — that is
    // too late to answer "what is running now", which is why these exist.
    runner: join(root, 'runner', 'runner.json'),
    current: join(root, 'runner', 'current.json'),
  };
  const writeJson = deps.writeJson || ((path, value) => deps.write(path, `${JSON.stringify(value, null, 2)}\n`));
  const remove = deps.remove || (() => {});
  const pid = deps.pid ?? process.pid;
  const repos = defaultRepos(deps.env);
  const stamp = () => deps.now().toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const say = (text) => {
    const line = `${stamp()}  ${text}`;
    deps.append(paths.runnerLog, `${line}\n`);
    deps.log(line);
  };
  const gitOut = (cwd, args) => { const r = deps.git(cwd, args); return r.ok ? String(r.stdout ?? '').trimEnd() : null; };
  const stopRequested = () => deps.exists(paths.stop);

  function planOf(worktree, name) {
    const base = join(worktree, 'docs', 'project');
    for (const programme of deps.list(base)) {
      const path = join(base, programme, name, 'PLAN.md');
      if (deps.exists(path)) {
        const text = deps.read(path) || '';
        return { path, programme, text, ...parsePlanFrontmatter(text), fields: planFields(text) };
      }
    }
    return null;
  }

  /** memoro | memoro-cli | null — an existing workarea first, then the main trees. */
  function repoOf(name, plans) {
    for (const repo of repos) if (deps.exists(join(root, name, repo.name, '.git'))) return repo;
    const plan = plans.find((p) => p.project === name);
    return plan ? repos.find((r) => r.name === plan.repo) || null : null;
  }

  /**
   * Merge origin/main into the area branch — never rebase. The one conflict
   * resolved here is an identical .gitignore hunk; anything else is left in
   * progress for a reconcile step.
   */
  function syncMain(worktree, name) {
    if (!deps.git(worktree, ['fetch', '-q', 'origin']).ok) return { ok: false, conflicts: [] };
    if (deps.git(worktree, ['merge', '-q', '--no-edit', 'origin/main']).ok) return { ok: true, conflicts: [] };
    const conflicts = (gitOut(worktree, ['diff', '--name-only', '--diff-filter=U']) || '').split('\n').filter(Boolean);
    if (conflicts.length === 1 && conflicts[0] === '.gitignore') {
      if (deps.git(worktree, ['checkout', '--theirs', '.gitignore']).ok && deps.git(worktree, ['add', '.gitignore']).ok && deps.git(worktree, ['commit', '-q', '--no-edit']).ok) return { ok: true, conflicts: [] };
    }
    say(`${name}: merge conflict in: ${conflicts.join(' ')}`);
    return { ok: false, conflicts };
  }

  async function waitMergeable(worktree, pr) {
    let verdict = 'UNKNOWN';
    for (let i = 0; i < 12 && verdict === 'UNKNOWN'; i += 1) {
      const r = deps.gh(worktree, ['pr', 'view', String(pr), '--json', 'mergeable', '-q', '.mergeable']);
      verdict = (r.ok && r.stdout.trim()) || 'UNKNOWN';
      if (verdict === 'UNKNOWN') await deps.sleep(5000);
    }
    return verdict;
  }

  async function mergePr(worktree, name, pr) {
    const title = deps.gh(worktree, ['pr', 'view', String(pr), '--json', 'title', '-q', '.title']).stdout.trim();
    const squash = () => deps.gh(worktree, ['pr', 'merge', String(pr), '--squash', '--subject', `${title} (#${pr})`]);
    await waitMergeable(worktree, pr);
    let r = squash();
    if (r.ok) { say(`${name}: merged #${pr}`); deps.git(worktree, ['fetch', '-q', 'origin']); return true; }
    say(`${name}: merge of #${pr} failed: ${r.stderr.trim().split('\n').at(-1) || r.stdout.trim()}`);
    // Usually main moved during the step: bring it in and try once more. A
    // conflict is aborted here — the next round's reconcile step owns it; a
    // merge left in progress would make the worktree dirty and skipped forever.
    const sync = syncMain(worktree, name);
    if (!sync.ok) { deps.git(worktree, ['merge', '--abort']); say(`${name}: #${pr} needs reconcile next round`); return false; }
    if (deps.git(worktree, ['push', '-q', 'origin', 'HEAD']).ok) {
      await waitMergeable(worktree, pr);
      r = squash();
      if (r.ok) { say(`${name}: merged #${pr} (after syncing main)`); deps.git(worktree, ['fetch', '-q', 'origin']); return true; }
    }
    say(`${name}: #${pr} left open — could not merge`);
    return false;
  }

  /** One row in runs.tsv, header written the first time. Steps and the helper. */
  function logRun(row) {
    if (!deps.exists(paths.runs)) deps.write(paths.runs, `${tsvHeader()}\n`);
    deps.append(paths.runs, `${tsvRow(row)}\n`);
  }

  const dashes = { turns: '-', input: '-', output: '-', cacheRead: '-', cacheWrite: '-', session: '-' };

  /**
   * The day's `mc helper`, run at the top of a round. Returns 'ran',
   * 'failed' or null when it was not due.
   *
   * It is not a step and not a project: it opens no worktree, touches no
   * branch, and its row in runs.tsv carries `helper` in both the name and the
   * kind column. `helperDue` is the whole gate, and that row is the whole
   * state — written whether the run succeeded or failed, which is how a
   * failed collect stays unretried for the rest of the day.
   *
   * The collect half reads production and the turn half calls a model, so the
   * two are timed together and logged once: what a reader of runs.tsv wants
   * to know is what the day's helper cost and what came out of it.
   */
  async function runHelperDay() {
    const due = helperDue({ tsv: deps.read(paths.runs) || '', now: deps.now() });
    if (!due.due) return null;
    const t0 = deps.now().getTime();
    const took = () => Math.round((deps.now().getTime() - t0) / 1000);
    say('helper: the day\'s digest');

    let digest = null;
    try {
      digest = await deps.collect({ now: deps.now() });
    } catch (error) {
      logRun({ ts: stamp(), name: HELPER_NAME, kind: HELPER_KIND, exit: 1, seconds: took(), pr: '-', ...dashes, note: helperNote(null) });
      say(`helper: the collect step failed — ${error?.message || error}. Not retried today.`);
      return 'failed';
    }
    say(`helper: ${digest.path} — ${describeDigest(digest.data)}`);
    for (const note of digest.data.notes || []) say(`helper: ${note}`);
    for (const [section, source] of unreadableSections(digest.data)) say(`helper: ${section} not read — ${source.error}`);

    const turn = await deps.helperTurn({ digestPath: digest.path, digestText: digest.text, now: deps.now() });
    logRun({
      ts: stamp(), name: HELPER_NAME, kind: HELPER_KIND, exit: turn.status ?? 1, seconds: took(), pr: '-',
      turns: turn.turns ?? '-', input: turn.input ?? '-', output: turn.output ?? '-',
      cacheRead: turn.cacheRead ?? '-', cacheWrite: turn.cacheWrite ?? '-', session: turn.session ?? '-',
      note: helperNote(turn),
    });
    for (const note of turn.groundNotes || []) say(`helper: ${note}`);
    say(turn.ok
      ? `helper: ${describeTurn(turn)} (${took()}s)`
      : `helper: the turn did not finish — ${turn.reason || turn.note} (${took()}s)`);
    if (turn.quota) { say(`quota/rate limit seen — sleeping ${QUOTA_SLEEP_MS / 60000}m`); await deps.sleep(QUOTA_SLEEP_MS); }
    return turn.ok ? 'ran' : 'failed';
  }

  /** One project. Returns 'merged' | 'ran' | 'skipped' | 'stop'. */
  async function runStep(name, plans) {
    if (stopRequested()) { say(`STOP file present (${paths.stop}) — not starting ${name}`); return 'stop'; }
    const repo = repoOf(name, plans);
    if (!repo) { say(`${name}: no workarea and no plan on main, skip`); return 'skipped'; }
    const worktree = join(root, name, repo.name);
    if (!deps.exists(worktree)) {
      say(`${name}: no workarea — creating ${repo.name} worktree from origin/main`);
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      const added = deps.addWorktree({ name, repo: repo.path, branch: name, from: 'origin/main', env: deps.env });
      if (!added.ok) { say(`${name}: worktree add failed (${added.reason}), skip`); return 'skipped'; }
    }
    if (deps.tmuxHas(`mc-${name}`)) { say(`${name}: live tmux session, skip`); return 'skipped'; }
    if ((gitOut(worktree, ['status', '--porcelain']) || '').trim()) { say(`${name}: dirty worktree, skip`); return 'skipped'; }

    const sync = syncMain(worktree, name);
    if (!sync.ok && !sync.conflicts.length) { say(`${name}: fetch/merge failed, skip`); return 'skipped'; }
    const plan = sync.conflicts.length ? null : planOf(worktree, name);
    const choice = chooseKind({ plan, conflicts: sync.conflicts });
    // A null `skip` is a skip nobody would read — see `chooseKind`.
    if (!choice.kind) { if (choice.skip) say(`${name}: ${choice.skip}, skip`); return 'skipped'; }
    const { kind } = choice;

    const role = deps.role(kind);
    if (!role?.overlay) { say(`${name}: canon/roles/${kind}.md is missing — skip`); return 'skipped'; }
    const settings = sessionSettings(plan?.fields || {});
    const launch = deps.launch(settings.tool);
    if (!launch?.ok) { say(`${name}: ${settings.tool} is not available (${launch?.hint || launch?.reason}), skip`); return 'skipped'; }
    const now = deps.now();
    const prompt = kind === 'reconcile'
      ? reconcilePrompt({ name, repo: repo.name, conflicts: sync.conflicts })
      : stepPrompt({ name, repo: repo.name, planPath: plan.path, planText: plan.text, now });
    const instructions = [await deps.profile(), role.overlay].filter(Boolean).join('\n\n---\n\n');
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: settings.model, instructions, prompt, profileArgs });

    const ts = stamp().replace(/[-:]/gu, '');
    const out = join(paths.log, `${name}-${ts}.json`);
    say(`${name}: ${kind} starting (${launch.shortName} ${settings.model}, ${settings.budgetMinutes} min)`);
    const t0 = deps.now().getTime();
    // current.json exists exactly as long as the session does — written
    // before the call that blocks, removed however that call returns.
    writeJson(paths.current, {
      name, kind, tool: settings.tool, model: settings.model,
      budget_minutes: settings.budgetMinutes, started: stamp(), pid, worktree,
    });
    let result;
    try {
      result = deps.session({ bin: launch.spec.bin, args, cwd: worktree, timeoutMs: settings.budgetMinutes * 60_000 });
    } finally {
      remove(paths.current);
    }
    const seconds = Math.round((deps.now().getTime() - t0) / 1000);
    deps.write(out, result.stdout);
    deps.write(`${out}.err`, result.stderr);

    if (kind === 'reconcile' && deps.git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
      deps.git(worktree, ['merge', '--abort']);
      say(`${name}: reconcile did not finish — merge aborted`);
    }
    const branch = gitOut(worktree, ['branch', '--show-current']) || name;
    const prList = deps.gh(worktree, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number']);
    const pr = (prList.ok && prList.stdout.trim()) || '-';
    const read = readSessionOutput({ toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut });
    let { note } = read;
    if (merge && pr !== '-' && note === 'success') note = (await mergePr(worktree, name, pr)) ? 'success,merged' : 'success,open';

    logRun({ ts: stamp(), name, kind, exit: result.status, seconds, pr, turns: read.turns, input: read.input, output: read.output, cacheRead: read.cacheRead, cacheWrite: read.cacheWrite, session: read.session, note });
    say(`${name}: ${kind} done rc=${result.status} ${seconds}s pr=${pr} turns=${read.turns} note=${note}`);
    if (read.quota) { say(`quota/rate limit seen — sleeping ${QUOTA_SLEEP_MS / 60000}m`); await deps.sleep(QUOTA_SLEEP_MS); }
    // A merged step or a finished reconcile both leave the project ready for
    // its next step now; 'merged' is the round's cue to stay on it.
    return note === 'success,merged' || (kind === 'reconcile' && note === 'success') ? 'merged' : 'ran';
  }

  /** The queue, re-read every round: queue.md, then every plan on origin/main. */
  function queue() {
    const plans = [];
    for (const repo of repos) {
      if (!deps.exists(join(repo.path, '.git'))) continue;
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      plans.push(...listPlans(repo, { git: gitOut, batch: showBatch(gitOut) }));
    }
    return { names: assembleQueue(deps.read(paths.queue) || '', plans), plans };
  }

  /**
   * One pass: the day's helper if it is due, then every queued project.
   * Returns { ran, stop } — the helper is not counted, it is not a step.
   *
   * A project whose step merged keeps the
   * runner: its next step follows at once (plans re-read, so the merged
   * status is what decides) instead of waiting a whole round behind every
   * other project — 2026-08-29 a six-step plan would have taken six rounds
   * of twenty projects. STOP is honoured between those steps too.
   */
  async function round({ once = false } = {}) {
    // The day's helper first, and only in a round that is a round: `--once`
    // exists to watch a single step, and a two-minute model turn over
    // production is not what somebody typing it asked for.
    if (!once && !stopRequested()) await runHelperDay();
    let { names, plans } = queue();
    let ran = 0;
    for (const name of names) {
      let r = await runStep(name, plans);
      for (let stayed = 0; ; stayed += 1) {
        if (r === 'stop') return { ran, stop: true };
        if (r === 'ran' || r === 'merged') {
          ran += 1;
          if (once) return { ran, stop: false, once: true };
          await deps.sleep(60_000);
        }
        if (stopRequested()) { say(`runner exit on STOP after ${name} (remove ${paths.stop} before the next start)`); return { ran, stop: true }; }
        if (r !== 'merged' || stayed >= 8) break;
        plans = queue().plans;
        const status = plans.find((p) => p.project === name)?.status;
        if (!status || status === 'done') break;
        say(`${name}: step merged and the plan is ${status} — staying on ${name}`);
        r = await runStep(name, plans);
      }
    }
    return { ran, stop: false };
  }

  /** runner.json — a runner is here, and this is the pid to test for life. */
  const markRunner = () => writeJson(paths.runner, { pid, started: stamp() });
  const clearRunner = () => { remove(paths.runner); remove(paths.current); };

  return { paths, say, round, runStep, runHelperDay, queue, stopRequested, syncMain, mergePr, planOf, repoOf, markRunner, clearRunner };
}

/**
 * The loop: rounds until `rounds` is reached (0 = forever), a STOP file
 * appears, or `--once` has run its one step.
 */
export async function runLoop({ rounds = 0, once = false, merge = true, idleSleepMs = 600_000, deps = realDeps() } = {}) {
  const runner = createRunner({ merge, deps });
  if (runner.stopRequested()) { runner.say(`STOP file present (${runner.paths.stop}) — remove it before starting`); return 2; }
  runner.say(`runner start (mc run, merge=${merge ? 1 : 0} rounds=${rounds} once=${once ? 1 : 0})`);
  runner.markRunner();
  try {
    let n = 0;
    while (rounds === 0 || n < rounds) {
      n += 1;
      const r = await runner.round({ once });
      if (r.stop) { runner.say(`runner exit on STOP (remove ${runner.paths.stop} before the next start)`); return 0; }
      if (r.once) { runner.say('once: exiting'); return 0; }
      runner.say(`round ${n} done (${r.ran} ran)`);
      if (r.ran === 0 && (rounds === 0 || n < rounds)) await deps.sleep(idleSleepMs);
    }
    runner.say(`runner exit after ${rounds} round(s)`);
    return 0;
  } finally {
    runner.clearRunner();
  }
}
