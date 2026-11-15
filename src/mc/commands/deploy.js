/**
 * `mc deploy` — the one door through which memoro's `main` reaches production.
 *
 * The deploy itself is memoro's: `npm run deploy` (`scripts/deploy.mjs`, its
 * seventeen steps ending in *Verify live version*) is the whole of it, and
 * nothing here reimplements a step of it or edits it. What this verb adds is
 * what is around it — the reading before, the one question that makes it a
 * thing a person did, and the process it runs in after. It hands the script one
 * thing: `MEMORO_DEPLOY_SKIP_REMOTE_PREFLIGHT=1`, always, because the commit
 * was chosen, measured and asked about here, and the script's own fast-forward
 * to the remote main would ship another.
 *
 * The question is not a formality and no flag skips it. Deploying to
 * production is asked every time, so `mc deploy` refuses outright
 * where there is nobody to ask: without a terminal it exits 2 rather than
 * assuming yes. `--dry-run` is the reading and stops before the question. The
 * runner never calls this and no role tells a session to: with `MC_HEADLESS=1`
 * it refuses before it reads anything (a deploy is refused to an unattended session), the reading
 * and `--follow` excepted.
 *
 * What ships is the newest first-parent commit of `origin/main` after the live
 * one whose full run is green (`pickCommit`) — main's tip when it is green, an
 * older commit when it is not, and then the reading says how far behind and
 * why the tip was passed over. Production never moves backwards: a pick is a
 * descendant of the live commit and not the live commit, or nothing ships.
 *
 * Before the question that commit is measured twice (`deploy-gate.js`): a full
 * run of exactly it from the history — one is started and followed when there
 * is none — and the suites memoro's `.mc/test.json` declares as gates, run
 * against a local server of it: the shared checkout is placed at it, detached,
 * and every ensure pins and never follows main. A red or stalled
 * run, a failed suite or one that cannot run refuses, naming what and the last
 * lines; a suite declared `gate: false` is not run and is never a refusal.
 * Only `--accept-red "<reason>"` goes past, and then main's tip is what is
 * prepared and shipped, with each red listed in the reading, the reason in the
 * question and the row. Both results are in the row
 * (`full_commit`, `full_verdict`, `suites`, `accepted_red`). The merge is never
 * held by any of it.
 *
 * Where the script runs is mc's to decide, and it is always a worktree that is
 * `main`: the one where `main` is checked out — git allows one — or one mc
 * makes and keeps under `~/.memoro/mc/deploy/memoro` when nobody has `main`
 * out. It is put at the commit that was measured by the deployer before the
 * script runs — fast-forwarded to it when behind, and in mc's own worktree reset
 * back to it (`git reset --keep`) when it stands past it — and the row names the
 * sha that shipped; a dirty or diverged `main` is a refused row naming the path — except
 * that in mc's own worktree, where nobody works, files git does not know are
 * removed rather than refused (`strayPaths`). `~/memoro` stays what it always
 * was for the reads — only the spawn's cwd moved (ruling 16, 2026-09-06: two
 * deploys had failed at *Deploy source preflight* because the verb spawned the
 * script in whatever branch `~/memoro` happened to be on).
 *
 * After the yes the deploy is its own process — the deployer, `ship` in
 * `deploy-run.js`, detached, its output in `~/mc/runner/log/deploy.log` — and
 * the terminal that asked only watches it (`followDeploy`): ^C stops the
 * watching, not the deploy, and `mc deploy --follow` watches again (ruling 30,
 * 2026-10-09). It takes no repository lease. A merge round holds the lease for
 * its whole gate, and until then a deploy waited up to eight minutes for that
 * window and gave up with exit 3; but the worktree is moved by nothing but
 * this verb, and a merge landing on `origin/main` changes nothing the build
 * sees (ruling 26). What it does wait for is the gate round in flight, and
 * the merger starts none while it runs (`waitForGate`, 2026-10-10): beside a
 * merge round the build swapped for 26 minutes. There is no queue: what keeps two deploys apart is the
 * record — a `running` row whose process is alive (`runningDeploy`,
 * deploys.js) is a deploy in progress, and a second one is refused with its
 * sha and start time. The check and the new row are one step under the
 * register's lock, which is held for milliseconds and by no merge round.
 *
 * The record (`deploys.js`) is written around the spawn rather than after it:
 * the row exists, saying `running`, before `npm run deploy` is started, and is
 * completed however it ends. A deploy that never came back is then a row that
 * says so instead of a silence somebody has to reconstruct from
 * `/admin/deploy/logs`. A refusal — no terminal, a `no`, a deploy already
 * running — is a row too: it is a deploy somebody meant to make.
 *
 * Every process boundary is on `deps` — git, the spawn, the prompt, the
 * deployer, the version fetch — so the whole verb runs in a test with nothing
 * real behind it (`startDeployer` running `ship` in the test's own process).
 * The record is the exception, and deliberately so: it is what this verb
 * exists to leave behind, `env` is already the seam that points it at a
 * throwaway directory, and a faked writer would only prove that the fake was
 * called.
 *
 * Exit codes: 0 for a deploy verified, `--dry-run`, or `--follow` with none
 * running; 1 for a deploy that failed, a `no`, a deploy already running or a
 * repository this machine has no checkout of, a refusal by the gate or a
 * headless session; 2 for a bad argument or no
 * terminal; 130 when the watching was stopped and the deploy goes on. Run in
 * this process (a test), the script's own exit code.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripAnsi } from '../../lib/prompt.js';
import { defaultRepos } from '../brief-collect.js';
import {
  closeAbandoned, DEPLOYED, FAILED, lastDeploy as lastDeployRow, readDeploys, recordEnd, recordRefusal, recordStart,
  runningDeploy,
} from '../deploys.js';
import { DEPLOY_MODE, holdName } from '../await-deploy.js';
import { branchNamed, openBranchPr, pinNote } from '../deploy-branch.js';
import { deployProgress } from '../deploy-progress.js';
import { fullRunVerdict, gateRecord, measureGate, pickCommit, reds, suiteLines, withMendsNow } from '../deploy-gate.js';
import {
  preparationLogPath, preparationServes, preparationState, patchPreparation, readPreparation, STAGE_WORDS,
  writePreparation,
} from '../deploy-prepare.js';
import { mcDiskPressure } from '../disk-admission.js';
import { POLL_MS as DISK_POLL_MS } from '../disk-pressure.js';
import { BUILD_LANE, releaseGateLock, runningRounds, takeGateLock } from '../gate-lock.js';
import { mainWorktree, tryGit } from '../git.js';
import { baseUrl } from '../helper-collect.js';
import { processAlive } from '../lease-owner.js';
import { languageState as readLanguageState, liveRun } from '../language-runs.js';
import { installedScript, readMerger } from '../merger.js';
import { nightlyReading, readNightlyHistory } from '../nightly-history.js';
import { mcHome, workRoot } from '../paths.js';
import { ask as realAsk, interactive as realInteractive } from '../prompt.js';
import { realLock } from '../runner-lock.js';
import { currentHolder } from '../repo-lease.js';
import { ghCommand } from './publish.js';
import { run as mergeRun } from './merge.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

/** The repository this verb is about. It takes no argument and never will:
 * memoro-cli is not deployed, it is installed. */
export const REPO = 'memoro';

const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

export function parseDeployArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--dry-run', '--json', '--follow'], strictValues: ['--accept-red'] });
  const opts = { dryRun: false, json: false, follow: false, acceptRed: null };
  if (scanned.error) return { ...opts, error: scanned.error };
  if (scanned.positional.length) {
    return { ...opts, error: `mc deploy takes no arguments (${scanned.positional[0]}) — it deploys memoro's main, and nothing else` };
  }
  // The reason is the point of the flag: it is read at the question and kept in
  // the record, so a blank one is no reason and the flag is refused with it.
  const accepted = scanned.flags['accept-red'];
  if (accepted !== null && !String(accepted).trim()) {
    return { ...opts, error: '--accept-red needs a reason — say why the red is accepted, in words; it is on the record' };
  }
  return {
    dryRun: scanned.flags['dry-run'], json: scanned.flags.json, follow: scanned.flags.follow,
    acceptRed: accepted === null ? null : String(accepted).trim(),
  };
}

export function usage() {
  return commandUsage('deploy');
}

/** `GET /api/version` — what production says it is, public and uncached. */
async function fetchVersionDefault(env = process.env) {
  try {
    const response = await fetch(`${baseUrl(env)}/api/version`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-store' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

/** What a person or a closing terminal sends a deploy that should stop. */
const STOP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

/** What `mc deploy` always hands `scripts/deploy.mjs`: do not fast-forward to origin/main (the script's own switch). */
export const SKIP_REMOTE_PREFLIGHT = 'MEMORO_DEPLOY_SKIP_REMOTE_PREFLIGHT';

export function spawnDeployDefault({
  cwd, env, onOutput, stdout = process.stdout, stderr = process.stderr, signals = process,
  spawnProcess = spawn,
}) {
  return new Promise((resolve) => {
    // The environment goes through as the caller has it — MEMORO_DEPLOY_CONTAINERS and
    // wrangler's own variables are the caller's to set, not mc's to invent — with one
    // addition: MEMORO_DEPLOY_SKIP_REMOTE_PREFLIGHT=1, always. The script's remote main
    // preflight (`ensureUpToDateWithOrigin`: fetch, then fast-forward to origin/main)
    // is then skipped — it would ship the tip instead of the commit mc measured and
    // placed the worktree at. The clean-tree check still runs, and `ship` checks that
    // HEAD is the measured commit before the spawn (`moved`).
    //
    // stdout and stderr are piped rather than inherited so the row can say
    // which step it stopped at and what version was verified — every chunk is
    // echoed straight on, so the person still watches the script's own
    // seventeen steps as they happen. The cost is that the child sees a pipe
    // and not a terminal, so a tool that draws a progress bar only for a TTY
    // prints plain lines instead. stdin stays inherited: `deploy.mjs` asks
    // nothing, but wrangler's own login flow might.
    const child = spawnProcess('npm', ['run', 'deploy'], { cwd, env: { ...env, [SKIP_REMOTE_PREFLIGHT]: '1' }, stdio: ['inherit', 'pipe', 'pipe'] });
    const tee = (stream, sink) => {
      if (!stream) return;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { sink.write(chunk); onOutput?.(chunk); });
    };
    tee(child.stdout, stdout);
    tee(child.stderr, stderr);

    // ^C, a closed terminal or a kill must not take mc down before the script:
    // the script needs the time to stop wrangler and restore its stamps, and
    // the row needs completing after it. Until 2026-10-06 mc died with the
    // signal; the row stayed `running`, the stamps stayed in the tree, and the
    // next mc deploy refused that tree as dirty. So mc waits, and passes the
    // signal on as SIGTERM — npm hands that to deploy.mjs, which says what
    // production runs and exits. A second ^C is passed on too: the script
    // takes that as "quit now" and still restores the stamps first.
    let interrupted = null;
    const ignoreWriteErrors = () => {};
    const onStop = (signal) => {
      if (!interrupted) {
        interrupted = signal;
        try {
          stderr.write(`\nmc: ${signal} — stopping the deploy; waiting for it to restore its stamps and say what production runs\n`);
        } catch { /* the terminal is gone */ }
      }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };
    for (const signal of STOP_SIGNALS) signals.on(signal, onStop);
    for (const sink of [stdout, stderr]) sink.on?.('error', ignoreWriteErrors);

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      for (const signal of STOP_SIGNALS) signals.off(signal, onStop);
      for (const sink of [stdout, stderr]) sink.off?.('error', ignoreWriteErrors);
      resolve({ ...result, interrupted });
    };
    child.on('error', (error) => settle({ code: 127, error: error?.message || String(error) }));
    // `close` rather than `exit`: it fires once the piped streams are drained,
    // so the last step header is in hand before the row is completed.
    child.on('close', (code, signal) => settle({ code: signal ? 1 : (code ?? 1), signal: signal || null }));
  });
}

/** How much of the script's chatter is kept. Everything the row needs — the
 * last step header, the verified version, the failure — is at the end of it,
 * and a container build can print megabytes before that. */
const OUTPUT_TAIL = 256 * 1024;

/**
 * What `deploy.mjs` said, in the four things the row keeps.
 *
 * The lines, read from `scripts/deploy.mjs` on 2026-09-04 and matched after
 * the colours are stripped:
 *   `▸ <label>`                                     — `step()`, its 17 headers
 *   `Live /api/version verified: build <n> · <sha>` — `verifyLiveVersion()`
 *   `✓ Deploy complete build <n> · <sha>`           — the success banner
 *   `✗ Deploy failed` + the message beneath it      — the catch at the end
 *
 * And, from 2026-10-05, the summary the script prints under `✗ Deploy failed`
 * and the retries it made on the way:
 *   `Production <what production runs now>`        — e.g. `unchanged — …`
 *   `Cause <why, and whether a rerun helps>`
 *   `↻ <wrangler call> failed after …`             — one per retry
 * And, from 2026-11-09, the last line of a deploy that made a change of its own
 * on a branch (`deploy-branch.js`):
 *   `Deploy branch: <branch>`                      — pushed; `ship` opens its pull request
 * Only the summary's lines count, the ones after `✗ Deploy failed`: a retry
 * prints `Production meanwhile: …` too, and a deploy that then went through is
 * not described by it.
 *
 * Tolerant on purpose: every one of them is a line that may not be there —
 * `MEMORO_DEPLOY_SKIP_LIVE_VERSION_VERIFY` removes the verified line, a
 * script that changes its wording removes any of them — and a missing line is
 * an empty cell. A deploy that worked must never be recorded as a failure
 * because mc could not parse the banner it printed.
 */
export function readScriptOutput(text) {
  const lines = stripAnsi(String(text || '')).split('\n').map((line) => line.trim());
  let stoppedAt = '';
  let verified = null;
  let banner = null;
  let failure = '';
  let failed = false;
  let production = '';
  let cause = '';
  let retries = 0;
  const branch = branchNamed(lines);
  lines.forEach((line, index) => {
    const step = /^▸\s+(.+)$/u.exec(line);
    if (step) { stoppedAt = step[1].trim(); return; }
    const live = /^Live \/api\/version verified: build (\d+) · (\S+)$/u.exec(line);
    if (live) { verified = { build: live[1], commit: live[2] }; return; }
    const complete = /^✓ Deploy complete build (\d+) · (\S+)$/u.exec(line);
    if (complete) { banner = { build: complete[1], commit: complete[2] }; return; }
    if (/^↻ /u.test(line)) { retries += 1; return; }
    if (/^✗ Deploy failed$/u.test(line)) {
      failed = true;
      failure = lines.slice(index + 1).find((next) => next) || '';
      return;
    }
    if (!failed) return;
    const prod = /^Production\s+(?!meanwhile:)(.+)$/u.exec(line);
    if (prod) { production = prod[1].trim(); return; }
    const why = /^Cause\s+(.+)$/u.exec(line);
    if (why) cause = why[1].trim();
  });
  return {
    stopped_at: stoppedAt,
    // The build number that shipped: the banner's, or the verified line's when
    // the script fell over between the two.
    build: banner?.build || verified?.build || '',
    // Only what was actually verified against production goes in these two.
    // The banner is what mc stamped, which is a different claim.
    live_commit: verified?.commit || '',
    live_build: verified?.build || '',
    verified: Boolean(verified),
    failure,
    production,
    cause,
    retries,
    branch: branch || '',
  };
}

/**
 * Where mc keeps a `main` of its own: `~/.memoro/mc/deploy/memoro`, added with
 * `git worktree add` the first time a deploy finds `main` checked out nowhere,
 * and never removed.
 *
 * Under `mcHome()` and deliberately not under `~/mc/`: a checkout there is a
 * runner area to `listStepAreas` (`work-area.js`) and to the runner's
 * `closeWorkareas`, or a stray to `listStrays`, and a deploy checkout is neither a project nor something
 * the board should draw. `env` rather than `mcHome()` alone so the seam every
 * other process boundary in this file goes through covers this one too.
 */
export function deployWorktreePath(env = process.env) {
  return join(env.MC_HOME || mcHome(), 'deploy', REPO);
}

/**
 * The worktree `npm run deploy` will run in, in the order the ruling fixes:
 *
 * 1. wherever `main` is checked out — git allows at most one worktree per
 *    branch, so there is nothing to choose between;
 * 2. otherwise mc's own, made here when `create` is set.
 *
 * Once mc's exists, (1) always finds it and the two cases converge: a
 * `git checkout main` anywhere else is refused by git while it stands, which
 * is the point (Martin, 2026-09-06: *"Jag checkar ut main enbart för att göra
 * deploys"*).
 *
 * `--dry-run` passes `create: false` and gets the path it *would* make, with
 * `absent: true`: the reading says where the deploy would run without making a
 * directory on the way.
 */
export function deploySource({ path, git = tryGit, env = process.env, create = false }) {
  const found = mainWorktree(git(path, ['worktree', 'list', '--porcelain']));
  if (found) return { worktree: found, created: false, absent: false, failed: false };

  const mine = deployWorktreePath(env);
  if (!create) return { worktree: mine, created: false, absent: true, failed: false };

  // `main` exists locally in all but a checkout that has only ever fetched;
  // then the branch is made from `origin/main` in the same call.
  const local = git(path, ['show-ref', '--verify', '--quiet', 'refs/heads/main']) !== null;
  const args = local
    ? ['worktree', 'add', mine, 'main']
    : ['worktree', 'add', '-b', 'main', mine, 'origin/main'];
  const added = git(path, args);
  if (added === null) return { worktree: mine, created: false, absent: true, failed: true };
  return { worktree: mine, created: true, absent: false, failed: false };
}

/**
 * The three readings that decide whether that worktree may be deployed from:
 * uncommitted files, commits it has that `origin/main` does not, and how far
 * behind it is. Read in the worktree itself — a working tree is its own, while
 * `origin/main` is a ref every worktree of the repository shares.
 */
export function worktreeState({ worktree, git = tryGit }) {
  const status = git(worktree, ['status', '--porcelain']);
  const dirty = String(status || '').split('\n').filter((line) => line.trim());
  const count = (range) => {
    const out = git(worktree, ['rev-list', '--count', range]);
    const value = Number(out);
    return out !== null && Number.isFinite(value) ? value : null;
  };
  // A status git could not give is not a clean tree: the caller refuses it.
  return { dirty, unreadable: status === null, ahead: count('origin/main..HEAD'), behind: count('HEAD..origin/main') };
}

/** Whether `worktree` is the one mc made for itself — the only `main` whose
 * dirt mc may remove, because nobody checks it out to work in. */
export function isOwnWorktree(worktree, env = process.env) {
  return resolve(worktree) === resolve(deployWorktreePath(env));
}

/**
 * The untracked paths in `dirty` when that is all it is, else null.
 *
 * In mc's own worktree they are leftovers, never work: on 2026-10-09 #13137
 * deleted the SDK generator together with the `.gitignore` block that hid its
 * output, so the fast-forward turned `artifacts/` and `public/sdk/` — written
 * there by every earlier deploy — into untracked files, and `deploy.mjs`'s
 * source preflight refused the tree. A generator retired with its ignore lines
 * does that every time, so mc removes them (`git clean -fd`, which leaves
 * ignored files such as `node_modules/` alone) instead of handing it to a person.
 * A modified or deleted tracked file is still a refusal: in that worktree it
 * means something went wrong, and that is worth seeing rather than discarding.
 */
export function strayPaths(dirty) {
  if (!dirty?.length) return null;
  return dirty.every((line) => line.startsWith('?? ')) ? dirty.map((line) => line.slice(3)) : null;
}

/** The two files `deploy.mjs` stamps before wrangler and restores after it
 * (`STAMPED_FILES` there). */
export const STAMP_FILES = ['public/sw.js', 'src/version.js'];

/** Every line a stamp writes: inject-version.mjs's whole `src/version.js`,
 * stamp-sw-cache.mjs's one `CACHE_VERSION` line. */
const STAMP_LINE = /^(\/\/ Auto-generated by scripts\/inject-version\.mjs\b.*|export const (VERSION|COMMIT|COMMIT_FULL|BUILD_TIME|BUILD_NUMBER) = .*|const CACHE_VERSION = .*)$/u;

/**
 * Whether everything uncommitted in `worktree` is a deploy's stamps — what a
 * deploy that was killed before it could restore them leaves behind. Only
 * then is the dirt not somebody's work: the two files and nothing else,
 * modified rather than added or deleted, and every added line one a stamp
 * writes. `deploy.mjs` restores such leftovers itself before it builds
 * (`repairGeneratedStamps`), so mc lets them through instead of refusing.
 */
export function leftoverStamps({ worktree, dirty, git = tryGit }) {
  if (!dirty?.length) return false;
  const entries = dirty.map((line) => {
    const [code, ...rest] = line.trim().split(/\s+/u);
    return { code, file: rest.join(' ') };
  });
  if (!entries.every(({ code, file }) => /^M{1,2}$/u.test(code) && STAMP_FILES.includes(file))) return false;
  const diff = git(worktree, ['diff', 'HEAD', '--unified=0', '--', ...entries.map(({ file }) => file)]);
  const added = String(diff || '').split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  return added.length > 0 && added.every((line) => STAMP_LINE.test(line.slice(1).trim()));
}

/**
 * What would ship, before anybody is asked: the commit, what is live, the gap
 * between them, and whether the nightly ever measured this tree whole.
 *
 * The commit is the newest first-parent commit of origin/main after the live
 * one whose full run is green (`pickCommit`) — main's tip when that is green,
 * and an older one when the tip's run is red, stalled or missing and an older
 * commit's is green. `plan.tip` is main's tip either way, and `plan.pick` says
 * what was passed over and why. With `acceptRed` the tip is what ships (the
 * person has said which red they take) and the pick is what would have shipped
 * without it. Nothing newer than the live commit — the live commit itself, or
 * one that does not descend from it — is `plan.backwards`: production never
 * moves backwards, and a refusal names the live commit.
 *
 * Everything it cannot answer is null rather than a guess — a deploy is not
 * the moment to invent a number — and `planLines` says the unknown out loud.
 */
export async function deployPlan({
  path, env = process.env, git = tryGit, fetchVersion = fetchVersionDefault,
  lastDeploy = lastDeployRow, nightly = nightlyReading, offline = false,
  languageState = readLanguageState, acceptRed = false, history = null,
}) {
  const fetched = offline ? false : git(path, ['fetch', 'origin', 'main', '--quiet']) !== null;
  const tip = git(path, ['rev-parse', '--verify', 'origin/main']);
  if (!tip) return { repo: REPO, path, sha: null, fetched, reason: 'no-checkout' };

  // What is live: the last deployed row's `live_commit` — what production said it ran
  // when that deploy was verified — else the sha it shipped, else what /api/version says.
  const row = lastDeploy(env);
  let last = null;
  if (row) {
    const ref = row.live_commit || row.sha;
    last = {
      sha: ref, short: short(ref), build: (row.live_commit ? row.live_build : '') || row.build || null,
      at: row.ended || row.started || null, source: 'deploys.tsv',
    };
  } else {
    const version = await fetchVersion(env);
    if (version?.commit) {
      last = {
        sha: version.commit, short: short(version.commit), build: version.build ?? null,
        at: version.build_time || null, source: 'api/version',
      };
    }
  }

  const count = (from, to) => {
    const out = from && to ? git(path, ['rev-list', '--count', `${from}..${to}`]) : null;
    const value = Number(out);
    return out !== null && Number.isFinite(value) ? value : null;
  };

  // The live commit as this checkout knows it, in full: a `live_commit` may be short.
  const liveFull = last ? (git(path, ['rev-parse', '--verify', `${last.sha}^{commit}`]) || null) : null;
  const descends = (sha) => Boolean(liveFull) && git(path, ['merge-base', '--is-ancestor', liveFull, sha]) !== null;
  let chain = [tip];
  let backwards = null;
  if (last && !liveFull) {
    backwards = `the live commit ${last.short} is not a commit this checkout has — nothing newer than it can be told from here, so nothing ships`;
  } else if (liveFull) {
    const listed = git(path, ['rev-list', '--first-parent', `${liveFull}..${tip}`]);
    if (listed === null) backwards = `git could not list the commits between the live commit ${last.short} and origin/main`;
    else chain = String(listed).split('\n').map((line) => line.trim()).filter(Boolean);
    if (!backwards && liveFull === tip) backwards = `the live commit ${last.short} is main's tip — nothing newer can ship`;
    else if (!backwards && !descends(tip)) backwards = `main's tip ${short(tip)} does not descend from the live commit ${last.short} — shipping it would move production backwards, and nothing newer can ship`;
  }

  const runs = history ? history() : readNightlyHistory(path, { root: mcHome(env) }).runs;
  const found = backwards
    ? { pick: null, tip, passed: [] }
    : pickCommit({ chain, live: liveFull, runs, descends });
  const tipVerdict = fullRunVerdict(runs, tip);
  // Without a green commit, or when the person accepts a red, the tip is what is prepared.
  const sha = acceptRed || !found.pick ? tip : found.pick;
  const older = Boolean(found.pick) && found.pick !== tip;
  const pick = {
    tip, green: found.pick, older, passed: found.passed,
    tip_state: tipVerdict.state, tip_run: tipVerdict.run,
    tip_red: tipVerdict.run?.red || [],
    behind: older ? count(found.pick, tip) : 0,
  };

  const reading = nightly(path);
  const measured = reading?.measured || null;
  const nightlyState = measured
    ? {
      commit: measured.commit, short: short(measured.commit), at: measured.at,
      red: measured.red, outcome: measured.outcome,
      this_tree: Boolean(measured.commit) && measured.commit === sha,
      behind: measured.commit === sha ? 0 : count(measured.commit, sha),
    }
    : null;

  return {
    repo: REPO,
    path,
    sha,
    short: short(sha),
    tip,
    subject: git(path, ['log', '-1', '--format=%s', sha]),
    fetched,
    last,
    live: liveFull,
    gap: last ? count(liveFull || last.sha, sha) : null,
    pick,
    backwards,
    nightly: nightlyState,
    // The deploy no longer promotes grammar; what waits is said here, from
    // the cache `mc language status` leaves — nothing is read anew.
    language: languageState(env),
  };
}

/**
 * The language line: what waits from the cached readings, and the gap a
 * stopped run left open. One line per fact, never a question.
 */
function languageLines(language, now = Date.now()) {
  if (!language) return [];
  const lines = [];
  const read = (language.languages || []).filter((entry) => entry.read_at);
  if (!read.length) {
    lines.push('mc: language — no reading; mc language status <lang>');
  } else {
    const waiting = read.filter((entry) => entry.waiting_rows);
    const ago = (entry) => {
      const minutes = Math.max(0, Math.round((now - Date.parse(entry.read_at)) / 60_000));
      if (!Number.isFinite(minutes)) return 'read at an unknown time';
      if (minutes < 60) return `read ${minutes}min ago`;
      const hours = Math.round(minutes / 60);
      return `read ${hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`} ago`;
    };
    if (waiting.length) {
      const said = waiting.map((entry) => `${entry.lang} ${entry.waiting_rows} rows waiting (${ago(entry)})`).join(', ');
      lines.push(`mc: language — ${said} · mc language promote`);
    } else {
      const newest = read.reduce((a, b) => (String(b.read_at) > String(a.read_at) ? b : a));
      lines.push(`mc: language — nothing waiting (${ago(newest)})`);
    }
  }
  const gap = language.open_gap;
  if (gap) lines.push(`mc: language — ${gap.manifest} stopped after ${gap.act}: ${gap.says} · mc language resume`);
  return lines;
}

/**
 * The one line that says where the script will run, and in what state that
 * `main` is. It is the reading, not the verdict: a dirty or diverged `main` is
 * said here and refused a moment later by `run`, so the person sees why.
 */
function sourceLine(plan) {
  const from = `mc: from ${plan.worktree} — `;
  if (plan.worktree_failed) return `${from}mc's own main worktree, which git worktree add would not make`;
  if (plan.worktree_absent) return `${from}mc's own main worktree, made before the script runs`;
  if (plan.stamps) return `${from}main, with the stamps a stopped deploy left in ${STAMP_FILES.join(' and ')} — the script restores them first`;
  if (plan.strays?.length) return `${from}mc's own main, ${plan.strays.length} untracked path${plan.strays.length === 1 ? '' : 's'} removed before the script runs`;
  if (plan.dirty?.length) return `${from}main, ${plan.dirty.length} uncommitted file${plan.dirty.length === 1 ? '' : 's'}`;
  if (plan.ahead) return `${from}main, ${plan.ahead} commit${plan.ahead === 1 ? '' : 's'} not on origin/main`;
  if (plan.behind) return `${from}main, ${plan.behind} behind origin/main, fast-forwarded before the script runs`;
  return `${from}main at origin/main`;
}

/** Why main's tip was passed over, in the words of its own full run — every red name, none cut. */
function passedOverWhy(pick) {
  const run = pick.tip_run;
  if (pick.tip_state === 'red') return `its full run is RED (${pick.tip_red.length}): ${pick.tip_red.join(', ')}`;
  if (pick.tip_state === 'stalled') return 'its full run STALLED';
  if (pick.tip_state === 'unmeasured') return `its full run stopped at ${run?.stopped_at || 'an unknown step'} and measured nothing`;
  return 'not measured: no full run of it';
}

const commits = (n) => `${n} commit${n === 1 ? '' : 's'}`;

/**
 * What the pick says beyond the commit itself: how far behind main's tip it is
 * and why the tip was passed over; under `--accept-red`, that the tip ships and
 * which green commit would have without it; with nothing green after the live
 * commit, that the tip is prepared as it is. A tip that is itself green says
 * nothing: it reads as it always did.
 */
function pickLines(plan) {
  const { pick } = plan;
  if (!pick || plan.backwards) return [];
  const tip = short(plan.tip);
  if (pick.older && plan.sha === pick.green) {
    const behind = pick.behind === null ? 'behind' : `${commits(pick.behind)} behind`;
    return [`mc: ${behind} main's tip ${tip} — ${passedOverWhy(pick)}`];
  }
  if (pick.older) {
    return [`mc: --accept-red ships main's tip ${tip}; without it ${short(pick.green)}, ${pick.behind === null ? 'behind' : `${commits(pick.behind)} behind`} the tip, would ship`];
  }
  if (!pick.green && plan.last && pick.tip_state !== 'green') {
    return [`mc: no commit after the live one ${plan.last.short} has a green full run — the tip is prepared as it is`];
  }
  return [];
}

/** The reading, in the words a person decides on. */
export function planLines(plan, { now = Date.now() } = {}) {
  const lines = [`mc: would deploy ${plan.repo} ${plan.sha}${plan.subject ? ` — ${plan.subject}` : ''}`];
  if (!plan.fetched) lines.push('mc: could not fetch origin — this is what the checkout already had');
  if (plan.worktree_created) lines.push(`mc: made mc's own main worktree at ${plan.worktree} — deploys run from it from now on`);
  if (plan.worktree) lines.push(sourceLine(plan));

  if (!plan.last) {
    lines.push('mc: what is live is unknown — no deploy of mc\'s own, and /api/version did not answer');
  } else {
    const when = plan.last.at ? `, ${String(plan.last.at).slice(0, 16).replace('T', ' ')}` : '';
    lines.push(`mc: live now ${plan.last.short}${plan.last.build ? ` (build ${plan.last.build})` : ''} — ${plan.last.source}${when}`);
    if (plan.gap === null) {
      lines.push(`mc: the gap is unknown — ${plan.last.short} is not a commit this checkout has`);
    } else if (plan.gap === 0) {
      lines.push('mc: nothing new would ship — this is already what is live');
    } else {
      lines.push(`mc: ${plan.gap} commit${plan.gap === 1 ? '' : 's'} would ship`);
    }
  }

  if (plan.backwards) lines.push(`mc: ${plan.backwards}`);
  lines.push(...pickLines(plan));

  if (!plan.nightly) {
    lines.push('mc: the nightly has measured nothing here — this tree was not measured whole');
  } else if (plan.nightly.this_tree) {
    lines.push(`mc: the nightly measured this tree ${plan.nightly.short} — ${plan.nightly.red === null ? 'no result' : `${plan.nightly.red} red`}`);
  } else {
    const ago = plan.nightly.behind === null ? 'another tree' : `${plan.nightly.behind} commit${plan.nightly.behind === 1 ? '' : 's'} ago`;
    lines.push(`mc: the nightly measured ${plan.nightly.short}, ${ago}; this tree was not measured whole`);
  }
  lines.push(...languageLines(plan.language, now));
  return lines;
}

/** The row's last cell: why it ended that way, in one line, or nothing when
 * there is nothing to say beyond `deployed`. */
function endNote({ result, said, ok, pin = null }) {
  const withPin = (text) => (pin ? [text, pinNote(said.branch, pin)].filter(Boolean).join('; ') : text);
  if (result.error) return withPin(`mc could not run npm run deploy — ${result.error}`);
  if (result.signal) return withPin(`killed by ${result.signal}`);
  if (!ok && result.interrupted && !said.failure) return withPin(`interrupted by ${result.interrupted}`);
  if (!ok) {
    const why = said.failure ? `exit ${result.code} — ${said.failure}` : `exit ${result.code}`;
    return withPin(said.production ? `${why} — production ${said.production}` : why);
  }
  // A green deploy whose live version nobody checked is worth saying: the
  // script skips its own verification on MEMORO_DEPLOY_SKIP_LIVE_VERSION_VERIFY.
  // So is one that needed retries: the count is how flaky the network was.
  const notes = [];
  if (!said.verified) notes.push('the script verified no live version');
  if (said.retries) notes.push(`went through after ${retryCount(said.retries)}`);
  return withPin(notes.join('; '));
}

function retryCount(n) {
  return `${n} retr${n === 1 ? 'y' : 'ies'} on network faults`;
}

/** The closing line of a failed deploy: where it stopped and what production
 * runs now, when the script said — and the old warning when it did not. */
function failureLine(code, said, interrupted) {
  const where = said.stopped_at ? ` at ${said.stopped_at}` : '';
  const production = said.production ? `production ${said.production}` : 'production may be part-way';
  if (interrupted) return `mc: the deploy was stopped by ${interrupted}${where} — ${production}\n`;
  return `mc: npm run deploy exited ${code}${where} — ${production}\n`;
}

/**
 * The gate for the commit that would ship: the full run, then the app used.
 *
 * Returns `{ full, exercise, lines, refusal, accepted }`. `refusal` is null when
 * the deploy may go on to its question, else `{ note, lines }` — the row's note
 * and what stderr says. A full run that measured nothing about this tree
 * (`unmeasured`, `moved`) refuses whatever flag was given; a red or stalled
 * run and a failed or unrunnable suite are what `--accept-red` accepts, each
 * listed. A deploy a red full run already refuses does not run the suites: the
 * answer is known and they cost minutes. A dry run and an accepted red run both,
 * so that the reading shows everything.
 */
export async function gateStage({ plan, opts, env, say, deps = {} }) {
  const measured = await measureGate({
    sha: plan.sha, path: plan.path, acceptRed: Boolean(opts.acceptRed), dryRun: opts.dryRun, env, say,
    deps: deps.gate || {}, suites: deps.suites || {},
  });
  return judgeGate({ ...measured, plan, opts });
}

/**
 * What the two measurements mean for this deploy: the lines to say, the
 * refusal if there is one, what `--accept-red` takes. The measuring may have
 * been done long ago, by another process (`deploy-prepare.js`); the judging is
 * always the asker's, with the asker's flags.
 */
export function judgeGate({ full, exercise, plan, opts }) {
  const lines = [...full.lines];
  const unmeasured = full.state === 'unmeasured' || full.state === 'moved';
  const redFull = full.state === 'red' || full.state === 'stalled';
  if (unmeasured || (redFull && !opts.dryRun && !opts.acceptRed)) {
    return { full, exercise: null, lines, accepted: '', refusal: refusalOf({ full, exercise: null, plan }) };
  }
  lines.push(...suiteLines(exercise, { sha: plan.sha }));

  const found = reds({ full, exercise });
  if (opts.dryRun) {
    if (found.length) lines.push(`mc: ${found.length} red would refuse the deploy${opts.acceptRed ? ' (--accept-red takes them)' : ' unless --accept-red "<reason>" takes them'}`);
    return { full, exercise, lines, refusal: null, accepted: '' };
  }
  if (!found.length) {
    if (opts.acceptRed) lines.push('mc: --accept-red — nothing is red; the reason is not needed and is not recorded');
    return { full, exercise, lines, refusal: null, accepted: '' };
  }
  if (!opts.acceptRed) return { full, exercise, lines, accepted: '', refusal: refusalOf({ full, exercise, plan }) };
  lines.push(`mc: --accept-red — accepting ${found.length} red:`);
  for (const item of found) lines.push(`mc:   ${item.replace(/\n/gu, '\nmc:     ')}`);
  lines.push(`mc: reason: ${opts.acceptRed}`);
  return { full, exercise, lines, refusal: null, accepted: opts.acceptRed };
}

function refusalOf({ full, exercise, plan }) {
  const found = reds({ full, exercise });
  const notes = [];
  if (full.state === 'unmeasured') notes.push(`no full run measured ${plan.short} — stopped at ${full.run?.stopped_at || 'an unknown step'}`);
  else if (full.state === 'moved') notes.push(`the full run measured ${short(full.run?.commit)}, not ${plan.short}`);
  for (const item of found) notes.push(item.split('\n')[0]);
  const lines = [`mc: refused — ${plan.short} is not measured whole and exercised:`, ...full.lines];
  for (const suite of exercise?.suites || []) {
    if (suite.state === 'red' || suite.state === 'cannot-run') {
      lines.push(`mc:   suite ${suite.name} ${suite.state === 'red' ? `failed (exit ${suite.status ?? 'unknown'})` : 'could not run'} — its last lines:`);
      for (const line of String(suite.tail || '').split('\n')) lines.push(`mc:     ${line}`);
    }
  }
  if (exercise?.error) lines.push(`mc:   the suites could not run: ${exercise.error}`);
  if (found.length) lines.push('mc: --accept-red "<reason>" is the only way past a red; the reason goes on the record');
  return { note: notes.join('; ') || 'the gate refused', lines };
}

/** The gate as --json says it. */
function gateSummary(gate) {
  return {
    full_run: { state: gate.full.state, commit: gate.full.commit, run: gate.full.run, mends: gate.full.mends },
    suites: gate.exercise ? { commit: gate.exercise.commit, error: gate.exercise.error, results: gate.exercise.suites } : null,
    refused: Boolean(gate.refusal),
    accepted_red: gate.accepted || null,
  };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const opts = parseDeployArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  // A deploy is refused to an unattended session (2026-11-14): refused before anything is read —
  // no fetch, no history, no full run, no suite. The reading (`--dry-run`) and
  // the watching (`--follow`) change nothing in production and stay allowed.
  if (env.MC_HEADLESS === '1' && !opts.dryRun && !opts.follow) {
    stderr.write('mc: mc deploy is refused to an unattended session and happens only in an interactive session; this one is headless (MC_HEADLESS=1) — nothing was deployed. mc deploy --dry-run is the reading.\n');
    return 1;
  }
  if (opts.follow) return follow({ env, stdout, deps });

  const repos = deps.repos || defaultRepos(env);
  const path = repos.find((repo) => repo.name === REPO)?.path;
  if (!path) {
    stderr.write(`mc: no checkout of ${REPO} on this machine — mc deploy deploys that repository and no other\n`);
    return 1;
  }

  // `path` is used for three things that must be told apart. The git reads
  // below are refs, and refs are shared by every worktree of the repository,
  // so they stay here. Only the spawn's cwd moves.
  const git = deps.git || tryGit;
  const base = await deployPlan({
    path,
    env,
    git,
    fetchVersion: deps.fetchVersion || fetchVersionDefault,
    lastDeploy: deps.lastDeploy || lastDeployRow,
    nightly: deps.nightly || nightlyReading,
    languageState: deps.languageState || readLanguageState,
    acceptRed: Boolean(opts.acceptRed),
    history: () => (deps.gate?.history || readNightlyHistory)(path, { root: deps.gate?.root ?? mcHome(env) }).runs,
  });
  if (!base.sha) {
    stderr.write(`mc: ${path} has no origin/main — mc deploy needs ${REPO}'s main checkout\n`);
    return 1;
  }

  // Where the script will run, and in what state that `main` is. A dry run
  // makes nothing, so it reports the worktree it would make rather than a
  // state it cannot read.
  const source = deploySource({ path, git, env, create: !opts.dryRun });
  const state = source.absent
    ? { dirty: [], ahead: null, behind: null }
    : worktreeState({ worktree: source.worktree, git });
  const own = isOwnWorktree(source.worktree, env);
  const plan = {
    ...base,
    worktree: source.worktree,
    worktree_created: source.created,
    worktree_absent: source.absent,
    worktree_failed: source.failed,
    dirty: state.dirty,
    stamps: !source.absent && leftoverStamps({ worktree: source.worktree, dirty: state.dirty, git }),
    strays: (own && strayPaths(state.dirty)) || [],
    ahead: state.ahead,
    behind: state.behind,
  };

  // The gate's two measurements of the commit that would ship. A dry run makes
  // them too — the reading is only worth having with both — except that it
  // starts no full run: it says one is needed.
  const say = (line) => { if (!opts.json) stdout.write(`${line}\n`); };
  const gateDeps = { gate: deps.gate || {}, suites: deps.suites || {} };

  // `--dry-run` is the question answered with the plan: it starts nothing and
  // deploys nothing, so it is the safe thing to type when you are not sure.
  if (opts.dryRun) {
    if (!opts.json) for (const line of planLines(plan)) stdout.write(`${line}\n`);
    // Production never moves backwards: there is nothing to gate, and the reading has said why.
    if (plan.backwards) {
      if (opts.json) stdout.write(`${JSON.stringify({ ...plan, dry_run: true, gate: null }, null, 2)}\n`);
      else stdout.write('mc: --dry-run — nothing would be deployed\n');
      return 0;
    }
    const busy = preparationInFlight({ root: deps.root || workRoot(env), plan, alive: deps.alive || processAlive });
    if (busy && !opts.json) stdout.write(`${busy}\n`);
    const gate = await gateStage({ plan, opts, env, say, deps: gateDeps });
    if (opts.json) stdout.write(`${JSON.stringify({ ...plan, dry_run: true, gate: gateSummary(gate) }, null, 2)}\n`);
    else {
      for (const line of gate.lines) stdout.write(`${line}\n`);
      stdout.write('mc: --dry-run — nothing was deployed\n');
    }
    return 0;
  }
  if (opts.json) stdout.write(`${JSON.stringify({ ...plan, dry_run: false }, null, 2)}\n`);
  else for (const line of planLines(plan)) stdout.write(`${line}\n`);

  // The holder is who the record names, and it is needed before it: a
  // refusal is written by somebody too.
  const holder = deps.holder || currentHolder();
  let cells = {};
  const refuse = (note) => recordRefusal({ sha: plan.sha, holder: holder.name, note, gate: cells }, env);

  // Another deploy going on is read from the record. Asked here so nobody
  // answers a question for nothing, and again under the lock, where the
  // answer is final.
  const alive = deps.alive || processAlive;
  const refuseRunning = () => {
    // A language run writes to the same production: the two never overlap
    // (ruling 31), decided from the same records under the same lock.
    const language = liveRun(env, { alive });
    if (language) {
      const when = String(language.started).slice(0, 16).replace('T', ' ');
      refuse(`a language run of ${language.manifest} is running — started ${language.started} by ${language.holder || 'somebody'}`);
      stderr.write(`mc: a language run of ${language.manifest} is running since ${when} (pid ${language.pid}) — nothing was deployed\n`);
      return true;
    }
    const other = runningDeploy(env, { alive });
    if (!other) return false;
    const when = String(other.started).slice(0, 16).replace('T', ' ');
    refuse(`a deploy of ${short(other.sha)} is running — started ${other.started} by ${other.holder || 'somebody'}`);
    stderr.write(`mc: a deploy of ${short(other.sha)} has been running since ${when} (${other.holder || 'holder unknown'}, pid ${other.pid}) — one deploy at a time; nothing was deployed\n`);
    return true;
  };
  if (refuseRunning()) return 1;

  // Production never moves backwards (also under --accept-red): a pick that is the live commit,
  // or that does not descend from it, is refused before anything is prepared or measured.
  if (plan.backwards) {
    refuse(plan.backwards);
    stderr.write(`mc: ${plan.backwards} — nothing was deployed\n`);
    return 1;
  }

  // Nothing here stashes, resets or discards anything: the worktree that has
  // `main` may well be somebody's, and a `main` that is not exactly
  // `origin/main` plus nothing is a refusal with the path in the row. The one
  // exception is untracked files in mc's own worktree, removed by the deployer
  // (`strayPaths`, `ship`).
  if (source.failed) {
    refuse(`could not make mc's own main worktree at ${source.worktree}`);
    stderr.write(`mc: git worktree add ${source.worktree} main failed in ${path} — mc deploy needs a checkout of main to run the script in\n`);
    return 1;
  }
  if (state.unreadable) {
    refuse(`git status failed in ${source.worktree} — whether main is clean there is unknown`);
    stderr.write(`mc: git status failed in ${source.worktree}, so whether the deploy would ship a clean tree is unknown — nothing was deployed\n`);
    return 1;
  }
  if (state.dirty.length && !plan.stamps && !plan.strays.length) {
    refuse(`main is dirty in ${source.worktree} — ${state.dirty.length} file(s)`);
    stderr.write(`mc: main in ${source.worktree} has ${state.dirty.length} uncommitted file${state.dirty.length === 1 ? '' : 's'}, and the deploy would ship that tree\n`);
    for (const line of state.dirty.slice(0, 5)) stderr.write(`mc:   ${line.trim()}\n`);
    if (state.dirty.length > 5) stderr.write(`mc:   … and ${state.dirty.length - 5} more\n`);
    stderr.write('mc: commit or clean it there — mc deploy moves nobody\'s work — nothing was deployed\n');
    return 1;
  }
  if (state.ahead) {
    refuse(`main in ${source.worktree} has ${state.ahead} commit(s) not on origin/main`);
    stderr.write(`mc: main in ${source.worktree} has ${state.ahead} commit${state.ahead === 1 ? '' : 's'} that origin/main does not — what would ship is ${plan.short}, which is not that tree\n`);
    stderr.write('mc: push them or reset that checkout yourself — nothing was deployed\n');
    return 1;
  }

  const interactive = deps.interactive || realInteractive;
  if (!interactive(env)) {
    refuse('no terminal to ask at');
    stderr.write('mc: mc deploy asks before it deploys, and there is no terminal here to ask — run it in one\n');
    return 2;
  }

  // The commit is measured whole and the app used before anybody is asked
  // anything — and after every refusal that costs nothing to make, so a deploy
  // already running or a dirty main is not found out after a full run.
  const root = deps.root || workRoot(env);
  const prepared = await prepareStage({
    plan, opts, env, root, holder, say, stdout, stderr, deps: { ...deps, gate: gateDeps.gate, suites: gateDeps.suites },
  });
  if (prepared.code != null) {
    if (prepared.note) refuse(prepared.note);
    return prepared.code;
  }
  const gate = judgeGate({ ...prepared.result, plan, opts });
  cells = gateRecord({ full: gate.full, exercise: gate.exercise, accepted: gate.accepted });
  if (opts.json) stdout.write(`${JSON.stringify({ gate: gateSummary(gate) }, null, 2)}\n`);
  else for (const line of gate.lines) stdout.write(`${line}\n`);
  if (gate.refusal) {
    refuse(gate.refusal.note);
    for (const line of gate.refusal.lines) stderr.write(`${line}\n`);
    stderr.write('mc: nothing was deployed\n');
    return 1;
  }

  const ask = deps.ask || realAsk;
  const answer = ask(`deploy ${plan.short} to production${gate.accepted ? `, accepting red (${gate.accepted})` : ''}? [y/N]`, { stdout });
  if (!/^y(es)?$/iu.test(String(answer || '').trim())) {
    refuse('answered no at the question');
    stdout.write('mc: nothing was deployed\n');
    return 1;
  }

  // One deploy at a time, decided under the register's lock — milliseconds,
  // and nothing a merge round ever holds — rather than under the
  // repository's lease, which a merge round holds for its whole gate
  // (ruling 30: the deploy is its own process, beside the merger). Under the
  // lock the record is final: the check for a running deploy, the closing of
  // an abandoned row, the deployer's start and its row are one step.
  const lock = deps.lock || realLock;
  const startDeployer = deps.startDeployer || startDeployerDefault;
  const started = lock(root, () => {
    if (refuseRunning()) return null;
    // The ancestor rule once more, against the last deployed row as it stands now: a deploy that
    // landed while the question was open may have moved production past this pick.
    const standing = (deps.lastDeploy || lastDeployRow)(env);
    const standingRef = standing ? (standing.live_commit || standing.sha) : null;
    if (standingRef) {
      const standingFull = git(path, ['rev-parse', '--verify', `${standingRef}^{commit}`]);
      const forward = Boolean(standingFull) && standingFull !== plan.sha
        && git(path, ['merge-base', '--is-ancestor', standingFull, plan.sha]) !== null;
      if (!forward) {
        const why = `${short(standingRef)} is live now and ${plan.short} does not come after it — nothing newer can ship`;
        refuse(why);
        stderr.write(`mc: ${why}; nothing was deployed\n`);
        return null;
      }
    }
    // A row still `running` whose process is gone is a deploy that died
    // without completing it.
    for (const row of closeAbandoned({ alive }, env)) {
      const when = String(row.started).slice(0, 16).replace('T', ' ');
      stdout.write(`mc: the deploy of ${short(row.sha)} started ${when} never came back — its row now says failed\n`);
    }
    // Before the deployer can write anything: the row exists, saying
    // `running`, before `npm run deploy` is started, and names the process the
    // deploy runs in so the next reader can tell it from one that died.
    const key = { started: new Date().toISOString(), sha: plan.sha };
    const job = {
      key, sha: plan.sha, worktree: source.worktree, own, holder: holder.name, json: opts.json, root,
    };
    const deployer = startDeployer(job, { ...deps, stdout, stderr, env });
    recordStart({ sha: plan.sha, holder: holder.name, pid: deployer.pid ?? '', started: key.started, gate: cells }, env);
    return { key, deployer };
  }, { name: 'deploy' });
  if (!started) return 1;
  const { key, deployer } = started;
  // A deployer run in this process — a test's — is run now, after its row is
  // written, and its exit code is the answer.
  if (deployer.inline) return deployer.inline();
  if (!deployer.pid) {
    recordEnd(key, { outcome: FAILED, stopped_at: 'start', note: `mc: the deployer could not be started (${deployer.error || 'no pid'})` }, env);
    stderr.write(`mc: the deployer could not be started (${deployer.error || 'no pid'}) — nothing was deployed\n`);
    return 1;
  }
  stdout.write(`mc: deploying ${plan.short} in its own process (pid ${deployer.pid}) — after the gate round in flight, if any; the merge queue waits for it\n`);
  // The live page resumes as soon as the confirmed deploy has started. The
  // shell command still follows by default; explicit --follow stays available.
  if (deps.follow === false) return 0;
  stdout.write(`mc: ^C stops watching, not the deploy; mc deploy --follow watches again\n`);
  return followDeploy({ log: deployer.log, pid: deployer.pid, key, env, stdout, deps });
}

/** How often the deployer looks again at a gate round it is waiting for. */
export const GATE_POLL_MS = 5 * 1000;
/** How often a deploy asks again while another mc process holds disk admission. */
export const DISK_BUSY_RETRY_MS = 1000;
/** How long a deploy waits for a held disk admission before it refuses. */
export const DISK_BUSY_WAIT_MS = 10 * 60 * 1000;

/**
 * The deploy builds alone (Martin, 2026-10-10: *"den kilar in sig efter
 * pågående merge-process, kör själv, därefter fortsätter merge-kön"*). On an
 * 8 GB machine a bundle beside a merge round's `npm ci` and suite swapped for
 * 26 minutes (2026-10-10). The merger starts no round while the deploy's row
 * says `running`; this waits for the ones already in flight — any gate round,
 * `mc test`'s too, in either lane (ruling 34): a light round beside the bundle
 * is still a round beside the bundle. A session's gate is no round here. With a merger alive the gate must be free on two reads a
 * poll apart: a merger that read no deploy just before the row was written
 * takes the lock within that time.
 */
export async function waitForGate(job, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const root = job.root || workRoot(deps.env || process.env);
  // The first round in flight in any lane, heavy first, or null. The lock
  // files are in mc's home (`gate-lock.js`), not under the work root: read
  // there, this saw no round at all until 2026-10-10. The deploy goes when the
  // round is done.
  const rounds = deps.runningRounds || (() => runningRounds());
  const round = deps.runningRound || (() => Object.values(rounds() || {}).find(Boolean) || null);
  const merger = deps.readMerger || (() => readMerger({ root }));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const deploy = (deps.mode ?? DEPLOY_MODE) === DEPLOY_MODE;
  let said = false;
  for (;;) {
    const running = round();
    if (!running) {
      if (said || !merger()) break;
      await sleep(GATE_POLL_MS);
      if (!round()) break;
      continue;
    }
    if (!said) {
      const after = deploy ? 'the merger starts no other while this deploy runs' : `the ${holdName({ mode: deps.mode })} takes the heavy lane after it`;
      stdout.write(`mc: waiting for the gate round of ${running.repo || 'a repository'} #${running.pr ?? '?'}${running.lane ? ` in the ${running.lane} lane` : ''} (pid ${running.pid}) to finish — ${after}\n`);
      said = true;
    }
    await sleep(GATE_POLL_MS);
  }
  if (said) stdout.write(deploy ? 'mc: the gate is free — deploying alone; the merge queue goes on after it\n' : 'mc: the gate is free — building with the heavy lane held\n');
}

/** Who holds the build lane, in words: its mode (a deploy, an iOS build) and pid. */
export function laneHolder(running) {
  const what = running?.mode || running?.repo || 'a round';
  return `${what}${running?.pr != null ? ` #${running.pr}` : ''}${running?.pid ? ` pid ${running.pid}` : ''}`;
}

/** How long it has held the lane: `40 s`, `3 min`, `2 h 5 min`; `age unknown` without a start. */
export function laneAge(since, now = new Date()) {
  const ms = now.getTime() - Date.parse(since || '');
  if (!Number.isFinite(ms) || ms < 0) return 'age unknown';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The deploy holds the heavy lane while it builds (Martin, 2026-10-18:
 * *"Deploy ska ta tung lease"*). Waiting for the rounds in flight was not
 * enough: on 2026-10-18 the merger waited behind a deploy as it should, but
 * session `mc gate` runs went on beside the bundle, and the deploy took 40
 * minutes, the bundle alone 15. So once the gate is free the deployer takes
 * the heavy gate lock with `mode: 'deploy'`: `mc test` and the merger see a
 * heavy round, and a `mc gate` started meanwhile waits for it before its tests
 * (`await-deploy.js`). A round that took the lock between the wait and the
 * take is waited for again. True when this process holds it; a lock that
 * could not be written is no reason not to deploy.
 *
 * An iOS build holds it the same way, as `deps.mode` `'ios-build'`
 * (`buildIos`, ios-build.js; `buildSim`, ios-sim-build.js): they exclude each
 * other through this lock, and one that finds it held says once who holds it
 * and for how long (`waiting for the build lane (<holder>, <age>)`).
 */
export async function holdBuildLane(job, deps = {}) {
  const take = deps.takeGateLock || takeGateLock;
  const root = job.lockRoot || mcHome(deps.env || process.env);
  const mode = deps.mode ?? DEPLOY_MODE;
  const stdout = deps.stdout || process.stdout;
  let said = false;
  for (;;) {
    await waitForGate(job, deps);
    const held = take({ repo: mode, pr: null, mode, root, lane: BUILD_LANE });
    if (held.ok) return held.took;
    if (held.error) throw new Error(held.error);
    // Who holds it, once: a build waiting behind another looks like a hang otherwise.
    if (held.running && !said) {
      stdout.write(`mc: waiting for the build lane (${laneHolder(held.running)}, ${laneAge(held.running.since, (deps.now || (() => new Date()))())})\n`);
      said = true;
    }
    // A round that took the lane between the wait and the take: without this, a busy loop.
    await (deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })))(GATE_POLL_MS);
  }
}

/**
 * Everything after the yes, in the deployer's own process: the round in
 * flight waited for (`waitForGate`), the worktree fast-forwarded to
 * `origin/main`, the script run there, the row completed with the sha that
 * shipped. No repository lease is held — the worktree is moved by nothing
 * but this, and the merger lands nothing while the row says `running`
 * (rulings 26, 30) — but the heavy gate lock is, for the whole deploy
 * (`holdBuildLane`).
 */
export async function ship(job, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const git = deps.git || tryGit;
  const { key, sha, worktree, own } = job;
  const progress = deployProgress(job, { env });
  let tail = '';
  let holding = false;
  try {
    progress.report('waiting', 'Waiting for deployment lane');
    holding = await holdBuildLane(job, { ...deps, stdout });
    progress.report('prepare', 'Preparing deploy worktree');
    // The one movement of somebody else's checkout this verb may make: it is
    // fast-forwarded to the sha the gate measured and the question named
    // (2026-11-14) — not to whatever `origin/main` is by now, which no full
    // run and no suite has seen. `--ff-only` on a tree already proved clean
    // and not ahead, so it either fast-forwards or does nothing.
    //
    // The sha may be older than origin/main (the newest commit whose full run is
    // green): a worktree behind it is fast-forwarded, and one that stands *past* it
    // — at main's tip, say — is put back with `git reset --keep`. That is a
    // movement of the worktree to a commit origin/main contains and nothing else, so
    // it is made only in mc's own worktree, from a HEAD origin/main contains, with
    // nothing tracked uncommitted. Anywhere else the worktree is left alone and the
    // check below refuses it, naming the commit that stood.
    const state = worktreeState({ worktree, git });
    const head = git(worktree, ['rev-parse', '--verify', 'HEAD']);
    const ancestor = (older, newer) => Boolean(older && newer) && git(worktree, ['merge-base', '--is-ancestor', older, newer]) !== null;
    const past = Boolean(head) && head !== sha && ancestor(sha, head);
    let moved = false;
    if (state.behind && !past) {
      if (git(worktree, ['merge', '--ff-only', sha]) === null) {
        recordEnd(key, { outcome: FAILED, stopped_at: 'fast-forward', note: `mc: could not fast-forward main in ${worktree} to ${short(sha)}` }, env);
        stderr.write(`mc: git merge --ff-only ${short(sha)} failed in ${worktree} — nothing was deployed\n`);
        return 1;
      }
      moved = true;
    } else if (past && own && !state.unreadable && ancestor(head, 'origin/main')
      && !state.dirty.some((line) => !line.startsWith('?? '))) {
      if (git(worktree, ['reset', '--keep', sha]) === null) {
        recordEnd(key, { outcome: FAILED, stopped_at: 'fast-forward', note: `mc: could not move main in ${worktree} back to ${short(sha)}, the commit that was measured` }, env);
        stderr.write(`mc: git reset --keep ${short(sha)} failed in ${worktree} — nothing was deployed\n`);
        return 1;
      }
      moved = true;
    }
    const behind = moved;
    // Read again after the fast-forward, because the fast-forward can dirty
    // it: a commit that drops lines from `.gitignore` turns files that were
    // ignored a moment ago into untracked ones (2026-10-09). In mc's own
    // worktree they go; anywhere else they are somebody's to look at, and mc
    // says so instead of letting the script's preflight say it later.
    const strays = strayPaths(worktreeState({ worktree, git }).dirty);
    if (strays && own) {
      if (git(worktree, ['clean', '-fd']) === null) {
        recordEnd(key, { outcome: FAILED, stopped_at: 'clean', note: `mc: could not remove untracked files in ${worktree}` }, env);
        stderr.write(`mc: git clean -fd failed in ${worktree} — nothing was deployed\n`);
        return 1;
      }
      stdout.write(`mc: removed ${strays.length} untracked path${strays.length === 1 ? '' : 's'} from mc's own main worktree:\n`);
      for (const file of strays.slice(0, 5)) stdout.write(`mc:   ${file}\n`);
      if (strays.length > 5) stdout.write(`mc:   … and ${strays.length - 5} more\n`);
    } else if (strays && behind) {
      recordEnd(key, { outcome: FAILED, stopped_at: 'dirty', note: `mc: main is dirty in ${worktree} after the fast-forward — ${strays.length} untracked file(s)` }, env);
      stderr.write(`mc: the fast-forward left ${strays.length} untracked file${strays.length === 1 ? '' : 's'} in ${worktree} — likely ignored until the commit that came in:\n`);
      for (const file of strays.slice(0, 5)) stderr.write(`mc:   ${file}\n`);
      if (strays.length > 5) stderr.write(`mc:   … and ${strays.length - 5} more\n`);
      stderr.write('mc: remove them there and run this again — nothing was deployed\n');
      return 1;
    }

    // What ships is what that worktree stands on now, read rather than
    // assumed — and it is the sha the gate measured, or nothing. The merger
    // lands and fetches all the time, and a main checkout moved between the
    // question and the yes stands on a commit no full run and no suite has
    // seen: that is a refusal, never a deploy of "main as it is now" (which it
    // was until 2026-11-14, after two rows had named the wrong sha, 2026-09-14
    // and 2026-09-19). The row is completed with the sha that stood.
    const shipping = git(worktree, ['rev-parse', '--verify', 'HEAD']) || sha;
    if (behind) stdout.write(`mc: ${past ? 'moved' : 'fast-forwarded'} main in ${worktree} to ${short(shipping)}\n`);
    if (shipping !== sha) {
      recordEnd(key, { sha: shipping, outcome: FAILED, stopped_at: 'moved', note: `mc: main in ${worktree} stands on ${short(shipping)}, not ${short(sha)}, the commit that was measured and asked about` }, env);
      stderr.write(`mc: main in ${worktree} stands on ${short(shipping)}, not ${short(sha)} — the commit the full run and the suites measured and the question named; run the deploy again — nothing was deployed\n`);
      return 1;
    }

    const spawnDeploy = deps.spawnDeploy || spawnDeployDefault;
    // The disk (disk-pressure.js), asked at the spawn itself: under 20 GB a
    // pressure pass first, and no script unless it restores the line. A
    // reading that fails refuses too. Only on the real spawn: a fixture with
    // its own and no `disk` touches no disk of this machine.
    const disk = deps.disk !== undefined ? deps.disk : (deps.spawnDeploy ? null : mcDiskPressure({ env, say: (line) => stdout.write(`mc: ${line}\n`) }));
    let diskAdmission;
    if (disk) {
      progress.report('prepare', 'Checking disk capacity');
      // Another mc process holding the admission lease is a moment, not a
      // verdict: the runner holds it through a session's allocation and spawn.
      // The deploy waits for it, bounded, as the runner itself retries; only a
      // lease still held after DISK_BUSY_WAIT_MS refuses (2026-11-14: a deploy
      // refused at 312 GB free because a lane was starting).
      const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
      const clock = deps.clock || (() => Date.now());
      const until = clock() + DISK_BUSY_WAIT_MS;
      let admitted;
      let waited = false;
      for (;;) {
        admitted = await disk.admit({ trigger: 'deploy', what: 'the deploy script', hold: true });
        if (admitted.admitted || !admitted.busy || clock() >= until) break;
        if (!waited) { stdout.write(`mc: waiting for the disk admission — ${admitted.reason}\n`); waited = true; }
        await sleep(DISK_BUSY_RETRY_MS);
      }
      diskAdmission = admitted;
      if (!admitted.admitted) {
        recordEnd(key, { outcome: FAILED, stopped_at: 'disk', note: `mc: ${admitted.line}` }, env);
        stderr.write(`mc: ${admitted.line} — nothing was deployed\n`);
        return 1;
      }
    }
    const onOutput = (chunk) => {
      tail = (tail + chunk).slice(-OUTPUT_TAIL);
      progress.output(chunk);
    };
    // While the script runs, the disk is read every minute even with no
    // runner, and a pressure pass starts below 30 GB. The deploy is never
    // stopped for it: what it already writes is its own.
    const every = deps.every || ((ms, fn) => { const timer = setInterval(fn, ms); timer.unref?.(); return () => clearInterval(timer); });
    const stopMonitor = disk ? every(DISK_POLL_MS, () => disk.poll({ trigger: 'deploy-monitor' }).catch(() => null)) : null;
    let result;
    try {
      progress.report('prepare', 'Starting deploy script');
      const pending = spawnDeploy({ cwd: worktree, env, sha: shipping, onOutput, stdout, stderr });
      diskAdmission?.release?.();
      result = await pending;
    } finally {
      diskAdmission?.release?.();
      stopMonitor?.();
    }
    const said = readScriptOutput(tail);
    const ok = result.code === 0;
    // A branch the script made is landed through a pull request, whatever the
    // deploy's outcome; failing to open it changes neither the exit code nor
    // the outcome (`openBranchPr` never throws).
    const pin = said.branch
      ? await openBranchPr({
        worktree,
        branch: said.branch,
        short: short(shipping),
        repo: REPO,
        git,
        gh: deps.gh || ((args) => ghCommand(args, worktree)),
        merge: deps.merge || mergeRun,
        stdout: job.json ? stderr : stdout,
        stderr,
      })
      : null;
    recordEnd(key, {
      sha: shipping,
      outcome: ok ? DEPLOYED : FAILED,
      build: said.build,
      live_commit: said.live_commit,
      live_build: said.live_build,
      stopped_at: ok ? '' : said.stopped_at,
      note: endNote({ result, said, ok, pin }),
    }, env);

    if (result.error) stderr.write(`mc: could not run npm run deploy in ${worktree} — ${result.error}\n`);
    if (result.signal) stderr.write(`mc: the deploy was killed by ${result.signal}\n`);
    if (pin) {
      const out = job.json ? stderr : stdout;
      if (pin.number) out.write(`mc: ${said.branch} → ${pin.ref}${pin.url ? ` ${pin.url}` : ''}${pin.queued ? ' — queued for the merger' : ' — opened, not queued'}\n`);
      if (pin.error) stderr.write(`mc: the pull request for ${said.branch} — ${pin.error}; the deploy's outcome is unchanged\n`);
    }
    if (job.json) stdout.write(`${JSON.stringify({ sha: shipping, exit_code: result.code, deployed: ok, ...said, ...(pin ? { pin_pr: pin.number } : {}) }, null, 2)}\n`);
    else if (!ok) stderr.write(failureLine(result.code, said, result.interrupted));
    else if (said.live_commit) {
      const retried = said.retries ? ` (after ${retryCount(said.retries)})` : '';
      stdout.write(`mc: deployed — build ${said.live_build} · ${short(said.live_commit)} verified live${retried}\n`);
    }
    return result.code;
  } catch (error) {
    // A throw is not a deploy that finished: the row would otherwise stay
    // `running` for a failure mc itself caused, and the throw goes on up.
    recordEnd(key, { outcome: FAILED, stopped_at: readScriptOutput(tail).stopped_at, note: `mc: ${error?.message || error}` }, env);
    throw error;
  } finally {
    if (holding) (deps.releaseGateLock || releaseGateLock)({ root: job.lockRoot || mcHome(env), lane: BUILD_LANE });
  }
}

/* ------------------------------------------------------------ preparation */

const PREPARER_RUN = fileURLToPath(new URL('../deploy-prepare-run.js', import.meta.url));

/**
 * The preparation, started detached: `deploy-prepare-run.js` with the job as
 * its one argument, its output in `deploy-prepare.log`. Its own process group
 * — a terminal lost on the way, over SSH or at the page, reaches only the
 * watcher. `{ pid, log }`, or `{ pid: null, error }`.
 */
export function startPreparerDefault(job, { env = process.env, spawnProcess = spawn } = {}) {
  return startDetached(job, {
    script: join('src', 'mc', 'deploy-prepare-run.js'), fallback: PREPARER_RUN, log: preparationLogPath(job.root),
    cwd: job.path, env, spawnProcess,
  });
}

/** One line for a preparation of `plan.sha` that is running, or null. */
function preparationInFlight({ root, plan, alive }) {
  const record = readPreparation(root);
  if (!record || record.sha !== plan.sha || preparationState(record, { alive }) !== 'running') return null;
  return `mc: ${plan.short} is being prepared (${STAGE_WORDS[record.stage] || record.stage}, pid ${record.pid}) — mc deploy joins it`;
}

/**
 * Everything before the question, in a process of its own: the full run of
 * the commit that would ship and the app used (`deploy-prepare.js`).
 *
 * The record decides, under the register's lock, and exactly by sha: a
 * preparation of this commit that is running is joined (watched, not started
 * again); one that finished and answers these flags is read; anything else — none,
 * an interrupted one, a failed one, one of another main — starts a new one,
 * and says so in one line. The watching is this process's; a lost terminal
 * ends it and nothing else.
 *
 * `{ result }` when the measurements are in, else `{ code, note }`: the exit
 * code the deploy ends with and, for a refusal, the row's note.
 */
async function prepareStage({ plan, opts, env, root, holder, say, stdout, stderr, deps, again = false }) {
  const alive = deps.alive || processAlive;
  const lock = deps.lock || realLock;
  const startPreparer = deps.startPreparer || startPreparerDefault;
  const when = (at) => String(at || '').slice(0, 16).replace('T', ' ');

  const chosen = lock(root, () => {
    const record = readPreparation(root);
    const state = preparationState(record, { alive });
    const same = record?.sha === plan.sha;
    if (same && state === 'running') return { join: record };
    // A finished preparation is the gate's answer only while the history still says what
    // it recorded: a full run that has been written since (a red where it read green, or
    // the other way) makes it a measurement of an older state of the same commit.
    let stale = null;
    if (same && state === 'done' && preparationServes(record, opts)) {
      const runs = (deps.gate?.history || readNightlyHistory)(plan.path, { root: deps.gate?.root ?? mcHome(env) }).runs;
      const now = fullRunVerdict(runs, record.sha).state;
      const then = record.result?.full?.state;
      if (now === then) return { done: record };
      stale = `mc: the preparation of ${plan.short} read the full run as ${then}, the history says ${now} now — preparing again`;
    }

    let said = stale;
    if (stale) { /* said above */ } else if (record && !same) {
      said = `mc: the last preparation was of ${short(record.sha)}${state === 'running' ? ' and is still running' : ''}, main is ${plan.short} now — starting a new one, of ${plan.short}`;
    } else if (record && state === 'interrupted') {
      said = `mc: the preparation of ${plan.short} started ${when(record.started)} was interrupted at ${STAGE_WORDS[record.stage] || record.stage} — starting a new one`;
    } else if (record && state === 'failed') {
      said = `mc: the preparation of ${plan.short} failed (${record.error}) — starting a new one`;
    } else if (record && state === 'done') {
      said = `mc: the preparation of ${plan.short} skipped the suites, which --accept-red needs — preparing again`;
    }
    const log = preparationLogPath(root);
    const started = new Date().toISOString();
    const job = { root, sha: plan.sha, path: plan.path, started, acceptRed: Boolean(opts.acceptRed), log, holder: holder.name };
    // The record is written before the process exists, so that its first
    // word about itself finds it and a second asker finds it too.
    writePreparation(root, { sha: plan.sha, pid: null, started, stage: 'starting', log, accept_red: Boolean(opts.acceptRed), holder: holder.name });
    const preparer = startPreparer(job, { ...deps, stdout, stderr, env });
    if (preparer.pid) patchPreparation(root, started, { pid: preparer.pid }, { lock: (r, fn) => fn() });
    else patchPreparation(root, started, { stage: 'done', ended: new Date().toISOString(), error: `the preparation could not be started (${preparer.error || 'no pid'})` }, { lock: (r, fn) => fn() });
    return { started: { job, preparer }, said };
  }, { name: 'deploy-prepare' });

  let record;
  let watch;
  if (chosen.done) {
    say(`mc: ${plan.short} was prepared ${when(chosen.done.ended)} — the gate's answer is read from that, nothing is measured again`);
    // The measurement is read; the mends holding its red are read as they are now.
    const { result } = chosen.done;
    return { result: { ...result, full: withMendsNow(result.full, { env, deps: deps.gate || {} }) } };
  }
  if (chosen.join) {
    record = chosen.join;
    say(`mc: ${plan.short} is already being prepared (${STAGE_WORDS[record.stage] || record.stage}, pid ${record.pid}, since ${when(record.started)}) — following it, not starting a second`);
    watch = { pid: Number(record.pid), log: record.log || preparationLogPath(root) };
  } else {
    if (chosen.said) say(chosen.said);
    const { job, preparer } = chosen.started;
    record = { started: job.started };
    if (!preparer.pid) {
      const note = `the preparation could not be started (${preparer.error || 'no pid'})`;
      stderr.write(`mc: ${note} — nothing was deployed\n`);
      return { code: 1, note };
    }
    say(`mc: preparing ${plan.short} in its own process (pid ${preparer.pid}) — the full run and the suites; a lost terminal does not stop it, mc deploy joins it`);
    if (preparer.inline) await preparer.inline();
    else watch = { pid: preparer.pid, log: preparer.log || job.log };
  }
  if (watch) {
    const stopped = await followLog({
      log: watch.log, pid: watch.pid, stdout, deps,
      stopped: `the preparation goes on (pid ${watch.pid}); mc deploy joins it and asks`,
    });
    if (stopped !== null) return { code: stopped };
  }
  const ended = readPreparation(root);
  if (!ended || ended.started !== record.started) {
    // Another asker moved the record on while this one watched: main moved.
    const note = `the preparation of ${plan.short} was replaced by a newer one while it was watched`;
    stderr.write(`mc: ${note} — mc deploy again joins the newer one; nothing was deployed\n`);
    return { code: 1, note };
  }
  const state = preparationState(ended, { alive });
  if (state === 'done' && ended.result) {
    if (preparationServes(ended, opts)) return { result: ended.result };
    // A joined preparation was started without --accept-red and skipped the
    // suites on a red full run: the same rule as a finished one — prepare
    // again, with the suites, said in one line. Once: a preparation this
    // asker started has its flags.
    if (!again) return prepareStage({ plan, opts, env, root, holder, say, stdout, stderr, deps, again: true });
    const note = `the preparation of ${plan.short} did not run the suites --accept-red needs`;
    stderr.write(`mc: ${note} — nothing was deployed\n`);
    return { code: 1, note };
  }
  const why = state === 'failed' ? `failed — ${ended.error}` : `was interrupted at ${STAGE_WORDS[ended.stage] || ended.stage} (its process is gone)`;
  const note = `the preparation of ${plan.short} ${why}`;
  stderr.write(`mc: ${note} — nothing was deployed; mc deploy starts a new one\n`);
  return { code: 1, note };
}

/* --------------------------------------------------------------- deployer */

const DEPLOYER_RUN = fileURLToPath(new URL('../deploy-run.js', import.meta.url));

/** Where the deployer writes what the script says: one deploy at a time, so one file. */
export function deployLogPath(root) {
  return join(root, 'runner', 'log', 'deploy.log');
}

/**
 * The deployer, started detached: `deploy-run.js` with the job as its one
 * argument, its output in `deploy.log` (emptied for each deploy). Its own
 * process group, so a ^C at the terminal that asked reaches only the
 * watcher. `{ pid, log }`, or `{ pid: null, error }`.
 *
 * stdin is closed: the script asks nothing, and a wrangler that wants a
 * login stops with its own message in the log — `wrangler login` at a
 * terminal, then `mc deploy` again.
 */
export function startDeployerDefault(job, { env = process.env, spawnProcess = spawn } = {}) {
  return startDetached(job, {
    script: join('src', 'mc', 'deploy-run.js'), fallback: DEPLOYER_RUN, log: deployLogPath(job.root),
    cwd: job.worktree, env, spawnProcess,
  });
}

/**
 * `node <script> <job as JSON>`, detached in its own process group, stdin
 * closed, its output truncated into `log`. The script is the installed mc's,
 * like the merger's: never the asking tree's. `{ pid, log }`, or
 * `{ pid: null, error }`. The deployer's start, and the iOS builder's.
 */
export function startDetached(job, {
  script, fallback, log, cwd, env = process.env, spawnProcess = spawn, direct = false,
}) {
  let fd = null;
  try {
    mkdirSync(dirname(log), { recursive: true });
    fd = openSync(log, 'w', 0o644);
    const run = direct ? { path: fallback } : installedScript(script, fallback, env);
    const child = spawnProcess(process.execPath, [run.path, JSON.stringify(job)], {
      cwd, detached: true, stdio: ['ignore', fd, fd], env,
    });
    child.unref();
    return { pid: child.pid ?? null, log };
  } catch (error) {
    return { pid: null, log, error: error?.message || String(error) };
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** How often the watcher reads the log again. */
const FOLLOW_POLL_MS = 500;

/**
 * Watch a deploy in its own process: the log as it grows, until the process
 * is gone, then the row's word on how it ended. ^C ends the watching and
 * nothing else. Exit 0 for `deployed`, 1 otherwise, 130 when stopped.
 */
export async function followDeploy({ log, pid, key = null, env = process.env, stdout = process.stdout, deps = {} }) {
  const stopped = await followLog({
    log, pid, stdout, deps, stopped: `the deploy goes on (pid ${pid}); mc deploy --follow watches again`,
  });
  if (stopped !== null) return stopped;
  // By its start alone: the deployer completes the row with the sha that
  // shipped, which is not the key's when `main` moved after the question.
  const rows = readDeploys(env);
  const row = key
    ? rows.findLast((r) => r.started === key.started)
    : rows.findLast((r) => String(r.pid) === String(pid));
  return row?.outcome === DEPLOYED ? 0 : 1;
}

/**
 * The watching itself, shared with `mc asc build`: the log as it grows until
 * `pid` is gone. 130 after a ^C, saying `mc: stopped watching — <stopped>`;
 * null once the process has ended and the log is drained.
 */
export async function followLog({ log, pid, stdout = process.stdout, deps = {}, stopped: goesOn }) {
  const alive = deps.alive || processAlive;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const signals = deps.signals || process;
  let stopped = false;
  const onStop = () => { stopped = true; };
  for (const signal of STOP_SIGNALS) signals.on(signal, onStop);
  let offset = 0;
  const drain = () => {
    let text = '';
    try { text = readFileSync(log, 'utf8'); } catch { return; }
    if (text.length > offset) { stdout.write(text.slice(offset)); offset = text.length; }
  };
  try {
    for (;;) {
      drain();
      if (stopped) {
        stdout.write(`\nmc: stopped watching — ${goesOn}\n`);
        return 130;
      }
      if (!alive(pid)) break;
      await sleep(FOLLOW_POLL_MS);
    }
    drain();
  } finally {
    for (const signal of STOP_SIGNALS) signals.off(signal, onStop);
  }
  return null;
}

/** `mc deploy --follow`: the deploy going on now, watched; or a line saying none is. */
async function follow({ env, stdout, deps }) {
  const alive = deps.alive || processAlive;
  const running = runningDeploy(env, { alive });
  if (!running) {
    const root = deps.root || workRoot(env);
    const record = readPreparation(root);
    if (preparationState(record, { alive }) === 'running') {
      stdout.write(`mc: following the preparation of ${short(record.sha)} (${STAGE_WORDS[record.stage] || record.stage}, pid ${record.pid}, started ${String(record.started).slice(0, 16).replace('T', ' ')}) — mc deploy joins it and asks\n`);
      const stopped = await followLog({
        log: record.log || preparationLogPath(root), pid: Number(record.pid), stdout, deps,
        stopped: `the preparation goes on (pid ${record.pid}); mc deploy joins it`,
      });
      return stopped ?? 0;
    }
    stdout.write('mc: no deploy is running\n');
    return 0;
  }
  stdout.write(`mc: following the deploy of ${short(running.sha)} (pid ${running.pid}, started ${String(running.started).slice(0, 16).replace('T', ' ')})\n`);
  const root = deps.root || workRoot(env);
  return followDeploy({ log: deployLogPath(root), pid: Number(running.pid), key: { started: running.started, sha: running.sha }, env, stdout, deps });
}
