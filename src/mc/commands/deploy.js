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
 * The lease (`repo-lease.js`) is claimed for the length of the deploy with
 * errand `deploy <sha>`, so a gate round or a landing that meets it waits or
 * refuses, exactly as they do for a merge round: what is being shipped must
 * not be `main` as it was two commits ago. It is released however the deploy
 * ends.
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
 * a held lease or a repository this machine has no checkout of; 2 for a bad
 * argument or no terminal.
 */
import { spawn } from 'node:child_process';

import { stripAnsi } from '../../lib/prompt.js';
import { defaultRepos } from '../brief-collect.js';
import { DEPLOYED, FAILED, lastDeploy as lastDeployRow, recordEnd, recordRefusal, recordStart } from '../deploys.js';
import { tryGit } from '../git.js';
import { baseUrl } from '../helper-collect.js';
import { nightlyReading } from '../nightly-history.js';
import { ask as realAsk, interactive as realInteractive } from '../prompt.js';
import { claimLease as realClaim, currentHolder, releaseLease as realRelease } from '../repo-lease.js';
import { leaseRow } from '../repo-render.js';
import { painter } from '../status-render.js';
import { scanArgs } from './flags.js';

/** The repository this verb is about. It takes no argument and never will:
 * memoro-cli is not deployed, it is installed. */
export const REPO = 'memoro';

const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

export function parseDeployArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--dry-run', '--json', '--help'] });
  const opts = { dryRun: false, json: false, help: false };
  if (scanned.error) return { ...opts, error: scanned.error };
  if (scanned.positional.length) {
    return { ...opts, error: `mc deploy takes no arguments (${scanned.positional[0]}) — it deploys memoro's main, and nothing else` };
  }
  return { dryRun: scanned.flags['dry-run'], json: scanned.flags.json, help: scanned.flags.help };
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

export function spawnDeployDefault({ cwd, env, onOutput, stdout = process.stdout, stderr = process.stderr }) {
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
    child.on('error', (error) => resolve({ code: 127, error: error?.message || String(error) }));
    // `close` rather than `exit`: it fires once the piped streams are drained,
    // so the last step header is in hand before the row is completed.
    child.on('close', (code, signal) => resolve({ code: signal ? 1 : (code ?? 1), signal: signal || null }));
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
  lines.forEach((line, index) => {
    const step = /^▸\s+(.+)$/u.exec(line);
    if (step) { stoppedAt = step[1].trim(); return; }
    const live = /^Live \/api\/version verified: build (\d+) · (\S+)$/u.exec(line);
    if (live) { verified = { build: live[1], commit: live[2] }; return; }
    const complete = /^✓ Deploy complete build (\d+) · (\S+)$/u.exec(line);
    if (complete) { banner = { build: complete[1], commit: complete[2] }; return; }
    if (/^✗ Deploy failed$/u.test(line)) {
      failure = lines.slice(index + 1).find((next) => next) || '';
    }
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
  };
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

/** The reading, in the words a person decides on. */
export function planLines(plan) {
  const lines = [`mc: would deploy ${plan.repo} ${plan.sha}${plan.subject ? ` — ${plan.subject}` : ''}`];
  if (!plan.fetched) lines.push('mc: could not fetch origin — this is what the checkout already had');

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
  if (!ok) return said.failure ? `exit ${result.code} — ${said.failure}` : `exit ${result.code}`;
  // A green deploy whose live version nobody checked is worth saying: the
  // script skips its own verification on MEMORO_DEPLOY_SKIP_LIVE_VERSION_VERIFY.
  return said.verified ? '' : 'the script verified no live version';
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
  if (opts.help) { stdout.write(usage()); return 0; }

  const repos = deps.repos || defaultRepos(env);
  const path = repos.find((repo) => repo.name === REPO)?.path;
  if (!path) {
    stderr.write(`mc: no checkout of ${REPO} on this machine — mc deploy deploys that repository and no other\n`);
    return 1;
  }

  const plan = await deployPlan({
    path,
    env,
    git: deps.git || tryGit,
    fetchVersion: deps.fetchVersion || fetchVersionDefault,
    lastDeploy: deps.lastDeploy || lastDeployRow,
    nightly: deps.nightly || nightlyReading,
  });
  if (!plan.sha) {
    stderr.write(`mc: ${path} has no origin/main — mc deploy needs ${REPO}'s main checkout\n`);
    return 1;
  }

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

  const claim = deps.claimLease || realClaim;
  const release = deps.releaseLease || realRelease;
  const claimed = claim({ repoPath: path, errand: `deploy ${plan.sha}`, holder, ownerPid: process.pid });
  if (!claimed.ok) {
    refuse(`held by ${claimed.lease.holder} — ${claimed.lease.errand}`);
    const c = painter(Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined);
    stderr.write(`mc: ${path} is held by ${claimed.lease.holder} — ${leaseRow(c, claimed.lease)}\n`);
    stderr.write('mc: a deploy takes the lease for its whole length, so main cannot move under the build — nothing was deployed\n');
    return 1;
  }

  // Before the spawn, not after it: a deploy that never comes back — the
  // terminal closed, a ^C in the middle of wrangler — leaves this row saying
  // `running` with no `ended`, which is the true thing to say about it.
  const key = recordStart({ sha: plan.sha, holder: holder.name }, env);

  const spawnDeploy = deps.spawnDeploy || spawnDeployDefault;
  let tail = '';
  const onOutput = (chunk) => {
    tail = (tail + chunk).slice(-OUTPUT_TAIL);
  };
  try {
    const result = await spawnDeploy({ cwd: path, env, sha: plan.sha, onOutput, stdout, stderr });
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

    if (result.error) stderr.write(`mc: could not run npm run deploy in ${path} — ${result.error}\n`);
    if (result.signal) stderr.write(`mc: the deploy was killed by ${result.signal}\n`);
    if (opts.json) stdout.write(`${JSON.stringify({ sha: plan.sha, exit_code: result.code, deployed: ok, ...said }, null, 2)}\n`);
    else if (!ok) stderr.write(`mc: npm run deploy exited ${result.code}${said.stopped_at ? ` at ${said.stopped_at}` : ''} — production may be part-way\n`);
    else if (said.live_commit) stdout.write(`mc: deployed — build ${said.live_build} · ${short(said.live_commit)} verified live\n`);
    return result.code;
  } catch (error) {
    // A throw is not a deploy that finished: the row would otherwise stay
    // `running` for a failure mc itself caused, and the throw goes on up.
    recordEnd(key, { outcome: FAILED, stopped_at: readScriptOutput(tail).stopped_at, note: `mc: ${error?.message || error}` }, env);
    throw error;
  } finally {
    // However it ended, including a throw: a lease left behind by a deploy
    // stops the next gate round for a reason that is over.
    release({ repoPath: path, holder });
  }
}
