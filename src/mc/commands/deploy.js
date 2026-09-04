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
 * Every process boundary is on `deps` — git, the spawn, the prompt, the
 * lease, the version fetch — so the whole verb runs in a test with nothing
 * real behind it.
 *
 * Exit codes: the script's own when it ran; 0 for `--dry-run`; 1 for a `no`,
 * a held lease or a repository this machine has no checkout of; 2 for a bad
 * argument or no terminal.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultRepos } from '../brief-collect.js';
import { tryGit } from '../git.js';
import { baseUrl } from '../helper-collect.js';
import { nightlyReading } from '../nightly-history.js';
import { workRoot } from '../paths.js';
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

/**
 * `~/mc/runner/log/deploys.tsv` — the last deploy mc itself made.
 *
 * Read tolerantly and inline for now: the file is written by the next step of
 * this project, which also gives it a reader of its own (`src/mc/deploys.js`)
 * for the page and the helper. Until then an absent file is simply "mc has
 * not deployed anything yet", which is true, and the version endpoint below
 * answers the same question about the world rather than about mc.
 */
export function lastDeployRow(env = process.env) {
  let text = null;
  try { text = readFileSync(join(workRoot(env), 'runner', 'log', 'deploys.tsv'), 'utf8'); } catch { return null; }
  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length < 2) return null;
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']));
  });
  const last = rows.filter((row) => row.sha && row.outcome === 'deployed').at(-1);
  return last || null;
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

function spawnDeployDefault({ cwd, env }) {
  return new Promise((resolve) => {
    // The person is watching the script's own seventeen steps, and the
    // environment goes through untouched: MEMORO_DEPLOY_CONTAINERS and
    // wrangler's own variables are the caller's to set, not mc's to invent.
    const child = spawn('npm', ['run', 'deploy'], { cwd, env, stdio: 'inherit' });
    child.on('error', (error) => resolve({ code: 127, error: error?.message || String(error) }));
    child.on('close', (code, signal) => resolve({ code: signal ? 1 : (code ?? 1), signal: signal || null }));
  });
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

  const interactive = deps.interactive || realInteractive;
  if (!interactive(env)) {
    stderr.write('mc: mc deploy asks before it deploys, and there is no terminal here to ask — run it in one\n');
    return 2;
  }

  const ask = deps.ask || realAsk;
  const answer = ask(`deploy ${plan.short} to production? [y/N]`, { stdout });
  if (!/^y(es)?$/iu.test(String(answer || '').trim())) {
    stdout.write('mc: nothing was deployed\n');
    return 1;
  }

  const claim = deps.claimLease || realClaim;
  const release = deps.releaseLease || realRelease;
  const holder = deps.holder || currentHolder();
  const claimed = claim({ repoPath: path, errand: `deploy ${plan.sha}`, holder, ownerPid: process.pid });
  if (!claimed.ok) {
    const c = painter(Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined);
    stderr.write(`mc: ${path} is held by ${claimed.lease.holder} — ${leaseRow(c, claimed.lease)}\n`);
    stderr.write('mc: a deploy takes the lease for its whole length, so main cannot move under the build — nothing was deployed\n');
    return 1;
  }

  const spawnDeploy = deps.spawnDeploy || spawnDeployDefault;
  try {
    const result = await spawnDeploy({ cwd: path, env, sha: plan.sha });
    if (result.error) stderr.write(`mc: could not run npm run deploy in ${path} — ${result.error}\n`);
    if (result.signal) stderr.write(`mc: the deploy was killed by ${result.signal}\n`);
    if (opts.json) stdout.write(`${JSON.stringify({ sha: plan.sha, exit_code: result.code, deployed: result.code === 0 }, null, 2)}\n`);
    else if (result.code !== 0) stderr.write(`mc: npm run deploy exited ${result.code} — production may be part-way; the script's own last step says where\n`);
    return result.code;
  } finally {
    // However it ended, including a throw: a lease left behind by a deploy
    // stops the next gate round for a reason that is over.
    release({ repoPath: path, holder });
  }
}
