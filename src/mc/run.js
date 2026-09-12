/**
 * `mc run` — the runner, inside mc.
 *
 * The runner takes the next step: a lane picks the first project its
 * repository's order says is ready and nothing is holding (`nextFor`,
 * run-plan.js), runs it, and picks again. One step is one fresh headless
 * session in one workarea, then the merge of the PR it opened. The runner
 * decides nothing with a model: it reads files, runs git and gh, starts the
 * session through the launch adapter and waits for it. No inbox, no knock,
 * no watcher — it is the parent of the process it starts.
 *
 * There is no round. Until 2026-09-08 a lane walked its whole slice of the
 * queue and then began again, which meant a project nothing could start was
 * tried and skipped every ten minutes for days and a `skipped 15 (blocked
 * 15)` line was written for every one of those passes. Each repository is a
 * lane loop on its own clock — memoro's steps and memoro-cli's never touch
 * (different main branches, different worktrees) — and `mc run lanes <n>`
 * puts n loops on each. `--once` is one step, for a person watching.
 *
 * A step the runner cannot start is written down instead of met again. A
 * refusal that is a fact about the workarea or this machine — a dirty worktree,
 * a branch that could not be moved, a merge that would not commit, a role or a
 * tool that is missing — sets that
 * step `blocked` on `main` with `blocked_by: { kind: "workarea", name }` and one
 * comment naming the path, through a docs-only pull request the runner lands
 * itself (`blockStep`). Then nothing picks the project until `mc brief` or a
 * planning session sets the step `ready` again: the runner never writes `ready`
 * and never retries. What it does **not** block on is transient and not the
 * project's fault — STOP, the quota, GitHub not answering, a failed fetch — and
 * there the lane waits and asks the same question again (ruling 17).
 *
 * The chores take away what is finished: every plan on main that
 * says `status: done` is archived — its `docs/project/<programme>/<project>/`
 * removed and a `project_log.md` row left behind it — in one PR per
 * repository that the runner merges like any other. `done` is the whole
 * trigger; there is nothing to type. The rules are in archive-plan.js.
 *
 * The chore loop also takes away the folder that plan explains: a workarea
 * whose project is finished — its plan has left main, or `project_log.md`
 * says it was archived — and whose worktree is clean and whose
 * last row in runs.tsv ends `merged` is removed: worktree handed back, local
 * branch deleted, everything it kept beside its checkout moved to
 * `runner/log/closed/<name>/`. A workarea no project explains at all is never
 * removed by a machine; it is written to `~/mc/runner/unplanned-workareas.md`
 * instead. The rules are in close-workarea.js.
 *
 * The same holds for a plan on origin/main that does not parse: the runner can
 * hand out no step from it and must not guess at what its author meant, so it
 * goes to `~/mc/runner/unreadable-plans.md` (plan-intake.js) rather than to a
 * `runner.log` line nobody reads. `new-user` had that line every pass for a
 * day, and the fault was five paragraphs of prose in a validated field.
 *
 * A lane asks GitHub what is open before it acts. An open pull request on a
 * project takes it out of the pick with a line naming it — the plan on
 * origin/main and the plan in the worktree both say `ready` while the step's
 * work sits in an open pull request, and the runner used to believe them and
 * start the step again. A workarea whose branch has already landed is moved to
 * `<name>-<n>` from origin/main before a session starts, which is also what
 * makes the `<name>`/`<name>-<suffix>` convention that matches a pull request
 * to a project true. The rules are project-prs.js and `inFlight`.
 *
 * Where a step stands is the register's word (`register.js`, ruling 21):
 * `running` with the session's pid before the session, and after it `done`
 * when the session's own `mc merge` landed the pull request, `failed` when it
 * did not — the runner lands nothing of a session's and repairs nothing. A
 * step the runner could not start is `blocked` there too.
 *
 * `~/mc/queue.md` is Martin's "these first" and nothing else: names of
 * projects that still have a step to run, one per line. The chores rewrite it
 * to that shape, and a name leaves it when its plan is done or off main —
 * never merely because one step of it has run (2026-09-08), because with the
 * pick as the only order there is, that would drop a prioritised project to
 * alphabetical after its first step.
 *
 * Two things that are not steps ride along, and neither opens a worktree or
 * touches a branch. `runHelperDay` is the collect: once per calendar day, in
 * the first chore loop after 05:00Z, one digest per repository into
 * `~/mc/intake/`, no model. `runIntakeDrain` is the inbox: every chore loop, the
 * oldest files in `~/mc/intake/` up to `INTAKE_PER_ROUND`, one headless turn
 * each, each file archived under `~/mc/runner/log/intake/<date>/` the moment its
 * turn ends. They used to be one gate and one row, which meant one file could be
 * read a day and only if the collect had also run.
 *
 * The runner is worked from another terminal by three files under
 * `~/mc/runner/`, all read between two picks and never mid-session: `STOP`
 * ends it, `UPDATE` makes it fast-forward mc's own checkout and hand over to a
 * fresh process on the new code. `mc run start|stop|--update` write them; the
 * rules and the handover are in run-control.js. `UPDATE` has one writer that
 * is not a person — a landing that changed `src/mc/` or `canon/`, which is
 * the runner having merged the code it is running (`askForUpdate`).
 *
 * Every process boundary is a dependency on `deps`, so a lane's pass can be
 * driven in a test with a fake git, gh, tmux and session and no network.
 * The rules themselves live in run-plan.js.
 */
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
import { applyEntry, currentIndex, overlayPlans, readEntry, updateStep } from './register.js';
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
import { pidAlive } from './status-collect.js';
import { PR_LIST_ARGS, openPrsFor, projectForBranch } from './project-prs.js';
import { loadProfile, profileArgs } from './portrait.js';
import { readLaneCount } from './lane-count.js';
import { instructionsFor, readCanonRole, roleRecord, roleSourceOf } from './roles.js';
import { keepAwake, onACPower } from './stay-awake.js';
import { addWorktree } from './work-area.js';
import {
  HELPER_KIND, HELPER_NAME, INTAKE_KIND, INTAKE_PER_ROUND, QUOTA_SLEEP_MS, REFUSAL, TIMEOUT_EXIT,
  WORKAREA_BLOCKS, assembleQueue, checkInPrompt, chooseKind, collectNote, headlessArgs,
  helperDue, inFlight, intakeNote, landingNote, mcOwnFiles, nextBranch, nextFor,
  queueFileText, readSessionOutput, sessionResult, sessionSettings, describeSettings, describeWatch,
  stepPrompt, strictQueue, tsvHeader, tsvRow, userMessageLine,
} from './run-plan.js';

export const REPO_NAMES = ['memoro', 'memoro-cli'];

/**
 * The refusals a lane waits out rather than moves past: they are facts about
 * this moment, not about the project. GitHub not answering `gh pr list` and a
 * fetch that failed are the network; the bare `skipped` is this process's own
 * (an UPDATE while waiting for a slot, or a project another lane took between
 * the pick and the run). Every other refusal is the project's, and the lane
 * takes the next name instead — see `pass`.
 */
export const WAIT_REFUSALS = new Set(['skipped', 'skipped:prs-unknown', 'skipped:sync']);
/** How often an idle lane looks again while an UPDATE waits for the quiet moment. */
export const UPDATE_POLL_MS = 30 * 1000;
/** How often a lane held back by the total cap looks for a free slot again. */
export const TOTAL_POLL_MS = 15 * 1000;

/* ------------------------------------------------------------ real deps */

function sh(cmd, args, { cwd, timeout = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * One session: the adapter's binary with the headless argument list, and
 * nothing killed on elapsed time (ruling 18).
 *
 * For claude (`prompt` given) stdin is a pipe. The prompt goes in as the
 * first stream-json user message; every `checkInMs` while the session runs,
 * `checkIn(elapsedMinutes, count)` is written as another, and the session
 * judges its own step. A message written mid-turn is folded into that turn;
 * one written after a `result` starts a new turn — so on the first `result`
 * line stdin is ended, no check-in follows, and claude exits. The only kill
 * is the stall guard: `stallMs` without a byte on stdout, armed at spawn and
 * reset on every chunk, SIGTERMs the child and reports `stalled`. Stream-json
 * prints an event per message, so a working session is never silent that
 * long.
 *
 * Codex (no `prompt`) keeps its positional prompt with stdin closed, and gets
 * neither a check-in nor a stall guard: nothing kills it.
 *
 * `spawn` and not `spawnSync`: two lanes run in this one process, and a
 * synchronous wait would hold the event loop for the whole session — the
 * second lane would never get to start. The output is collected here instead
 * of by `maxBuffer`, and capped rather than allowed to eat the machine.
 */
export function streamSession({ bin, args, cwd, env, prompt = null, checkInMs = 0, stallMs = 0, checkIn = null, onSpawn = null, spawn: spawnFn = spawn }) {
  return new Promise((resolve) => {
    const piped = prompt != null;
    const child = spawnFn(bin, args, { cwd, stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'], env });
    // The register records the pid as the step's session (ruling 21); a
    // record, not the session, so a throwing recorder must not end the run.
    if (child.pid && onSpawn) { try { onSpawn(child.pid); } catch { /* recorded elsewhere */ } }
    const cap = 256 << 20;
    const collect = (stream, onChunk) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        if (size < cap) { chunks.push(chunk); size += chunk.length; }
        onChunk?.(chunk);
      });
      return () => Buffer.concat(chunks).toString('utf8');
    };
    const started = Date.now();
    let settled = false;
    let failure = null;
    let stalled = false;
    let resultSeen = false;
    let stallTimer = null;
    let checkInTimer = null;
    let count = 0;
    const stop = () => { clearTimeout(stallTimer); clearInterval(checkInTimer); };
    const send = (text) => {
      if (!piped || resultSeen || settled || !child.stdin?.writable) return;
      child.stdin.write(userMessageLine(text));
    };
    const armStall = () => {
      if (!stallMs || stalled || settled) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        stalled = true;
        stop();
        child.kill('SIGTERM');
      }, stallMs);
    };
    // Lines are scanned for a `result` only while stdin is still open; a
    // partial line waits for the rest of it.
    const decoder = new StringDecoder('utf8');
    let partial = '';
    const onResultLine = () => {
      resultSeen = true;
      clearInterval(checkInTimer);
      try { child.stdin.end(); } catch { /* already closed */ }
    };
    const scan = (chunk) => {
      armStall();
      if (!piped || resultSeen) return;
      const text = partial + decoder.write(chunk);
      const lines = text.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        if (!line.slice(0, 200).includes('"type":"result"')) continue;
        let event = null;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.type === 'result') { onResultLine(); return; }
      }
    };
    const stdout = collect(child.stdout, scan);
    const stderr = collect(child.stderr);
    const done = (value) => { if (!settled) { settled = true; stop(); resolve(value); } };
    if (piped) {
      // A check-in written to a child that has just exited is an EPIPE on
      // the stream, not a crash of the runner and both its lanes.
      child.stdin.on('error', () => {});
      send(prompt);
      if (checkInMs && checkIn) {
        checkInTimer = setInterval(() => {
          if (settled || resultSeen) return;
          count += 1;
          send(checkIn(Math.round((Date.now() - started) / 60_000), count));
        }, checkInMs);
      }
    }
    armStall();
    child.on('error', (error) => {
      failure = error;
      if (!child.pid) done({ status: 1, stdout: '', stderr: String(error.message), timedOut: false, stalled: false });
    });
    child.on('close', (status) => {
      done({
        status: stalled ? TIMEOUT_EXIT : (status ?? 1),
        stdout: stdout(),
        stderr: stderr() || (failure ? String(failure.message) : ''),
        timedOut: stalled,
        stalled,
      });
    });
  });
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
    // The session — `streamSession` below. The session's Bash tool gets a
    // ten-minute ceiling instead of claude's two-minute default. Measured
    // 2026-09-01..03: with two minutes, a step ran `npm test` in the
    // background and polled it in `sleep` loops of 120 s — 212 such calls,
    // 1.9 h of 12.5 h tool time — and 17 calls were killed on the timeout
    // itself. A suite run is one call now. The same ten minutes is why
    // `DEFAULT_STALL_MINUTES` is twenty.
    //
    // `options.env` is what the runner adds for this session — `MC_STEP=<project>:<index>`,
    // so `mc step` and `mc merge` inside it know which step they are — and
    // `onSpawn` gets the child's pid the moment there is one: the register
    // records it as the step's session, which is how `mc merge` finds the
    // process to end when the step has landed (ruling 21).
    session: (options) => streamSession({
      ...options,
      env: { ...env, BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '600000', ...(options.env || {}) },
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

  /* ------------------------------------------------------------- register */

  /**
   * The register's IO, through this runner's dependencies: `read` and
   * `writeJson` are the fixture's in a test, and the lock is the real one
   * only where the dependencies are (`deps.lock`), because a test's work root
   * is not a directory.
   */
  const register = {
    root,
    read: deps.read,
    write: writeJson,
    lock: deps.lock || ((_root, fn) => fn()),
    get now() { return stamp(); },
  };
  const alive = deps.alive || pidAlive;

  /** One step's state, written. Says what it wrote; a refusal is a line, not a crash. */
  function recordStep(name, index, patch) {
    try {
      return updateStep({ root, project: name, index, patch, read: deps.read, write: writeJson, lock: register.lock, now: stamp() });
    } catch (error) {
      say(`${name}: the register refused step ${index + 1} → ${patch.status || 'the patch'}: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * A `running` step whose session is not there is a step nothing will
   * finish: the runner that held it was killed, or the machine slept through
   * it. It is `failed` with that reason, so the picker does not wait on it
   * for ever and a person sees it where every other failed step is. A pid
   * this process owns and is still awaiting is alive, so this never touches
   * a lane's own session.
   */
  function sweepRunning(plans) {
    return plans.map((record) => {
      const steps = Array.isArray(record?.plan?.steps) ? record.plan.steps : [];
      let out = record;
      steps.forEach((step, index) => {
        if (step?.status !== 'running') return;
        const entry = readEntry(root, record.project, { read: deps.read });
        const pid = entry?.steps?.[index]?.session?.pid;
        if (pid && alive(pid)) return;
        say(`${record.project}: step ${index + 1} was running under pid ${pid ?? 'none'}, which is gone — failed`);
        const written = recordStep(record.project, index, { status: 'failed', reason: `the session (pid ${pid ?? 'unknown'}) is gone without a result` });
        if (written) out = applyEntry(out, written);
      });
      return out;
    });
  }
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
   * The plan the workarea carries, read off disk and nowhere else.
   *
   * There is one copy of a plan the runner obeys — the one on `main`
   * (`docs/project/README.md`, § Who writes what) — and after `syncMain` the
   * file on disk is that copy: git merges the files it can, so a merge that
   * stopped on `src/a.js` has already written main's plan into the worktree,
   * and a `PLAN.json` that conflicted is resolved by the plan's own rule or,
   * where the rule refuses, by taking main's side outright
   * (`resolvePlanConflict`). Neither leaves conflict markers behind.
   *
   * It used to take a `fromHead` option that read the branch's own last commit
   * (`git show HEAD:<path>`) for exactly the case that is now resolved: a plan
   * the rule refused, whose copy on disk carried markers and parsed as nothing.
   * HEAD is stale there by construction — it is the side that has *not* taken
   * main — and reading it is what reported `docx-editor` as blocked on a
   * decision main had re-planned the evening before, for 13 rounds (measured
   * over `runner.log` to 2026-09-05). The option went with the case,
   * 2026-09-08.
   */
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
   * A conflicted `PLAN.json`, merged by the plan's own rule about who may
   * write what (`plan-merge.js`) rather than by a session.
   *
   * The three sides come out of the index, which is where git keeps them
   * while a merge is in progress: `:1:` the merge base, `:2:` ours — this
   * project's branch — and `:3:` theirs, origin/main. Resolved means written
   * and staged; the commit is `syncMain`'s, once every conflict is gone.
   *
   * Where the rule refuses — both sides edited one step, or the step counts
   * differ — main's copy is taken. It is the copy the runner obeys everywhere
   * else (`docs/project/README.md`, § Who writes what), and by the time this
   * runs there is nothing of the branch's left to lose: an open pull request of
   * this project's has already ended the pick (`inFlight`), and a branch whose
   * content is in origin/main has already been moved (`freshBranch`). What is
   * left on the branch and not on main is either work that landed in another
   * shape or work no pull request carries.
   *
   * The rule is still tried first, and its refusal is still a line in
   * runner.log: the next reader of that file is deciding whether what the
   * branch had was worth anything. What the line is not any more is the end of
   * the project — `sql-w3-email-closure` merged, refused and aborted every ten
   * minutes from 2026-09-06T18:34Z to 2026-09-08 on this one predicate.
   *
   * Returns true when the file is resolved, either way.
   */
  function resolvePlanConflict(worktree, name, path) {
    const stage = (n) => {
      const shown = deps.git(worktree, ['show', `:${n}:${path}`]);
      return shown.ok ? String(shown.stdout ?? '') : null;
    };
    const merged = mergePlanText({ base: stage(1), branch: stage(2), main: stage(3) });
    if (!merged.ok) {
      if (!deps.git(worktree, ['checkout', '--theirs', '--', path]).ok
        || !deps.git(worktree, ['add', '--', path]).ok) {
        say(`${name}: ${path} — the plan's rule refused (${merged.why}) and main's copy could not be taken either`);
        return false;
      }
      say(`${name}: ${path} — the plan's rule refused (${merged.why}); main's copy taken`);
      return true;
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
   *
   * `why` tells the two failures apart for the caller, because their answers
   * are opposite: `fetch` is the network and the lane waits it out, `commit` is
   * this workarea and blocks the step (`merge-uncommittable`, `WORKAREA_BLOCKS`).
   * Both used to be `{ ok: false, conflicts: [] }` and nothing could ask.
   * `detail` is what git said, for the block's comment — the one thing a person
   * opening the workarea has to go on.
   */
  function syncMain(worktree, name) {
    if (!deps.git(worktree, ['fetch', '-q', 'origin']).ok) return { ok: false, conflicts: [], why: 'fetch' };
    const merge = deps.git(worktree, ['merge', '-q', '--no-edit', 'origin/main']);
    if (merge.ok) return { ok: true, conflicts: [] };
    const conflicts = (gitOut(worktree, ['diff', '--name-only', '--diff-filter=U']) || '').split('\n').filter(Boolean);
    if (conflicts.length === 1 && conflicts[0] === '.gitignore') {
      if (deps.git(worktree, ['checkout', '--theirs', '.gitignore']).ok && deps.git(worktree, ['add', '.gitignore']).ok && deps.git(worktree, ['commit', '-q', '--no-edit']).ok) return { ok: true, conflicts: [] };
    }
    const left = conflicts.filter((path) => !(isPlanPath(path) && resolvePlanConflict(worktree, name, path)));
    if (!left.length) {
      const commit = deps.git(worktree, ['commit', '-q', '--no-edit']);
      if (commit.ok) return { ok: true, conflicts: [] };
      // Resolved, staged, and the commit refused: not a conflict any more and
      // not a merge either. No session is started in a worktree mid-merge, and
      // nothing the runner does next changes the answer — so the step is
      // blocked on `main` rather than skipped (`merge-uncommittable`). With no
      // conflict at all, git refused the merge before it began — unrelated
      // histories, a stale `index.lock` — which is the same answer.
      const detail = conflicts.length
        ? `origin/main was merged in, ${conflicts.join(' ')} resolved, and the commit was refused (${lastLine(commit)})`
        : `origin/main could not be merged in, with no conflict to resolve (${lastLine(merge)})`;
      return { ok: false, conflicts: [], why: 'commit', detail };
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

  /* --------------------------------------------------------------- landing */

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

  /**
   * What `deps.session` is handed besides the argument list: the prompt for
   * stdin, the check-in interval with the text it writes, and the stall
   * guard. A codex session gets none of it — its prompt is its last
   * positional and nothing watches it — so its stdin stays closed.
   */
  function watchFor(launch, settings, { prompt, name, kind, onCheckIn = null }) {
    if (launch.id === 'codex') return {};
    return {
      prompt,
      checkInMs: settings.checkInMinutes * 60_000,
      stallMs: settings.stallMinutes * 60_000,
      checkIn: (minutes, count) => {
        say(`${name}: check-in ${count} at ${minutes} min`);
        onCheckIn?.(count, minutes);
        return checkInPrompt({ project: name, minutes, count, kind });
      },
    };
  }

  /**
   * A session's three log files under one stem: the stream as it came
   * (`.jsonl`), the result read from it alone (`.json`, the summed object
   * `scripts/measure-steps.py` reads — absent when there was none), and
   * stderr (`.json.err`, where it always was).
   */
  function writeSessionLogs(stem, result) {
    deps.write(`${stem}.jsonl`, result.stdout);
    const summed = sessionResult(result.stdout);
    if (summed) deps.write(`${stem}.json`, `${JSON.stringify(summed)}\n`);
    deps.write(`${stem}.json.err`, result.stderr);
  }

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

  /* ------------------------------------------------------------- blocking */

  /**
   * A step the runner could not start, written down where the state lives:
   * `blocked` in the register with `blocked_by: { kind: 'workarea', name }`
   * and the detail as the reason, so nothing picks the project again until
   * `mc step ready` — and nothing in a plan file moves for it. Until
   * 2026-09-12 this was a docs-only pull request the runner opened and landed
   * itself, because the state lived in the plan on main and there was no
   * other way to it (ruling 21: the register).
   *
   * Says which step, and refuses to write over a step that is already
   * blocked — the world this lane read was stale, and a second reason on the
   * same step is the same fact twice.
   */
  async function blockStep({ repo, name, reason, detail }) {
    const entry = readEntry(root, name, { read: deps.read });
    if (!entry) { say(`${name}: not in the register — nothing to block`); return false; }
    const index = currentIndex(entry);
    if (index < 0) { say(`${name}: every step is done — nothing to block`); return false; }
    const step = entry.steps[index];
    if (step.status === 'blocked') {
      say(`${name}: step ${index + 1} is already blocked on ${step.blocked_by?.kind || 'something'} ${step.blocked_by?.name || '(unnamed)'} — not written again`);
      return false;
    }
    const area = join(root, name, repo.name);
    const written = recordStep(name, index, {
      status: 'blocked',
      blocked_by: { kind: 'workarea', name: reason },
      reason: `${detail}. The workarea is ${area}.`,
      comment: `Blocked by mc run on ${stamp()}: ${detail}. The workarea is ${area}. mc step ready ${name} ${index + 1} once it is fixed; the runner does not retry.`,
    });
    if (written) say(`${name}: step ${index + 1} blocked on workarea ${reason}`);
    return written;
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
   * One project is in flight in one lane at a time, whatever the lanes' count
   * says. Two lanes on one repository read the world separately — two `gh pr
   * list` calls, up to ten minutes apart — and the first lane's pull request
   * is not open yet while its session runs, so nothing on GitHub or on disk
   * says the project is taken. Two sessions in one worktree is the failure
   * this refuses; the claim lives in this process, where the lanes are.
   *
   * `claimed` is the lane saying it already holds the name: the pick takes the
   * claim in the same tick it chooses (`pass`), so that a second lane picking
   * a moment later cannot choose the same name, and this is the same claim
   * arriving here rather than a second one.
   */
  const claims = new Set();
  /**
   * The names whose last refusal was one a person has to act on (`block` in
   * `runStepClaimed`). `sync` is both a wait and a block — a fetch that failed
   * and a merge that would not commit answer in the same word — and the lane
   * must tell them apart: it waits out the first and moves to the next name
   * past the second. Read and cleared by `pass`.
   */
  const persistent = new Set();
  async function runStep(name, world = {}, { lane = 0, claimed = false } = {}) {
    if (!claimed && claims.has(name)) { say(`${name}: in flight in another lane, skip`); return 'skipped'; }
    claims.add(name);
    persistent.delete(name);
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
    // The other way out, for the refusals a person has to act on: the same word
    // back to the lane, and the step written `blocked` on `main` so that this
    // project is never picked again until somebody sets it `ready`
    // (`blockStep`, and `WORKAREA_BLOCKS` for which refusals are these).
    const block = async (reason, detail) => {
      say(`${name}: ${detail} — ${worktree}`);
      persistent.add(name);
      await blockStep({ repo, name, reason: WORKAREA_BLOCKS[reason], detail });
      return `skipped:${reason}`;
    };
    if (!deps.exists(worktree)) {
      say(`${name}: no workarea — creating ${repo.name} worktree from origin/main`);
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      const added = deps.addWorktree({ name, repo: repo.path, branch: name, from: 'origin/main', env: deps.env });
      if (!added.ok) return block(REFUSAL.worktree, `git worktree add failed (${added.reason})`);
    }
    // A merge of origin/main a killed session left behind. The runner aborts
    // its own after the session (below), but a runner killed mid-session — rc
    // 143, `mc run stop --force` — never reaches that line, and what it leaves
    // is unmerged paths: a dirty worktree, which parks the project for every
    // pick from then on. `sql-w1-universe-closure` was
    // `dirty worktree (.gitattributes, .github/workflows/deploy.yml,
    // .gitignore +1039)` every round of 2026-09-08 on exactly this.
    //
    // The abort returns the tree to the branch's own last commit; nothing a
    // session committed is touched, and what it had not committed went with the
    // session. `REBASE_HEAD` and `CHERRY_PICK_HEAD` are deliberately not
    // aborted — the runner starts neither, so one of those is a person's work
    // and the dirty check below reports it as it always has.
    if (deps.git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
      deps.git(worktree, ['merge', '--abort']);
      say(`${name}: a merge of origin/main was left in progress — aborted`);
    }
    // A dirty worktree is nobody's but a person's — the runner never commits,
    // stashes or restores one — so the step is blocked and the files are named:
    // `email-window-layout` stood third in queue.md and was skipped 134 rounds
    // on three modified files before anyone read the reason.
    const dirty = (gitOut(worktree, ['status', '--porcelain']) || '').trim();
    if (dirty) {
      // `XY path` per porcelain line; the whole is trimmed above, which takes
      // the first line's leading status space with it — hence a pattern, not
      // `slice(3)`, which printed `ublic/css/…` on 2026-09-04.
      const files = dirty.split('\n').map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/u, '').trim() || line.trim());
      const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? ` +${files.length - 5}` : '');
      return block(REFUSAL.dirty, `uncommitted changes that are not a merge in progress (${shown})`);
    }
    if (prsFailed.includes(repo.name)) return refuse(REFUSAL['prs-unknown'], 'what is open on GitHub is unknown this round, skip');

    // Work already in flight ends the round for this project, whatever the
    // plan says — the plan on origin/main and the plan in the worktree both
    // read `ready` while the step's work sits in an open pull request. The
    // rule itself is `inFlight`, beside `chooseKind` in run-plan.js.
    const openPrs = openPrsFor({ prs, name, names: plans.map((p) => p.project), repo: repo.name });
    const flight = inFlight(openPrs);
    if (flight) return refuse(flight.reason, flight.skip);
    // A session must be somewhere it can push from. The push-guard asks the
    // same question at the wrong end — after ninety minutes of work.
    const moved = freshBranch(worktree, name);
    if (!moved.ok) return block(REFUSAL.branch, moved.why);

    const sync = syncMain(worktree, name);
    // A fetch that failed is the network and this lane waits it out; a merge
    // that resolved and would not commit is this workarea, and a person's.
    // The merge git would not commit is aborted before the block is written,
    // so the workarea a person opens is the branch's own last commit and not a
    // tree with everything staged.
    if (!sync.ok && !sync.conflicts.length) {
      if (sync.why === 'commit') {
        if (deps.git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) deps.git(worktree, ['merge', '--abort']);
        return block(REFUSAL.sync, sync.detail);
      }
      return refuse(REFUSAL.sync, 'fetch/merge failed, skip');
    }
    // What git and the plan's own rule could not resolve. It no longer makes
    // the project unreadable to the runner: the conflict goes to the step
    // session as something to do first.
    const conflicts = sync.conflicts;
    // Off disk, always: a conflicting `PLAN.json` has been resolved by the
    // plan's rule or by taking main's copy before this line (`syncMain`), and
    // every other conflict left main's plan on disk already merged. That is the
    // copy the runner hands out.
    const plan = planOf(worktree, name);
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
    // The one plan conflict that still stops a step: git could give neither the
    // plan's rule its three sides nor main's copy (`resolvePlanConflict`), so
    // the plan on disk is a half-merged file no session can be handed a step
    // from. Nothing the runner does next changes that, so it is blocked like
    // any merge that would not commit.
    const planAt = plan?.path?.startsWith(`${worktree}/`) ? plan.path.slice(worktree.length + 1) : null;
    if (planAt && conflicts.includes(planAt)) {
      abandonMerge(`${planAt} could not be resolved`);
      return block(REFUSAL.sync, `origin/main was merged in and ${planAt} could be resolved neither by the plan's rule nor by taking main's copy`);
    }
    // What the worktree's file says a step *is*, with the register's word on
    // where it *stands* laid over it for the choice — and only for the
    // choice: the prompt quotes the file, and the boundary check after the
    // session compares the file the session was handed with the one it left,
    // so a register state on some other step must not read as an edit.
    const standing = (found) => {
      const entry = found?.plan ? readEntry(root, name, { read: deps.read }) : null;
      return entry ? applyEntry({ ...found, project: name }, entry) : found;
    };
    const choice = chooseKind({ plan: standing(plan) });
    if (conflicts.length && choice.kind !== 'step') {
      // The way here is `runStep` driven by hand past the picker — the plan on
      // disk is main's and it refuses the project itself. A project main's plan
      // refuses is never picked at all (`nextFor`, run-plan.js), so no worktree
      // of its is touched by a lane. That is the plan's word, not the merge's,
      // and nothing is recorded: `machineState` reads the same plan on main and
      // answers it before it asks anything of this machine.
      abandonMerge(choice.skip || 'no session to hand it to');
      return refuse(choice.reason || 'no-plan');
    }
    // A null `skip` is a skip nobody would read — see `chooseKind`.
    if (!choice.kind) return refuse(choice.reason || 'no-plan', choice.skip ? `${choice.skip}, skip` : null);
    const { kind } = choice;

    // The two that are about this machine rather than this workarea, and blocked
    // for the same reason: nothing the runner does next installs a role file or
    // a tool. The merge is abandoned first, so the block is written over a
    // workarea that is not left mid-merge.
    const role = deps.role(kind);
    if (!role?.overlay) {
      abandonMerge(`canon/roles/${kind}.md is missing`);
      return block(REFUSAL['role-missing'], `canon/roles/${kind}.md is missing on this machine`);
    }
    // Step over plan over the kind's defaults (ruling 18).
    const settings = sessionSettings(plan?.plan?.runner, choice.step?.runner, { kind });
    const launch = deps.launch(settings.tool);
    if (!launch?.ok) {
      abandonMerge(`${settings.tool} is not available`);
      return block(REFUSAL['tool-missing'], `${settings.tool} is not available on this machine (${launch?.hint || launch?.reason})`);
    }
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
    const prompt = stepPrompt({ name, repo: repo.name, planPath: plan.path, plan: plan.plan, step: choice.step, index: choice.index, conflicts, now });
    const instructions = instructionsFor(launch.id, await deps.profile(), role.overlay);
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: settings.model, effort: settings.effort, advisor: settings.advisor, instructions, prompt, profileArgs });

    const ts = stamp().replace(/[-:]/gu, '');
    const out = join(paths.log, `${name}-${ts}`);
    // A plan that names no model on a tool that is not claude gets none, and
    // the line says so rather than printing `null`: the tool picks.
    say(`${name}: ${kind} starting (${describeSettings(launch.shortName, settings)}, ${describeWatch(launch.id, settings)})`);
    const t0 = deps.now().getTime();
    // The lane's current file exists exactly as long as the session does —
    // written before the call that blocks, removed however that call
    // returns. It carries its repo, which is also its lane's name. The
    // machine's slot is dropped in the same breath, so what the page shows
    // and what the cap counts are the same fact and cannot drift. The
    // session's check-ins rewrite it with their count, which is what the
    // page's clock reads (`check_ins`); the timers stop before the session's
    // promise settles, so no check-in writes it after the `finally` below.
    const currentPath = paths.currentFor(repo.name, lane);
    const current = {
      name, kind, repo: repo.name, lane, tool: settings.tool, model: settings.model,
      effort: settings.effort, advisor: settings.advisor,
      check_in_minutes: launch.id === 'codex' ? null : settings.checkInMinutes, check_ins: 0,
      started: stamp(), pid, worktree,
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
    };
    writeJson(currentPath, current);
    // The step is running, says the register — with the session's pid as
    // soon as there is one, which is what `mc merge` ends when the step
    // lands.
    const stepIndex = choice.index;
    const stepBranch = gitOut(worktree, ['branch', '--show-current']) || name;
    if (stepIndex != null) {
      recordStep(name, stepIndex, {
        status: 'running', branch: stepBranch, pr: null, reason: null,
        session: { pid: null, started: stamp(), model: settings.model, lane, tool: settings.tool },
      });
    }
    let result;
    try {
      result = await deps.session({
        bin: launch.spec.bin, args, cwd: worktree,
        ...watchFor(launch, settings, {
          prompt, name, kind,
          onCheckIn: (count) => writeJson(currentPath, { ...current, check_ins: count }),
        }),
        env: stepIndex == null ? {} : { MC_STEP: `${name}:${stepIndex}`, MC_PROJECT: name, MC_REPO: repo.name, MC_WORKAREA: worktree },
        onSpawn: (childPid) => {
          if (stepIndex == null) return;
          recordStep(name, stepIndex, { session: { pid: childPid, started: stamp(), model: settings.model, lane, tool: settings.tool } });
        },
      });
    } finally {
      remove(currentPath);
      dropSlot();
    }
    const seconds = Math.round((deps.now().getTime() - t0) / 1000);
    writeSessionLogs(out, result);

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
    const read = readSessionOutput({ toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut, stalled: result.stalled });
    let { note } = read;

    // Where the step stands now is the register's word, not this process's
    // (ruling 21). The session ran `mc merge` itself: green wrote `done` and
    // ended the session, so the process under this lane came back with a
    // signal and no JSON, and that is the ordinary end of a landed step. A
    // session that gave up wrote `failed` with its reason. Anything still
    // `running` when the process is gone is failed here: a pull request
    // left open the session did not land, or no pull request at all. A
    // quota answer is no session and the step goes back to `ready`. The
    // runner lands nothing of a session's and never retries a failed step;
    // `mc step ready` is the way back.
    const landSeconds = null;
    const after = readEntry(root, name, { read: deps.read })?.steps?.[choice.index] || null;
    // The row's note keeps the session's own exit word — `success`,
    // `timeout`, `no-json`, `failed` — and says after it where the step
    // stands: a step `mc merge` landed is `success,merged` however the
    // process died, because the verb ends the session on purpose.
    if (after?.status === 'done') {
      note = 'success,merged';
      say(`${name}: #${after.pr || pr} landed through mc merge from the session — step ${choice.index + 1} is done`);
      if (after.pr) askForUpdate(repo, name, after.pr);
    } else if (after?.status === 'failed') {
      note = `${note},failed`;
      say(`${name}: step ${choice.index + 1} failed by the session's own word — ${after.reason}`);
    } else if (after?.status === 'blocked') {
      note = `${note},blocked`;
      say(`${name}: step ${choice.index + 1} is blocked by the session on ${after.blocked_by?.kind} ${after.blocked_by?.name}`);
    } else if (read.quota) {
      recordStep(name, choice.index, { status: 'ready', session: null });
    } else {
      const reason = pr !== '-'
        ? `#${pr} is open and the session ended ${note} (rc ${result.status}) without landing it`
        : `the session ended ${note} (rc ${result.status}) with no pull request`;
      recordStep(name, choice.index, { status: 'failed', pr: Number(pr) || null, branch, reason });
      say(`${name}: step ${choice.index + 1} failed — ${reason}`);
      note = `${note},failed`;
    }

    logRun({ ts: stamp(), name, kind, exit: result.status, seconds, pr, turns: read.turns, input: read.input, output: read.output, cacheRead: read.cacheRead, cacheWrite: read.cacheWrite, session: read.session, note, landSeconds, model: settings.model });
    say(`${name}: ${kind} done rc=${result.status} ${seconds}s pr=${pr} turns=${read.turns} note=${note}${landSeconds == null ? '' : ` land=${landSeconds}s`}`);
    if (read.quota) await quotaPause();
    // `merged` and `ran` are both *a step ran*, and the lane picks again on
    // either. They are still told apart because the row and the log line are
    // read by a person, and because a merged step is the one that leaves the
    // project ready for its next one — which the order now takes care of:
    // the project is still at the head of it (2026-09-08, replacing the
    // eight-step stay a lane used to make after a merge).
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
      // The plan on main says what each step is; the register says where it
      // stands (register.js). A plan the register has never seen is seeded
      // from its own file here, once, and a step whose session is gone —
      // a runner killed under it, a machine that slept — is failed here,
      // because a `running` step with no process is one nothing will finish.
      plans.push(...sweepRunning(overlayPlans(listPlans(repo, { git: gitOut, batch: showBatch(gitOut) }), register)));
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
   * What this lane takes next: the first name in the queue's order, in this
   * repository, that the plan on `origin/main` says is ready and that nothing
   * else — an open pull request, a spent repair, another lane's claim — is
   * holding. The rule is `nextFor` (run-plan.js), which is the same function
   * the page draws NEXT from; what this adds is the two things only the
   * running process knows: what the lanes are holding, and what this pass has
   * already been refused on.
   */
  function nextStep({ repo = null, world = {}, passed = new Set() } = {}) {
    return nextFor({ repo, world, claimed: claims, passed });
  }

  /**
   * One pass of one lane: the world for its repository read once, then the
   * first name nothing stops, run — and the answer, so the lane knows whether
   * to pick again at once or to wait.
   *
   * Returns `{ ran, stop, waited, name, step }`. `ran` is 0 or 1: a pass ends
   * when a step has run, because the world it was picked from is now a world
   * in which a pull request exists and a plan has moved on, and the next pick
   * must be made against the new one. `waited` is the refusal that was about
   * this moment rather than about the project (`WAIT_REFUSALS`) — the lane
   * sleeps and asks the same question again. Anything else is this project's
   * own refusal: it is passed over for the rest of this pass and the lane
   * moves to the next name, which is what stops one stuck project from
   * standing in front of a queue (2026-09-08: `sql-w3-email-closure` was
   * merged, refused and aborted every ten minutes for two days, and
   * `sql-w1-universe-closure` was dirty every round, while 15 memoro projects
   * behind them ran nothing).
   *
   * `last` is the `{ name, step }` this lane ran a moment ago, and the one
   * thing the picker itself cannot know: whether anything moved. A project
   * whose step landed is picked again at once and gets its *next* step, which
   * is what the eight-step stay after a merge was for — but a step that ended
   * with the plan on main saying exactly what it said before is one this lane
   * would otherwise start again the second it finished, for ever. So that one
   * name waits for the next pass.
   */
  async function pass({
    repo = null, lane = 0, tag = null, world = null, last = null, passed: already = [],
  } = {}) {
    const label = tag || repo || 'run';
    const known = world || queue({ only: repo });
    // Cleared with the world, and only with it: the names in here were refused
    // by a reading of this world, and a fresh reading is what could change the
    // answer. A caller may seed it with names it already has an answer for —
    // which is how a test drives a lane over a whole queue without a clock.
    const passed = new Set(already);
    const stepOf = (name) => known.plans.find((item) => item.project === name)?.step ?? null;
    for (;;) {
      if (stopRequested()) return { ran: 0, stop: true };
      const pick = nextStep({ repo, world: known, passed });
      if (!pick) return { ran: 0 };
      if (last && pick.name === last.name && stepOf(pick.name) === last.step) {
        say(`${label}: ${pick.name} is on the same step its last session ended on — leaving it for the next pass`);
        passed.add(pick.name);
        continue;
      }
      const plan = known.plans.find((item) => item.project === pick.name) || null;
      const at = plan?.step && plan?.steps ? ` (step ${plan.step}/${plan.steps})` : '';
      say(`${label}: next — ${pick.name}${at}`);
      // The claim, taken in the tick the name was picked: `nextStep` has just
      // read this set, and a second lane picking a moment from now must see
      // the name taken before this one's session has opened anything.
      claims.add(pick.name);
      const outcome = await runStep(pick.name, known, { lane, claimed: true });
      if (outcome === 'stop') return { ran: 0, stop: true };
      if (outcome === 'ran' || outcome === 'merged') {
        const ran = { ran: 1, name: pick.name, step: stepOf(pick.name) };
        if (stopRequested()) {
          say(`runner exit on STOP after ${pick.name} (remove ${paths.stop} before the next start)`);
          return { ...ran, stop: true };
        }
        return ran;
      }
      // A refusal that blocked the step is never a wait, whatever its word: the
      // plan on main is being told, and the next name is the lane's business.
      if (!persistent.delete(pick.name) && WAIT_REFUSALS.has(outcome)) return { ran: 0, waited: outcome };
      passed.add(pick.name);
    }
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
    paths, repos, say, pass, nextStep, claims, chores, runStep, runHelperDay, runIntakeDrain, archiveDone, queue, stopRequested,
    writeUnreadable,
    blockStep,
    updateRequested, syncMain, freshBranch, landDocsPr, planOf, repoOf, markRunner, clearRunner, closeWorkareas,
    closeWorkarea, archivedProjects, workareas, tidyQueue,
  };
}

/**
 * The loop: one lane loop per repository per `per_repo`, each taking the next
 * step of the next project until a STOP file appears or an UPDATE hands over —
 * or, under `--once`, one step and out.
 */
export async function runLoop({
  once = false, merge = true, idleSleepMs = 600_000,
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
  runner.say(`runner start (mc run, merge=${merge ? 1 : 0} once=${once ? 1 : 0})`);
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
    if (!once) {
      // The unattended run: one loop per repository, each on its own clock,
      // each taking the next step of the next project (`pass`). The chores a
      // round used to do around its lanes run in their own loop beside them.
      // STOP and UPDATE are read between picks, and the handover waits for
      // every lane to reach one.
      //
      // `mc run lanes <n>` puts n of these loops on each repository. They take
      // from one ordered list and claim what they pick (`claims`), so two
      // never hold one project — until 2026-09-08 they took every nth name of
      // the repository's list instead, which meant lane 2 took the second name
      // whether or not lane 1 could run the first. What they share is the
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
      // Nothing in flight anywhere: no step lane in a session.
      const quiet = () => runner.paths.currents().length === 0;
      const lane = async (repo, index) => {
        const tag = count > 1 ? `${repo.name}#${index + 1}` : repo.name;
        let draining = false;
        // The last line this lane said about having taken nothing. An idle
        // lane looks every ten minutes and would otherwise write the same
        // sentence 144 times a day; it says it once and then goes quiet until
        // something changes.
        let quietLine = null;
        // What this lane ran a moment ago, so a step that left the plan where
        // it found it is not started again the second it ends (`pass`).
        let last = null;
        for (;;) {
          if (runner.updateRequested()) {
            if (!draining) { draining = true; runner.say(`${tag}: UPDATE — taking no new step; handing over when every lane is done`); }
            if (quiet()) return { update: true };
            await deps.sleep(UPDATE_POLL_MS);
            if (runner.stopRequested()) return { stop: true };
            continue;
          }
          const r = await runner.pass({ repo: repo.name, lane: index, tag, last });
          if (r.stop) return { stop: true };
          // A step ran: the world it was picked from is stale now, so the next
          // pick is made at once against a fresh reading rather than after a
          // sleep nobody is waiting for.
          if (r.ran) { quietLine = null; last = { name: r.name, step: r.step }; continue; }
          // Nothing ran, and the sleep below is ten minutes: what the last step
          // left is worth looking at again on the other side of it.
          last = null;
          const line = r.waited
            ? `${tag}: waiting — ${r.waited === 'skipped' ? 'nothing could be started this pass' : r.waited.slice('skipped:'.length)}`
            : `${tag}: nothing to run — sleeping`;
          if (line !== quietLine) { runner.say(line); quietLine = line; }
          if (runner.updateRequested()) continue;
          await deps.sleep(idleSleepMs);
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
    // `--once`: one pick over the whole queue, in Martin's order, and out.
    // One lane, both repositories, no chores — a person watching one step,
    // which is what the flag is for. A project the machine refuses is passed
    // over and the next name tried, exactly as a lane does.
    const r = await runner.pass({ tag: 'once' });
    if (r.stop) { runner.say(`runner exit on STOP (remove ${runner.paths.stop} before the next start)`); return 0; }
    runner.say(r.ran ? 'once: exiting' : 'once: nothing to run');
    return 0;
  } finally {
    if (!handedOver) runner.clearRunner();
  }
}
