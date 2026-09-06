/**
 * `mc run` — the runner, inside mc.
 *
 * One round is one pass over the queue; one step is one fresh headless
 * session in one workarea, then the merge of the PR it opened. The runner
 * decides nothing with a model: it reads files, runs git and gh, starts the
 * session through the launch adapter and waits for it. No inbox, no knock,
 * no watcher — it is the parent of the process it starts.
 *
 * Each repository is a lane, and each lane runs its own rounds on its own
 * clock: memoro's steps and memoro-cli's never touch (different main
 * branches, different worktrees), so neither waits for the other's round to
 * end. Nothing new to type or start — the lanes are inside the one `mc run`
 * process, and one repository with ready plans is one lane. `--rounds N` and
 * `--once` still drive one shared round at a time, for a person watching.
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
 * removed by a machine; it is written to `~/mc/runner/unplanned-workareas.md`
 * instead. The rules are in close-workarea.js.
 *
 * The same holds for a plan on origin/main that does not parse: the runner can
 * hand out no step from it and must not guess at what its author meant, so it
 * goes to `~/mc/runner/unreadable-plans.md` (plan-intake.js) rather than to a
 * `runner.log` line nobody reads. `new-user` had that line every round for a
 * day, and the fault was five paragraphs of prose in a validated field.
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
 * A pull request the runner will **not** land is written down rather than
 * logged and forgotten: `~/mc/runner/held.json` carries every one of them with
 * the reason — a red gate, a plan trespass, a session that timed out with its
 * work pushed — and an entry leaves the file when its pull request lands or
 * stops being open. It is mc's own state beside `runner.json`, never a status
 * in a plan, and it is what the page draws as `held before merge`. The rules
 * are held.js.
 *
 * `~/mc/queue.md` is Martin's "these first" and nothing else: names of
 * projects that still have a step to run, one per line. The round rewrites it
 * to that shape and a name leaves it the moment its step has run, so a queue
 * everything ran from is an empty file.
 *
 * Two things that are not steps ride along, and neither opens a worktree or
 * touches a branch. `runHelperDay` is the collect: once per calendar day at the
 * top of the first round after 05:00Z, one digest per repository into
 * `~/mc/intake/`, no model. `runIntakeDrain` is the inbox: every round, the
 * oldest files in `~/mc/intake/` up to `INTAKE_PER_ROUND`, one headless turn
 * each, each file archived under `~/mc/runner/log/intake/<date>/` the moment its
 * turn ends. They used to be one gate and one row, which meant one file could be
 * read a day and only if the collect had also run.
 *
 * The runner is worked from another terminal by three files under
 * `~/mc/runner/`, all read at a round boundary and never mid-session: `STOP`
 * ends it, `UPDATE` makes it fast-forward mc's own checkout and hand over to a
 * fresh process on the new code. `mc run start|stop|--update` write them; the
 * rules and the handover are in run-control.js. `UPDATE` has one writer that
 * is not a person — a landing that changed `src/mc/` or `canon/`, which is
 * the runner having merged the code it is running (`askForUpdate`).
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
import {
  bumpRepairs, heldPath, holdDetails, holdPr, holdReason, holdsAfterSession, parseHeld,
  reconcileHeld, releasePr,
} from './held.js';
import { defaultRepos, listPlans, showBatch } from './brief-collect.js';
import { readPlanText, unauthorisedChanges } from './plan-schema.js';
import { isPlanPath, mergePlanText } from './plan-merge.js';
import { closable, lastRunFor, unplannedFile, unplannedRow } from './close-workarea.js';
import { unreadableFile, unreadablePlans } from './plan-intake.js';
import { handOver, readRunner } from './run-control.js';
import { collectHelper, describeDigest, HELPER_REPOS, unreadableSections } from './helper-collect.js';
import { describeTurn, drainIntake, runHelperTurn } from './helper-turn.js';
import {
  UNDOCUMENTED_CLOSURES, UNPLANNED_WORKAREAS, UNREADABLE_PLANS, runnerTablePath, workRoot,
} from './paths.js';
import { runDocsMerge } from './docs-merge.js';
import { runMergeRound } from './repo-merge.js';
import { kindFor, pidAlive } from './status-collect.js';
import { PR_LIST_ARGS, openPrsFor } from './project-prs.js';
import { loadProfile, profileArgs } from './portrait.js';
import { readLaneCount } from './lane-count.js';
import { instructionsFor, readCanonRole, roleRecord, roleSourceOf } from './roles.js';
import { keepAwake, onACPower } from './stay-awake.js';
import { addWorktree } from './work-area.js';
import {
  HELPER_KIND, HELPER_NAME, INTAKE_KIND, INTAKE_PER_ROUND, QUOTA_SLEEP_MS, REFUSAL, TIMEOUT_EXIT,
  assembleQueue, chooseKind, collectNote, headlessArgs,
  heldRepair, helperDue, inFlight, intakeNote, landingNote, mcOwnFiles, nextBranch, queueFileNames,
  queueFileText, readSessionOutput, repairPrompt, sessionSettings, stackOrder,
  stepOfPr, stepPrompt, strictQueue, tsvHeader, tsvRow,
} from './run-plan.js';

export const REPO_NAMES = ['memoro', 'memoro-cli'];

/**
 * A landing that met another round. `busy` is the gate lock (one gate round
 * on this machine), `lease` the repository lease (one holder per repository);
 * both are live rounds that end in minutes, and the runner waits for them
 * rather than leaving the pull request open — see `landPr`.
 */
export const BUSY_STOPS = ['busy', 'lease'];
export const LAND_WAIT_MS = 45 * 60 * 1000;
export const LAND_RETRY_MS = 30 * 1000;
/** How often an idle lane looks again while an UPDATE waits for the quiet moment. */
export const UPDATE_POLL_MS = 30 * 1000;
/** How often a lane held back by the total cap looks for a free slot again. */
export const TOTAL_POLL_MS = 15 * 1000;

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
    // The one liveness test the page, `mc run start` and the loop's own
    // refusal all use, so a runner.json that names a pid means the same thing
    // to every reader of it.
    alive: pidAlive,
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    list: (path) => { try { return readdirSync(path); } catch { return []; } },
    // Files only, for the one caller that must not mistake a directory for an
    // item: `~/mc/intake/decisions-archive/` is an archive, not an inbox entry.
    files: (path) => {
      try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; }
    },
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
    // no production behind it and no model in it. The drain itself is not a
    // dependency — it is handed `files`, `move` and `helperTurn` above, so a
    // test's filesystem is the one it archives into and the loop is measured
    // rather than replaced.
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
    //
    // The session's Bash tool gets a ten-minute ceiling instead of claude's
    // two-minute default. Measured 2026-09-01..03: with two minutes, a step
    // ran `npm test` in the background and polled it in `sleep` loops of
    // 120 s — 212 such calls, 1.9 h of 12.5 h tool time — and 17 calls were
    // killed on the timeout itself. A suite run is one call now.
    session: ({ bin, args, cwd, timeoutMs }) => new Promise((resolve) => {
      const sessionEnv = { ...env, BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '600000' };
      const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM', env: sessionEnv });
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

/**
 * The plan a repair session's edits are judged against, and the step it was
 * allowed to edit. Null when there is no plan to judge by at all.
 *
 * An ordinary repair is judged against the plan it was handed — the step that
 * names this pull request is its own. A repair of a `plan-trespass` is judged
 * against the plan on origin/main, because the plan it was handed is the
 * trespass: the step's work has not landed, or it would not be held.
 */
function repairBaseline(entry, plan, onMain) {
  if (!plan?.path) return null;
  const before = entry.note === 'plan-trespass' && onMain ? onMain : plan.plan;
  return before ? { before, index: stepOfPr(before, entry.pr) } : null;
}

export function createRunner({
  merge = true, deps = realDeps(),
  // `lanes.json`'s second number, or null for no cap — read once by `runLoop`
  // and handed here, because the count of steps in flight has to be one count
  // for the whole process and this is the one object every lane shares.
  total = null,
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
    // Every pull request the runner would not land, with the reason it did
    // not. mc's own state beside the two above, never a status in a plan —
    // see held.js.
    held: heldPath(root),
    // With more than one lane per repository (`mc lanes`), the first keeps
    // the file's old name and the rest number themselves, so the page —
    // which reads `current-*.json` by name — needs no new rule.
    currentFor: (repo, lane = 0) => join(root, 'runner', lane ? `current-${repo}-${lane}.json` : `current-${repo}.json`),
    currents: () => deps.list(join(root, 'runner')).filter((file) => /^current-.+\.json$/u.test(file)).map((file) => join(root, 'runner', file)),
    // Where a closed workarea's filing goes — its inbox, its decisions, the
    // scratch directory a session left beside its checkout. Moved, never
    // deleted: the folder is what goes, not what somebody wrote in it.
    closed: join(root, 'runner', 'log', 'closed'),
    // The three tables the round writes about its own rounds, beside the rest
    // of the runner's state rather than in `~/mc/intake/`: two of them are
    // rewritten whole every round, so an inbox that drained one would find it
    // back the next round, forever (paths.js).
    undocumented: runnerTablePath(UNDOCUMENTED_CLOSURES, deps.env),
    unplanned: runnerTablePath(UNPLANNED_WORKAREAS, deps.env),
    unreadable: runnerTablePath(UNREADABLE_PLANS, deps.env),
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

  /**
   * The plan the workarea carries. `fromHead` reads the branch's own last
   * committed copy (`git show HEAD:<path>`) instead of the file on disk.
   *
   * That is for a worktree with a merge in progress. The file there may carry
   * conflict markers — after the plan rule (plan-merge.js) that is only the
   * case it refuses, two sides editing the same step, but it is exactly the
   * case a session is then handed. HEAD is the branch's last good copy, and
   * it is the right one: the step being handed out is the step this branch is
   * on. Main's own edits to the plan are what the session is merging in.
   */
  function planOf(worktree, name, { fromHead = false } = {}) {
    const base = join(worktree, 'docs', 'project');
    for (const programme of deps.list(base)) {
      const dir = join(base, programme, name);
      const path = join(dir, 'PLAN.json');
      if (deps.exists(path)) {
        const at = ['docs', 'project', programme, name, 'PLAN.json'].join('/');
        const text = (fromHead ? gitOut(worktree, ['show', `HEAD:${at}`]) : deps.read(path)) || '';
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
   * A conflicted `PLAN.json`, merged by the plan's own rule about who may
   * write what (`plan-merge.js`) rather than by a session.
   *
   * The three sides come out of the index, which is where git keeps them
   * while a merge is in progress: `:1:` the merge base, `:2:` ours — this
   * project's branch — and `:3:` theirs, origin/main. Resolved means written
   * and staged; the commit is `syncMain`'s, once every conflict is gone.
   *
   * Returns true when the file is resolved. Every other answer is a line in
   * runner.log saying which side of the rule it fell off, because the next
   * reader of that file is deciding whether the refusal was right.
   */
  function resolvePlanConflict(worktree, name, path) {
    const stage = (n) => {
      const shown = deps.git(worktree, ['show', `:${n}:${path}`]);
      return shown.ok ? String(shown.stdout ?? '') : null;
    };
    const merged = mergePlanText({ base: stage(1), branch: stage(2), main: stage(3) });
    if (!merged.ok) {
      say(`${name}: ${path} is not resolvable by the plan's rule — ${merged.why}`);
      return false;
    }
    deps.write(join(worktree, path), merged.text);
    if (!deps.git(worktree, ['add', '--', path]).ok) {
      say(`${name}: ${path} was merged by the plan's rule but could not be staged`);
      return false;
    }
    const took = merged.took.length ? merged.took.join(', ') : 'nothing either side had changed';
    say(`${name}: ${path} resolved by the plan's own rule — ${took}`);
    return true;
  }

  /**
   * Merge origin/main into the area branch — never rebase. Two conflicts are
   * resolved here without a session: an identical .gitignore hunk, and a
   * PLAN.json whose two sides wrote to different steps. Anything else — and
   * any plan the rule refuses — is left in progress for the step session.
   */
  function syncMain(worktree, name) {
    if (!deps.git(worktree, ['fetch', '-q', 'origin']).ok) return { ok: false, conflicts: [] };
    if (deps.git(worktree, ['merge', '-q', '--no-edit', 'origin/main']).ok) return { ok: true, conflicts: [] };
    const conflicts = (gitOut(worktree, ['diff', '--name-only', '--diff-filter=U']) || '').split('\n').filter(Boolean);
    if (conflicts.length === 1 && conflicts[0] === '.gitignore') {
      if (deps.git(worktree, ['checkout', '--theirs', '.gitignore']).ok && deps.git(worktree, ['add', '.gitignore']).ok && deps.git(worktree, ['commit', '-q', '--no-edit']).ok) return { ok: true, conflicts: [] };
    }
    const left = conflicts.filter((path) => !(isPlanPath(path) && resolvePlanConflict(worktree, name, path)));
    if (!left.length) {
      if (deps.git(worktree, ['commit', '-q', '--no-edit']).ok) return { ok: true, conflicts: [] };
      // Resolved, staged, and the commit refused: not a conflict any more and
      // not a merge either. The round skips the project rather than start a
      // session in a worktree mid-merge.
      say(`${name}: ${conflicts.join(' ')} resolved, but the merge would not commit`);
      return { ok: false, conflicts: [] };
    }
    say(`${name}: merge conflict in: ${left.join(' ')}`);
    return { ok: false, conflicts: left };
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

  /* --------------------------------------------------- held before merge */

  /**
   * `~/mc/runner/held.json`, read-modify-written through these three and
   * nowhere else.
   *
   * Every lane may hold a pull request, and two lanes land at the same time,
   * so the file is never held open across an await: it is read, changed and
   * written whole (`writeJsonAtomic`) inside one turn, which is what makes a
   * lane's hold safe beside another's. The rules themselves are pure, in
   * held.js.
   */
  const heldNow = () => parseHeld(deps.read(paths.held));

  function hold(entry) {
    writeJson(paths.held, holdPr(heldNow(), { ...entry, since: stamp() }));
  }

  /** This pull request's one repair, counted before the session starts. */
  function countRepair(repo, pr) {
    writeJson(paths.held, bumpRepairs(heldNow(), { repo, pr: Number(pr) }));
  }

  function release(repo, pr) {
    const entries = heldNow();
    const kept = releasePr(entries, { repo, pr: Number(pr) });
    if (kept.length !== entries.length) writeJson(paths.held, kept);
  }

  /**
   * The file against what the round has just asked GitHub. A pull request
   * somebody merged or closed by hand is not held any more, and nothing else
   * would ever have taken it out of the file.
   */
  function reconcileHold({ prs = [], repos: asked = [] }) {
    const entries = heldNow();
    if (!entries.length) return;
    const { kept, dropped } = reconcileHeld(entries, { prs, repos: asked });
    if (!dropped.length) return;
    for (const entry of dropped) say(`held: ${entry.project} #${entry.pr} is no longer open — no longer held before merge`);
    writeJson(paths.held, kept);
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
  async function landPr(repo, name, pr, { branch = null } = {}) {
    const round = () => deps.mergeRound({
      repoPath: repo.path,
      pr: Number(pr),
      // Who holds the repository for the length of the round. `currentHolder()`
      // would answer `user@host` from wherever the runner process happens to
      // stand; the workarea is the answer `mc repo who` is asked for.
      holder: { name, kind: 'work-area' },
      onProgress: (message) => say(`${name}: merge #${pr} — ${message}`),
    });
    let report = await round();
    // The gate lock and the repository lease both *refuse* a second round
    // rather than queueing it (gate-lock.js: one gate round on this machine;
    // repo-lease.js: one holder per repository), and that stays as it is —
    // the guarantee is one suite at a time. What changes is what this caller
    // does with the refusal: it used to log `#N left open` and move on, which
    // parked the project until a person merged by hand, because an open pull
    // request stops its project. Two lanes landing at once did that to each
    // other; with several steps in flight per repository it would be routine.
    // So a refused round waits — for a live round, which is minutes — and
    // asks again, up to `LAND_WAIT_MS` in all.
    const t0 = deps.now().getTime();
    let waited = false;
    while (report && BUSY_STOPS.includes(report.stopped_at) && deps.now().getTime() - t0 < LAND_WAIT_MS) {
      if (!waited) say(`${name}: merge #${pr} — waiting for the gate: ${report.reason}`);
      waited = true;
      await deps.sleep(LAND_RETRY_MS);
      if (stopRequested()) break;
      report = await round();
    }
    if (waited) say(`${name}: merge #${pr} — waited ${Math.round((deps.now().getTime() - t0) / 1000)}s for the gate`);
    const note = landingNote(report);
    if (note === 'merged') {
      // It landed, so nothing holds it any more — including a hold an earlier
      // round wrote, which is how a repaired pull request leaves the file.
      release(repo.name, pr);
      say(`${name}: merged #${pr} into ${report.merged_into} through the gate`);
      askForUpdate(repo, name, pr);
    } else if (note.startsWith('off-')) say(`${name}: #${pr} was merged into ${report.merged_into}, NOT main — not recorded as merged`);
    else {
      // The one place the runner knows a pull request is held and why, and
      // until now the only trace was this line. Written down first, said
      // second.
      const reason = report?.reason || 'the merge round said nothing';
      // With what the gate saw: the red tests by name and the output of every
      // command gate that failed. The report is the only place either exists,
      // and the repair session is the reader.
      hold({ project: name, repo: repo.name, pr: Number(pr), branch, reason, note, ...holdDetails(report) });
      say(`${name}: #${pr} left open — ${reason}`);
    }
    return note;
  }

  /**
   * The second writer of `runner/UPDATE`, and the only one that is not a
   * person: a landing that changed mc's own code.
   *
   * A step may change the rules the runner judges the next step by — the plan
   * schema, `unauthorisedChanges`, the prompt — and the runner is the code
   * being changed while it is running. Node read its module graph at process
   * start, so the round after a merge of `plan-schema.js` judges plans with
   * the schema the process was started with. Measured 2026-09-02: a step
   * migrated every plan on both mains, the runner re-read them with the old
   * schema, they did not parse, and a session that did nothing wrong was
   * logged `plan-trespass`.
   *
   * GitHub's own file list for the merged pull request is what decides it,
   * the way `docs-merge.js` reads a docs PR's files — not the gate's report,
   * whose `files` are the *test* files its selection ran, and not a local
   * diff a stale checkout could answer wrong. `landDocsPr` needs none of
   * this: `runDocsMerge` refuses anything outside `docs/`, and neither
   * `src/mc/` nor `canon/` is under it, so the gate is the only door mc's own
   * code can come through.
   *
   * This writes the flag and nothing more. The reader is `runLoop`'s existing
   * one, at the round boundary, never mid-session, and `mc run --update`
   * keeps its own meaning as the human order — this adds a second writer of
   * one file, not a second kind of handover.
   */
  function askForUpdate(repo, name, pr) {
    const asked = deps.gh(repo.path, ['pr', 'view', String(pr), '--json', 'files', '-q', '.files[].path']);
    if (!asked.ok) {
      say(`${name}: GitHub could not be asked which files #${pr} changed (${lastLine(asked)}) — no update requested`);
      return false;
    }
    const own = mcOwnFiles(String(asked.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean));
    if (!own.length) return false;
    // STOP is already written: this runner finishes the round and exits, and
    // a fresh one reads the new code because it is a fresh process. Leaving
    // UPDATE behind for whoever starts the next runner by hand would hand it
    // over on its first round for nothing — the same refusal `requestUpdate`
    // makes for the same reason.
    if (stopRequested()) {
      say(`${name}: #${pr} changed mc's own code, but STOP is written — the next runner starts on it anyway`);
      return false;
    }
    if (updateRequested()) return true;
    deps.write(paths.update, `${stamp()}\n`);
    say(`${name}: #${pr} changed mc's own code (${own.slice(0, 3).join(' ')}${own.length > 3 ? ` +${own.length - 3} more` : ''}) — UPDATE written, handing over after this round`);
    return true;
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
   * has not landed. A conflict is not resolved here, and it is not the
   * conflicted `git merge origin/main` a step session is handed: a squashed
   * base breaking the branch above it is a different cause with a different
   * answer. Abort, name the files, and stop on this project.
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
    if (!stack.ok) {
      say(`${name}: ${stack.reason} — landing none of them`);
      // Not one of these is going to be landed by anything the runner does
      // next, and every one of them keeps the project from starting a step.
      for (const pr of prs) hold({ project: name, repo: repo.name, pr: Number(pr.number), branch: pr.headRefName, reason: stack.reason, note: 'open,not-a-stack' });
      return { note: 'open,not-a-stack', seconds: took() };
    }
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
        if (!replayed.ok) {
          say(`${name}: ${replayed.why} — stopping on this project for the round`);
          hold({ project: name, repo: repo.name, pr: Number(pr.number), branch: pr.headRefName, reason: replayed.why, note: 'open,stack-stopped' });
          return { note: 'open,stack-stopped', seconds: took() };
        }
      }
      note = await landPr(repo, name, pr.number, { branch: pr.headRefName });
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
      if (!deps.exists(paths.undocumented)) deps.write(paths.undocumented, UNDOCUMENTED_HEADER);
      deps.append(paths.undocumented, `${undocumented.join('\n')}\n`);
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
   * `bin/`, `brief/`, `inbox/`, `intake/`, `runner/`, `status/`
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
   * One row of `~/mc/runner/unplanned-workareas.md`. `branch` is asked of
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

  /**
   * The plans on `origin/main` the schema refuses, written where the workareas
   * with no project are written. `chooseKind` says `unparseable` and `runStep`
   * logs it, and that line is read by nobody: `new-user` had one every round
   * for a day. Written from the round's own reading, so it costs nothing, and
   * rewritten whole, so a plan somebody fixed leaves the list by itself.
   *
   * Not gated on `--once` as the closing is: this is a write of what the round
   * has already read, not a pass over every workarea.
   */
  function writeUnreadable(plans) {
    const rows = unreadablePlans(plans);
    deps.write(paths.unreadable, unreadableFile(rows));
    for (const row of rows) say(`${row.project}: the plan does not parse on origin/main — ${row.problem}`);
    if (rows.length) say(`plans: ${rows.length} unreadable on origin/main — ${paths.unreadable}`);
    return rows.length;
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
   * The day's collect, run at the top of a round. Returns 'ran', 'failed' or
   * null when it was not due.
   *
   * It is not a step and not a project: it opens no worktree, touches no
   * branch, calls no model, and its rows in runs.tsv carry `helper` in both the
   * name and the kind column. `helperDue` is the whole gate, and those rows are
   * the whole state — one per repository, written whether the collect succeeded
   * or failed, which is how a failed collect stays unretried for the rest of the
   * day.
   *
   * Reading the digest is no longer part of this. The digest lands in the inbox
   * like anything else somebody put there, and `runIntakeDrain` takes it in its
   * turn — which is what lets a round drain without collecting, and collect
   * without the day's reading being the only reading there is.
   */
  async function runHelperDay() {
    const due = helperDue({ tsv: deps.read(paths.runs) || '', now: deps.now() });
    if (!due.due) return null;
    const t0 = deps.now().getTime();
    const took = () => Math.round((deps.now().getTime() - t0) / 1000);
    say('helper: the day\'s digest');

    // One digest per repository. memoro's production is the deployed service;
    // memoro-cli's is this machine, and until 2026-08-30 nothing read the
    // second — every failure in mc itself was found by a person noticing it.
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
      }
      if (digest) {
        say(`helper: ${digest.path} — ${describeDigest(digest.data)}`);
        for (const note of digest.data.notes || []) say(`helper: ${repo}: ${note}`);
        for (const [section, source] of unreadableSections(digest.data)) say(`helper: ${repo}: ${section} not read — ${source.error}`);
        if (outcome !== 'failed') outcome = 'ran';
      }
      logRun({
        ts: stamp(), name: HELPER_NAME, kind: HELPER_KIND, exit: digest ? 0 : 1, seconds: took(), pr: '-',
        ...dashes, note: collectNote({ repo, digest }),
      });
    }
    return outcome;
  }

  /**
   * The inbox, drained: the oldest files in `~/mc/intake/` up to
   * `INTAKE_PER_ROUND`, one headless turn each, each one archived under
   * `~/mc/runner/log/intake/<date>/` the moment its turn ends.
   *
   * There is no day gate here and there is not meant to be — the question is
   * *is there a file?*, and a round asks it every time. Thirteen files is
   * therefore five rounds rather than thirteen days, and a round with an empty
   * inbox costs a directory listing.
   *
   * The row is `kind: intake` with the **file** in the name column: a reader of
   * runs.tsv who cannot tell thirteen turns apart has no record at all, and the
   * name column is the column for naming the thing a row is about. `intakeNote`
   * carries the outcome.
   */
  async function runIntakeDrain() {
    const out = await drainIntake({
      env: deps.env,
      now: deps.now,
      limit: INTAKE_PER_ROUND,
      deps: {
        files: deps.files,
        move: deps.move,
        turn: deps.helperTurn,
        stop: stopRequested,
        onTurn: async ({ file, turn, archived, seconds }) => {
          logRun({
            ts: stamp(), name: file, kind: INTAKE_KIND, exit: turn.status ?? 1, seconds, pr: '-',
            turns: turn.turns ?? '-', input: turn.input ?? '-', output: turn.output ?? '-',
            cacheRead: turn.cacheRead ?? '-', cacheWrite: turn.cacheWrite ?? '-', session: turn.session ?? '-',
            note: intakeNote(turn),
          });
          for (const note of turn.groundNotes || []) say(`intake: ${note}`);
          say(turn.ok
            ? `intake: ${file} — ${describeTurn(turn)} (${seconds}s)`
            : `intake: ${file} — the turn did not finish: ${turn.reason || turn.note} (${seconds}s)`);
          // The one way the drain fails to terminate, so it is said out loud
          // rather than inferred from the same file appearing every round.
          if (!archived) say(`intake: ${file} could not be moved out of the inbox — the next round will take it again`);
          if (turn.quota) await quotaPause();
        },
      },
    });
    if (out.left) say(`intake: ${out.left} file(s) still waiting`);
    return out;
  }

  /**
   * The machine's cap: at most `total` steps in flight anywhere, over every
   * repository at once, when `mc run lanes --total` has set one.
   *
   * `per_repo` needs nothing like this because it is structural — there are
   * exactly that many lane loops on each repository, so no one has to count.
   * A total cannot be: the lanes are independent loops over two repositories
   * and nothing about their shape says three. So it is a claim, and it lives
   * in this process beside `claims` below, for the reason that one does. A
   * count of `current-*.json` files would be the wrong instrument: the file
   * is written after the step begins, so two lanes reading it in one tick
   * both see a free slot and both start.
   *
   * Nothing is counted at all when no total is set. An operator who has never
   * set one gets exactly what they got before this existed, which is what
   * `lanes.json` promises for an absent number.
   *
   * Taken at the last moment before the session rather than at the top of the
   * round: a slot held while `runStepClaimed` fetches, merges and reads a
   * plan is a slot the other repository cannot use for the length of a `git
   * status` and a fetch, and most of those readings end in a refusal that
   * spends no session at all. What it costs is a reading thrown away when the
   * machine turns out to be full — seconds against the hour a session is.
   *
   * Which waiting lane gets a freed slot is whichever looks first, and that
   * is arbitrary. Measured 2026-09-05: 26 memoro plans with a ready step
   * against memoro-cli's 3, and a median step of 14 minutes (p90 58). The
   * repository with the work is the one that keeps asking, so under a cap the
   * small queue can wait behind the large one for as long as the large one
   * has steps. That hazard is named here rather than answered — no ordering
   * rule is built in this step, and none should be built before somebody has
   * watched what the cap actually does.
   */
  let running = 0;
  const cap = Number.isInteger(total) && total > 0 ? total : null;
  /** Take a slot, or don't — in one tick, with no await between the test and the take. */
  function takeSlot() {
    if (cap !== null && running >= cap) return false;
    running += 1;
    return true;
  }
  const dropSlot = () => { running -= 1; };
  /**
   * `ok` when the slot is held, `stop` or `update` when the wait was given up
   * on. One line when the waiting starts and none per attempt: runner.log
   * already carries ten thousand `, skip` lines and this is the kind of loop
   * that would add ten thousand more.
   *
   * It gives up on STOP for the obvious reason and on UPDATE for a contract
   * one: from the moment an UPDATE is read no lane starts a step, and a lane
   * that launched one after waiting out somebody else's would stretch a drain
   * that is meant to end within one step's length into two.
   */
  async function waitForSlot(name) {
    if (takeSlot()) return 'ok';
    say(`${name}: ${running} of ${cap} steps in flight on this machine — waiting for a lane`);
    for (;;) {
      await deps.sleep(TOTAL_POLL_MS);
      if (stopRequested()) return 'stop';
      if (updateRequested()) return 'update';
      if (takeSlot()) return 'ok';
    }
  }

  /**
   * One project. Returns 'merged' | 'ran' | 'stop' | `skipped:<reason>`.
   *
   * The reason is a word, not a sentence: `RUN_REFUSALS` for the machine-shaped
   * refusals and `chooseKind`'s own for the plan-shaped ones, which is the same
   * vocabulary `machineState` answers `mc status` in. Callers ask whether the
   * outcome is `ran`, `merged` or `stop` and nothing else — a `skipped:` prefix
   * is every way this ends without a session.
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
  /**
   * One project is in flight in one lane at a time, whatever the lanes'
   * slices say. The slices split a repository's names by index, but a lane
   * that merged a step stays on its project for the next one (`runLane`),
   * and another lane's round can read that project as ready — the pull
   * request that would stop it is not open yet, and the worktree is clean
   * for the first minute. Two sessions in one worktree is the failure this
   * refuses; the claim lives in this process, where the lanes are.
   */
  const claims = new Set();
  async function runStep(name, world = {}, { lane = 0 } = {}) {
    if (claims.has(name)) { say(`${name}: in flight in another lane, skip`); return 'skipped'; }
    claims.add(name);
    try {
      return await runStepClaimed(name, world, { lane });
    } finally {
      claims.delete(name);
    }
  }

  async function runStepClaimed(name, world = {}, { lane = 0 } = {}) {
    const { plans = [], prs = [], prsFailed = [] } = Array.isArray(world) ? { plans: world } : world;
    // Every way out of this round that is not a session goes through here, so
    // that what the round refused on is a word and not only a line in the log.
    // `machineState` answers `mc status` in the same words, and the agreement
    // test drives one case per word through both (tests/mc/run.test.js).
    const refuse = (reason, text = null) => { if (text) say(`${name}: ${text}`); return `skipped:${reason}`; };
    if (stopRequested()) { say(`STOP file present (${paths.stop}) — not starting ${name}`); return 'stop'; }
    // A quota answer in the other lane is this lane's answer too: wait it
    // out here, before a worktree is touched or a session is spent.
    await quotaHold();
    const repo = repoOf(name, plans);
    // `no-plan` and not a word of its own: no workarea and no plan on main is
    // the same fact `kindFor` answers with, met one question later.
    if (!repo) return refuse('no-plan', 'no workarea and no plan on main, skip');
    const worktree = join(root, name, repo.name);
    if (!deps.exists(worktree)) {
      say(`${name}: no workarea — creating ${repo.name} worktree from origin/main`);
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      const added = deps.addWorktree({ name, repo: repo.path, branch: name, from: 'origin/main', env: deps.env });
      if (!added.ok) return refuse(REFUSAL.worktree, `worktree add failed (${added.reason}), skip`);
    }
    // A dirty worktree parks the project for every round until a person acts,
    // so the line names the files: `email-window-layout` stood third in
    // queue.md and was skipped 134 rounds on three modified files before
    // anyone read the reason.
    const dirty = (gitOut(worktree, ['status', '--porcelain']) || '').trim();
    if (dirty) {
      // `XY path` per porcelain line; the whole is trimmed above, which takes
      // the first line's leading status space with it — hence a pattern, not
      // `slice(3)`, which printed `ublic/css/…` on 2026-09-04.
      const files = dirty.split('\n').map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/u, '').trim() || line.trim());
      const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '');
      return refuse(REFUSAL.dirty, `dirty worktree (${shown}) — skipped every round until it is committed or stashed in ${worktree}`);
    }
    if (prsFailed.includes(repo.name)) return refuse(REFUSAL['prs-unknown'], 'what is open on GitHub is unknown this round, skip');

    // Work already in flight ends the round for this project, whatever the
    // plan says — the plan on origin/main and the plan in the worktree both
    // read `ready` while the step's work sits in an open pull request. The
    // rule itself is `inFlight`, beside `chooseKind` in run-plan.js.
    const openPrs = openPrsFor({ prs, name, names: plans.map((p) => p.project), repo: repo.name });
    // Unless it is a pull request the runner itself would not land. That is not
    // work in flight — nothing is going to finish it — and its first round back
    // is one repair session rather than the same skip for ever. `heldRepair`
    // holds the whole rule, including the second round, which is the brief's.
    const repair = heldRepair({ entries: heldNow(), openPrs, project: name, repo: repo.name });
    if (repair?.skip) return refuse(repair.reason, repair.skip);
    if (!repair) {
      const flight = inFlight(openPrs);
      if (flight) return refuse(flight.reason, flight.skip);
    }
    // A session must be somewhere it can push from. The push-guard asks the
    // same question at the wrong end — after ninety minutes of work. A repair
    // is the exception: its branch carries the work being repaired, so it is
    // stood on rather than left behind.
    if (repair) {
      const on = gitOut(worktree, ['branch', '--show-current']);
      if (repair.entry.branch && on !== repair.entry.branch
        && !deps.git(worktree, ['checkout', '-q', repair.entry.branch]).ok) {
        return refuse(REFUSAL.branch, `#${repair.entry.pr} is on ${repair.entry.branch}, which this workarea could not check out, skip`);
      }
    } else {
      const moved = freshBranch(worktree, name);
      if (!moved.ok) return refuse(REFUSAL.branch, `${moved.why}, skip`);
    }

    const sync = syncMain(worktree, name);
    if (!sync.ok && !sync.conflicts.length) return refuse(REFUSAL.sync, 'fetch/merge failed, skip');
    // What git and the plan's own rule could not resolve. It no longer makes
    // the plan unreadable to the runner: the plan is read from HEAD and the
    // conflict goes to the step session as something to do first.
    const conflicts = sync.conflicts;
    const plan = planOf(worktree, name, { fromHead: conflicts.length > 0 });
    // A merge nobody is handed is a merge nobody finishes, and an unmerged
    // path is a dirty worktree — which skips the project every round until a
    // person acts. So every way out of this round that is not the step
    // session goes through here: abort, and leave the workarea as clean as
    // the old merge-only session's abort did.
    const abandonMerge = (why) => {
      if (!conflicts.length) return;
      deps.git(worktree, ['merge', '--abort']);
      say(`${name}: ${why} — the merge of origin/main is aborted, still conflicting in: ${conflicts.join(' ')}`);
    };
    // A repair used to be refused in a worktree with a merge in progress, on
    // the reasoning that the merge was not its job. That deadlocked the most
    // common hold there is: a pull request held *because* it conflicts with
    // main hits the same conflict when the runner syncs, so the repair was
    // refused for the very reason it was owed — every round, for ever.
    // Measured 2026-09-05: #612 and #614 both sat at `repairs: 0` with the
    // gate's reason reading `conflicts with origin/main`. Resolving the merge
    // is the repair; `repairPrompt` is handed the files.
    const choice = repair ? { kind: 'repair' } : chooseKind({ plan });
    if (conflicts.length && choice.kind !== 'step' && choice.kind !== 'repair') {
      abandonMerge(choice.skip || 'no session to hand it to');
      return refuse(choice.reason || 'no-plan');
    }
    // A null `skip` is a skip nobody would read — see `chooseKind`.
    if (!choice.kind) return refuse(choice.reason || 'no-plan', choice.skip ? `${choice.skip}, skip` : null);
    const { kind } = choice;

    const role = deps.role(kind);
    if (!role?.overlay) { abandonMerge(`canon/roles/${kind}.md is missing`); return refuse(REFUSAL['role-missing'], `canon/roles/${kind}.md is missing — skip`); }
    const settings = sessionSettings(plan?.plan?.runner || {});
    const launch = deps.launch(settings.tool);
    if (!launch?.ok) { abandonMerge(`${settings.tool} is not available`); return refuse(REFUSAL['tool-missing'], `${settings.tool} is not available (${launch?.hint || launch?.reason}), skip`); }
    // The machine's cap, claimed here — everything from this line to the
    // session is the launch itself, and nothing below returns without
    // spending it. Given up on the way `claims` refuses a project already in
    // flight: a bare `skipped`, because a slot that was not free at one
    // instant in this process is not a fact any file on this machine holds,
    // and `machineState` would have to guess at it.
    const slot = await waitForSlot(name);
    if (slot !== 'ok') {
      abandonMerge(slot === 'stop' ? 'STOP is present' : 'an UPDATE is pending');
      if (slot === 'stop') { say(`STOP file present (${paths.stop}) — not starting ${name}`); return 'stop'; }
      say(`${name}: UPDATE while waiting for a lane — starting no step, skip`);
      return 'skipped';
    }
    const now = deps.now();
    const prompt = kind === 'repair'
      ? repairPrompt({ name, repo: repo.name, ...repair.entry, conflicts })
      : stepPrompt({ name, repo: repo.name, planPath: plan.path, planText: plan.text, step: choice.step, index: choice.index, conflicts, now });
    // Counted before the session runs, not after: a repair killed on its budget
    // still had its one turn, and a count written afterwards would give the next
    // round a second repair for the same pull request.
    if (kind === 'repair') {
      countRepair(repo.name, repair.entry.pr);
      say(`${name}: #${repair.entry.pr} is held before merge — one repair session: ${repair.entry.reason}`);
    }
    const instructions = instructionsFor(launch.id, await deps.profile(), role.overlay);
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: settings.model, instructions, prompt, profileArgs });

    const ts = stamp().replace(/[-:]/gu, '');
    const out = join(paths.log, `${name}-${ts}.json`);
    // A plan that names no model on a tool that is not claude gets none, and
    // the line says so rather than printing `null`: the tool picks.
    say(`${name}: ${kind} starting (${launch.shortName} ${settings.model || 'own default model'}, ${settings.budgetMinutes} min)`);
    const t0 = deps.now().getTime();
    // The lane's current file exists exactly as long as the session does —
    // written before the call that blocks, removed however that call
    // returns. It carries its repo, which is also its lane's name. The
    // machine's slot is dropped in the same breath, so what the page shows
    // and what the cap counts are the same fact and cannot drift.
    const currentPath = paths.currentFor(repo.name, lane);
    writeJson(currentPath, {
      name, kind, repo: repo.name, lane, tool: settings.tool, model: settings.model,
      budget_minutes: settings.budgetMinutes, started: stamp(), pid, worktree,
      // Which role text this session is actually running on. `kind` already
      // names the role, but a name is not a revision: `mc roles check step`
      // compares this digest with what `canon/roles/step.md` assembles to now,
      // and an hour-long session started before an edit lands is exactly the
      // case nobody could see (#659's goal).
      role: roleRecord({
        name: role.name || kind,
        source: roleSourceOf(role) || 'canon',
        overlay: role.overlay,
        instructions,
      }),
    });
    let result;
    try {
      result = await deps.session({ bin: launch.spec.bin, args, cwd: worktree, timeoutMs: settings.budgetMinutes * 60_000 });
    } finally {
      remove(currentPath);
      dropSlot();
    }
    const seconds = Math.round((deps.now().getTime() - t0) / 1000);
    deps.write(out, result.stdout);
    deps.write(`${out}.err`, result.stderr);

    // The abort survives the kind it was written for, and for the reason it
    // was written: a merge the session did not commit leaves unmerged paths,
    // and an unmerged path is a dirty worktree that skips the project every
    // round until a person acts. It is only reached when the session left
    // `MERGE_HEAD` behind — a step session that resolved the conflict and
    // committed it has none, and nothing of its work is touched here.
    if (conflicts.length && deps.git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
      deps.git(worktree, ['merge', '--abort']);
      say(`${name}: the session left the merge of origin/main unfinished — merge aborted`);
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
      const all = JSON.parse(asked.stdout || '[]');
      openNow = openPrsFor({ prs: all, name, names: plans.map((p) => p.project) });
      // The branch the worktree stands on is this project's whatever it is
      // called. A session that made its own branch (`mc-test`'s sessions
      // opened three PRs from `test-architecture-*`, 2026-09-03) left work the
      // runner could neither land nor see as in flight, and ran the project's
      // next step on top of it.
      const own = all.find((item) => item.headRefName === branch);
      if (own && !openNow.some((item) => item.number === own.number)) {
        say(`${name}: #${own.number} is on ${branch}, not a branch named after the project — landing it anyway`);
        openNow = [own, ...openNow];
      }
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
    //
    // A repair is checked the same way, and a repair of a `plan-trespass` is
    // checked against the plan on **origin/main** rather than against the one
    // it was handed: the worktree's plan already carries the trespass, so
    // judging the repair by it would call the trespass repaired the moment
    // nothing more was touched, and the runner would land what it refused to
    // land an hour earlier.
    //
    // A step session whose conflict was in the plan itself is judged against
    // the plan on origin/main for the same reason, the other way round: the
    // copy it was handed is the branch's HEAD, and the merge that stopped is
    // precisely main's edits to that file. Judging by HEAD would read every
    // one of them — a step somebody else finished, a criterion somebody else
    // met — as a step this session had no business touching.
    let problems = [];
    const onMain = plans.find((p) => p.project === name)?.plan || null;
    const planConflicted = Boolean(plan?.path) && conflicts.some((path) => plan.path.endsWith(`/${path}`));
    const judged = kind === 'repair'
      ? repairBaseline(repair.entry, plan, onMain)
      : (kind === 'step' ? { before: (planConflicted && onMain) || plan.plan, index: choice.index } : null);
    if (judged && note === 'success') {
      const after = readPlanText(deps.read(plan.path) || '');
      const trespass = after.plan
        ? unauthorisedChanges(judged.before, after.plan, judged.index)
        : { ok: false, problems: [`the plan no longer parses: ${after.problems[0]}`] };
      if (!trespass.ok) {
        note = 'plan-trespass';
        problems = trespass.problems;
        for (const problem of trespass.problems) say(`${name}: ${problem}`);
        say(`${name}: #${pr} left open — the session changed more of the plan than its step`);
      }
    }

    // The second birthplace of a hold: a pull request this session left behind
    // that nothing is going to land. A trespass, a session that timed out with
    // its work pushed, a tool that printed no result — all of them leave a
    // branch `inFlight` refuses the project on every later round, and until now
    // the only trace was a runs.tsv note.
    if (pr !== '-' && holdsAfterSession(note)) {
      hold({ project: name, repo: repo.name, pr: Number(pr), branch, reason: holdReason({ note, problems }), note });
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
    // A merged step leaves the project ready for its next step now; 'merged'
    // is the round's cue to stay on it. There is no second way to earn it:
    // the only other session that used to — one that finished a merge and
    // stopped — is gone, and its work is the first thing a step session does.
    return note === 'success,merged' ? 'merged' : 'ran';
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
    const askedRepos = [];
    for (const repo of repos) {
      if (only && repo.name !== only) continue;
      if (!deps.exists(join(repo.path, '.git'))) continue;
      askedRepos.push(repo.name);
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
    // What is open is the whole answer to what is still held, and the round
    // has just paid for it. A repository GitHub could not be asked for is
    // unknown rather than empty, so nothing of its is dropped on a bad
    // network.
    reconcileHold({ prs, repos: askedRepos.filter((repo) => !prsFailed.includes(repo)) });
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
   * What the plan on `origin/main` already says about a name, asked before
   * anything is touched. `{ name, reason }` means the lane does not go there
   * this pass, and the reason is the word the round counts in `refusedLine`;
   * null means it does.
   *
   * `kindFor` is the page's reading — `chooseKind` over the plan text
   * `queue()` has already fetched — and it answers `skip:<reason>` for a plan
   * that is blocked, done, unparseable or unmigrated without a worktree, a
   * `git status`, a fetch or a merge. `runStep` used to be where that answer
   * arrived, five pieces of git work later: 2026-09-02 a round spent 51
   * seconds walking 38 projects to start one, and 21 of those refusals were
   * on the page before the round began.
   *
   * It does not replace `runStep`'s own reading, which stays exactly where it
   * was. The plan in the worktree after `syncMain` is the one that must be
   * obeyed — it is the one a step session will edit, and it can be one merge
   * ahead of this one. This only stops the walk from arriving at a project
   * whose plan on main already refuses it.
   *
   * Two things it deliberately does not answer:
   *
   * - **A name with no plan on main at all.** `assembleQueue` drops those, so
   *   it can only happen when a plan leaves main mid-round; `runStep` has the
   *   line for it, and this leaves it there.
   * - **A conflicted merge left in a workarea.** It lives in a worktree no
   *   plan on main can see, and it is the step session's to resolve — so a
   *   project whose plan on main is stopped never reaches the merge at all,
   *   which is the round it would have been able to use it in anyway.
   */
  function planRefusal(name, plans = []) {
    const plan = plans.find((p) => p.project === name) || null;
    if (!plan) return null;
    const kind = kindFor(name, { plans });
    if (!kind.startsWith('skip:')) return null;
    return { name, reason: kind.slice('skip:'.length) };
  }

  /**
   * The one line a round leaves about what its plans refused, or null when
   * they refused nothing.
   *
   * A plan-shaped refusal is already on the page — `mc status`'s QUEUE draws
   * it from the same `kindFor` — so the twenty-first `blocked on decision
   * plan-review` in runner.log tells a reader nothing the first one did not.
   * What it costs is the lines that are *not* on the page: a dirty worktree,
   * a pull request in flight, a merge that conflicted. Those are facts about
   * this machine at this moment, they keep their own named line in `runStep`,
   * and they are what this line exists to leave room for.
   *
   * The shape is the page's: `skipped 28 (blocked 21, unparseable 5, done
   * 1)`, reasons in the order the queue met them. One reason is named rather
   * than only counted — a plan that does not parse is a thing somebody must
   * go and fix, and a count of five does not say which five.
   */
  function refusedLine(refusals = []) {
    if (!refusals.length) return null;
    const counts = new Map();
    for (const { reason } of refusals) counts.set(reason, (counts.get(reason) || 0) + 1);
    const by = [...counts].map(([reason, n]) => `${reason} ${n}`).join(', ');
    const unparseable = refusals.filter((r) => r.reason === 'unparseable').map((r) => r.name);
    const named = unparseable.length ? ` — the plans that do not parse: ${unparseable.join(', ')}` : '';
    return `skipped ${refusals.length} (${by})${named}`;
  }

  /**
   * One lane: its names in order, one step at a time. A project whose step
   * merged keeps the lane — its next step follows at once (plans re-read, so
   * the merged status is what decides) instead of waiting a whole round
   * behind every other project — 2026-08-29 a six-step plan would have taken
   * six rounds of twenty projects. STOP is honoured between those steps too.
   *
   * The names it does not stop at are `planRefusal`: a project whose plan on
   * origin/main already says the runner would do nothing is passed over here,
   * before `runStep` opens a worktree to find out the same thing. It says
   * nothing about them one at a time — they are collected and returned as
   * `refused`, and the round leaves the one line (`refusedLine`).
   */
  async function runLane({ repo = null, names = [], lane = 0 }, world, { once = false } = {}) {
    let known = Array.isArray(world) ? { plans: world } : world;
    let ran = 0;
    const refused = [];
    for (const name of names) {
      // The plan first, git second: a project its own plan on main refuses is
      // never reached, and no worktree, status or fetch is spent on it. Asked
      // per name against `known`, which a merged step re-reads — a plan that
      // came good in that window does not wait for the next round.
      const no = planRefusal(name, known.plans);
      if (no) { refused.push(no); continue; }
      let r = await runStep(name, known, { lane });
      for (let stayed = 0; ; stayed += 1) {
        if (r === 'stop') return { ran, stop: true, refused };
        if (r === 'ran' || r === 'merged') {
          ran += 1;
          if (once) return { ran, stop: false, once: true, refused };
          await deps.sleep(60_000);
        }
        if (stopRequested()) { say(`runner exit on STOP after ${name} (remove ${paths.stop} before the next start)`); return { ran, stop: true, refused }; }
        if (r !== 'merged' || stayed >= 8) break;
        // Re-read: the plan the merge advanced, and what GitHub has open now
        // — the step that just landed may have left a second pull request.
        known = queue({ only: repo });
        // The plan the merge advanced says stop: the lane lets go, and the
        // count is the round's, same as any other refusal on the plan.
        const stopped = planRefusal(name, known.plans);
        if (stopped) { refused.push(stopped); break; }
        const status = known.plans.find((p) => p.project === name)?.status;
        if (!status || status === 'done') break;
        say(`${name}: step merged and the plan is ${status} — staying on ${name}`);
        r = await runStep(name, known, { lane });
      }
    }
    return { ran, stop: false, refused };
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
  async function round({ once = false, only = null, lane = 0, count = 1 } = {}) {
    // `only` is one lane's round — the unattended loop's shape since
    // 2026-09-03, when Martin saw that a round ended only when *both* lanes
    // had: memoro-cli's lane sat idle for hours while memoro's walked thirty
    // names, and a memoro-cli step that became ready in that time waited for
    // a round boundary nobody needed. A lane's round reads the queue for its
    // repository alone and does none of the chores, because the chores read
    // the whole queue: `tidyQueue` over one repository's plans would drop the
    // other's names from queue.md, and `closeWorkareas` would file the
    // other's workareas as unplanned. `chores()` runs them beside the lanes.
    const chores = only == null;
    // The day's collect first, then the inbox it just added to, and only in a
    // round that is a round: `--once` exists to watch a single step, and a
    // model turn over production is not what somebody typing it asked for.
    if (chores && !once && !stopRequested()) {
      await runHelperDay();
      await runIntakeDrain();
    }
    const world = queue({ only });
    const { names, plans } = world;
    if (chores && !once) tidyQueue(plans);
    if (chores) writeUnreadable(plans);
    // A plan that says `done` is archived in the round the runner reads it,
    // before any step of that round runs — one PR per repository, and the
    // two repositories never touch. Not under `--once`, for the reason the
    // helper is not: that is one step to watch, not a round.
    const archives = chores && !once ? await Promise.all(repos.map((repo) => archiveDone(repo, plans))) : [];
    const archived = archives.flatMap((a) => a.archived);
    const landed = archives.flatMap((a) => a.landed);
    const left = names.filter((name) => !archived.includes(name));
    // `--once` is one step, so it is one lane over the whole queue in
    // Martin's order — there is nothing for a second lane to do.
    // With `lanes` above one for a repository, this round is one of that
    // many running side by side, and takes every `lanes`th name from the
    // repository's list starting at its own index — so two rounds in one
    // repository never hold the same project, and each still walks its
    // names in the queue's order. A project that is in flight in the other
    // lane is also refused by `inFlight`'s open pull request, once it has one.
    const lanes = (once ? [{ repo: null, names: left }] : splitLanes(left, plans))
      .filter((item) => only == null || item.repo === only)
      .map((item) => ({ ...item, lane, names: item.names.filter((_, index) => index % count === lane) }));
    if (lanes.length > 1) say(`lanes: ${lanes.map((lane) => `${lane.repo || 'unplaced'} (${lane.names.length})`).join(', ')}`);
    const results = await Promise.all(lanes.map((lane) => runLane(lane, world, { once })));
    const out = {
      ran: results.reduce((sum, r) => sum + r.ran, 0),
      stop: results.some((r) => r.stop),
    };
    // What the plans refused, in one line for the whole round rather than one
    // line per project: both lanes' refusals counted together, because a
    // reader of runner.log is reading a round, not a lane.
    const line = refusedLine(results.flatMap((r) => r.refused || []));
    if (line) say(only ? `${only}: ${line}` : line);
    // Last of all, and only in a whole round that was not cut short: the
    // workareas whose plan left main this round are taken down, and the ones
    // with no plan at all are written where Martin looks. `--once` changes
    // nothing but the one step it exists to watch.
    if (chores && !once && !out.stop) closeWorkareas(plans, landed, archivedProjects());
    if (results.some((r) => r.once)) out.once = true;
    return out;
  }

  /**
   * What a whole round did around its lanes, for the unattended loop where
   * the lanes no longer share a round: the day's collect, the inbox drained,
   * queue.md tidied, the unreadable plans filed, finished plans archived,
   * finished workareas closed. Read from the whole queue — which is why it is
   * not in a lane's round.
   *
   * Archiving lands a docs PR through the gate, and the gate refuses a
   * second round rather than queueing it (gate-lock.js): a lane landing its
   * step at that moment would lose the landing. So archives wait for a pass
   * when no lane is in a session. `closeWorkareas` needs no such care — a
   * workarea whose plan is not `done` is never touched, and a running step's
   * plan is not.
   */
  async function chores() {
    if (stopRequested()) return;
    await runHelperDay();
    await runIntakeDrain();
    const { plans } = queue();
    tidyQueue(plans);
    writeUnreadable(plans);
    const quiet = paths.currents().length === 0;
    const archives = quiet ? await Promise.all(repos.map((repo) => archiveDone(repo, plans))) : [];
    closeWorkareas(plans, archives.flatMap((a) => a.landed), archivedProjects());
  }

  /** runner.json — a runner is here, and this is the pid to test for life. */
  const markRunner = () => writeJson(paths.runner, { pid, started: stamp() });
  const clearRunner = () => {
    remove(paths.runner);
    for (const file of paths.currents()) remove(file);
  };

  return {
    paths, repos, say, round, chores, runStep, runLane, splitLanes, runHelperDay, runIntakeDrain, archiveDone, queue, stopRequested,
    held: heldNow,
    writeUnreadable,
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
  // Both numbers, read once, before anything is started: `per_repo` is how
  // many lane loops each repository gets and `total` is how many steps this
  // machine will have in flight at once. A running runner keeps what it was
  // started with — `mc run --update` (or stop and start) is how a new value
  // takes effect, and the verb says so when it writes.
  const laneSetting = (deps.laneCount || readLaneCount)();
  const runner = createRunner({ merge, deps, total: laneSetting.total });
  if (runner.stopRequested()) { runner.say(`STOP file present (${runner.paths.stop}) — remove it before starting`); return 2; }
  // runner.json read before it is written. `markRunner()` below is a
  // statement, not a claim anyone checked, so until now a second `mc run` in
  // the same work root simply overwrote the first and became invisible to
  // every reader of mc's state — measured 2026-09-02, when two runners handed
  // the same step to two sessions in one worktree 100 seconds apart. `mc run
  // start` has always refused on exactly this; the same `readRunner` answers
  // here, so the two cannot disagree about who is running.
  //
  // `--once` is refused too. It is a person watching one step rather than an
  // unattended loop, but the collision is the same one: one step, one
  // worktree, one `git add -A`, and a second session that can only stand
  // down. There is nothing about being watched that makes that safe.
  const held = readRunner({ paths: runner.paths, read: deps.read, alive: deps.alive || pidAlive });
  if (held?.alive) {
    runner.say(`a runner is already running — pid ${held.pid}${held.started ? `, started ${held.started}` : ''}`);
    runner.say('mc run stop ends it · mc run --update restarts it on the newest code');
    return 2;
  }
  // A file naming a pid that is gone is a killed runner's leftovers, not a
  // reason nothing can start: it is cleared and said, the way `mc run start`
  // clears it. `clearRunner()` takes the `current-<repo>.json` files with it,
  // which are the same runner's other leftovers and would otherwise draw a
  // step that has not been running for hours.
  if (held) {
    runner.clearRunner();
    runner.say(`cleared runner.json — the pid it named (${held.pid}) is gone`);
  }
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
  // `mc run --update`, read where STOP is read: at a round boundary, with no
  // session in flight and nothing half-done. runner.json is cleared before
  // the new runner is started rather than after, so the two never race for
  // the same file.
  const update = async () => {
    runner.clearRunner();
    const handed = await (deps.handOver || handOver)({ paths: runner.paths, deps, say: runner.say });
    if (handed.ok) { handedOver = true; return true; }
    runner.markRunner();
    return false;
  };
  try {
    if (rounds === 0 && !once) {
      // The unattended run: one loop per repository, each on its own clock.
      // A lane's round ends when its own names are walked and its next one
      // starts then — not when the other lane's does. Until 2026-09-03 the
      // two lanes shared a round, and memoro-cli's sat idle for hours while
      // memoro's walked thirty names. The chores a shared round did around
      // its lanes run in their own loop beside them. STOP and UPDATE are
      // read where they always were, at a round boundary — now each lane's
      // own — and the handover waits for every lane to reach one.
      //
      // `mc run lanes <n>` puts n of these loops on each repository. Each
      // takes every nth name of the repository's queue (round.js: `lane`,
      // `count`), so two never hold one project; what they share is the
      // repository's main, and a landing that meets the other's at the gate
      // waits for it (`landPr`).
      //
      // `--total` bounds the two repositories together: `lanes 3` on both is
      // six sessions, and the total is what says three. Both bind and the
      // smaller wins — the loops are still `per_repo` per repository, and a
      // lane waits for a slot before it launches (`waitForSlot`). With no
      // total set nothing is counted and this is what it always was.
      const { per_repo: count, total } = laneSetting;
      if (count > 1 || total !== null) {
        runner.say(`lanes: ${count} per repository, ${total === null ? 'no total cap' : `${total} in total`}`);
      }
      //
      // UPDATE drains the runner: from the moment it is read no lane starts
      // a step, the steps in flight finish and land, and the handover comes
      // when nothing is in flight anywhere — within one step's length. Two
      // wrong versions preceded this on 2026-09-04. In the morning a lane
      // that read UPDATE after an idle round left its loop and *sat*, so the
      // idle lanes took no work for the whole of a busy lane's step. Then
      // idle lanes were let to keep taking work until a quiet moment — and
      // with four lanes in steady work the quiet moment never came: an
      // UPDATE the runner wrote for itself at 09:30 was still pending two
      // hours later, running old code the whole time. Martin chose the drain
      // (A) over an immediate handover with two runners (B).
      const quiet = () => runner.paths.currents().length === 0;
      const lane = async (repo, index) => {
        const tag = count > 1 ? `${repo.name}#${index + 1}` : repo.name;
        let draining = false;
        for (let n = 1; ; n += 1) {
          if (runner.updateRequested()) {
            if (!draining) { draining = true; runner.say(`${tag}: UPDATE — taking no new step; handing over when every lane is done`); }
            if (quiet()) return { update: true };
            await deps.sleep(UPDATE_POLL_MS);
            if (runner.stopRequested()) return { stop: true };
            continue;
          }
          const r = await runner.round({ only: repo.name, lane: index, count });
          if (r.stop) return { stop: true };
          runner.say(`${tag}: round ${n} done (${r.ran} ran)`);
          if (runner.updateRequested()) continue;
          if (r.ran === 0) await deps.sleep(idleSleepMs);
          if (runner.stopRequested()) return { stop: true };
        }
      };
      const choreLoop = async () => {
        for (;;) {
          if (runner.stopRequested() || runner.updateRequested()) return {};
          await runner.chores();
          await deps.sleep(idleSleepMs);
        }
      };
      const lanes = runner.repos.flatMap((repo) => Array.from({ length: count }, (_, index) => lane(repo, index)));
      const results = await Promise.all([...lanes, choreLoop()]);
      if (results.some((r) => r.stop)) { runner.say(`runner exit on STOP (remove ${runner.paths.stop} before the next start)`); return 0; }
      if (results.some((r) => r.update) && await update()) return 0;
      runner.say('runner exit — the update did not hand over');
      return 0;
    }
    let n = 0;
    while (once ? n < 1 : n < rounds) {
      n += 1;
      const r = await runner.round({ once });
      if (r.stop) { runner.say(`runner exit on STOP (remove ${runner.paths.stop} before the next start)`); return 0; }
      if (r.once) { runner.say('once: exiting'); return 0; }
      runner.say(`round ${n} done (${r.ran} ran)`);
      if (runner.updateRequested() && await update()) return 0;
      if (r.ran === 0 && n < rounds) await deps.sleep(idleSleepMs);
    }
    runner.say(`runner exit after ${rounds} round(s)`);
    return 0;
  } finally {
    if (!handedOver) runner.clearRunner();
  }
}
