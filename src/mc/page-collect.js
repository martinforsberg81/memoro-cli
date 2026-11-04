/**
 * The page — the sections `mc` prints, gathered from files the runner, the
 * helper and the sessions already write. No model, nothing started; the only
 * writes are the two read-through caches in page-cache.js.
 *
 * One key per section, and this is all of them — the header named a
 * `DECISIONS` section for a while that `collectPage` never returned:
 *
 * runner     — one lane per repository whether or not it has a step, the
 *              runner process behind them, a pending STOP, the lane files
 *              whose process is gone, what is in production, and the day.
 * sessions   — the two desks, the planning session of each programme, and
 *              everything else somebody has open, oldest first.
 * merges     — the gate rounds running now, one per lane (`runningMerges`), and the two
 *              queues behind it: what `mc merge` left for the runner's lane,
 *              and what the runner refuses to land at all.
 * intake     — the helper's newest digest per repository, what is new in it,
 *              the `!` lines split into message, fingerprint and count, and
 *              the root proposals with no owning programme.
 * checks     — per repository, the nightly's last full test and the last
 *              daily `mc deps` reading: when, of which commit, and what each
 *              found. Two file reads each; nothing is run.
 * programmes — one heading per programme with its planning session, and
 *              under it one numbered row per goal (`goalsOf`): its status, its
 *              sessions, its criteria and its last entry. The number is the
 *              one the menu shows the goal by. What no kind explains is
 *              `strays`: directories and ownerless sessions.
 * language   — the language side, from files `mc language` leaves: each
 *              cached reading's numbers, the newest run, and the gap a stopped
 *              run left open (`languageState`, language-runs.js).
 * dev        — the dev servers and who holds each, and who waits for one
 *              (`readPool`, `devSection`, dev-pool.js). File reads only.
 * docker     — the runtime, its leases, images and idle stop, from state.json.
 *
 * Plus `caches` (what the two read-through caches did) and `notes` (whatever
 * could not be read).
 *
 * The builders are pure: each takes read data and returns the section, so the
 * tests feed them fixtures and never touch git, gh or tmux. `collectPage` is
 * the only part that touches the machine, and `renderPage` (page-render.js)
 * is the only part that knows how it looks.
 *
 * The readers are shared: `nowBlock` and `pidAlive`
 * come from status-collect.js, the runs.tsv parser from brief-collect.js, the
 * digest's shape from helper-collect.js.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { run as runGitSync, runAsync as runGitAsync } from './git.js';
import { join } from 'node:path';

import {
  DAY_MS, defaultRepos, listProgrammes, proposalSystem, runsSince, summariseRuns,
} from './brief-collect.js';
import { SESSION_KINDS, sessionKind } from './session-kind.js';
import { deployAlive, lastAttempt, lastDeploy, runningDeploy } from './deploys.js';
import { criteriaCount } from './criteria.js';
import { FINISHED, goalName, phaseOpen, programsGoals, sessions as goalSessions, waitsOnPerson } from './goals.js';
import { statePath } from './docker.js';
import { devSection, readPool } from './dev-pool.js';
import { GITHUB_STATE, githubFailures, mayAsk } from './github-backoff.js';
import { DEFAULT_LANES, readLaneCount } from './lane-count.js';
import { languageState } from './language-runs.js';
import { HELPER_REPOS, digestDirs, findDigest, proposalsDir } from './helper-collect.js';
import {
  inLine, mergesPath, queueEntries, queueOrder, redEntries,
} from './merge-queue.js';
import { readMerger } from './merger.js';
import { runningMerges } from './merges-collect.js';
import { BUILD_LANE, runningRound } from './gate-lock.js';
import { gateLaneOf } from './repo-gate-table.js';
import { readLease } from './repo-lease.js';
import { readRounds } from './repo-round-log.js';
import { duration } from './page-grid.js';
import { readLiveVersion } from './live-version.js';
import { loadSaved } from './deps.js';
import { nightlyReading } from './nightly-history.js';
import { watcherState } from './repo-watch.js';
import { billingStatus } from './billing-route.js';
import { readCapacity } from './model-capacity.js';
import { readBillingState } from './billing.js';
import { controlPaths, drainState, mcCheckout } from './run-control.js';
import {
  PRS_STALE_SECONDS, ageWords, loadPrs, mergePrs, savePrs,
} from './page-cache.js';
import { RUNNER_DISK, RUNNER_MEMORY, mcHome, programsHome, workRoot } from './paths.js';
import { claudeSettingsPath, hookDrift, hookRegistration, readClaudeSettings } from './hooks.js';
import { listStrays } from './work-area.js';
import { DESKS, ownerOf } from './session-owner.js';
import { gitDirOf } from './repos.js';
import { PRICES_DATED, estimateCost } from './prices.js';
import { PR_LIST_ARGS, parseWorktrees, prOwner } from './open-prs.js';
import {
  REPO_NAMES, RUNNER_MODEL, nowBlock, pidAlive, readCurrents,
} from './status-collect.js';

/** How many of each list the page names rather than counts. */
export const DECISIONS_NAMED = 3;

/* ---------------------------------------------------------------- RUNNER */

/**
 * The machine: the runner's headless sessions, one per lane (`nowBlock`), a
 * pending STOP, the lane files whose process is gone, and one line of the day
 * behind it.
 *
 * A session is one of three kinds (session-kind.js): `plan`, `build` and
 * `review`. Each carries its `kind` and `variant`, and what it works on:
 * `goal` (`mc/<goal>`). The list is `sessions`, and the day counts outcomes per kind in
 * `day.by_kind`; the page draws from these and nothing else.
 *
 * This was NOW, and NOW held two different kinds of thing at once — the
 * runner's steps and the sessions a person had open, drawn as one list of
 * dots. They answer different questions and are stopped by different things,
 * so they are two sections now: this one is what `mc run` is doing, and
 * `sessionsSection` is who is sitting where.
 *
 * `nowBlock`'s `runner` — the process, not the section — is carried as
 * `process`, because `runner.runner.alive` is a sentence nobody should have to
 * read. The rename is at this boundary only: `nowBlock` is shared with
 * `mc status` and keeps the shape it had.
 */
/**
 * Past this, a deploy that says `running` is a deploy that did not come back.
 *
 * Nothing sweeps `deploys.tsv` and nothing should: the row is what happened,
 * and a deploy whose terminal was closed half-way through wrangler is truly
 * `running` for ever. An hour is well past the longest deploy there is, so past
 * it the row is a question rather than a status.
 */
export const DEPLOY_LATE_S = 60 * 60;

const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : null);

/** The shortest sha two readings may be compared on: git's own abbreviation. */
const SHA_MIN = 7;

/**
 * Are these two readings the same commit? Compared on the shorter of the two.
 *
 * `deploys.tsv` records the full 40-character sha and `/api/version` answers
 * the 7-character one, so `!==` said *mismatch* on every deploy this machine
 * ever made — the line was bold-yellow with `919de24` printed on both sides of
 * it. Below git's own abbreviation nothing is compared at all: a prefix that
 * short matches too much to mean anything, so two readings that disagree in
 * length there are reported as they are.
 */
function sameCommit(a, b) {
  const one = String(a || '').toLowerCase();
  const two = String(b || '').toLowerCase();
  if (!one || !two) return false;
  const n = Math.min(one.length, two.length);
  if (n < SHA_MIN) return one === two;
  return one.slice(0, n) === two.slice(0, n);
}

/**
 * What is in production, from the two readings that know: the last `deployed`
 * row of `deploys.tsv` and the `/api/version` the helper last cached.
 *
 * They are drawn together because the interesting case is when they differ.
 * The row says what mc shipped; the version says what is answering requests. A
 * deploy somebody made another way, a deploy that did not take, a wrangler that
 * rolled back — every one of them shows up here as two shas that are not the
 * same, and nothing else on the page would say so.
 *
 * Nothing is fetched: the page is offline and instant, so the version is
 * whatever `mc helper --collect` last wrote (`live-version.js`) and its age is
 * carried so a reader can weigh it. Null when neither source has anything —
 * a machine that has never deployed and never collected has nothing to say
 * about production, and a line saying "unknown" is worse than no line.
 */
export function productionSection({
  deploy = null, attempt = null, live = null, now = new Date(), alive = pidAlive,
} = {}) {
  // A first deploy, running before anything was ever deployed or collected, is
  // still a deploy the page shows.
  if (!deploy?.sha && !live && attempt?.outcome !== 'running') return null;
  const at = now.getTime();
  const age = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((at - t) / 1000));
  };
  const when = deploy ? (deploy.ended || deploy.started || null) : null;

  // The last attempt matters only when it is not the deploy row itself: a
  // deploy in flight, or one that failed after the last good one.
  const same = deploy && attempt && attempt.started === deploy.started && attempt.sha === deploy.sha;
  const since = same ? null : attempt;
  const attemptState = (row) => ({
    sha: row.sha || null,
    short: shortSha(row.sha),
    holder: row.holder || null,
    at: row.ended || row.started || null,
    age_seconds: age(row.ended || row.started),
    stopped_at: row.stopped_at || null,
  });
  const running = since?.outcome === 'running' ? attemptState(since) : null;
  // From the record: a row with a pid is late exactly when that process is
  // gone (`deployAlive`), however long it has run; a row from before the pid
  // column has only its age to go on.
  if (running) {
    running.late = since.pid
      ? !deployAlive(since, { alive })
      : running.age_seconds != null && running.age_seconds >= DEPLOY_LATE_S;
  }

  return {
    sha: deploy?.sha || null,
    short: shortSha(deploy?.sha),
    build: deploy?.build || null,
    holder: deploy?.holder || null,
    at: when,
    age_seconds: when ? age(when) : null,
    live,
    // Yellow on the page: what mc last shipped is not what production answers,
    // and no machine here can tell which of the two is the one to believe. On
    // the shorter of the two, which is `/api/version`'s seven characters
    // against `deploys.tsv`'s forty — compared whole, every deploy mc ever made
    // was a mismatch.
    differs: Boolean(live?.commit && deploy?.sha && !sameCommit(live.commit, deploy.sha)),
    running,
    failed: since?.outcome === 'failed' ? attemptState(since) : null,
  };
}

export function runnerSection({
  runner = null, currents = [], stop = false, rows = [],
  // What STOP says: the time it was written, for the stop line's `since`.
  stopText = null,
  deploy = null, attempt = null, live = null, repos = REPO_NAMES,
  // What `mc run lanes` set: how many sessions run at once, across every
  // repository. The rows are one per lane, so the page needs the number.
  lanes: setting = { lanes: DEFAULT_LANES },
  // `~/mc/runner/github.json` as the round left it: the repositories whose
  // last `gh pr list` failed, why, and since when (github-backoff.js).
  github = null,
  // `~/mc/runner/disk.json`: present while the runner starts no step because
  // the disk under scratch is too full, with the line it said.
  disk = null,
  // `~/mc/runner/memory.json`: the same, while too little memory is free.
  memory = null,
  now = new Date(), alive = pidAlive,
} = {}) {
  const { runner: process, steps: sessions, ...base } = nowBlock({ runner, currents, stop, rows, disk, memory, now, alive });
  const tokens = rows.reduce((acc, r) => ({
    input: acc.input + (Number(r.input) || 0),
    output: acc.output + (Number(r.output) || 0),
    cacheRead: acc.cacheRead + (Number(r.cache_read) || 0),
    cacheWrite: acc.cacheWrite + (Number(r.cache_write) || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  for (const session of sessions) {
    // Every session has an owner, and a lane's is a programme: the one its
    // lane file names, else its goal's (`<programme>/<goal>`) (goal mc/no-work).
    session.owner = { kind: 'programme', name: session.programme || session.goal?.split('/')[0] || null };
    // The grid's fields (page-grid.js), under the names every section uses:
    // a goal's session is named `mc/<goal>` as its goal row is, a lane with a
    // session in it is `running`, and its progress is its clock.
    if (session.goal) session.name = session.goal;
    session.state = 'running';
    session.progress = session.elapsed_seconds == null ? null : duration(session.elapsed_seconds);
    session.prs = session.prs || [];
  }
  const stopAt = Date.parse(String(stopText ?? '').trim());
  return {
    ...base,
    sessions,
    stop_requested: stop && !Number.isNaN(stopAt)
      ? { at: new Date(stopAt).toISOString(), age_seconds: Math.max(0, Math.round((now.getTime() - stopAt) / 1000)) }
      : null,
    lanes: lanesOfRunner(sessions, setting),
    setting: { lanes: setting.lanes ?? DEFAULT_LANES },
    process,
    // One entry per repository the round could not ask GitHub about, while
    // that lasts: the round's `prsFailed`, carried between rounds.
    github: githubFailures(github, { now }),
    // What is in production, under the day it took to get there.
    production: productionSection({ deploy, attempt, live, now, alive }),
    day: {
      ...summariseRuns(rows),
      by_kind: dayByKind(rows),
      tokens,
      cost: estimateCost(tokens, RUNNER_MODEL),
      model: RUNNER_MODEL,
      prices_dated: PRICES_DATED,
    },
  };
}

/**
 * Where a session left its work, in the order the day line names them. A
 * runs.tsv note is the session's own exit word — `success`, `timeout`,
 * `no-json`, `failed` — and after it where the step stands (run.js): `merged`,
 * `queued` for the merge queue, `built` on its branch, `open`, `red` back
 * from the merger, `blocked`, `failed`.
 */
export const DAY_OUTCOMES = Object.freeze(['merged', 'queued', 'built', 'open', 'red', 'blocked', 'failed', 'timeout']);

/**
 * One row's outcome: the last of its note's words that says where the work
 * stands; failing that, what the exit word says — `timeout` for a timeout or
 * a stall (the runner's only kill since ruling 18), `failed` for an exit that
 * is not a success, and `other` for a success that moved nothing on (a
 * goal's session, whose work is in its log, or a hand-over between billings).
 */
export function outcomeOf(row) {
  const words = String(row?.note ?? '').split(',').map((word) => word.trim());
  const where = words.slice(1).reverse().find((word) => DAY_OUTCOMES.includes(word));
  if (where) return where;
  if (words[0] === 'timeout' || words[0].startsWith('stalled')) return 'timeout';
  if (String(row?.exit ?? '0') !== '0' || words[0] !== 'success') return 'failed';
  return 'other';
}

/**
 * The day's outcomes per session kind: `{ plan, build, review }`, each with
 * `sessions` and a count per outcome (`DAY_OUTCOMES`, and `other`), so each
 * kind's outcomes add up to its sessions. A row under an old word (`step`,
 * `goal`) counts as the build it was. What is not a session of these kinds — a
 * merge round, a mend row from before 2026-11-02, the helper's turns — is `other` beside them, a count
 * and nothing more: the line before counted every row as a step, merge rounds
 * and helper turns with them.
 */
export function dayByKind(rows = []) {
  const blank = () => ({ sessions: 0, ...Object.fromEntries([...DAY_OUTCOMES, 'other'].map((word) => [word, 0])) });
  const out = { ...Object.fromEntries(SESSION_KINDS.map((kind) => [kind, blank()])), other: 0 };
  for (const row of rows) {
    const named = sessionKind(row.kind);
    if (!named) { out.other += 1; continue; }
    out[named.kind].sessions += 1;
    out[named.kind][outcomeOf(row)] += 1;
  }
  return out;
}

/**
 * The lanes, numbered through, whether or not each has a session.
 *
 * A lane is what `mc run` drives and it exists between steps as much as during
 * one, so the rows are there step or no step: a lane between steps and a lane
 * that had died used to look exactly alike, which is nothing.
 *
 * They were one row per repository lane — `memoro #2`, `memoro-cli #4` — which
 * at four lanes on each of two repositories was eight rows under a cap of five:
 * three of them could never hold a step at the same time as the rest. The rows
 * are the slots the runner can actually fill now — the total `mc run lanes`
 * set, across every repository and every kind — and a row is `lane 3` until
 * a session is in it, when the session is what the row says.
 *
 * The sessions fill from the top, oldest first, so a row only moves when one
 * above it ends. A session past the count — a runner started under a higher
 * setting than the file holds now — still gets its row: the lane file is the
 * runner saying it is there, and the page believes it over the setting.
 *
 * The lane's `session` is the same object `sessions` carries, not a copy —
 * the two cannot disagree about a lane, because there is one of it.
 */
function lanesOfRunner(sessions = [], setting = {}) {
  const slots = Number.isInteger(setting?.lanes) && setting.lanes > 0 ? setting.lanes : DEFAULT_LANES;
  const running = [...sessions].sort((a, b) => String(a.started || '').localeCompare(String(b.started || ''))
    || String(a.name).localeCompare(String(b.name)));
  return Array.from({ length: Math.max(slots, running.length) }, (_, index) => {
    const session = running[index] || null;
    return {
      number: index + 1, repo: session?.repo ?? null, lane: session?.lane ?? null, state: session ? 'running' : 'idle', session,
    };
  });
}

/* ------------------------------------------------------------- FOREGROUND */

/** The two singleton desks (session-owner.js), re-exported for the page's readers. */
export { DESKS, ownerOf };

/**
 * Who is sitting where — everything running that the runner did not start.
 *
 * Every session has an owner, and there are two kinds (goal mc/no-work): a
 * programme — its planning session, or another session in one of its rooms —
 * or a desk. The two desks are singletons and get a fixed row each, drawn open
 * or not: there is one helper and one brief, and *"is the helper running?"* is
 * a question an empty row answers as well as a full one. A programme's
 * sessions are drawn on its heading in PROGRAMMES.
 *
 * The register is `~/mc/runner/foreground/<pid>.json`, written by the verbs
 * that hold a terminal through `foreground.js`. An entry whose pid is not
 * alive is dropped rather than believed: a session killed with its terminal
 * never gets to remove its own file.
 *
 * What has no owner is a stray, not a session: a register entry no verb
 * explains (a `mc plan` from before programmes, a retired verb's), and a tmux
 * session `mc-<name>` mc did not start for anyone. They are `strays`, drawn
 * beside the directories under `~/mc` that no kind explains.
 *
 * **Every session carries its age**, which the page used to throw away. The
 * register has written `started` since it existed and nothing read it, so on
 * 2026-09-02 a `mc plan` opened three days earlier was drawn exactly like one
 * opened twenty minutes ago. The age is the whole difference between somebody
 * working here and somebody having left this open.
 */
export function sessionsSection({
  foreground = [], live = [], now = new Date(), alive = pidAlive,
} = {}) {
  const at = now.getTime();
  const age = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((at - t) / 1000));
  };
  const open = foreground
    .filter((item) => alive(item.pid))
    .map((item) => ({ ...item, age_seconds: age(item.started), owner: ownerOf(item) }));

  const desks = {};
  for (const verb of DESKS) desks[verb] = open.find((item) => item.verb === verb) || null;

  // A planning session belongs to its programme, and PROGRAMMES draws it on
  // that programme's own heading — which is the whole reason `mc plan` puts
  // one at `planAreaName` (paths.js). Any other session of the programme is
  // drawn on the same heading. Keyed by
  // programme here, so the section that owns programmes never has to know how
  // a session's area is spelled.
  const planning = {};
  const planningSessions = {};
  const programmeSessions = {};
  for (const item of open) {
    if (item.owner?.kind !== 'programme') continue;
    if (item.verb === 'plan') {
      planning[item.owner.name] = item;
      (planningSessions[item.owner.name] ||= []).push(item);
    } else {
      (programmeSessions[item.owner.name] ||= []).push(item);
    }
  }

  // Oldest first: the one that has been open longest is the one most likely
  // to have been forgotten.
  const strays = [
    ...open.filter((item) => !item.owner).map((item) => ({
      kind: 'register', name: item.area || item.verb || '?', verb: item.verb || null, pid: item.pid, age_seconds: item.age_seconds,
    })),
    ...live.map((area) => ({
      kind: 'tmux',
      name: `mc-${area.name}`,
      verb: null,
      pid: null,
      age_seconds: area.opened_ms == null ? null : Math.max(0, Math.round((at - area.opened_ms) / 1000)),
    })),
  ].sort((a, b) => (b.age_seconds ?? -1) - (a.age_seconds ?? -1) || String(a.name).localeCompare(String(b.name)));

  const owned = open.filter((item) => item.owner);
  return {
    desks,
    planning,
    planning_sessions: planningSessions,
    programme_sessions: programmeSessions,
    strays,
    count: owned.length,
  };
}

/** A pull request's number, or null when there is none to draw: `#0` and `#NaN` are not pull requests. */
function prNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * MERGES — one queue per repository, including idle queues. `repos[]` is
 * the page/JSON contract; aggregate fields remain for status/PR readers.
 * The running rounds and the merger's queue behind them
 * (`merges.json`, ruling 30): every pull request `mc merge` or the runner has
 * handed the merger and it has not answered yet.
 *
 * `landing` is `runningMerges`'s list (merges-collect.js) — one round per
 * gate lane, so two when a memoro and a memoro-cli round run side by side —
 * or one such object, or null. This function does not read the locks itself,
 * so its tests never touch a real one.
 *
 * `red` is what came back red and has not been queued again: inline per repository
 * until `mc merge` puts it back in line (Martin, 2026-10-10). One whose pull
 * request is no longer open is nobody's to fix and is not drawn — when the
 * open pull requests are known at all.
 *
 * `landings` is one item per pull request in a round: the first carries the
 * round's phase, age and lane, the rest `batch_of: <first pr>`.
 */
export function mergesSection({
  landing = null, queued = [], prs = [], now = new Date(), alive = pidAlive,
  repos = REPO_NAMES, pauses = {}, merger = null, history = [],
} = {}) {
  const all = queueEntries(queued);
  const entries = queueOrder(inLine(all));
  const rounds = [].concat(landing || []).filter(Boolean);
  const ofRepo = (round, item) => !round.repo || !item.repo || round.repo === item.repo;
  const landingFor = (round) => (item) => Number(round.pr) === item.pr && item.state === 'landing' && ofRepo(round, item);
  // The one a round is landing is drawn as the round, not twice — but its
  // queue entry is where its branch is, and the open pull requests are where its title is: the row names what is landing, not only
  // its number (Martin, 2026-10-09).
  const titled = (repo, number) => prs.find((pr) => pr.repo === repo && Number(pr.number) === Number(number)) || null;
  const named = (repo, number, entry) => {
    const pr = titled(repo, number);
    const branch = entry?.branch || pr?.headRefName || null;
    return { branch, name: branch, title: pr?.title || null };
  };
  // A batch is one round, but every pull request in it keeps its own row
  // (Martin, 2026-10-10: *"den pr som mergas genom en session får behålla sin
  // rad"*). The lock names only the first; the others are the `landing`
  // entries of its repository that `markLanding` gave the same `started`.
  const members = new Set();
  const landings = rounds.flatMap((round) => {
    const own = entries.find(landingFor(round)) || null;
    if (own) members.add(own);
    const rest = own?.started
      ? entries.filter((item) => item !== own && item.state === 'landing' && item.started === own.started && ofRepo(round, item))
      : [];
    for (const item of rest) members.add(item);
    return [
      { ...round, ...named(round.repo, round.pr, own), queue_since: own?.since || null },
      ...rest.map((item) => ({
        repo: item.repo || round.repo || null, pr: item.pr, mode: round.mode || null, batch_of: Number(round.pr),
        ...named(item.repo || round.repo, item.pr, item),
      })),
    ];
  });
  const isLanding = (item) => members.has(item);
  const at = now instanceof Date ? now.getTime() : Number(now);
  const ageOf = (when) => {
    const ms = Date.parse(when || '');
    return Number.isFinite(ms) ? Math.max(0, Math.round((at - ms) / 1000)) : null;
  };
  const queuedItems = entries.filter((item) => !isLanding(item)).map((item) => {
    const since = Date.parse(item.since || '');
    return {
      ...item,
      title: titled(item.repo, item.pr)?.title || null,
      wait_seconds: Number.isFinite(since) ? Math.max(0, Math.round((at - since) / 1000)) : null,
    };
  });
  const open = (item) => !prs.length || Boolean(titled(item.repo, item.pr));
  const reds = redEntries(all).filter(open).map((item) => {
    const answered = Date.parse(item.answered || '');
    const pr = titled(item.repo, item.pr);
    return {
      ...item,
      name: item.branch || pr?.headRefName || null,
      title: pr?.title || null,
      age_seconds: Number.isFinite(answered) ? Math.max(0, Math.round((at - answered) / 1000)) : null,
    };
  });
  const liveJobMerger = all.some((item) => item.merger != null && alive(item.merger));
  const mergerAlive = Boolean(merger) || liveJobMerger;
  const names = [...new Set([...REPO_NAMES, ...repos.map((repo) => repo.name || repo),
    ...all.map((item) => item.repo), ...landings.map((item) => item.repo)].filter(Boolean))];
  const repoQueues = names.map((repo) => {
    const own = (items) => items.filter((item) => item.repo === repo);
    // Every item carries the grid's fields (page-grid.js) under the names every
    // section uses: what it is (`kind`), its branch (`name`), its `state`, how
    // long it has been in it (`progress`) and its pull request. An item with no
    // pull request number — a goal's job, a red with nothing recorded — has no
    // PR cell, never `#0` or `#NaN`.
    const gridded = (item, kind, state, seconds, flags) => ({
      ...item,
      kind,
      name: item.name ?? item.branch ?? null,
      state,
      progress: seconds == null ? null : ageWords(seconds),
      prs: prNumber(item.pr) ? [{ number: prNumber(item.pr), repo, ...flags }] : [],
    });
    const active = own(landings).filter(isLandingRound).map((item) => {
      const phase = mergePhase(item.phase);
      return gridded({ ...item, queue_age_seconds: ageOf(item.queue_since), phase_words: phase },
        'gate', phase === 'landing' ? 'landing' : phase, item.age_seconds ?? null, { merging: 'landing' });
    });
    // The merger has it — unless there is no merger to have it, and then the
    // queue is `stopped`.
    const queuedOwn = own(queuedItems);
    const stopped = !mergerAlive && !active.length && Boolean(queuedOwn.length);
    const waiting = queuedOwn.map((item) => gridded(item, 'wait', stopped ? 'stopped' : 'queued',
      item.wait_seconds, stopped ? {} : { merging: 'queued' }));
    const red = own(reds).map((item) => gridded(item, 'red', 'red', item.age_seconds, { merge_red: item.reason || 'red' }));
    const landed = history.filter((round) => String(round.repo || '').replace(/\.git$/u, '') === repo
      && round.phase !== 'start' && round.merged?.length)
      .flatMap((round) => {
        // Round records timestamp the start. Completion is the start plus its duration.
        const ended = Date.parse(round.at) + (Number(round.duration_ms) || 0);
        return Number.isFinite(ended) ? round.merged.slice().reverse().map((pr) => ({ pr: Number(pr), at: new Date(ended).toISOString() })) : [];
      }).sort((a, b) => b.at.localeCompare(a.at));
    const last = landed[0] ? { ...landed[0], age_seconds: ageOf(landed[0].at) } : null;
    const day = new Set(landed.filter((item) => ageOf(item.at) <= DAY_MS / 1000).map((item) => item.pr)).size;
    const pause = pauses[repo] || null;
    return {
      repo,
      state: stopped ? 'stopped' : pause ? 'paused' : active.length ? 'landing'
        : waiting.length ? 'waiting' : red.length ? 'red' : 'idle',
      pause, merger_stopped: stopped, landing: active[0] || null, landings: active,
      waiting, reds: red, day_count: day, last,
      // The repository's own grid row, drawn while its queue is empty: the
      // repository by name — under 90 columns the repo column is not drawn —
      // how long ago it last landed, and that pull request.
      kind: 'idle',
      name: repo,
      progress: last ? ageWords(last.age_seconds) : null,
      prs: [...active, ...red, ...waiting].length
        ? [...active, ...red, ...waiting].flatMap((item) => item.prs)
        : (prNumber(last?.pr) ? [{ number: prNumber(last.pr), repo, merged: true }] : []),
    };
  });
  return {
    repos: repoQueues,
    // Retained for status/PR ownership readers. The MERGES drawing uses repos only.
    landing: landings[0] || null,
    landings,
    queued: { count: queuedItems.length, items: queuedItems },
    red: { count: reds.length, items: reds },
    count: landings.length + queuedItems.length,
  };
}

/** Gate-only modes measure but never land; docs rounds really do land their PR. */
function isLandingRound(round) {
  return round.pr != null && (round.mode === 'merge' || round.mode === 'docs' || !round.mode);
}

/** Short phase words shared by JSON and the page; progress messages stay in `phase`. */
export function mergePhase(phase) {
  if (/rebas|restack|conflict|merge.*(?:main|candidate)/iu.test(phase || '')) return 'rebase';
  if (/squash|push|landing|landed|merging|merged #|pr merge/iu.test(phase || '')) return 'landing';
  return phase ? 'gate' : 'landing';
}

/**
 * Read exactly the merger's pre-round barriers, without claiming or reaping anything.
 * A merge round's own lock and lease describe its landing, not another pause.
 */
export function mergePauses({
  repos = [], rounds = [], env = process.env, root = mcHome(env), now = new Date(), alive = pidAlive,
  deploy = () => runningDeploy(env, { alive }),
  round = (lane) => runningRound({ root, lane, alive }),
  lease = (repo) => readLease(repo.path, { root, now: now.getTime(), kill: (pid) => {
    if (!alive(pid)) throw new Error('process gone');
  } }),
} = {}) {
  const deploying = deploy();
  return Object.fromEntries(repos.map((repo) => {
    const lane = gateLaneOf(repo.name);
    const running = round(lane);
    const own = running && rounds.some((item) => item.repo === repo.name && isLandingRound(item)
      && item.pid === running.pid && item.pr === running.pr);
    const held = lease(repo);
    const pause = lane === BUILD_LANE && deploying
      ? { kind: 'deploy', reason: 'deploy', sha: deploying.sha || null }
      : running && !own ? { kind: 'gate', reason: 'gate round', pid: running.pid }
      : held?.held && !held.orphaned && !own ? { kind: 'lease', reason: 'lease held', holder: held.holder }
      : null;
    return [repo.name, pause];
  }));
}

/**
 * CHECKS — the two daily readings of each repository, side by side: the
 * nightly's last full test (`nightly-history.js`) and the runner's last
 * `mc deps` (`deps.js`). Each is null when it has never run.
 *
 * Only what the reading says, with its age and its commit: the page is where
 * a person sees how old each answer is, and `mc deploy` no longer prints
 * either (2026-10-09).
 */
export function checksSection({ repos = [], now = new Date() } = {}) {
  const age = (at) => {
    const ms = now.getTime() - Date.parse(at);
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
  };
  return {
    repos: repos.map(({ name, nightly, deps }) => {
      const measured = nightly?.measured || null;
      return {
        repo: name,
        test: measured
          ? { at: measured.at, age_seconds: age(measured.at), short: measured.commit ? String(measured.commit).slice(0, 7) : null, red: measured.red }
          : null,
        deps: deps?.read_at
          ? {
            at: deps.read_at,
            age_seconds: age(deps.read_at),
            short: deps.sha ? String(deps.sha).slice(0, 7) : null,
            critical: deps.audit?.counts?.critical || 0,
            high: deps.audit?.counts?.high || 0,
          }
          : null,
      };
    }),
  };
}

/* ------------------------------------------------------------- PULL REQUESTS */

/**
 * Every open pull request, and whose it is (`prOwner`, open-prs.js): a
 * plan session's, a workarea's, a folder elsewhere, or nobody's. Each item
 * says whether the merger has it, and how long since anything happened on it.
 *
 * `worktrees` is `{ <repo>: [{ path, branch }] }`, one `git worktree list` per
 * repository — local, and the only way to know which folder holds a branch.
 */
export function prsSection({
  prs = [], worktrees = {}, root = '', merges = null, fetched = null, ageSeconds = null, now = new Date(),
} = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const landings = merges?.landings || [].concat(merges?.landing || []);
  const queued = merges?.queued?.items || [];
  const reds = merges?.red?.items || [];
  const items = prs.map((pr) => {
    const owner = prOwner(pr, { worktrees: worktrees[pr.repo] || [], root });
    const updated = Date.parse(pr.updatedAt || '');
    const number = Number(pr.number);
    return {
      repo: pr.repo || null,
      number,
      title: pr.title || null,
      branch: pr.headRefName || null,
      draft: Boolean(pr.isDraft),
      owner,
      merging: landings.some((landing) => landing.repo === pr.repo && Number(landing.pr) === number)
        ? 'landing'
        : (queued.some((item) => item.repo === pr.repo && item.pr === number) ? 'queued' : null),
      merge_red: (() => {
        const red = reds.find((item) => item.repo === pr.repo && item.pr === number);
        return red ? red.reason || 'red' : null;
      })(),
      updated: pr.updatedAt || null,
      quiet_seconds: Number.isFinite(updated) ? Math.max(0, Math.round((at - updated) / 1000)) : null,
    };
  }).sort((a, b) => String(a.repo).localeCompare(String(b.repo)) || b.number - a.number);
  const counts = {};
  for (const item of items) counts[item.owner.kind] = (counts[item.owner.kind] || 0) + 1;
  return {
    count: items.length, counts, fetched, age_seconds: ageSeconds, items,
  };
}

/**
 * The pull requests onto the running lanes that own them, so the work a pull
 * request belongs to is read on the same line (Martin, 2026-10-09): a goal's
 * pull request is its branch's, `goal/<goal>`. Same objects as `prs.items`,
 * not copies.
 */
export function attachPrs({ programmes, runner, pulls }) {
  const goalPrs = (goal) => pulls.items.filter((item) => (item.branch === `goal/${goal.name}`
      || (goal.carries || []).some((carried) => carried.repo === item.repo && Number(carried.pr) === item.number))
    && (!goal.repos?.length || goal.repos.includes(item.repo)));
  for (const group of programmes?.programmes || []) {
    for (const goal of group.goals || []) goal.prs = goalPrs(goal);
  }
  // A goal's session's pull request is its branch's, `goal/<goal>`.
  for (const session of runner?.sessions || []) {
    session.prs = session.goal
      ? pulls.items.filter((item) => item.branch === `goal/${session.goal.split('/').pop()}`
        && (session.repo == null || item.repo === session.repo))
      : [];
  }
}

/* ------------------------------------------------------------------ INTAKE */

const NEW_SINCE = /^##\s+New since the last digest\b/iu;

/** How many of the digest's `!` lines the page names rather than counts. */
export const INTAKE_LOUD_NAMED = 3;

/**
 * The three parts of a digest bullet, in the order the digest writes them:
 * `` `<fingerprint>` — 41× 500 — <message> ``.
 *
 * They are split apart here so the page can put the **message** first. The
 * bullet's own order buries it behind a hash nobody reads and a count that only
 * means something once the message has been read, and at 100 columns the clip
 * was eating exactly the half that makes somebody look.
 *
 * A bullet that is not that shape — a condition that has just started failing
 * has no fingerprint and no count — is all message, which is the right answer
 * for it too.
 */
function splitError(text) {
  const full = /^`([^`]+)`\s+—\s+([^—]+?)\s+—\s+(.*)$/u.exec(text);
  if (full) return { message: full[3].trim(), fingerprint: full[1], count: full[2].trim() };
  const bare = /^`([^`]+)`\s+—\s+(.*)$/u.exec(text);
  if (bare) return { message: bare[2].trim(), fingerprint: bare[1], count: null };
  return { message: text, fingerprint: null, count: null };
}

/**
 * The bullets under "New since the last digest", as the digest wrote them:
 * `- ! \`<fingerprint>\` — 41× 500 — <message>` for a new fingerprint at or
 * above the threshold or a condition that has just started failing, `- ·` for
 * the rest. The marker is dropped here and kept as `loud`, so the page can
 * draw it in its own way, and the rest is split into its three parts so the
 * page can draw those in an order of its own.
 */
export function newErrorLines(text) {
  const lines = String(text || '').replace(/\r\n/gu, '\n').split('\n');
  const at = lines.findIndex((line) => NEW_SINCE.test(line));
  if (at < 0) return { lines: [], first: false };
  const out = [];
  let first = false;
  for (const line of lines.slice(at + 1)) {
    if (/^##\s/u.test(line)) break;
    if (/^_first digest/u.test(line.trim())) { first = true; continue; }
    const bullet = /^-\s+(!|·)?\s*(.*)$/u.exec(line);
    if (!bullet) continue;
    const body = bullet[2].trim();
    out.push({ loud: bullet[1] === '!', text: body, ...splitError(body) });
  }
  return { lines: out, first };
}

/** The bullets under "New since the last digest": how many, and how many loud. */
export function countNewErrors(text) {
  const { lines, first } = newErrorLines(text);
  return { count: lines.length, loud: lines.filter((line) => line.loud).length, first };
}

/**
 * What waits in `~/mc/intake/`: the newest digest with what is new in it, and
 * the root proposals with no owning programme.
 *
 * With no digest the section says so. It never prints a zero — a zero here
 * would read as "production is quiet" when it means "nobody has looked".
 */
export function intakeSection({ digests = [], proposals = [], now = new Date(), named = INTAKE_LOUD_NAMED } = {}) {
  const repos = digests.map((digest) => {
    const { lines, first } = newErrorLines(digest.text);
    const loud = lines.filter((line) => line.loud);
    const age = digest.mtime_ms == null ? null : Math.max(0, Math.round((now.getTime() - digest.mtime_ms) / 1000));
    return {
      repo: digest.repo,
      digest: digest.name,
      // The date is read off the end of the name: `errors-<repo>-<date>.md`
      // does not match a pattern anchored on `errors-` and a digit, which is
      // why the section showed no date at all once the prefix landed.
      date: dateOf(digest.name) || null,
      age_seconds: age,
      new_errors: lines.length,
      loud: loud.length,
      // The `!` lines themselves, not just how many. A count of loud errors is
      // a number somebody has to go and look up; the line is the thing that
      // makes them look. Everything below the first few is a number again.
      //
      // In their three parts rather than as the digest's one string: the page
      // leads with the message, and a renderer that had to take the bullet
      // apart again would be a second parser of the same line.
      loud_lines: loud.slice(0, named).map(({ message, fingerprint, count }) => ({ message, fingerprint, count })),
      more_loud: Math.max(0, loud.length - named),
      first,
    };
  });
  return { repos, digests: repos.length, proposals: proposals.length, by_system: proposalCounts(proposals), proposal_files: proposalSummary(proposals) };
}

/** How many of the newest proposals BRIEF names. */
export const PROPOSALS_NAMED = 3;

/**
 * What lies in `~/mc/proposals`, as BRIEF's one line says it: how far back the
 * pile reaches and the newest few by name. A proposal is `<date>-<system>-<slug>.md`,
 * and what follows the date is the only title mc has without opening the file —
 * which is enough to recognise one, and reading 109 files for a line is not.
 */
function proposalSummary(files, named = PROPOSALS_NAMED) {
  const dated = files
    .map((file) => /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/u.exec(file))
    .filter(Boolean)
    .map((match) => ({ date: match[1], name: match[2] }));
  return {
    oldest: dated[0]?.date ?? null,
    newest: dated.at(-1)?.date ?? null,
    newest_names: dated.slice(-named).reverse().map((item) => item.name),
  };
}

/** The proposals by the system their filename names; a name with none is `untagged`, which is where the naming rule was not followed. */
function proposalCounts(files) {
  const counts = { mc: 0, memoro: 0, untagged: 0 };
  for (const file of files) counts[proposalSystem(file) || 'untagged'] += 1;
  return counts;
}

/* ---------------------------------------------------------------------- MC */

/**
 * mc itself, for the page's last line: how long the runner has been up, the
 * commit it runs, whether `origin/main` has moved past it, and whether
 * `mc run --update` has been asked for.
 *
 * `behind` is counted from the commit the *runner* started on (`runner.json`,
 * run.js) and not from the checkout's HEAD when the two are known to differ: a
 * checkout somebody pulled by hand is already new, and the runner beside it is
 * still the old code until it hands over. A runner that never said — one
 * started before it wrote its commit — is measured by the checkout, which is
 * the best reading there is.
 *
 * `predecessor` is the runner an update replaced while it is still alive and
 * finishing the steps it held (ruling 28): its pid and those steps' names, so
 * the line can say two runners are running and why.
 *
 * `processes` are the other long-lived mc processes (`{ name, pid, commit }`:
 * the merger, the repo watcher); `behind_checkout` is those whose commit is not
 * the checkout's — each leaves for the new code at its next safe point.
 */
export function mcSection({
  process = null, commit = null, head = null, main = null, behind = null, updateText = null, drain = null, now = new Date(),
  pid = null, predecessor = null, processes = [], hooks = null,
} = {}) {
  const asked = Date.parse(String(updateText || '').trim());
  const behindCheckout = head ? processes.filter((p) => p?.commit && !sameCommit(p.commit, head)) : [];
  return {
    up_seconds: process?.alive ? process.up_seconds : null,
    // The runner's own word or nothing: the checkout's HEAD is what the *next*
    // runner would be, and drawing it as `on <sha>` would say the opposite.
    commit: commit || null,
    head: head || null,
    main: main || null,
    behind: Number.isInteger(behind) ? behind : null,
    // Only while mc's hook registration in ~/.claude/settings.json has drifted.
    ...(hooks ? { hooks } : {}),
    // Only while two runners overlap; otherwise the line is what it was.
    ...(predecessor ? { pid: Number.isInteger(pid) ? pid : null, predecessor: { pid: predecessor.pid, steps: predecessor.steps || [] } } : {}),
    // Only while a process is behind; otherwise the line is what it was.
    ...(behindCheckout.length ? { behind_checkout: behindCheckout } : {}),
    update_requested: updateText == null ? null : {
      at: Number.isNaN(asked) ? null : new Date(asked).toISOString(),
      age_seconds: Number.isNaN(asked) ? null : Math.max(0, Math.round((now.getTime() - asked) / 1000)),
      // What the drain still waits on (run-control.js `drainState`), so the
      // line says it in the words `mc run --update` uses.
      in_flight: drain?.inFlight ?? [],
      lanes: drain?.lanes ?? null,
    },
  };
}

/* -------------------------------------------------------------- PROGRAMMES */

/**
 * How many goals of each status a set of goals holds: the heading's own count.
 */
function statusesOf(goals) {
  const out = {};
  for (const goal of goals) {
    const key = goal.status || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * One heading per **programme**, its goals under it, sorted programme then
 * goal.
 *
 * A programme is what `mc plan` opens on and what a goal belongs to, so it is
 * the shape of the section; a goal's repository is a column on its own row.
 * Projects went on 2026-11-03 (goal mc/projects-to-goals): a project's steps
 * are goals in phases now, and this section draws goals only.
 *
 * The programme heading carries its **planning session**, open or not — that
 * is the room `mc plan <programme>` fills, and a programme with none is a
 * programme nobody is thinking about right now (Martin, 2026-09-02). A
 * programme is drawn whether or not it has a goal, and a programme that exists
 * *only* as an open planning session is drawn too.
 *
 * Numbering runs through the goals in the order the page draws them
 * (programme, then name), so the menu reaches each by the number beside it.
 *
 * What no kind explains is a stray (`strays`): a directory under `~/mc` that is
 * no area (`listStrays`), and a session with no owner (`sessionsSection`).
 * Nothing on the page removes one; `mc tidy` lists what is left.
 */
export function programmesSection({
  planning = {}, planningSessions = {}, programmeSessions = {}, goalRows = [], programmes = [], proposalCounts = {},
  strays = [], sessionStrays = [],
} = {}) {

  const goalList = goalRows.map((goal) => ({ ...goal }))
    .sort((a, b) => String(a.programme).localeCompare(String(b.programme)) || a.name.localeCompare(b.name));
  let number = 0;
  for (const goal of goalList) { number += 1; goal.number = number; }
  // Every programme that has a goal, plus every one that exists only as an
  // open planning session or as a directory with nothing under it yet.
  // `programmes` is the tree's own answer (`listProgrammes`), which is what
  // keeps a programme whose work has all been archived on the page — that is
  // exactly the heading the next piece of its work belongs under.
  const names = [...new Set([
    ...Object.keys(planning),
    ...Object.keys(planningSessions),
    ...Object.keys(programmeSessions),
    ...goalList.map((goal) => goal.programme),
    ...programmes,
  ])].filter(Boolean).sort((a, b) => a.localeCompare(b));

  const groups = names.map((name) => {
    const goals = goalList.filter((goal) => goal.programme === name);
    return {
      programme: name,
      // A programme with no goal of any status. An open plan session does not
      // make it active: nothing is on it yet. The renderer folds these into
      // one line (Martin, 2026-11-02).
      dormant: goals.length === 0,
      goals,
      proposals: proposalCounts[name] || 0,
      repos: [...new Set(goals.flatMap((goal) => goal.repos || []))].sort(),
      planning: planning[name] || null,
      planning_sessions: planningSessions[name] || (planning[name] ? [planning[name]] : []),
      // The programme's other sessions, somebody's open in one of its rooms.
      sessions: programmeSessions[name] || [],
      statuses: statusesOf(goals),
    };
  });

  const dormant = groups.filter((group) => group.dormant).length;
  return {
    count: goalList.length,
    programmes: groups,
    active: groups.length - dormant,
    dormant,
    statuses: statusesOf(goalList),
    planning: groups.filter((group) => group.planning).length,
    running: goalList.filter((goal) => goal.running).length,
    // What no kind explains, drawn under `not an area mc knows`: the
    // directories under `~/mc` that are no area (`listStrays`), then the
    // sessions with no owner. Nothing removes one.
    strays: [
      ...strays.map((stray) => ({ kind: 'directory', ...stray })),
      ...sessionStrays,
    ],
  };
}

/**
 * The goals under the programmes home, as PROGRAMMES draws them (`goals.js`):
 * the stage and status, the sessions, the last entry, and whether a live current file
 * names the goal. The runner names a goal session `goal:<programme>/<goal>`,
 * and a current file whose process is gone is not a session, as `nowBlock` reads
 * them. `goals` is `programsGoals`' answer, and nothing is read here.
 * `phase` is its phase; `held` whether a lower phase of its programme is
 * still to finish (`phaseOpen`), so the runner does not pick it yet.
 */
export function goalsOf({ goals = [], currents = [], alive = pidAlive } = {}) {
  return goals.map((goal) => {
    const running = currents.some((current) => current.name === goalName(goal) && alive(current.pid));
    const sessions = goalSessions(goal.log);
    return {
    name: goal.goal,
    programme: goal.programme,
    repos: goal.repos,
    stage: goal.stage,
    status: goal.status,
    // The grid's fields (page-grid.js), as a project row has them: its kind,
    // its first repository, its state — its stage, which says where in the
    // order it is; the status is beside it, and a blocked one leads its tail —
    // how many sessions it has had, and its open pull requests (`goal/<goal>`,
    // put here by `attachPrs`).
    kind: 'goal',
    repo: goal.repos?.[0] ?? null,
    state: goal.stage ?? null,
    progress: `${sessions} sess`,
    prs: [],
    // The pull requests GOAL.json says carry it: `attachPrs` finds a goal's
    // open one by these as well as by `goal/<goal>`, for a goal on a branch
    // it took over from a project (`mc goal from-project`).
    carries: goal.prs ?? [],
    phase: goal.phase ?? null,
    held: goal.problems.length === 0 && !FINISHED.includes(goal.stage) && !phaseOpen(goal, goals),
    sessions,
    // `{ met, all }` of its success criteria; the row says `criteria <met>/<all>`.
    criteria: criteriaCount(goal),
    last: goal.log.at(-1) ?? null,
    running,
    // Blocked, in any stage, it waits on a person (`waitsOnPerson`).
    person: waitsOnPerson(goal),
    // What it waits on the person for: the last entry's comment — the
    // session's question, or the runner's word on why it stopped.
    question: waitsOnPerson(goal) ? (goal.log.at(-1)?.comment ?? null) : null,
    problems: goal.problems,
    };
  });
}

/* ----------------------------------------------------------------- readers */

function runGit(cwd, args) {
  const r = runGitSync(undefined, ['-C', cwd, ...args]);
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

function execAsync(cmd, args, opts = {}) {
  if (cmd === 'git') {
    return runGitAsync(opts.cwd, args, { timeoutMs: opts.timeout ?? 20_000, maxBuffer: opts.maxBuffer ?? (8 << 20) })
      .then((r) => ({ ok: !r.error && r.status === 0, stdout: r.stdout || '' }));
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 << 20, ...opts }, (error, stdout) => resolve({ ok: !error, stdout: stdout || '' }));
  });
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * The container runtime, from the state file `mc docker` and the runner write
 * (docker.js). Null when there is no file, and then the page has no docker
 * line. The leases are filtered by `alive` (`pidAlive` unless a test says
 * otherwise), because the file may be older than a holder's death: a lease
 * whose pid is gone is held by nobody, whatever the file still says.
 * `idle_stop_seconds` is set only while the runtime is up and no lease is
 * alive, the only state in which the idle stop can come.
 */
export function dockerSection({ state, now = new Date(), alive = pidAlive } = {}) {
  if (!state?.runtime) return null;
  const leases = (state.leases || []).filter((lease) => alive(lease.pid));
  const stopAt = Date.parse(state.idle_stop);
  const savedAt = Date.parse(state.at);
  return {
    kind: state.runtime.kind,
    up: state.runtime.up,
    leases: leases.map((lease) => ({ pid: lease.pid, run: lease.run, repo: lease.repo })),
    images: state.inventory?.df?.images?.count ?? null,
    idle_stop_seconds: state.runtime.up && leases.length === 0 && Number.isFinite(stopAt)
      ? Math.max(0, Math.round((stopAt - now) / 1000))
      : null,
    as_of_seconds: Number.isFinite(savedAt) ? Math.max(0, Math.round((now - savedAt) / 1000)) : null,
  };
}

/**
 * The tmux sessions that are a workarea, with when each was opened.
 * `#{session_created}` is epoch seconds, which is how long somebody has had
 * this open — the one thing about a live area the page can know for 5 ms.
 */
export function liveAreas(run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })) {
  const r = run('tmux', ['ls', '-F', '#{session_name} #{session_created}']);
  if (!r || r.status !== 0) return [];
  return r.stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('mc-'))
    .map((line) => {
      const [name, created] = line.split(/\s+/u);
      const at = Number(created) * 1000;
      return { name: name.slice(3), opened_ms: Number.isFinite(at) && at > 0 ? at : null };
    });
}

/** `~/mc/runner/foreground/<pid>.json` — the verbs that registered themselves. */
export function readForeground(dir, read = readJson, list = readdirSync) {
  let names = [];
  try { names = list(dir).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const item = read(join(dir, name));
    if (item && item.pid) out.push(item);
  }
  return out;
}

/**
 * Every digest on the machine, one per repository, in `HELPER_REPOS` order.
 *
 * It read one directory and one name shape until 2026-09-05, which stopped
 * being a digest's name when the two-repository digest landed and stopped
 * being a digest's home when the inbox began to drain. Both are `findDigest`'s
 * now, so the page and the delta cannot drift apart again.
 *
 * It returns them all rather than the newest, because the newest silently hid
 * whichever repository was collected first — and memoro-cli's digest is about
 * this machine, which is the one nobody else is watching.
 */
export function readDigests(env) {
  const dirs = digestDirs(env);
  return HELPER_REPOS
    .map((repo) => { const found = findDigest(dirs, { repo }); return found && { repo, ...found }; })
    .filter(Boolean);
}

function dateOf(name) {
  return (/(\d{4}-\d{2}-\d{2})\.md$/u.exec(name) || [])[1] || '';
}

/**
 * The strays under `~/mc` (`listStrays`, work-area.js), with the two facts
 * the page says about each and nothing it would have to weigh: whether it
 * holds a checkout, and how many uncommitted changes those hold. Read-only.
 */
export function readStrays(root, { git = runGit } = {}) {
  return listStrays({ root }).map(({ name, path }) => {
    let children = [];
    try { children = readdirSync(path).filter((child) => !child.startsWith('.')); } catch { children = []; }
    const checkouts = children.filter((child) => existsSync(join(path, child, '.git')));
    const uncommitted = checkouts.reduce((sum, child) => {
      const status = git(join(path, child), ['status', '--porcelain']);
      return sum + (status ? status.split('\n').filter(Boolean).length : 0);
    }, 0);
    return { name, checkout: checkouts.length > 0, uncommitted };
  });
}

/**
 * PROGRAMMES alone, from the sources `collectPage` reads it from — the goals,
 * the open plan sessions and the tree's own programmes (`listProgrammes`) — and through the same `programmesSection`, so
 * `mc programs list` and the page cannot give a programme two verdicts. No
 * fetch, no GitHub, no tmux: none of those decide whether a programme is
 * active, and the verb answers in the time it takes to read files.
 */
export function readProgrammes({
  env = process.env,
  now = new Date(),
  repos = defaultRepos(env),
  alive = pidAlive,
  programmes = (repo) => listProgrammes(repo),
} = {}) {
  const root = workRoot(env);
  const present = repos.filter((repo) => existsSync(gitDirOf(repo)));
  const sessions = sessionsSection({ foreground: readForeground(join(root, 'runner', 'foreground')), now, alive });
  // Which repository's tree each programme is a directory in: the one fact a
  // programme with no goal has about where it lives.
  const homes = {};
  for (const repo of present) {
    for (const name of programmes(repo)) (homes[name] ||= []).push(repo.name);
  }
  const section = programmesSection({
    planning: sessions.planning,
    planningSessions: sessions.planning_sessions,
    goalRows: goalsOf({ goals: programsGoals({ home: programsHome(env) }), currents: readCurrents(join(root, 'runner')), alive }),
    programmes: Object.keys(homes),
    proposalCounts: readProgrammeProposalCounts(programsHome(env)),
  });
  return { section, homes };
}

/* ----------------------------------------------------------------- collect */

/**
 * Everything the page shows, in one object: one key per section, plus what the
 * caches did and whatever could not be read.
 *
 * Goals come from `~/mc/programs/` (`programsGoals`); open PRs come from
 * `prs.json` with their age said out loud. `fresh: true` (`--fresh`, `mc prs`) asks GitHub for all
 * of them; `fresh: 'stale'` — the page at a terminal — asks only when the
 * cache is older than `PRS_STALE_SECONDS`, and only the repositories the
 * runner's backoff (`github.json`) does not hold. `--offline` skips the fetch
 * of `origin/main` (ruling 20).
 */
export async function collectPage({
  env = process.env,
  now = new Date(),
  repos = defaultRepos(env),
  fresh = false,
  offline = false,
  git = runGit,
  run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }),
  exec = execAsync,
  alive = pidAlive,
  laneCount = readLaneCount,
  cache = { loadPrs, savePrs, mergePrs },
  // `~/mc/runner/github.json`, for `fresh: 'stale'`: a repository the runner
  // is backing off from is not asked by the page either — every ask at a
  // locked keychain left a modal behind (2026-09-20).
  githubState = null,
  merges = runningMerges,
  // The checkout mc itself runs from, or null. Injected so a test never reads
  // the real one.
  checkout = mcCheckout(),
  // Injected so that no test reads the real file; an env without HOME means none is read.
  claudeSettings = () => (env.HOME ? readClaudeSettings(claudeSettingsPath(env.HOME)) : null),
  // The dev-server pool (dev-pool.js): injected so a test names its own main slot.
  pool = (args) => readPool(args),
} = {}) {
  const root = workRoot(env);
  // mc's own home — the gate locks, lanes.json, the dependency and nightly
  // readings — from the same `env`: a reader left on its default read the
  // machine's real home, and a test saw a live merge round as its own
  // (2026-10-10, 2026-10-11).
  const home = mcHome(env);
  const notes = [];
  const present = repos.filter((repo) => existsSync(gitDirOf(repo)));

  let fetched = false;
  if (!offline) {
    const results = await Promise.all(present.map((repo) => exec('git', ['-C', repo.path, 'fetch', '-q', 'origin'])
      .then((r) => { if (!r.ok) notes.push(`${repo.name}: git fetch failed`); return r.ok; })));
    fetched = present.length === 0 || results.some(Boolean);
  }

  let prs = { prs: [], fetched: null, age_seconds: null };
  const askGithub = async (targets) => {
    const asked = [];
    const answered = [];
    await Promise.all(targets.map((repo) => exec('gh', PR_LIST_ARGS, { cwd: repo.path }).then((r) => {
      try {
        if (r.ok) { asked.push(...JSON.parse(r.stdout).map((pr) => ({ repo: repo.name, ...pr }))); answered.push(repo.name); }
        else notes.push(`${repo.name}: gh pr list failed`);
      } catch { notes.push(`${repo.name}: gh pr list unreadable`); }
    })));
    return { asked, answered };
  };
  // Whether this collect went to GitHub, so a page that keeps asking on a
  // timer can hold off after a failed ask as well as after a good one.
  let askedGithub = fresh === true;
  const cached = fresh === 'stale' && !offline ? cache.loadPrs({ root, now }) : null;
  const stale = cached && (cached.age_seconds == null || cached.age_seconds >= PRS_STALE_SECONDS);
  if (fresh === true) {
    const { asked } = await askGithub(present);
    prs = cache.savePrs({ root, prs: asked, now });
  } else if (stale) {
    // Only what the runner is not backing off from; a held repository keeps
    // the entries it had, and the age says how old the list is.
    const held = githubState ?? readJson(join(root, 'runner', GITHUB_STATE)) ?? {};
    const targets = present.filter((repo) => !held[repo.name] || mayAsk(held[repo.name], now));
    const { asked, answered } = await askGithub(targets);
    askedGithub = targets.length > 0;
    prs = (answered.length ? (cache.mergePrs || mergePrs)({ root, repos: answered, prs: asked, now }) : null) || cached;
    if (answered.length < present.length) {
      const missing = present.map((repo) => repo.name).filter((name) => !answered.includes(name));
      notes.push(`PRs for ${missing.join(', ')} from cache — GitHub not answering or held back`);
    }
  } else if (cached) {
    prs = cached;
  } else {
    prs = cache.loadPrs({ root, now });
    notes.push(prs.fetched
      ? `PRs from cache, ${ageWords(prs.age_seconds)} old — --fresh asks GitHub`
      : 'no PR cache yet — --fresh asks GitHub and fills it');
  }

  let tsv = '';
  try { tsv = readFileSync(join(root, 'runner', 'log', 'runs.tsv'), 'utf8'); } catch { notes.push('no runner/log/runs.tsv'); }
  const rows = runsSince(tsv, new Date(now.getTime() - DAY_MS));
  const live = liveAreas(run);

  const stop = existsSync(join(root, 'runner', 'STOP'));
  const queuedForMerge = queueEntries(readJson(mergesPath(root)));

  // RUNNER draws one row per lane, and the drain line counts them.
  const laneSetting = laneCount({ root: home, repos: present.length });
  const runnerFile = readJson(join(root, 'runner', 'runner.json'));
  const currents = readCurrents(join(root, 'runner'));
  const runner = runnerSection({
    runner: runnerFile,
    currents,
    stop,
    stopText: stop ? readText(join(root, 'runner', 'STOP')) : null,
    rows,
    // The repositories this machine has a checkout of; the lanes are the
    // total `mc run lanes` set, across all of them.
    repos: present.map((repo) => repo.name),
    lanes: laneSetting,
    github: readJson(join(root, 'runner', GITHUB_STATE)),
    disk: readJson(join(root, 'runner', RUNNER_DISK)),
    memory: readJson(join(root, 'runner', RUNNER_MEMORY)),
    // Three file reads, no network: the record `mc deploy` wrote and the
    // version the helper's last collect cached.
    deploy: lastDeploy(env),
    attempt: lastAttempt(env),
    live: readLiveVersion(env, now),
    now,
    alive,
  });
  const sessions = sessionsSection({
    foreground: readForeground(join(root, 'runner', 'foreground')),
    live,
    now,
    alive,
  });

  const roundsNow = merges({ root: home, repos: present, alive, now });
  const mergesNow = mergesSection({
    landing: roundsNow, queued: queuedForMerge, prs: prs.prs, now,
    repos: repos.map((repo) => repo.name),
    pauses: mergePauses({ repos: present, rounds: roundsNow, env, root: home, now, alive }),
    merger: readMerger({ root, alive }), history: readRounds({ root: home }).rounds,
    alive,
  });
  const programmes = programmesSection({
    planning: sessions.planning,
    planningSessions: sessions.planning_sessions,
    programmeSessions: sessions.programme_sessions,
    sessionStrays: sessions.strays,
    goalRows: goalsOf({ goals: programsGoals({ home: programsHome(env) }), currents, alive }),
    programmes: present.flatMap((repo) => listProgrammes(repo)),
    proposalCounts: readProgrammeProposalCounts(programsHome(env)),
    strays: readStrays(root, { git }),
  });
  const worktrees = Object.fromEntries(present.map((repo) => [
    repo.name, parseWorktrees(git(repo.path, ['worktree', 'list', '--porcelain'])),
  ]));
  const pulls = prsSection({
    prs: prs.prs, worktrees, root, merges: mergesNow, fetched: prs.fetched, ageSeconds: prs.age_seconds, now,
  });
  attachPrs({ programmes, runner, pulls });

  return {
    runner,
    billing: billingStatus({ capacity: readCapacity({ root: join(root, 'runner') }), state: readBillingState({ root: join(root, 'runner') }), now }),
    sessions,
    // File reads and a signal 0 per server; one `git branch` per worktree.
    dev: devSection({
      ...pool({ env, alive }),
      now,
      alive,
      env,
      branchOf: (worktree) => (worktree ? (git(worktree, ['branch', '--show-current']) || '').trim() || null : null),
    }),
    merges: mergesNow,
    prs: pulls,
    checks: checksSection({
      repos: present.map((repo) => {
        let nightly = null;
        try { nightly = nightlyReading(repo.path, { root: home }); } catch { notes.push(`${repo.name}: nightly history unreadable`); }
        return { name: repo.name, nightly, deps: loadSaved(repo.name, home) };
      }),
      now,
    }),
    // File reads only, as the rest of the page: the runtime is never asked.
    docker: dockerSection({ state: readJson(statePath(home)), now, alive }),
    intake: intakeSection({ digests: readDigests(env), proposals: proposalFiles(proposalsDir(env)), now }),
    programmes,
    // File reads only, as DEPLOY's are: the page never runs a read.
    language: languageState(env),
    mc: mcSection({
      process: runner.process,
      commit: runnerFile?.commit ?? null,
      pid: runnerFile?.pid ?? null,
      predecessor: runnerFile?.predecessor?.pid && alive(runnerFile.predecessor.pid)
        ? {
          pid: runnerFile.predecessor.pid,
          steps: runner.sessions.filter((session) => session.pid === runnerFile.predecessor.pid).map((session) => session.name).filter(Boolean),
        }
        : null,
      ...mcReading(checkout, runnerFile?.commit ?? null, git),
      // File reads and a signal 0, as the rest of the page: no network.
      processes: [
        (() => { const m = readMerger({ root }); return m ? { name: 'merger', pid: m.pid, commit: m.commit || null } : null; })(),
        (() => { const w = watcherState({ root: home }); return w.running ? { name: 'repo watch', pid: w.pid, commit: w.commit } : null; })(),
      ].filter(Boolean),
      hooks: (() => { const settings = claudeSettings(); return settings ? hookDrift(hookRegistration(settings)) : null; })(),
      updateText: readText(join(root, 'runner', 'UPDATE')),
      drain: drainState({
        paths: controlPaths(root),
        read: readText,
        list: (dir) => { try { return readdirSync(dir); } catch { return []; } },
        now,
        lanes: laneSetting.lanes,
      }),
      now,
    }),
    caches: {
      fresh, offline, fetched, prs: { fetched: prs.fetched, age_seconds: prs.age_seconds, count: prs.prs.length, asked: askedGithub },
    },
    notes,
  };
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/**
 * The checkout's HEAD, `origin/main`, and how many commits `origin/main` is
 * past `base` — the runner's own commit, or HEAD when it never said. The page
 * has fetched by now (memoro-cli's clone is one of its repositories), so this
 * is three local reads.
 */
function mcReading(checkout, base, git) {
  if (!checkout) return { head: null, main: null, behind: null };
  const head = git(checkout, ['rev-parse', '--short', 'HEAD']);
  const main = git(checkout, ['rev-parse', '--short', 'origin/main']);
  const count = main ? git(checkout, ['rev-list', '--count', `${base || 'HEAD'}..origin/main`]) : null;
  return { head, main, behind: count != null && /^\d+$/u.test(count) ? Number(count) : null };
}

/** The proposal files, by name. A count is all mc does with a proposal. */
function proposalFiles(dir) {
  try { return readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); } catch { return []; }
}

/** Count proposal files directly under each programme's proposals/ directory. */
function readProgrammeProposalCounts(home) {
  const counts = {};
  let programmes = [];
  try { programmes = readdirSync(home, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return counts; }
  for (const programme of programmes) {
    let files = [];
    try { files = readdirSync(join(home, programme.name, 'proposals'), { withFileTypes: true }); } catch { /* no proposals directory */ }
    counts[programme.name] = files.filter((entry) => entry.isFile()).length;
  }
  return counts;
}
