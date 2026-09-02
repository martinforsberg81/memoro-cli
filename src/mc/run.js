/**
 * `mc run` — the runner, inside mc.
 *
 * One round is one pass over the queue; one step is one fresh headless
 * session in one workarea, then the merge of the PR it opened. The runner
 * decides nothing with a model: it reads files, runs git and gh, starts the
 * session through the launch adapter and waits for it. No inbox, no knock,
 * no watcher — it is the parent of the process it starts.
 *
 * A round drives one lane per repository at the same time: memoro's steps
 * and memoro-cli's never touch (different main branches, different
 * worktrees), so a round is as slow as the slower repository rather than as
 * slow as both. Nothing new to type or start — the lanes are inside the one
 * `mc run` process, and one repository with ready plans is one lane.
 *
 * A round begins by taking away what is finished: every plan on main that
 * says `status: done` is archived — its `docs/project/<programme>/<project>/`
 * removed and a `project_log.md` row left behind it — in one PR per
 * repository that the runner merges like any other. `done` is the whole
 * trigger; there is nothing to type. The rules are in archive-plan.js.
 *
 * A round ends by taking away the folder that plan explains: a workarea whose
 * project is finished — its plan left main this round, or `project_log.md`
 * says an earlier round archived it — and whose worktree is clean and whose
 * last row in runs.tsv ends `merged` is removed: worktree handed back, local
 * branch deleted, everything it kept beside its checkout moved to
 * `runner/log/closed/<name>/`. A workarea no project explains at all is never
 * removed by a machine; it is written to `~/mc/intake/unplanned-workareas.md`
 * instead. The rules are in close-workarea.js.
 *
 * A round asks GitHub what is open before it acts. An open pull request on a
 * project ends that project's round with a line naming it — the plan on
 * origin/main and the plan in the worktree both say `ready` while the step's
 * work sits in an open pull request, and the runner used to believe them and
 * start the step again. A workarea whose branch has already landed is moved to
 * `<name>-<n>` from origin/main before a session starts, which is also what
 * makes the `<name>`/`<name>-<suffix>` convention that matches a pull request
 * to a project true. The rules are project-prs.js and `inFlight`.
 *
 * `~/mc/queue.md` is Martin's "these first" and nothing else: names of
 * projects that still have a step to run, one per line. The round rewrites it
 * to that shape and a name leaves it the moment its step has run, so a queue
 * everything ran from is an empty file.
 *
 * One thing that is not a step rides along: `mc helper --intake`, once per calendar
 * day at the top of the first round after 05:00Z, logged in runs.tsv under
 * its own kind. It opens no worktree and touches no branch — it reads
 * production, writes a digest and proposals into `~/mc/intake/`, and that is
 * all. `runHelperDay` below is the whole of it.
 *
 * The runner is worked from another terminal by three files under
 * `~/mc/runner/`, all read at a round boundary and never mid-session: `STOP`
 * ends it, `UPDATE` makes it fast-forward mc's own checkout and hand over to a
 * fresh process on the new code. `mc run start|stop|--update` write them; the
 * rules and the handover are in run-control.js.
 *
 * Every process boundary is a dependency on `deps`, so the round can be
 * driven in a test with a fake git, gh, tmux and session and no network.
 * The rules themselves live in run-plan.js.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import {
  ARCHIVE_BRANCH_PREFIX, UNDOCUMENTED_HEADER, appendRow, donePlans, isUndocumented, logRows,
  mergedPrs, planDoc, planSummary, pointerCell, remoteSlug, rowFor, undocumentedRow,
} from './archive-plan.js';
import { writeJsonAtomic } from './atomic-write.js';
import { branchLanded } from './branch-landed.js';
import { defaultRepos, listPlans, showBatch } from './brief-collect.js';
import { readPlanText, unauthorisedChanges } from './plan-schema.js';
import { closable, lastRunFor, unplannedFile, unplannedRow } from './close-workarea.js';
import { handOver } from './run-control.js';
import { collectHelper, describeDigest, HELPER_REPOS, intakeDir, unreadableSections } from './helper-collect.js';
import { describeTurn, runHelperTurn } from './helper-turn.js';
import { workRoot } from './paths.js';
import { runDocsMerge } from './docs-merge.js';
import { runMergeRound } from './repo-merge.js';
import { PR_LIST_ARGS, openPrsFor } from './project-prs.js';
import { loadProfile, profileArgs } from './portrait.js';
import { readCanonRole } from './roles.js';
import { keepAwake, onACPower } from './stay-awake.js';
import { addWorktree } from './work-area.js';
import {
  HELPER_KIND, HELPER_NAME, QUOTA_SLEEP_MS, TIMEOUT_EXIT, assembleQueue, chooseKind, headlessArgs,
  helperDue, helperNote, inFlight, landingNote, nextBranch, queueFileNames, queueFileText,
  readSessionOutput, reconcilePrompt, sessionSettings, stackOrder, stepPrompt, strictQueue,
  tsvHeader, tsvRow,
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
    // Closing a workarea moves what it kept beside its worktree; it never
    // deletes it. `~/mc` and `~/mc/runner/log/closed/` are one filesystem, so
    // a rename is the whole move.
    move: (from, to) => {
      try { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); return true; } catch { return false; }
    },
    // The area directory itself, once everything in it has been moved out.
    // Called with an empty directory and nothing else — see `closeWorkarea`.
    rmdir: (path) => { try { rmSync(path, { recursive: true }); return true; } catch { return false; } },
    // The two files that say a runner is here and a step is in flight. Whole
    // or not at all: `mc status` reads them while they are being written.
    writeJson: (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
    remove: (path) => { try { rmSync(path, { force: true }); } catch { /* already gone */ } },
    pid: process.pid,
    addWorktree,
    profile: () => loadProfile({ env }),
    role: readCanonRole,
    launch: resolveLaunch,
    // The two halves of `mc helper --intake`, so a round can be driven in a test with
    // no production behind it and no model in it.
    collect: (options) => collectHelper({ env, ...options }),
    helperTurn: (options) => runHelperTurn({ env, ...options }),
    // The one door work lands through. `mc merge`'s round and `mc merge
    // --docs`', called in process because the runner is mc — not shelled out
    // to, and not replaced by a `gh pr merge` that skips the gate. A
    // dependency so a round can be driven in a test without a real suite, a
    // real lease and a real remote behind it.
    mergeRound: (options) => runMergeRound({ env, ...options }),
    docsMerge: (options) => runDocsMerge(options),
    // The session: the adapter's binary with the headless argument list,
    // stdin closed (claude -p reads a piped stdin and would eat it), a
    // wall-clock cap after which it is killed and logged as a timeout.
    //
    // `spawn` and not `spawnSync`: two lanes run in this one process, and a
    // synchronous wait would hold the event loop for the whole ninety
    // minutes — the second lane would never get to start. The output is
    // collected here instead of by `maxBuffer`, and capped rather than
    // allowed to eat the machine: a session that floods stdout is not going
    // to parse as JSON either way.
    session: ({ bin, args, cwd, timeoutMs }) => new Promise((resolve) => {
      const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM', env });
      const cap = 256 << 20;
      const collect = (stream) => {
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => { if (size < cap) { chunks.push(chunk); size += chunk.length; } });
        return () => Buffer.concat(chunks).toString('utf8');
      };
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      let settled = false;
      let failure = null;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      child.on('error', (error) => {
        failure = error;
        if (!child.pid) done({ status: 1, stdout: '', stderr: String(error.message), timedOut: false });
      });
      child.on('close', (status, signal) => {
        const timedOut = status == null && signal === 'SIGTERM';
        done({
          status: timedOut ? TIMEOUT_EXIT : (status ?? 1),
          stdout: stdout(),
          stderr: stderr() || (failure ? String(failure.message) : ''),
          timedOut,
        });
      });
    }),
    // `mc run --update`: this runner's replacement, on the code that is on
    // disk now. Node read its whole module graph at process start, so the only
    // way to run new code is to be a new process — the same argument list,
    // detached so it outlives this one, and the same stdio, which for a runner
    // `mc run start` spawned is the append handle on runner.log.
    respawn: () => {
      const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'inherit', env });
      child.unref();
      return child.pid ?? null;
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
    // `mc run --update` leaves this one. It is read where STOP is read — at a
    // round boundary — because it means the same kind of thing: finish what
    // you are in, then do as you are told. See run-control.js.
    update: join(root, 'runner', 'UPDATE'),
    // What is running, for anyone who asks. runner.json says a runner is
    // here and names the pid to test; `current-<repo>.json` exists only
    // while that lane's step is in flight — one file per lane, because two
    // steps run side by side. runs.tsv gets its row when the step is over —
    // that is too late to answer "what is running now", which is why these
    // exist.
    runner: join(root, 'runner', 'runner.json'),
    currentFor: (repo) => join(root, 'runner', `current-${repo}.json`),
    // Where a closed workarea's filing goes — its inbox, its decisions, the
    // scratch directory a session left beside its checkout. Moved, never
    // deleted: the folder is what goes, not what somebody wrote in it.
    closed: join(root, 'runner', 'log', 'closed'),
    unplanned: join(intakeDir(deps.env), 'unplanned-workareas.md'),
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
  const updateRequested = () => deps.exists(paths.update);

  /**
   * The 5-hour Claude quota is one budget for every lane. The first lane to
   * be refused sleeps on it and every other lane joins that same sleep
   * before its next step: one sleep, not two, and no session spent to be
   * told the same thing again. `quotaHold` is what a lane awaits before it
   * starts anything; `quotaPause` is what the lane that saw the refusal
   * calls.
   */
  let quotaSleep = null;
  async function quotaPause() {
    if (quotaSleep) { await quotaSleep; return; }
    say(`quota/rate limit seen — every lane sleeping ${QUOTA_SLEEP_MS / 60000}m`);
    quotaSleep = Promise.resolve(deps.sleep(QUOTA_SLEEP_MS));
    try { await quotaSleep; } finally { quotaSleep = null; }
  }
  const quotaHold = async () => { if (quotaSleep) await quotaSleep; };

  function planOf(worktree, name) {
    const base = join(worktree, 'docs', 'project');
    for (const programme of deps.list(base)) {
      const dir = join(base, programme, name);
      const path = join(dir, 'PLAN.json');
      if (deps.exists(path)) {
        const text = deps.read(path) || '';
        const { plan, problems } = readPlanText(text);
        return { path, programme, text, plan, problems, legacy: false };
      }
      // A project still on the old file is reported as what it is. The runner
      // reads PLAN.json and nothing else; guessing at markdown is what let a
      // plan missing the sections the role names be handed out anyway.
      if (deps.exists(join(dir, 'PLAN.md'))) {
        return { path: join(dir, 'PLAN.md'), programme, text: '', plan: null, problems: [], legacy: true };
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

  /**
   * The workarea, moved to a branch it can still push to.
   *
   * `action-window` stood on `action-window`, which had merged as #11177 and
   * been deleted on the remote; the plan the worktree carried therefore read
   * `ready`, and the 04:33 session of 2026-09-02 would have been refused by
   * the push-guard (push-guard.js, D-0164) ninety minutes later — the guard
   * asks the right question at the wrong end. A branch whose *content* is
   * already in origin/main has nothing left to carry, so the workarea is
   * checked out on `<name>-<n>` from origin/main before anything is started.
   * "By content" because the runner squash-merges: "ahead by N commits" says
   * nothing (branch-landed.js).
   *
   * A branch that has not landed is left exactly where it is — it carries
   * work, and an open pull request on it has already ended this round above.
   *
   * Returns `{ ok, moved, why }`: `moved` is the new branch, or null when the
   * workarea was already somewhere it could push from.
   */
  function freshBranch(worktree, name) {
    deps.git(worktree, ['fetch', '-q', 'origin']);
    const branch = gitOut(worktree, ['branch', '--show-current']);
    // Detached, or git could not say: not a branch this can reason about.
    if (!branch) return { ok: true, moved: null };
    const landed = branchLanded(worktree, branch, { run: (args) => gitOut(worktree, args) });
    if (landed !== 'landed') return { ok: true, moved: null };
    const local = (gitOut(worktree, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']) || '').split('\n');
    const remote = (gitOut(worktree, ['ls-remote', '--heads', 'origin']) || '').split('\n')
      .map((line) => line.split('refs/heads/')[1]);
    const next = nextBranch(name, [...local, ...remote].map((ref) => (ref || '').trim()).filter(Boolean));
    if (!deps.git(worktree, ['checkout', '-q', '-b', next, 'origin/main']).ok) {
      return { ok: false, moved: null, why: `${branch} has landed and ${next} could not be made` };
    }
    say(`${name}: ${branch} has already landed — moved to ${next} from origin/main`);
    return { ok: true, moved: next };
  }

  /* --------------------------------------------------------------- landing */

  /**
   * The one door. `mc merge`'s own round, in this process — `repo-merge.js`,
   * not a shell out to `mc`, because the runner *is* mc.
   *
   * There is no `gh pr merge` left in here. The old `mergePr` squash-merged
   * whatever the branch's pull request was and waited only for `mergeable`, so
   * a step landed without the gate at all — and never read the base it landed
   * on: on 2026-09-02 at 13:00 that squashed #11250 into
   * `msr-track-3-capture-command`, the branch of #11249 the runner had left
   * open eighty minutes earlier, logged `success,merged`, and `main` received
   * nothing. Martin, 2026-09-02: only `mc merge` may be used.
   *
   * What the round gives back and this reads: `merged_into` and `off_default`,
   * through `landingNote`. The runner's own "it returned zero" is not evidence
   * that anything landed on main.
   *
   * The gate costs a round — 20–35 minutes on memoro — where the old merge
   * cost seconds. That is the price of the contract, and `land_seconds` is
   * where a reader of runs.tsv sees it.
   */
  async function landPr(repo, name, pr) {
    const report = await deps.mergeRound({
      repoPath: repo.path,
      pr: Number(pr),
      // Who holds the repository for the length of the round. `currentHolder()`
      // would answer `user@host` from wherever the runner process happens to
      // stand; the workarea is the answer `mc repo who` is asked for.
      holder: { name, kind: 'work-area' },
      onProgress: (message) => say(`${name}: merge #${pr} — ${message}`),
    });
    const note = landingNote(report);
    if (note === 'merged') say(`${name}: merged #${pr} into ${report.merged_into} through the gate`);
    else if (note.startsWith('off-')) say(`${name}: #${pr} was merged into ${report.merged_into}, NOT main — not recorded as merged`);
    else say(`${name}: #${pr} left open — ${report?.reason || 'the merge round said nothing'}`);
    return note;
  }

  /**
   * Retarget and replay the branch above one that has just landed.
   *
   * A squashed base leaves every branch above it conflicting even when its
   * author did nothing wrong — the gate merges origin/main into the candidate
   * before measuring, and against a squash of the branch below that merge
   * conflicts wherever the two touched the same lines. Measured on a
   * three-step memoro-cli stack on 2026-09-01: both remaining branches went
   * from MERGEABLE to CONFLICT the moment the first one landed.
   *
   * `git rebase --onto origin/main <the old base's head>` replays only what
   * has not landed. A conflict is not resolved here and is not what
   * `reconcile` is for: abort, name the files, and stop on this project.
   */
  function replayOnto(worktree, name, pr, wasAt) {
    if (!wasAt) return { ok: false, why: `where ${pr.headRefName} left ${pr.baseRefName} could not be read` };
    const edited = deps.gh(worktree, ['pr', 'edit', String(pr.number), '--base', 'main']);
    if (!edited.ok) return { ok: false, why: `#${pr.number} could not be retargeted at main (${lastLine(edited)})` };
    deps.git(worktree, ['fetch', '-q', 'origin']);
    if (deps.git(worktree, ['rebase', '--onto', 'origin/main', wasAt, pr.headRefName]).ok) {
      const pushed = deps.git(worktree, ['push', '-q', '--force-with-lease', 'origin', pr.headRefName]);
      if (pushed.ok) return { ok: true };
      return { ok: false, why: `${pr.headRefName} was rebased onto origin/main but could not be pushed (${lastLine(pushed)})` };
    }
    const conflicts = (gitOut(worktree, ['diff', '--name-only', '--diff-filter=U']) || '').split('\n').filter(Boolean);
    deps.git(worktree, ['rebase', '--abort']);
    return { ok: false, why: `${pr.headRefName} conflicts with what just landed in: ${conflicts.join(' ') || 'unknown files'}` };
  }

  /**
   * Everything this project has open, landed through the gate, bottom first.
   *
   * Normally that is one pull request — step 1's rule means the project had
   * none open when the session started. A session that could not branch its
   * later work from main leaves a stack, and `stackOrder` is the only thing
   * that decides whether this is one: not a stack it understands means
   * nothing lands and a line saying why.
   *
   * Returns `{ note, seconds }` — the runs.tsv note after `success,`, and how
   * long the landing itself took.
   */
  async function landProject(worktree, repo, name, prs) {
    const t0 = deps.now().getTime();
    const took = () => Math.round((deps.now().getTime() - t0) / 1000);
    const stack = stackOrder(prs);
    if (!stack.ok) { say(`${name}: ${stack.reason} — landing none of them`); return { note: 'open,not-a-stack', seconds: took() }; }
    if (!stack.order.length) return { note: 'open', seconds: took() };
    if (stack.order.length > 1) say(`${name}: a stack of ${stack.order.length}, landing bottom first: ${stack.order.map((pr) => `#${pr.number}`).join(' → ')}`);
    // Where each branch left its base, read now and not later: a base branch
    // is gone from the remote the moment the pull request on it is merged, and
    // this is the commit `--onto` replays the branch above off.
    const forkedAt = new Map(stack.order.map((pr) => [
      pr.number, gitOut(worktree, ['merge-base', `origin/${pr.baseRefName}`, `origin/${pr.headRefName}`]),
    ]));
    let note = 'open';
    for (const [i, pr] of stack.order.entries()) {
      if (i > 0) {
        const replayed = replayOnto(worktree, name, pr, forkedAt.get(pr.number));
        // The one below it has landed and this one has not. `open,stack-stopped`
        // rather than anything with `merged` in it: something of this project's
        // is still open, and a note that reads as merged would let the round
        // that closes workareas take this one away.
        if (!replayed.ok) { say(`${name}: ${replayed.why} — stopping on this project for the round`); return { note: 'open,stack-stopped', seconds: took() }; }
      }
      note = await landPr(repo, name, pr.number);
      deps.git(worktree, ['fetch', '-q', 'origin']);
      if (note !== 'merged') return { note, seconds: took() };
    }
    return { note, seconds: took() };
  }

  /**
   * The archive pull request, landed through `mc merge --docs`.
   *
   * It removes `docs/project/<programme>/<project>/` and adds a row to
   * `project_log.md`, so it is documentation by construction and there is no
   * test for the gate to run on it — `docs-merge.js` checks that against
   * GitHub's own file list rather than a local diff, and refuses anything
   * that touches a line of code. Still through mc's own door, and its
   * `merged_into` is read like any other.
   */
  async function landDocsPr(worktree, name, pr) {
    const report = await deps.docsMerge({
      repoPath: worktree,
      pr: Number(pr),
      gh: (args) => deps.gh(worktree, args),
      onProgress: (message) => say(`${name}: ${message}`),
    });
    const note = landingNote(report);
    if (note === 'merged') {
      // The worktree shares its refs with the repository it was added from, so
      // this is also how everything downstream of the round learns that main
      // has moved.
      deps.git(worktree, ['fetch', '-q', 'origin']);
      say(`${name}: merged #${pr} into ${report.merged_into} (docs only)`);
      return true;
    }
    if (note.startsWith('off-')) say(`${name}: #${pr} was merged into ${report.merged_into}, NOT main`);
    else say(`${name}: #${pr} left open — ${report?.reason || 'the docs merge said nothing'}`);
    return false;
  }

  const lastLine = (r) => String(r.stderr || '').trim().split('\n').at(-1) || String(r.stdout || '').trim() || 'no reason given';

  /** One row in runs.tsv, header written the first time. Steps and the helper. */
  function logRun(row) {
    if (!deps.exists(paths.runs)) deps.write(paths.runs, `${tsvHeader()}\n`);
    deps.append(paths.runs, `${tsvRow(row)}\n`);
  }

  const dashes = { turns: '-', input: '-', output: '-', cacheRead: '-', cacheWrite: '-', session: '-' };

  /* ------------------------------------------------------------- archiving */

  /**
   * An archive PR of an earlier round that never merged, or null. One is
   * enough to hold this round off: a second PR would remove the same
   * directories again and land two rows for the same project.
   */
  function openArchivePr(repo) {
    const r = deps.gh(repo.path, ['pr', 'list', '--state', 'open', '--json', 'number,headRefName',
      '-q', `.[] | select(.headRefName | startswith("${ARCHIVE_BRANCH_PREFIX}")) | .number`]);
    if (!r.ok) return null;
    return r.stdout.trim().split('\n').filter(Boolean)[0] || null;
  }

  /**
   * Every plan of one repository that says `done` on main, archived in this
   * round: the directory removed, a `project_log.md` row written for the
   * projects that have none, one PR the runner merges like any other.
   *
   * Returns `{ archived, landed }` — the projects this round took out of
   * `docs/project/`, and the ones whose PR actually merged. Only the second
   * set may have its workarea closed later in the round: the plan goes first,
   * then the workarea.
   *
   * The work happens in a worktree of its own under `~/mc/runner/archive/`,
   * made from origin/main and taken down again however this ends. Not the
   * project's own workarea: a done project need not have one, several are
   * archived in the one PR, and the workarea is removed later in the same
   * round — the plan goes first, then the workarea, so a workarea is never
   * removed while the plan that explains it is still on main.
   */
  async function archiveDone(repo, plans) {
    const none = { archived: [], landed: [] };
    const done = donePlans(plans, repo.name);
    if (!done.length) return none;
    const open = openArchivePr(repo);
    if (open) { say(`archive: ${repo.name} #${open} is still open from an earlier round — not opening another`); return none; }

    const branch = `${ARCHIVE_BRANCH_PREFIX}${stamp().replace(/[-:]/gu, '')}`;
    const worktree = join(root, 'runner', 'archive', repo.name);
    if (deps.exists(worktree)) deps.git(repo.path, ['worktree', 'remove', '--force', worktree]);
    if (!deps.git(repo.path, ['worktree', 'add', '-b', branch, worktree, 'origin/main']).ok) {
      say(`archive: ${repo.name} — could not open the archive worktree, nothing archived this round`);
      return none;
    }
    try {
      return await archiveIn({ repo, worktree, branch, done });
    } finally {
      deps.git(repo.path, ['worktree', 'remove', '--force', worktree]);
      deps.git(repo.path, ['branch', '-D', branch]);
    }
  }

  /** The archive itself, inside the worktree that was made for it. */
  async function archiveIn({ repo, worktree, branch, done }) {
    const logPath = join(worktree, 'docs', 'project', 'project_log.md');
    const slug = remoteSlug(gitOut(repo.path, ['remote', 'get-url', 'origin']));
    const date = stamp().slice(0, 10);
    let logText = deps.read(logPath) ?? '';
    const archived = [];
    const undocumented = [];

    for (const plan of done) {
      const dir = join('docs', 'project', plan.programme, plan.project);
      // The plan as it stands at close-out. PLAN.json is the plan; a project
      // still on the old file is read there until the last one is migrated.
      const planText = deps.read(join(worktree, dir, 'PLAN.json'))
        || deps.read(join(worktree, dir, 'PLAN.md'))
        || '';
      if (!deps.git(worktree, ['rm', '-r', '-q', '--', dir]).ok) {
        say(`archive: ${repo.name} ${plan.programme}/${plan.project} — git rm failed, left alone`);
        continue;
      }
      // The row is preferred, never waited for: a close-out step that already
      // wrote one knows more about the project than this does.
      const existing = rowFor(logText, plan.project);
      const row = existing || {
        date,
        programme: plan.programme,
        project: plan.project,
        outcome: 'delivered',
        summary: planSummary(planText),
        doc: planDoc(planText),
        pointer: pointerCell(mergedPrs(deps.read(paths.runs) || '', plan.project), {
          slug,
          fallback: gitOut(worktree, ['log', '-1', '--format=%h', 'origin/main', '--', dir]),
        }),
      };
      if (!existing) logText = appendRow(logText, row);
      archived.push(plan.project);
      say(`archive: ${repo.name} ${plan.programme}/${plan.project} removed — ${existing ? 'row already written' : 'row added to project_log.md'}`);
      if (isUndocumented(row)) {
        undocumented.push(undocumentedRow({ date, repo: repo.name, programme: plan.programme, project: plan.project, pointer: row.pointer }));
        say(`archive: ${plan.project} names no docs/technical/ note — recorded for mc brief`);
      }
    }
    if (!archived.length) return { archived: [], landed: [] };

    deps.write(logPath, logText);
    const title = `Archive ${archived.length} done project${archived.length === 1 ? '' : 's'}: ${archived.join(', ')}`;
    const body = [
      'A plan that reaches `done` is archived in the round the runner reads it:',
      'the project directory is removed and `docs/project/project_log.md` carries',
      'a row for it. The history is the record — `git log --all -- <path>` still',
      'answers every question the removed directory could.',
      '',
      ...archived.map((project) => `- ${project}`),
    ].join('\n');
    deps.git(worktree, ['add', '-A']);
    if (!deps.git(worktree, ['commit', '-q', '-m', title, '-m', body]).ok
      || !deps.git(worktree, ['push', '-q', '-u', 'origin', 'HEAD']).ok) {
      say(`archive: ${repo.name} — commit or push failed, nothing archived this round`);
      return { archived: [], landed: [] };
    }
    const created = deps.gh(worktree, ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body]);
    const listed = deps.gh(worktree, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number']);
    const pr = (/(\d+)\s*$/u.exec(created.stdout.trim())?.[1]) || (listed.ok && listed.stdout.trim()) || null;
    if (!pr) { say(`archive: ${repo.name} — the PR could not be opened (${created.stderr.trim().split('\n').at(-1) || 'no number'})`); return { archived: [], landed: [] }; }

    if (undocumented.length) {
      const path = join(intakeDir(deps.env), 'undocumented-closures.md');
      if (!deps.exists(path)) deps.write(path, UNDOCUMENTED_HEADER);
      deps.append(path, `${undocumented.join('\n')}\n`);
    }
    // Only a merged archive PR lets the workareas go: until the plan is off
    // main, the folder it explains stays where it is.
    const landed = (merge && await landDocsPr(worktree, `archive/${repo.name}`, pr)) ? archived : [];
    return { archived, landed };
  }

  /* -------------------------------------------------------------- closing */

  /** The repositories this workarea has a checkout of. Empty means it is not one. */
  function areaRepos(name) {
    return repos.filter((repo) => deps.exists(join(root, name, repo.name, '.git')));
  }

  /**
   * Every directory under `~/mc` that is a workarea, sorted.
   *
   * A folder without `memoro/` or `memoro-cli/` in it is not a workarea:
   * `bin/`, `brief/`, `decisions/`, `inbox/`, `intake/`, `runner/`, `status/`
   * and the two role homes are mc's own, and the runner has no business
   * looking at them.
   */
  function workareas() {
    return deps.list(root).filter((name) => !name.startsWith('.') && areaRepos(name).length).sort();
  }

  /** `git status --porcelain` across every checkout the area holds. */
  function uncommitted(name) {
    return areaRepos(name).reduce((count, repo) => {
      const out = gitOut(join(root, name, repo.name), ['status', '--porcelain']) || '';
      return count + out.split('\n').filter(Boolean).length;
    }, 0);
  }

  /**
   * One closable workarea, taken down: the worktree removed through the
   * repository that owns it, the local branch deleted, and everything the
   * folder kept beside its checkout moved to `runner/log/closed/<name>/`
   * before the folder itself goes.
   *
   * What mc deletes is nothing: every file the folder holds outside the
   * checkout is moved, and the checkout is git's to hand back — its content
   * is on origin, and the remote branch and the PRs stay. `git worktree
   * remove` does take the ignored files with it, which on the workareas
   * measured 2026-08-29 was `node_modules/`, `__pycache__/`, `.wrangler/`,
   * `public/dist/` and one generated `.sql` — build output a fresh checkout
   * rebuilds, and nothing a person wrote.
   *
   * A step that fails stops the rest and says so: the folder keeps whatever
   * has not been moved yet, and the next round tries again.
   */
  function closeWorkarea(name) {
    const area = join(root, name);
    for (const repo of areaRepos(name)) {
      const worktree = join(area, repo.name);
      if (!deps.git(repo.path, ['worktree', 'remove', worktree]).ok) {
        say(`close: ${name} — git worktree remove failed for ${repo.name}, left alone`);
        return false;
      }
      deps.git(repo.path, ['branch', '-D', name]);
    }
    const kept = deps.list(area).filter(Boolean);
    for (const entry of kept) {
      if (!deps.move(join(area, entry), join(paths.closed, name, entry))) {
        say(`close: ${name} — could not move ${entry} to ${join(paths.closed, name)}, folder left alone`);
        return false;
      }
    }
    deps.rmdir(area);
    const moved = kept.length ? `, ${kept.length} file(s) moved to runner/log/closed/${name}/` : '';
    say(`close: ${name} removed — worktree, branch ${name}${moved}`);
    return true;
  }

  /**
   * The end of the round: every workarea whose plan is finished is taken
   * down, and every workarea with no plan on main is written where somebody
   * looks.
   *
   * `landed` is the projects whose archive PR merged in this round — the plan
   * goes first, then the workarea, so a workarea is never removed while the
   * plan that explains it is still on main. `plans` is the round's reading of
   * main, taken before that archive removed them. `archived` is every project
   * `project_log.md` names, which is what a plan removed by an *earlier* round
   * leaves behind: without it, a round cut short between the archive and the
   * closing left a folder no machine would ever look at again.
   *
   * A plan that is neither done nor missing is passed over without asking git
   * anything: `closable` would answer the same, and forty `git status` calls
   * a round for an answer already on the plan is not a price worth paying.
   */
  function closeWorkareas(plans, landed = [], archived = new Set()) {
    const byProject = new Map(plans.map((plan) => [plan.project, plan]));
    const tsv = deps.read(paths.runs) || '';
    const rows = [];
    let closed = 0;
    for (const name of workareas()) {
      const plan = byProject.get(name) || null;
      if (plan && plan.status !== 'done') continue;
      const verdict = closable({
        plan,
        archived: archived.has(name),
        dirty: uncommitted(name) > 0,
        live: deps.tmuxHas(`mc-${name}`),
        lastRun: lastRunFor(tsv, name),
      });
      if (verdict.unplanned) { rows.push(unplannedFor(name)); continue; }
      if (!verdict.close) { say(`close: ${name} kept — ${verdict.why}`); continue; }
      // The plan goes first, then the workarea. A plan this round still read on
      // main goes only if the archive PR that removes it actually merged; one
      // that was already gone is answered by the project log instead, which is
      // what lets a round cut short by STOP be finished by the next one.
      if (plan && !landed.includes(name)) { say(`close: ${name} kept — its plan is still on main`); continue; }
      if (closeWorkarea(name)) closed += 1;
    }
    deps.write(paths.unplanned, unplannedFile(rows));
    if (rows.length) say(`close: ${rows.length} workarea(s) with no project on main — ${paths.unplanned}`);
    return { closed, unplanned: rows.length };
  }

  /**
   * Every project `docs/project/project_log.md` names on origin/main — the
   * runner's own record of what it has archived, and the only thing that still
   * knows a folder was ever a project once its plan has gone.
   *
   * One `git show` per repository per round, read after the archive PRs have
   * merged, so a project archived moments ago is already in it.
   */
  function archivedProjects() {
    const names = new Set();
    for (const repo of repos) {
      if (!deps.exists(join(repo.path, '.git'))) continue;
      const text = gitOut(repo.path, ['show', 'origin/main:docs/project/project_log.md']);
      for (const row of logRows(text || '')) if (row.project) names.add(row.project);
    }
    return names;
  }

  /**
   * One row of `~/mc/intake/unplanned-workareas.md`. `branch` is asked of
   * content rather than of commit counts — the runner squash-merges, so
   * "ahead" by commits says nothing (branch-landed.js).
   */
  function unplannedFor(name) {
    const [repo] = areaRepos(name);
    const worktree = join(root, name, repo.name);
    // The branch is asked of the worktree, not guessed from the folder: a
    // workarea from before the plan world was made by hand and need not be
    // named after its branch (msr-track-1 sits on `msr-track1-skin`).
    // Measured 2026-08-29, guessing left 14 of 20 rows `unknown` — which is
    // the one column that says whether anything would be lost.
    const branch = gitOut(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']) || name;
    return unplannedRow({
      name,
      repo: repo.name,
      uncommitted: uncommitted(name),
      lastCommit: gitOut(worktree, ['log', '-1', '--format=%cs']) || '-',
      branch: branchLanded(worktree, branch, { run: (args) => gitOut(worktree, args) }),
    });
  }

  /* ---------------------------------------------------------------- queue */

  /**
   * `~/mc/queue.md` rewritten to what it is for: names of projects that still
   * have a step to run. Everything else goes, one runner.log line each.
   */
  function tidyQueue(plans) {
    const text = deps.read(paths.queue);
    if (text == null) return;
    const { names, dropped } = strictQueue(text, plans);
    for (const item of dropped) say(`queue: dropped "${item.line}" — ${item.why}`);
    const next = queueFileText(names);
    if (next !== text) deps.write(paths.queue, next);
  }

  /** A name leaves the queue the moment its step has run. */
  function dropFromQueue(name) {
    const text = deps.read(paths.queue);
    if (text == null) return;
    const names = queueFileNames(text).filter((line) => line !== name);
    const next = queueFileText(names);
    if (next !== text) deps.write(paths.queue, next);
  }

  /**
   * The day's `mc helper --intake`, run at the top of a round. Returns 'ran',
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

    // One digest and one turn per repository. memoro's production is the
    // deployed service; memoro-cli's is this machine, and until 2026-08-30
    // nothing read the second — every failure in mc itself was found by a
    // person noticing it.
    //
    // A repository that fails does not take the other down with it. The whole
    // reason the collect step reports per section instead of failing as a
    // unit is that these sources do not share a failure domain, and two
    // repositories share one even less.
    let outcome = null;
    for (const repo of HELPER_REPOS) {
      let digest = null;
      try {
        digest = await deps.collect({ now: deps.now(), repo });
      } catch (error) {
        say(`helper: ${repo}: the collect step failed — ${error?.message || error}. Not retried today.`);
        outcome = 'failed';
        continue;
      }
      say(`helper: ${digest.path} — ${describeDigest(digest.data)}`);
      for (const note of digest.data.notes || []) say(`helper: ${repo}: ${note}`);
      for (const [section, source] of unreadableSections(digest.data)) say(`helper: ${repo}: ${section} not read — ${source.error}`);

      const turn = await deps.helperTurn({ digestPath: digest.path, digestText: digest.text, repo, now: deps.now() });
      logRun({
        ts: stamp(), name: HELPER_NAME, kind: HELPER_KIND, exit: turn.status ?? 1, seconds: took(), pr: '-',
        turns: turn.turns ?? '-', input: turn.input ?? '-', output: turn.output ?? '-',
        cacheRead: turn.cacheRead ?? '-', cacheWrite: turn.cacheWrite ?? '-', session: turn.session ?? '-',
        note: `${repo},${helperNote(turn)}`,
      });
      for (const note of turn.groundNotes || []) say(`helper: ${note}`);
      say(turn.ok
        ? `helper: ${repo}: ${describeTurn(turn)} (${took()}s)`
        : `helper: ${repo}: the turn did not finish — ${turn.reason || turn.note} (${took()}s)`);
      if (turn.quota) await quotaPause();
      if (!turn.ok) outcome = 'failed';
      else if (outcome !== 'failed') outcome = 'ran';
    }
    // Every repository's collect step threw: nothing was written and nothing
    // read it, which is the one case that never logged a row above.
    if (outcome === 'failed' && !deps.read(paths.runs)?.includes(HELPER_NAME)) {
      logRun({ ts: stamp(), name: HELPER_NAME, kind: HELPER_KIND, exit: 1, seconds: took(), pr: '-', ...dashes, note: helperNote(null) });
    }
    return outcome;
  }

  /**
   * One project. Returns 'merged' | 'ran' | 'skipped' | 'stop'.
   *
   * `world` is what `queue()` returned: the plans on origin/main and the open
   * pull requests of both repositories. Everything that can end the round for
   * this project is asked before a session is spent, in the order it costs:
   * the STOP file, the quota, a dirty worktree, an open pull request, and then
   * whether the branch underneath is one that can still be pushed.
   *
   * A session somebody has open in the workarea is **not** on that list any
   * more. It used to be — a live `mc-<name>` tmux session skipped the project —
   * and the rule looked prudent while being a second, undeclared way to stop
   * work: whether a step runs would depend on which terminals happened to be
   * open, which is nowhere in the plan and nothing the next round remembers.
   * A project the runner should leave alone says so where every other such
   * fact is written down, by being `blocked` in its own `PLAN.json` (Martin,
   * 2026-09-02). `mc work` and `mc run` now know nothing about each other.
   *
   * `closeWorkareas` still asks. That is a different question — whether it is
   * safe to *delete* the directory — and pulling the ground from under a
   * terminal somebody is standing in is not the same as declining to run a
   * step in it.
   */
  async function runStep(name, world = {}) {
    const { plans = [], prs = [], prsFailed = [] } = Array.isArray(world) ? { plans: world } : world;
    if (stopRequested()) { say(`STOP file present (${paths.stop}) — not starting ${name}`); return 'stop'; }
    // A quota answer in the other lane is this lane's answer too: wait it
    // out here, before a worktree is touched or a session is spent.
    await quotaHold();
    const repo = repoOf(name, plans);
    if (!repo) { say(`${name}: no workarea and no plan on main, skip`); return 'skipped'; }
    const worktree = join(root, name, repo.name);
    if (!deps.exists(worktree)) {
      say(`${name}: no workarea — creating ${repo.name} worktree from origin/main`);
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      const added = deps.addWorktree({ name, repo: repo.path, branch: name, from: 'origin/main', env: deps.env });
      if (!added.ok) { say(`${name}: worktree add failed (${added.reason}), skip`); return 'skipped'; }
    }
    if ((gitOut(worktree, ['status', '--porcelain']) || '').trim()) { say(`${name}: dirty worktree, skip`); return 'skipped'; }
    if (prsFailed.includes(repo.name)) { say(`${name}: what is open on GitHub is unknown this round, skip`); return 'skipped'; }

    // Work already in flight ends the round for this project, whatever the
    // plan says — the plan on origin/main and the plan in the worktree both
    // read `ready` while the step's work sits in an open pull request. The
    // rule itself is `inFlight`, beside `chooseKind` in run-plan.js.
    const flight = inFlight(openPrsFor({ prs, name, names: plans.map((p) => p.project), repo: repo.name }));
    if (flight) { say(`${name}: ${flight.skip}`); return 'skipped'; }
    // And a session must be somewhere it can push from. The push-guard asks
    // the same question at the wrong end — after ninety minutes of work.
    const moved = freshBranch(worktree, name);
    if (!moved.ok) { say(`${name}: ${moved.why}, skip`); return 'skipped'; }

    const sync = syncMain(worktree, name);
    if (!sync.ok && !sync.conflicts.length) { say(`${name}: fetch/merge failed, skip`); return 'skipped'; }
    const plan = sync.conflicts.length ? null : planOf(worktree, name);
    const choice = chooseKind({ plan, conflicts: sync.conflicts });
    // A null `skip` is a skip nobody would read — see `chooseKind`.
    if (!choice.kind) { if (choice.skip) say(`${name}: ${choice.skip}, skip`); return 'skipped'; }
    const { kind } = choice;

    const role = deps.role(kind);
    if (!role?.overlay) { say(`${name}: canon/roles/${kind}.md is missing — skip`); return 'skipped'; }
    const settings = sessionSettings(plan?.plan?.runner || {});
    const launch = deps.launch(settings.tool);
    if (!launch?.ok) { say(`${name}: ${settings.tool} is not available (${launch?.hint || launch?.reason}), skip`); return 'skipped'; }
    const now = deps.now();
    const prompt = kind === 'reconcile'
      ? reconcilePrompt({ name, repo: repo.name, conflicts: sync.conflicts })
      : stepPrompt({ name, repo: repo.name, planPath: plan.path, planText: plan.text, step: choice.step, index: choice.index, now });
    const instructions = [await deps.profile(), role.overlay].filter(Boolean).join('\n\n---\n\n');
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: settings.model, instructions, prompt, profileArgs });

    const ts = stamp().replace(/[-:]/gu, '');
    const out = join(paths.log, `${name}-${ts}.json`);
    // A plan that names no model on a tool that is not claude gets none, and
    // the line says so rather than printing `null`: the tool picks.
    say(`${name}: ${kind} starting (${launch.shortName} ${settings.model || 'own default model'}, ${settings.budgetMinutes} min)`);
    const t0 = deps.now().getTime();
    // The lane's current file exists exactly as long as the session does —
    // written before the call that blocks, removed however that call
    // returns. It carries its repo, which is also its lane's name.
    const currentPath = paths.currentFor(repo.name);
    writeJson(currentPath, {
      name, kind, repo: repo.name, tool: settings.tool, model: settings.model,
      budget_minutes: settings.budgetMinutes, started: stamp(), pid, worktree,
    });
    let result;
    try {
      result = await deps.session({ bin: launch.spec.bin, args, cwd: worktree, timeoutMs: settings.budgetMinutes * 60_000 });
    } finally {
      remove(currentPath);
    }
    const seconds = Math.round((deps.now().getTime() - t0) / 1000);
    deps.write(out, result.stdout);
    deps.write(`${out}.err`, result.stderr);

    if (kind === 'reconcile' && deps.git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
      deps.git(worktree, ['merge', '--abort']);
      say(`${name}: reconcile did not finish — merge aborted`);
    }
    const branch = gitOut(worktree, ['branch', '--show-current']) || name;
    // What this project has open *now* — the same question `queue()` asked
    // before the session, asked again because the session is what changed the
    // answer. One `gh` call, and it gives both the row's `pr` (the one on this
    // branch) and what there is to land, which for a stack is more than one.
    const asked = deps.gh(worktree, PR_LIST_ARGS);
    let openNow = [];
    try {
      if (!asked.ok) throw new Error(lastLine(asked));
      openNow = openPrsFor({ prs: JSON.parse(asked.stdout || '[]'), name, names: plans.map((p) => p.project) });
    } catch (error) {
      say(`${name}: GitHub could not be asked what this project has open (${error?.message || error}) — nothing is landed this round`);
    }
    const pr = String(openNow.find((item) => item.headRefName === branch)?.number ?? '-');
    const read = readSessionOutput({ toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut });
    let { note } = read;

    // The boundary, checked instead of asked for. A step session edits its own
    // step, the criteria it met and what the code taught it; a session that
    // rewrote a step it did not run, added one, or widened the scope leaves a
    // PR the runner will not merge. Nothing is reverted here — the branch is
    // the session's work and Martin reads the PR.
    if (kind === 'step' && note === 'success') {
      const after = readPlanText(deps.read(plan.path) || '');
      const trespass = after.plan
        ? unauthorisedChanges(plan.plan, after.plan, choice.index)
        : { ok: false, problems: [`the plan no longer parses: ${after.problems[0]}`] };
      if (!trespass.ok) {
        note = 'plan-trespass';
        for (const problem of trespass.problems) say(`${name}: ${problem}`);
        say(`${name}: #${pr} left open — the session changed more of the plan than its step`);
      }
    }

    let landSeconds = null;
    if (merge && openNow.length && note === 'success') {
      const landed = await landProject(worktree, repo, name, openNow);
      note = `success,${landed.note}`;
      landSeconds = landed.seconds;
    }

    logRun({ ts: stamp(), name, kind, exit: result.status, seconds, pr, turns: read.turns, input: read.input, output: read.output, cacheRead: read.cacheRead, cacheWrite: read.cacheWrite, session: read.session, note, landSeconds });
    say(`${name}: ${kind} done rc=${result.status} ${seconds}s pr=${pr} turns=${read.turns} note=${note}${landSeconds == null ? '' : ` land=${landSeconds}s`}`);
    if (read.quota) await quotaPause();
    // The queue is Martin's "these first", and it empties itself: this
    // project has had its step, so its name leaves the file now.
    dropFromQueue(name);
    // A merged step or a finished reconcile both leave the project ready for
    // its next step now; 'merged' is the round's cue to stay on it.
    return note === 'success,merged' || (kind === 'reconcile' && note === 'success') ? 'merged' : 'ran';
  }

  /**
   * The queue, re-read every round: queue.md, then every plan on origin/main,
   * then what GitHub says is open. `only` narrows it to one repository — what
   * a lane re-reads mid-round, so two lanes never fetch the same repository at
   * the same moment.
   *
   * The third question is the one the runner never asked before it acted: one
   * `gh pr list` per repository, where the network is already being paid for
   * by the fetch beside it, and the answer decides which projects may start
   * anything at all (`runStep`). A repository GitHub could not be asked for is
   * named in `prsFailed` and starts nothing this round: not knowing what is
   * open is what bought a 120-minute session to rebuild work that was already
   * open as #11241, and an idle round costs ten minutes of sleep.
   */
  function queue({ only = null } = {}) {
    const plans = [];
    const prs = [];
    const prsFailed = [];
    for (const repo of repos) {
      if (only && repo.name !== only) continue;
      if (!deps.exists(join(repo.path, '.git'))) continue;
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      plans.push(...listPlans(repo, { git: gitOut, batch: showBatch(gitOut) }));
      const asked = deps.gh(repo.path, PR_LIST_ARGS);
      try {
        if (!asked.ok) throw new Error(asked.stderr.trim().split('\n').at(-1) || 'gh pr list failed');
        prs.push(...JSON.parse(asked.stdout || '[]').map((pr) => ({ repo: repo.name, ...pr })));
      } catch (error) {
        prsFailed.push(repo.name);
        say(`${repo.name}: GitHub could not be asked what is open (${error?.message || error}) — no step starts in this repository this round`);
      }
    }
    return { names: assembleQueue(deps.read(paths.queue) || '', plans), plans, prs, prsFailed };
  }

  /**
   * The queue split into lanes: one lane per repository, Martin's order kept
   * within each. A name whose repository cannot be told (no workarea and no
   * plan on main) rides in a lane of its own, where `runStep` says so and
   * skips it.
   */
  function splitLanes(names, plans) {
    const lanes = new Map();
    for (const name of names) {
      const repo = repoOf(name, plans)?.name || null;
      if (!lanes.has(repo)) lanes.set(repo, []);
      lanes.get(repo).push(name);
    }
    return [...lanes].map(([repo, laneNames]) => ({ repo, names: laneNames }));
  }

  /**
   * One lane: its names in order, one step at a time. A project whose step
   * merged keeps the lane — its next step follows at once (plans re-read, so
   * the merged status is what decides) instead of waiting a whole round
   * behind every other project — 2026-08-29 a six-step plan would have taken
   * six rounds of twenty projects. STOP is honoured between those steps too.
   */
  async function runLane({ repo = null, names = [] }, world, { once = false } = {}) {
    let known = Array.isArray(world) ? { plans: world } : world;
    let ran = 0;
    for (const name of names) {
      let r = await runStep(name, known);
      for (let stayed = 0; ; stayed += 1) {
        if (r === 'stop') return { ran, stop: true };
        if (r === 'ran' || r === 'merged') {
          ran += 1;
          if (once) return { ran, stop: false, once: true };
          await deps.sleep(60_000);
        }
        if (stopRequested()) { say(`runner exit on STOP after ${name} (remove ${paths.stop} before the next start)`); return { ran, stop: true }; }
        if (r !== 'merged' || stayed >= 8) break;
        // Re-read: the plan the merge advanced, and what GitHub has open now
        // — the step that just landed may have left a second pull request.
        known = queue({ only: repo });
        const status = known.plans.find((p) => p.project === name)?.status;
        if (!status || status === 'done') break;
        say(`${name}: step merged and the plan is ${status} — staying on ${name}`);
        r = await runStep(name, known);
      }
    }
    return { ran, stop: false };
  }

  /**
   * One pass: the day's helper if it is due, then every queued project —
   * memoro's lane and memoro-cli's at the same time, in the one process.
   * Returns { ran, stop } — the helper is not counted, it is not a step.
   *
   * The lanes never touch: different main branches, different worktrees,
   * different PRs. What they do share is the Claude quota (`quotaPause`) and
   * the STOP file, which ends both lanes after the step each is in. With
   * only one repository holding ready plans there is one lane, and a round
   * is exactly what it was before.
   */
  async function round({ once = false } = {}) {
    // The day's helper first, and only in a round that is a round: `--once`
    // exists to watch a single step, and a two-minute model turn over
    // production is not what somebody typing it asked for.
    if (!once && !stopRequested()) await runHelperDay();
    const world = queue();
    const { names, plans } = world;
    if (!once) tidyQueue(plans);
    // A plan that says `done` is archived in the round the runner reads it,
    // before any step of that round runs — one PR per repository, and the
    // two repositories never touch. Not under `--once`, for the reason the
    // helper is not: that is one step to watch, not a round.
    const archives = once ? [] : await Promise.all(repos.map((repo) => archiveDone(repo, plans)));
    const archived = archives.flatMap((a) => a.archived);
    const landed = archives.flatMap((a) => a.landed);
    const left = names.filter((name) => !archived.includes(name));
    // `--once` is one step, so it is one lane over the whole queue in
    // Martin's order — there is nothing for a second lane to do.
    const lanes = once ? [{ repo: null, names: left }] : splitLanes(left, plans);
    if (lanes.length > 1) say(`lanes: ${lanes.map((lane) => `${lane.repo || 'unplaced'} (${lane.names.length})`).join(', ')}`);
    const results = await Promise.all(lanes.map((lane) => runLane(lane, world, { once })));
    const out = {
      ran: results.reduce((sum, r) => sum + r.ran, 0),
      stop: results.some((r) => r.stop),
    };
    // Last of all, and only in a whole round that was not cut short: the
    // workareas whose plan left main this round are taken down, and the ones
    // with no plan at all are written where Martin looks. `--once` changes
    // nothing but the one step it exists to watch.
    if (!once && !out.stop) closeWorkareas(plans, landed, archivedProjects());
    if (results.some((r) => r.once)) out.once = true;
    return out;
  }

  /** runner.json — a runner is here, and this is the pid to test for life. */
  const markRunner = () => writeJson(paths.runner, { pid, started: stamp() });
  const clearRunner = () => {
    remove(paths.runner);
    for (const repo of repos) remove(paths.currentFor(repo.name));
  };

  return {
    paths, say, round, runStep, runLane, splitLanes, runHelperDay, archiveDone, queue, stopRequested,
    updateRequested, syncMain, freshBranch, landProject, landDocsPr, planOf, repoOf, markRunner, clearRunner, closeWorkareas,
    closeWorkarea, archivedProjects, workareas, tidyQueue,
  };
}

/**
 * The loop: rounds until `rounds` is reached (0 = forever), a STOP file
 * appears, or `--once` has run its one step.
 */
export async function runLoop({
  rounds = 0, once = false, merge = true, idleSleepMs = 600_000,
  // The machine's sleep, held for the length of the run. On by default,
  // because a runner that stops because the laptop dozed is the failure this
  // exists for and nobody would think to ask for the flag beforehand.
  awake = true,
  deps = realDeps(),
} = {}) {
  const runner = createRunner({ merge, deps });
  if (runner.stopRequested()) { runner.say(`STOP file present (${runner.paths.stop}) — remove it before starting`); return 2; }
  runner.say(`runner start (mc run, merge=${merge ? 1 : 0} rounds=${rounds} once=${once ? 1 : 0})`);
  // Before the first round, so a run that is going to be unattended is already
  // holding the assertion by the time anybody walks away from it. `--once` is
  // a person watching one step and does not need it.
  //
  // Nothing releases this: `caffeinate -w <pid>` watches this process and
  // exits when it does, including when it is killed with a signal no handler
  // can see. A `finally` here would be a worse version of that, and would not
  // run in exactly the case that matters.
  if (awake && !once) {
    const held = (deps.keepAwake || keepAwake)({ pid: process.pid, onAC: (deps.onACPower || onACPower)() });
    runner.say(held.ok
      ? `staying awake (caffeinate ${held.flags.join(' ')} pid ${held.pid}) — ${held.note}`
      : `NOT staying awake (${held.reason}) — this machine may sleep mid-run: ${held.note}`);
  }
  runner.markRunner();
  // A handover is the one exit that must not clear runner.json: the runner it
  // handed to has already written its own, and removing it on the way out
  // would leave the page saying nothing is running while something is.
  let handedOver = false;
  try {
    let n = 0;
    while (rounds === 0 || n < rounds) {
      n += 1;
      const r = await runner.round({ once });
      if (r.stop) { runner.say(`runner exit on STOP (remove ${runner.paths.stop} before the next start)`); return 0; }
      if (r.once) { runner.say('once: exiting'); return 0; }
      runner.say(`round ${n} done (${r.ran} ran)`);
      // `mc run --update`, read where STOP is read: between rounds, with no
      // session in flight and nothing half-done. runner.json is cleared before
      // the new runner is started rather than after, so the two never race for
      // the same file.
      if (runner.updateRequested()) {
        runner.clearRunner();
        const handed = await (deps.handOver || handOver)({ paths: runner.paths, deps, say: runner.say });
        if (handed.ok) { handedOver = true; return 0; }
        runner.markRunner();
      }
      if (r.ran === 0 && (rounds === 0 || n < rounds)) await deps.sleep(idleSleepMs);
    }
    runner.say(`runner exit after ${rounds} round(s)`);
    return 0;
  } finally {
    if (!handedOver) runner.clearRunner();
  }
}
