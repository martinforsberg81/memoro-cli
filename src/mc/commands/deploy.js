/**
 * `mc deploy` — the one door through which memoro's `main` reaches production.
 *
 * The deploy itself is memoro's: `npm run deploy` (`scripts/deploy.mjs`, its
 * seventeen steps ending in *Verify live version*) is the whole of it, and
 * nothing here reimplements a step of it, passes it a flag or edits it. What
 * this verb adds is what is around it — the reading before, the lease during,
 * and the one question that makes it a thing a person did.
 *
 * The question is not a formality and no flag skips it. Deploying to
 * production is Martin's word every time, so `mc deploy` refuses outright
 * where there is nobody to ask: without a terminal it exits 2 rather than
 * assuming yes. `--dry-run` is the reading and stops before the question. The
 * runner never calls this and no role tells a session to.
 *
 * Where the script runs is mc's to decide, and it is always a worktree that is
 * `main`: the one where `main` is checked out — git allows one — or one mc
 * makes and keeps under `~/.memoro/mc/deploy/memoro` when nobody has `main`
 * out. It is fast-forwarded to `origin/main` under the lease before the spawn;
 * a dirty or diverged `main` is a refused row naming the path — except that in
 * mc's own worktree, where nobody works, files git does not know are removed
 * rather than refused (`strayPaths`). `~/memoro`
 * stays what it always was for the reads and for the lease — only the spawn's
 * cwd moved (ruling 16, 2026-09-06: two deploys had failed at *Deploy source
 * preflight* because the verb spawned the script in whatever branch `~/memoro`
 * happened to be on).
 *
 * The lease (`repo-lease.js`) is claimed with errand `deploy <sha>` for the
 * fast-forward and the read of the sha that ships, and nothing after: `main`
 * must not move between the question and that read. The build then runs on
 * that sha with the lease released — a merge landing on `origin/main` does not
 * move the worktree, nothing but this verb and the person fast-forwards it —
 * so a gate or merge round can land the next pull request while production is
 * being built (ruling 26, 2026-10-07).
 *
 * A held lease is a window to wait for, not a refusal: a merge round holds it
 * for the length of its gate, and the deploy re-claims on `mc merge`'s cadence
 * and bound (`MERGE_POLL_MS`, `MERGE_WAIT_MS` in merge-queue.js), saying once
 * who holds it and for what. Eight minutes on, it gives up with exit 3, as the
 * merge does, and a refused row. What keeps two deploys apart is no longer the
 * lease but the record: a `running` row whose process is alive
 * (`runningDeploy`, deploys.js) is a deploy in progress, and a second one is
 * refused with its sha and start time.
 *
 * The record (`deploys.js`) is written around the spawn rather than after it:
 * the row exists, saying `running`, before `npm run deploy` is started, and is
 * completed however it ends. A deploy that never came back is then a row that
 * says so instead of a silence somebody has to reconstruct from
 * `/admin/deploy/logs`. A refusal — no terminal, a `no`, a held repository —
 * is a row too: it is a deploy somebody meant to make.
 *
 * Every process boundary is on `deps` — git, the spawn, the prompt, the
 * lease, the version fetch — so the whole verb runs in a test with nothing
 * real behind it. The lease and the record are the two exceptions, and
 * deliberately so: they are what this verb exists to leave behind, `env` is
 * already the seam that points both at a throwaway directory, and a faked
 * writer would only prove that the fake was called.
 *
 * Exit codes: the script's own when it ran; 0 for `--dry-run`; 1 for a `no`,
 * a deploy already running or a repository this machine has no checkout of; 2
 * for a bad argument or no terminal; 3 for a lease still held after the wait.
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { stripAnsi } from '../../lib/prompt.js';
import { defaultRepos } from '../brief-collect.js';
import {
  closeAbandoned, DEPLOYED, FAILED, lastDeploy as lastDeployRow, recordEnd, recordRefusal, recordStart,
  runningDeploy,
} from '../deploys.js';
import { mainWorktree, tryGit } from '../git.js';
import { baseUrl } from '../helper-collect.js';
import { processAlive } from '../lease-owner.js';
import { MERGE_POLL_MS, MERGE_WAIT_MS } from '../merge-queue.js';
import { nightlyReading } from '../nightly-history.js';
import { mcHome } from '../paths.js';
import { ask as realAsk, interactive as realInteractive } from '../prompt.js';
import { claimLease as realClaim, currentHolder, releaseLease as realRelease } from '../repo-lease.js';
import { tilde } from '../status-project.js';
import { scanArgs } from './flags.js';

/** The repository this verb is about. It takes no argument and never will:
 * memoro-cli is not deployed, it is installed. */
export const REPO = 'memoro';

const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

export function parseDeployArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--dry-run', '--json'] });
  const opts = { dryRun: false, json: false };
  if (scanned.error) return { ...opts, error: scanned.error };
  if (scanned.positional.length) {
    return { ...opts, error: `mc deploy takes no arguments (${scanned.positional[0]}) — it deploys memoro's main, and nothing else` };
  }
  return { dryRun: scanned.flags['dry-run'], json: scanned.flags.json };
}

export function usage() {
  return 'usage — mc deploy [--dry-run] [--json]   memoro\'s main to production, under the lease, after one question\n';
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

export function spawnDeployDefault({
  cwd, env, onOutput, stdout = process.stdout, stderr = process.stderr, signals = process,
}) {
  return new Promise((resolve) => {
    // The environment goes through untouched: MEMORO_DEPLOY_CONTAINERS and
    // wrangler's own variables are the caller's to set, not mc's to invent.
    //
    // stdout and stderr are piped rather than inherited so the row can say
    // which step it stopped at and what version was verified — every chunk is
    // echoed straight on, so the person still watches the script's own
    // seventeen steps as they happen. The cost is that the child sees a pipe
    // and not a terminal, so a tool that draws a progress bar only for a TTY
    // prints plain lines instead. stdin stays inherited: `deploy.mjs` asks
    // nothing, but wrangler's own login flow might.
    const child = spawn('npm', ['run', 'deploy'], { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
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
  };
}

/**
 * Where mc keeps a `main` of its own: `~/.memoro/mc/deploy/memoro`, added with
 * `git worktree add` the first time a deploy finds `main` checked out nowhere,
 * and never removed.
 *
 * Under `mcHome()` and deliberately not under `~/mc/`: a checkout there is a
 * workarea to `listWorkAreas` (`work-area.js`) and to the runner's
 * `closeWorkareas`, and a deploy checkout is neither a project nor something
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
  return { dirty, ahead: count('origin/main..HEAD'), behind: count('HEAD..origin/main') };
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
 * What would ship, before anybody is asked: the tree, what is live, the gap
 * between them, and whether the nightly ever measured this tree whole.
 *
 * Everything it cannot answer is null rather than a guess — a deploy is not
 * the moment to invent a number — and `planLines` says the unknown out loud.
 */
export async function deployPlan({
  path, env = process.env, git = tryGit, fetchVersion = fetchVersionDefault,
  lastDeploy = lastDeployRow, nightly = nightlyReading, offline = false,
}) {
  const fetched = offline ? false : git(path, ['fetch', 'origin', 'main', '--quiet']) !== null;
  const sha = git(path, ['rev-parse', '--verify', 'origin/main']);
  if (!sha) return { repo: REPO, path, sha: null, fetched, reason: 'no-checkout' };

  const row = lastDeploy(env);
  let last = row
    ? { sha: row.sha, short: short(row.sha), build: row.build || null, at: row.ended || row.started || null, source: 'deploys.tsv' }
    : null;
  if (!last) {
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
    subject: git(path, ['log', '-1', '--format=%s', sha]),
    fetched,
    last,
    gap: last ? count(last.sha, sha) : null,
    nightly: nightlyState,
  };
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

/** The reading, in the words a person decides on. */
export function planLines(plan) {
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

  if (!plan.nightly) {
    lines.push('mc: the nightly has measured nothing here — this tree was not measured whole');
  } else if (plan.nightly.this_tree) {
    lines.push(`mc: the nightly measured this tree ${plan.nightly.short} — ${plan.nightly.red === null ? 'no result' : `${plan.nightly.red} red`}`);
  } else {
    const ago = plan.nightly.behind === null ? 'another tree' : `${plan.nightly.behind} commit${plan.nightly.behind === 1 ? '' : 's'} ago`;
    lines.push(`mc: the nightly measured ${plan.nightly.short}, ${ago}; this tree was not measured whole`);
  }
  return lines;
}

/** The row's last cell: why it ended that way, in one line, or nothing when
 * there is nothing to say beyond `deployed`. */
function endNote({ result, said, ok }) {
  if (result.error) return `mc could not run npm run deploy — ${result.error}`;
  if (result.signal) return `killed by ${result.signal}`;
  if (!ok && result.interrupted && !said.failure) return `interrupted by ${result.interrupted}`;
  if (!ok) {
    const why = said.failure ? `exit ${result.code} — ${said.failure}` : `exit ${result.code}`;
    return said.production ? `${why} — production ${said.production}` : why;
  }
  // A green deploy whose live version nobody checked is worth saying: the
  // script skips its own verification on MEMORO_DEPLOY_SKIP_LIVE_VERSION_VERIFY.
  // So is one that needed retries: the count is how flaky the network was.
  const notes = [];
  if (!said.verified) notes.push('the script verified no live version');
  if (said.retries) notes.push(`went through after ${retryCount(said.retries)}`);
  return notes.join('; ');
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

  const repos = deps.repos || defaultRepos(env);
  const path = repos.find((repo) => repo.name === REPO)?.path;
  if (!path) {
    stderr.write(`mc: no checkout of ${REPO} on this machine — mc deploy deploys that repository and no other\n`);
    return 1;
  }

  // `path` is used for three things that must be told apart. The git reads
  // below are refs, and refs are shared by every worktree of the repository,
  // so they stay here; the lease stays here too, because this is the path the
  // runner's merge rounds claim against. Only the spawn's cwd moves.
  const git = deps.git || tryGit;
  const base = await deployPlan({
    path,
    env,
    git,
    fetchVersion: deps.fetchVersion || fetchVersionDefault,
    lastDeploy: deps.lastDeploy || lastDeployRow,
    nightly: deps.nightly || nightlyReading,
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

  if (opts.json) stdout.write(`${JSON.stringify({ ...plan, dry_run: opts.dryRun }, null, 2)}\n`);
  else for (const line of planLines(plan)) stdout.write(`${line}\n`);

  // `--dry-run` is the question answered with the plan: it takes no lease and
  // runs nothing, so it is the safe thing to type when you are not sure.
  if (opts.dryRun) {
    if (!opts.json) stdout.write('mc: --dry-run — nothing was deployed\n');
    return 0;
  }

  // The holder is who the record and the lease both name, and it is needed
  // before either: a refusal is written by somebody too.
  const holder = deps.holder || currentHolder();
  const refuse = (note) => recordRefusal({ sha: plan.sha, holder: holder.name, note }, env);

  // Another deploy going on is read from the record, not the lease: the lease
  // is free for most of a deploy now. Asked here so nobody answers a question
  // for nothing, and again under the lease, where the answer is final.
  const alive = deps.alive || processAlive;
  const refuseRunning = () => {
    const other = runningDeploy(env, { alive });
    if (!other) return false;
    const when = String(other.started).slice(0, 16).replace('T', ' ');
    refuse(`a deploy of ${short(other.sha)} is running — started ${other.started} by ${other.holder || 'somebody'}`);
    stderr.write(`mc: a deploy of ${short(other.sha)} has been running since ${when} (${other.holder || 'holder unknown'}, pid ${other.pid}) — one deploy at a time; nothing was deployed\n`);
    return true;
  };
  if (refuseRunning()) return 1;

  // Nothing here stashes, resets or discards anything: the worktree that has
  // `main` may well be somebody's, and a `main` that is not exactly
  // `origin/main` plus nothing is a refusal with the path in the row. The one
  // exception is untracked files in mc's own worktree, removed under the lease
  // below (`strayPaths`).
  if (source.failed) {
    refuse(`could not make mc's own main worktree at ${source.worktree}`);
    stderr.write(`mc: git worktree add ${source.worktree} main failed in ${path} — mc deploy needs a checkout of main to run the script in\n`);
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

  const ask = deps.ask || realAsk;
  const answer = ask(`deploy ${plan.short} to production? [y/N]`, { stdout });
  if (!/^y(es)?$/iu.test(String(answer || '').trim())) {
    refuse('answered no at the question');
    stdout.write('mc: nothing was deployed\n');
    return 1;
  }

  // A held lease is somebody's window — a merge round's gate, as a rule — and
  // the deploy's own is seconds long, so it waits for it the way `mc merge`
  // waits for the gate: re-claimed on the same cadence, up to the same bound.
  const claim = deps.claimLease || realClaim;
  const release = deps.releaseLease || realRelease;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const now = deps.now || (() => new Date());
  const t0 = now().getTime();
  const take = () => claim({ repoPath: path, errand: `deploy ${plan.sha}`, holder, ownerPid: process.pid });
  let claimed = take();
  let said = null;
  while (!claimed.ok) {
    const held = claimed.lease;
    const by = `${held.holder}${held.errand ? ` for “${held.errand}”` : ''}`;
    if (by !== said) {
      stderr.write(`mc: ${tilde(path)} is held by ${by} — waiting for the window\n`);
      said = by;
    }
    if (now().getTime() - t0 >= MERGE_WAIT_MS) {
      refuse(`held by ${held.holder} — ${held.errand}`);
      stderr.write(`mc: still waiting for ${tilde(path)}, held by ${by}, after 8 min — run this again; nothing was deployed\n`);
      return 3;
    }
    await sleep(MERGE_POLL_MS);
    claimed = take();
  }
  if (said) stderr.write(`mc: waited ${Math.round((now().getTime() - t0) / 1000)}s — the window is ours\n`);

  // From here until the early release the lease is ours; the `finally`
  // releases it only while that is still true, so a throw under the lease does
  // not leave it behind and a throw after it does not hand away a lease a merge
  // round has taken since — `releaseLease` refuses another holder's, but not
  // one under the same name.
  let stillHeld = true;
  let key = null;
  let tail = '';
  try {
    // Under the lease, the record is final: a deploy that started while this
    // one waited wrote its row under the lease too, so it is read here.
    if (refuseRunning()) return 1;
    // A row still `running` whose process is gone is a deploy that died
    // without completing it.
    for (const row of closeAbandoned({ alive }, env)) {
      const when = String(row.started).slice(0, 16).replace('T', ' ');
      stdout.write(`mc: the deploy of ${short(row.sha)} started ${when} never came back — its row now says failed\n`);
    }

    // Under the lease and before the record: the one movement of somebody else's
    // checkout this verb may make. `origin/main` is what ships — whatever is on
    // `main` is meant to — so it is fast-forwarded to `origin/main` as it is now,
    // which may be later than the sha the question showed. `--ff-only` on a tree
    // already proved clean and not ahead, so it either fast-forwards or does
    // nothing.
    if (state.behind) {
      const merged = git(source.worktree, ['merge', '--ff-only', 'origin/main']);
      if (merged === null) {
        refuse(`could not fast-forward main in ${source.worktree}`);
        stderr.write(`mc: git merge --ff-only origin/main failed in ${source.worktree} — nothing was deployed\n`);
        return 1;
      }
    }
    // The tree is read again after the fast-forward, because the fast-forward
    // can dirty it: a commit that drops lines from `.gitignore` turns files
    // that were ignored a moment ago into untracked ones (2026-10-09). In mc's
    // own worktree they go; anywhere else they are somebody's to look at, and
    // mc says so instead of letting the script's preflight say it later.
    const after = state.behind ? worktreeState({ worktree: source.worktree, git }).dirty : state.dirty;
    const strays = strayPaths(after);
    if (strays && own) {
      if (git(source.worktree, ['clean', '-fd']) === null) {
        refuse(`could not remove untracked files in ${source.worktree}`);
        stderr.write(`mc: git clean -fd failed in ${source.worktree} — nothing was deployed\n`);
        return 1;
      }
      stdout.write(`mc: removed ${strays.length} untracked path${strays.length === 1 ? '' : 's'} from mc's own main worktree:\n`);
      for (const file of strays.slice(0, 5)) stdout.write(`mc:   ${file}\n`);
      if (strays.length > 5) stdout.write(`mc:   … and ${strays.length - 5} more\n`);
    } else if (strays && state.behind) {
      refuse(`main is dirty in ${source.worktree} after the fast-forward — ${strays.length} untracked file(s)`);
      stderr.write(`mc: the fast-forward left ${strays.length} untracked file${strays.length === 1 ? '' : 's'} in ${source.worktree} — likely ignored until the commit that came in:\n`);
      for (const file of strays.slice(0, 5)) stderr.write(`mc:   ${file}\n`);
      if (strays.length > 5) stderr.write(`mc:   … and ${strays.length - 5} more\n`);
      stderr.write('mc: remove them there and run this again — nothing was deployed\n');
      return 1;
    }

    // What ships is what that worktree stands on now, read rather than assumed:
    // the runner lands and fetches all the time, and `origin/main` is a ref every
    // worktree shares, so it can have moved between the question and the yes.
    // Twice it had (2026-09-14, 2026-09-19), and the row named the sha the
    // question showed instead of the one that went out.
    const shipping = git(source.worktree, ['rev-parse', '--verify', 'HEAD']) || plan.sha;
    if (state.behind) stdout.write(`mc: fast-forwarded main in ${source.worktree} to ${short(shipping)}\n`);
    if (shipping !== plan.sha) stdout.write(`mc: main moved to ${short(shipping)} since the question; deploying ${short(shipping)}\n`);

    // Before the spawn, not after it: a deploy that never comes back — the
    // terminal closed, a ^C in the middle of wrangler — leaves this row saying
    // `running` with no `ended`, which is the true thing to say about it.
    key = recordStart({ sha: shipping, holder: holder.name, pid: process.pid }, env);

    // The sha is read and written down, so the lease has done its one job: the
    // build runs on that sha in a worktree nothing but this verb and the person
    // moves, and a merge round may land on origin/main beside it.
    stillHeld = false;
    release({ repoPath: path, holder });

    const spawnDeploy = deps.spawnDeploy || spawnDeployDefault;
    const onOutput = (chunk) => {
      tail = (tail + chunk).slice(-OUTPUT_TAIL);
    };
    const result = await spawnDeploy({ cwd: source.worktree, env, sha: shipping, onOutput, stdout, stderr });
    const said = readScriptOutput(tail);
    const ok = result.code === 0;
    recordEnd(key, {
      outcome: ok ? DEPLOYED : FAILED,
      build: said.build,
      live_commit: said.live_commit,
      live_build: said.live_build,
      stopped_at: ok ? '' : said.stopped_at,
      note: endNote({ result, said, ok }),
    }, env);

    if (result.error) stderr.write(`mc: could not run npm run deploy in ${source.worktree} — ${result.error}\n`);
    if (result.signal) stderr.write(`mc: the deploy was killed by ${result.signal}\n`);
    if (opts.json) stdout.write(`${JSON.stringify({ sha: shipping, exit_code: result.code, deployed: ok, ...said }, null, 2)}\n`);
    else if (!ok) stderr.write(failureLine(result.code, said, result.interrupted));
    else if (said.live_commit) {
      const retried = said.retries ? ` (after ${retryCount(said.retries)})` : '';
      stdout.write(`mc: deployed — build ${said.live_build} · ${short(said.live_commit)} verified live${retried}\n`);
    }
    return result.code;
  } catch (error) {
    // A throw is not a deploy that finished: the row would otherwise stay
    // `running` for a failure mc itself caused, and the throw goes on up.
    if (key) recordEnd(key, { outcome: FAILED, stopped_at: readScriptOutput(tail).stopped_at, note: `mc: ${error?.message || error}` }, env);
    throw error;
  } finally {
    if (stillHeld) release({ repoPath: path, holder });
  }
}
