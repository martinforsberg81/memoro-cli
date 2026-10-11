/**
 * `mc deploy` — the one door through which memoro's `main` reaches production.
 *
 * The deploy itself is memoro's: `npm run deploy` (`scripts/deploy.mjs`, its
 * seventeen steps ending in *Verify live version*) is the whole of it, and
 * nothing here reimplements a step of it, passes it a flag or edits it. What
 * this verb adds is what is around it — the reading before, the one question
 * that makes it a thing a person did, and the process it runs in after.
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
 * out. It is fast-forwarded to `origin/main` by the deployer before the
 * script runs, and the row names the sha that shipped; a dirty or diverged `main` is a refused row naming the path — except
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
 * repository this machine has no checkout of; 2 for a bad argument or no
 * terminal; 130 when the watching was stopped and the deploy goes on. Run in
 * this process (a test), the script's own exit code.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripAnsi } from '../../lib/prompt.js';
import { defaultRepos } from '../brief-collect.js';
import {
  closeAbandoned, DEPLOYED, FAILED, lastDeploy as lastDeployRow, readDeploys, recordEnd, recordRefusal, recordStart,
  runningDeploy,
} from '../deploys.js';
import { runningRounds } from '../gate-lock.js';
import { mainWorktree, tryGit } from '../git.js';
import { baseUrl } from '../helper-collect.js';
import { processAlive } from '../lease-owner.js';
import { languageState as readLanguageState, liveRun } from '../language-runs.js';
import { installedScript, readMerger } from '../merger.js';
import { nightlyReading } from '../nightly-history.js';
import { mcHome, workRoot } from '../paths.js';
import { ask as realAsk, interactive as realInteractive } from '../prompt.js';
import { realLock } from '../register.js';
import { currentHolder } from '../repo-lease.js';
import { scanArgs } from './flags.js';

/** The repository this verb is about. It takes no argument and never will:
 * memoro-cli is not deployed, it is installed. */
export const REPO = 'memoro';

const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

export function parseDeployArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--dry-run', '--json', '--follow'] });
  const opts = { dryRun: false, json: false, follow: false };
  if (scanned.error) return { ...opts, error: scanned.error };
  if (scanned.positional.length) {
    return { ...opts, error: `mc deploy takes no arguments (${scanned.positional[0]}) — it deploys memoro's main, and nothing else` };
  }
  return { dryRun: scanned.flags['dry-run'], json: scanned.flags.json, follow: scanned.flags.follow };
}

export function usage() {
  return [
    'usage — mc deploy [--dry-run] [--json]   memoro\'s main to production, after one question, in its own process\n',
    '        mc deploy --follow                 watch the deploy that is running\n',
  ].join('');
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
 * The container images earlier deploys built, removed after a deploy that
 * built new ones.
 *
 * memoro's `wrangler.toml` declares its containers as local Dockerfiles, so a
 * deploy that rolls them out builds every image on this machine, and nothing
 * removed the ones before it. On 2026-10-10 OrbStack held 21 images (17 GB)
 * on an 8 GB machine whose disk was 98 % full, and a full disk starves swap.
 *
 * Only after a deploy that rolled containers out: `scripts/deploy.mjs` prints
 * `Docker preflight skipped; containers are not rolling out.` when it does
 * not, and otherwise has made sure Docker is up. Any `docker` call starts
 * OrbStack, so a deploy that never needed it must not ask it anything.
 * A week, so the images this deploy built and the last week's stay.
 */
export const IMAGE_KEEP_FILTER = 'until=168h';
const CONTAINERS_SKIPPED = 'Docker preflight skipped; containers are not rolling out.';

/** Whether this deploy built container images: the config has some, and the script did not skip them. */
export function rolledOutContainers({ worktree, skipped, read = (path) => readFileSync(path, 'utf8') }) {
  if (skipped) return false;
  try {
    return /^\s*\[\[containers\]\]/mu.test(read(join(worktree, 'wrangler.toml')));
  } catch {
    return false;
  }
}

/** `docker image prune` for images older than a week. `{ ok, reclaimed, detail }`; never throws. */
export function pruneImagesDefault({ cwd, env = process.env, run = spawnSync } = {}) {
  try {
    const r = run(env.WRANGLER_DOCKER_BIN || 'docker', ['image', 'prune', '--all', '--force', '--filter', IMAGE_KEEP_FILTER], {
      cwd, env, encoding: 'utf8', timeout: 5 * 60 * 1000,
    });
    const out = `${r?.stdout || ''}${r?.stderr || ''}`;
    const reclaimed = /Total reclaimed space:\s*(\S+)/u.exec(out)?.[1] || null;
    if (r?.status === 0) return { ok: true, reclaimed };
    return { ok: false, reclaimed, detail: (r?.error?.message || out.trim().split('\n').at(-1) || `exit ${r?.status}`) };
  } catch (error) {
    return { ok: false, reclaimed: null, detail: error?.message || String(error) };
  }
}

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
  languageState = readLanguageState,
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

  // `--dry-run` is the question answered with the plan: it starts nothing and
  // runs nothing, so it is the safe thing to type when you are not sure.
  if (opts.dryRun) {
    if (!opts.json) stdout.write('mc: --dry-run — nothing was deployed\n');
    return 0;
  }

  // The holder is who the record names, and it is needed before it: a
  // refusal is written by somebody too.
  const holder = deps.holder || currentHolder();
  const refuse = (note) => recordRefusal({ sha: plan.sha, holder: holder.name, note }, env);

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

  // One deploy at a time, decided under the register's lock — milliseconds,
  // and nothing a merge round ever holds — rather than under the
  // repository's lease, which a merge round holds for its whole gate
  // (ruling 30: the deploy is its own process, beside the merger). Under the
  // lock the record is final: the check for a running deploy, the closing of
  // an abandoned row, the deployer's start and its row are one step.
  const lock = deps.lock || realLock;
  const root = deps.root || workRoot(env);
  const startDeployer = deps.startDeployer || startDeployerDefault;
  const started = lock(root, () => {
    if (refuseRunning()) return null;
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
    recordStart({ sha: plan.sha, holder: holder.name, pid: deployer.pid ?? '', started: key.started }, env);
    return { key, deployer };
  });
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
  stdout.write(`mc: ^C stops watching, not the deploy; mc deploy --follow watches again\n`);
  return followDeploy({ log: deployer.log, pid: deployer.pid, key, env, stdout, deps });
}

/** How often the deployer looks again at a gate round it is waiting for. */
export const GATE_POLL_MS = 5 * 1000;

/**
 * The deploy builds alone (Martin, 2026-10-10: *"den kilar in sig efter
 * pågående merge-process, kör själv, därefter fortsätter merge-kön"*). On an
 * 8 GB machine a bundle beside a merge round's `npm ci` and suite swapped for
 * 26 minutes (2026-10-10). The merger starts no round while the deploy's row
 * says `running`; this waits for the ones already in flight — any gate round,
 * `mc test`'s too, in either lane (ruling 34): a light round beside the bundle
 * is still a round beside the bundle. With a merger alive the gate must be free on two reads a
 * poll apart: a merger that read no deploy just before the row was written
 * takes the lock within that time.
 */
export async function waitForGate(job, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const root = job.root || workRoot(deps.env || process.env);
  // The first round in flight in any lane, heavy first, or null. The lock
  // files are in mc's home (`gate-lock.js`), not under the work root: read
  // there, this saw no round at all until 2026-10-10.
  const rounds = deps.runningRounds || (() => runningRounds());
  const round = deps.runningRound || (() => Object.values(rounds() || {}).find(Boolean) || null);
  const merger = deps.readMerger || (() => readMerger({ root }));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
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
      stdout.write(`mc: waiting for the gate round of ${running.repo || 'a repository'} #${running.pr ?? '?'}${running.lane ? ` in the ${running.lane} lane` : ''} (pid ${running.pid}) to finish — the merger starts no other while this deploy runs\n`);
      said = true;
    }
    await sleep(GATE_POLL_MS);
  }
  if (said) stdout.write('mc: the gate is free — deploying alone; the merge queue goes on after it\n');
}

/**
 * Everything after the yes, in the deployer's own process: the round in
 * flight waited for (`waitForGate`), the worktree fast-forwarded to
 * `origin/main`, the script run there, the row completed with the sha that
 * shipped. Nothing here holds a lease — the worktree is moved by nothing but
 * this, and the merger lands nothing while the row says `running`
 * (rulings 26, 30).
 */
export async function ship(job, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const git = deps.git || tryGit;
  const { key, sha, worktree, own } = job;
  let tail = '';
  try {
    await waitForGate(job, { ...deps, stdout });
    // The one movement of somebody else's checkout this verb may make.
    // `origin/main` is what ships — whatever is on `main` is meant to — so it
    // is fast-forwarded to `origin/main` as it is now, which may be later than
    // the sha the question showed. `--ff-only` on a tree already proved clean
    // and not ahead, so it either fast-forwards or does nothing.
    const behind = worktreeState({ worktree, git }).behind;
    if (behind) {
      if (git(worktree, ['merge', '--ff-only', 'origin/main']) === null) {
        recordEnd(key, { outcome: FAILED, stopped_at: 'fast-forward', note: `mc: could not fast-forward main in ${worktree}` }, env);
        stderr.write(`mc: git merge --ff-only origin/main failed in ${worktree} — nothing was deployed\n`);
        return 1;
      }
    }
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
    // assumed: the merger lands and fetches all the time, and `origin/main` is
    // a ref every worktree shares, so it can have moved between the question
    // and the yes. Twice it had (2026-09-14, 2026-09-19), and the row named
    // the sha the question showed instead of the one that went out — so the
    // row is completed with the sha that shipped.
    const shipping = git(worktree, ['rev-parse', '--verify', 'HEAD']) || sha;
    if (behind) stdout.write(`mc: fast-forwarded main in ${worktree} to ${short(shipping)}\n`);
    if (shipping !== sha) stdout.write(`mc: main moved to ${short(shipping)} since the question; deploying ${short(shipping)}\n`);

    const spawnDeploy = deps.spawnDeploy || spawnDeployDefault;
    // Seen anywhere in the output, not only in the kept tail: the preflight
    // line comes early and a container build prints megabytes after it.
    let skipped = false;
    const onOutput = (chunk) => {
      tail = (tail + chunk).slice(-OUTPUT_TAIL);
      if (!skipped && stripAnsi(String(chunk)).includes(CONTAINERS_SKIPPED)) skipped = true;
    };
    const result = await spawnDeploy({ cwd: worktree, env, sha: shipping, onOutput, stdout, stderr });
    const said = readScriptOutput(tail);
    const ok = result.code === 0;
    recordEnd(key, {
      sha: shipping,
      outcome: ok ? DEPLOYED : FAILED,
      build: said.build,
      live_commit: said.live_commit,
      live_build: said.live_build,
      stopped_at: ok ? '' : said.stopped_at,
      note: endNote({ result, said, ok }),
    }, env);

    if (result.error) stderr.write(`mc: could not run npm run deploy in ${worktree} — ${result.error}\n`);
    if (result.signal) stderr.write(`mc: the deploy was killed by ${result.signal}\n`);
    if (job.json) stdout.write(`${JSON.stringify({ sha: shipping, exit_code: result.code, deployed: ok, ...said }, null, 2)}\n`);
    else if (!ok) stderr.write(failureLine(result.code, said, result.interrupted));
    else if (said.live_commit) {
      const retried = said.retries ? ` (after ${retryCount(said.retries)})` : '';
      stdout.write(`mc: deployed — build ${said.live_build} · ${short(said.live_commit)} verified live${retried}\n`);
    }
    // After the row and the verdict: a prune that fails or hangs is a line,
    // never a deploy that failed.
    if (ok && rolledOutContainers({ worktree, skipped, read: deps.readFile })) {
      const pruned = (deps.pruneImages || pruneImagesDefault)({ cwd: worktree, env });
      const line = pruned.ok
        ? `mc: docker: images older than a week removed${pruned.reclaimed ? ` — ${pruned.reclaimed} reclaimed` : ''}\n`
        : `mc: docker: the image prune failed (${pruned.detail}) — the deploy stands\n`;
      (job.json ? stderr : stdout).write(line);
    }
    return result.code;
  } catch (error) {
    // A throw is not a deploy that finished: the row would otherwise stay
    // `running` for a failure mc itself caused, and the throw goes on up.
    recordEnd(key, { outcome: FAILED, stopped_at: readScriptOutput(tail).stopped_at, note: `mc: ${error?.message || error}` }, env);
    throw error;
  }
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
  const log = deployLogPath(job.root);
  let fd = null;
  try {
    mkdirSync(dirname(log), { recursive: true });
    fd = openSync(log, 'w', 0o644);
    // The installed mc's deployer, like the merger's: never the asking tree's.
    const run = installedScript(join('src', 'mc', 'deploy-run.js'), DEPLOYER_RUN, env);
    const child = spawnProcess(process.execPath, [run.path, JSON.stringify(job)], {
      cwd: job.worktree, detached: true, stdio: ['ignore', fd, fd], env,
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
        stdout.write(`\nmc: stopped watching — the deploy goes on (pid ${pid}); mc deploy --follow watches again\n`);
        return 130;
      }
      if (!alive(pid)) break;
      await sleep(FOLLOW_POLL_MS);
    }
    drain();
  } finally {
    for (const signal of STOP_SIGNALS) signals.off(signal, onStop);
  }
  // By its start alone: the deployer completes the row with the sha that
  // shipped, which is not the key's when `main` moved after the question.
  const rows = readDeploys(env);
  const row = key
    ? rows.findLast((r) => r.started === key.started)
    : rows.findLast((r) => String(r.pid) === String(pid));
  return row?.outcome === DEPLOYED ? 0 : 1;
}

/** `mc deploy --follow`: the deploy going on now, watched; or a line saying none is. */
async function follow({ env, stdout, deps }) {
  const alive = deps.alive || processAlive;
  const running = runningDeploy(env, { alive });
  if (!running) {
    stdout.write('mc: no deploy is running\n');
    return 0;
  }
  stdout.write(`mc: following the deploy of ${short(running.sha)} (pid ${running.pid}, started ${String(running.started).slice(0, 16).replace('T', ' ')})\n`);
  const root = deps.root || workRoot(env);
  return followDeploy({ log: deployLogPath(root), pid: Number(running.pid), key: { started: running.started, sha: running.sha }, env, stdout, deps });
}
