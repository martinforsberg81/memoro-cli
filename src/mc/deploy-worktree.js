/**
 * mc's own deploy worktree — `~/.memoro/mc/deploy/memoro`, the `main` mc keeps
 * for itself when nobody has main checked out — and the two things that decide
 * who may use it and in what state: the one placing of it at a commit, and the
 * one holder of it at a time.
 *
 * **The placing** (`placeWorktree`) is one function. The suites of the deploy's
 * gate run in this tree, at the commit that would ship, and the deployer runs
 * the script in it, at the same commit: both place it with this function, so
 * what was measured and what is built are the same tree by construction. It
 * fast-forwards when the tree is behind the commit, runs `git reset --keep`
 * when the tree stands past it on origin/main's line, and removes untracked
 * strays (a generator retired together with its ignore lines turns the files
 * it wrote into untracked ones). Everything else it cannot place and says what
 * stood: modified tracked files, commits origin/main lacks, a HEAD off
 * origin/main's line, a git reading that failed. A deploy killed between
 * stamping and restoring leaves `public/sw.js` and `src/version.js` stamped;
 * those two are what `leftoverStamps` recognises and are restored — they are
 * what the script itself restores before it builds.
 *
 * **The holder** (`takeHolder`) is one record beside the worktree,
 * `deploy/memoro.holder.json`: `{ pid, verb, started, token }`. The suites of
 * an exercise, the deployer and `mc language` each place or read the tree, and
 * none of them may do it while another stands in it. A record whose pid is gone
 * is stale and is taken over; one whose pid lives is waited for, said each
 * minute, up to `HOLDER_WAIT_MS`. The check and the write are one step under the
 * register's lock; the holding itself is the record, not the lock.
 *
 * Nothing here imports `commands/deploy.js` (which imports this file).
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { tryGit } from './git.js';
import { processAlive } from './lease-owner.js';
import { mcHome, workRoot } from './paths.js';
import { realLock } from './runner-lock.js';

const REPO = 'memoro';
const short = (sha) => (sha ? String(sha).slice(0, 7) : 'unknown');

/**
 * Where mc keeps a `main` of its own: `~/.memoro/mc/deploy/memoro`, added with
 * `git worktree add` the first time a deploy finds `main` checked out nowhere,
 * and never removed.
 *
 * Under `mcHome()` and deliberately not under `~/mc/`: a checkout there is a
 * runner area to `listStepAreas` (`work-area.js`) and to the runner's
 * `closeWorkareas`, or a stray to `listStrays`, and a deploy checkout is neither a project nor something
 * the board should draw. `env` rather than `mcHome()` alone so the seam every
 * other process boundary goes through covers this one too.
 */
export function deployWorktreePath(env = process.env) {
  return join(env.MC_HOME || mcHome(), 'deploy', REPO);
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

/** A few of the dirty paths, for a refusal to name. */
function pathsWords(paths) {
  const shown = paths.slice(0, 5).map((line) => String(line).trim()).join(', ');
  return paths.length > 5 ? `${shown}, … and ${paths.length - 5} more` : shown;
}

/**
 * Put mc's own worktree at `sha`, the commit the gate measured, and leave it
 * clean. The one function the exercise and `ship` both use.
 *
 * `{ ok: true, moved, how, strays, from }` — `moved` is whether HEAD changed,
 * `how` is `fast-forward` or `reset` (or null), `strays` the untracked paths
 * removed. Else `{ ok: false, stopped_at, reason, head, lines }`: `stopped_at`
 * is what `ship` writes into the row (`fast-forward` when git refused a move it
 * was asked for, `clean` when it refused the removal, `moved` for a tree that
 * stands on something this function cannot place, `unreadable` when git could
 * not say what stands there), `reason` names what stood, `head` is the commit
 * that stood (null when git could not read it), `lines` what stderr says.
 *
 * It never discards work: a modified tracked file, a commit origin/main lacks
 * or a HEAD off origin/main's line is a stop, because in this tree it means
 * something went wrong that is worth seeing.
 */
export function placeWorktree({ worktree, sha, git = tryGit }) {
  const head = git(worktree, ['rev-parse', '--verify', 'HEAD']);
  const state = worktreeState({ worktree, git });
  const stop = (stopped_at, reason, lines = []) => ({ ok: false, stopped_at, reason, head: head || null, lines });

  if (state.unreadable) return stop('unreadable', `git status failed in ${worktree} — what stands there is unknown`);
  if (!head) return stop('unreadable', `git could not read HEAD in ${worktree} — what stands there is unknown`);
  if (state.ahead === null) return stop('unreadable', `git could not count the commits of ${worktree} that origin/main lacks`);

  const tracked = state.dirty.filter((line) => !line.startsWith('?? '));
  let restore = [];
  if (tracked.length) {
    if (!leftoverStamps({ worktree, dirty: tracked, git })) {
      return stop('moved', `${worktree} has modified tracked files (${pathsWords(tracked)}) — main stands on ${short(head)}, not ${short(sha)}`);
    }
    restore = STAMP_FILES.filter((file) => tracked.some((line) => line.trim().endsWith(file)));
  }
  if (state.ahead > 0) {
    return stop('moved', `${worktree} has ${state.ahead} commit${state.ahead === 1 ? '' : 's'} that origin/main lacks — main stands on ${short(head)}, not ${short(sha)}`);
  }

  if (restore.length && git(worktree, ['checkout', '--', ...restore]) === null) {
    return stop('clean', `could not restore the stamps a killed deploy left in ${worktree}`, [`mc: git checkout -- ${restore.join(' ')} failed in ${worktree} — nothing was deployed`]);
  }

  const ancestor = (older, newer) => Boolean(older && newer) && git(worktree, ['merge-base', '--is-ancestor', older, newer]) !== null;
  let how = null;
  if (head !== sha) {
    const past = ancestor(sha, head);
    if (past) {
      // Past the pick: put back only along origin/main's own line, a movement to a commit it contains.
      if (!ancestor(head, 'origin/main')) {
        return stop('moved', `main stands on ${short(head)}, which origin/main does not contain — it is not ${short(sha)}`);
      }
      if (git(worktree, ['reset', '--keep', sha]) === null) {
        return {
          ...stop('fast-forward', `could not move main in ${worktree} back to ${short(sha)}, the commit that was measured`),
          lines: [`mc: git reset --keep ${short(sha)} failed in ${worktree} — nothing was deployed`],
        };
      }
      how = 'reset';
    } else if (ancestor(head, sha)) {
      if (git(worktree, ['merge', '--ff-only', sha]) === null) {
        return {
          ...stop('fast-forward', `could not fast-forward main in ${worktree} to ${short(sha)}`),
          lines: [`mc: git merge --ff-only ${short(sha)} failed in ${worktree} — nothing was deployed`],
        };
      }
      how = 'fast-forward';
    } else {
      return stop('moved', `main stands on ${short(head)}, which is neither before nor after ${short(sha)} on origin/main's line`);
    }
  }

  // Read again after a move, because a move can dirty the tree: a commit that drops lines from
  // `.gitignore` turns files that were ignored a moment ago into untracked ones (2026-10-09).
  const after = worktreeState({ worktree, git });
  if (after.unreadable) return stop('unreadable', `git status failed in ${worktree} after the placing — what stands there is unknown`);
  const strays = strayPaths(after.dirty) || [];
  if (strays.length && git(worktree, ['clean', '-fd']) === null) {
    return stop('clean', `could not remove ${strays.length} untracked path${strays.length === 1 ? '' : 's'} in ${worktree}`, [`mc: git clean -fd failed in ${worktree} — nothing was deployed`]);
  }
  if (after.dirty.length && !strays.length) {
    return stop('moved', `${worktree} has uncommitted files after the placing (${pathsWords(after.dirty)})`);
  }
  return { ok: true, moved: how !== null, how, strays, restored: restore, from: head };
}

/** The lines `ship` and the exercise say about what a placing removed. */
export function strayLines(strays) {
  if (!strays?.length) return [];
  return [
    `mc: removed ${strays.length} untracked path${strays.length === 1 ? '' : 's'} from mc's own main worktree:`,
    ...strays.slice(0, 5).map((file) => `mc:   ${file}`),
    ...(strays.length > 5 ? [`mc:   … and ${strays.length - 5} more`] : []),
  ];
}

// ---------------------------------------------------------------------------
// The holder
// ---------------------------------------------------------------------------

/** How long a user of the tree waits for its holder before it gives up. */
export const HOLDER_WAIT_MS = 90 * 60_000;
/** How often the holder is looked at again while it is waited for. */
export const HOLDER_POLL_MS = 5_000;
/** How often a wait says what it waits for. */
export const HOLDER_SAY_MS = 60_000;

/** The record beside the worktree: `deploy/memoro.holder.json`. */
export function holderPath(env = process.env) {
  return `${deployWorktreePath(env)}.holder.json`;
}

/** The record, or null: absent, unreadable or without a pid all read as none. */
export function readHolder(env = process.env) {
  try {
    const record = JSON.parse(readFileSync(holderPath(env), 'utf8'));
    return Number.isInteger(record?.pid) ? record : null;
  } catch {
    return null;
  }
}

const realSleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/** What a wait says about its holder. */
export function holderWords(record, at = null) {
  const since = String(record.started || '').slice(0, 16).replace('T', ' ');
  const mins = at != null && Number.isFinite(Date.parse(record.started)) ? `, ${Math.max(0, Math.round((at - Date.parse(record.started)) / 60_000))} min ago` : '';
  return `${record.verb || 'a user'} (pid ${record.pid}), since ${since}${mins}`;
}

/**
 * Take the holder of mc's own deploy worktree for `verb`, waiting for it when
 * another process has it.
 *
 * `{ ok: true, release, tookOver }` — `release()` removes the record when it is
 * still this holder's (it never removes another's); `tookOver` is the stale
 * record that was replaced, or null. `{ ok: false, reason, holder }` when a live
 * holder outlasted `waitMs`. The record of this very pid is this process's
 * own, left by an earlier use of it: it is taken, not waited for.
 *
 * The taking is made before the tree is placed or read, and released when its
 * last use has ended; a waiter says each `HOLDER_SAY_MS` what it waits for and
 * since when. `now`, `sleep`, `alive`, `pid` and `lock` are the seams.
 */
export async function takeHolder({
  env = process.env, verb, say = () => {}, now = () => Date.now(), sleep = realSleep, alive = processAlive,
  pid = process.pid, lock = realLock, root = null, waitMs = HOLDER_WAIT_MS, pollMs = HOLDER_POLL_MS, sayMs = HOLDER_SAY_MS,
} = {}) {
  const file = holderPath(env);
  const lockRoot = root || workRoot(env);
  const began = now();
  let lastSaid = null;
  for (;;) {
    const token = randomUUID();
    const attempt = lock(lockRoot, () => {
      const record = readHolder(env);
      if (record && record.pid !== pid && alive(record.pid)) return { held: record };
      mkdirSync(dirname(file), { recursive: true });
      writeJsonAtomic(file, { pid, verb, started: new Date(now()).toISOString(), token });
      return { took: record && record.pid !== pid ? record : null };
    }, { name: 'deploy-worktree' });
    if (!attempt.held) {
      if (attempt.took) say(`mc: the deploy worktree's holder, ${attempt.took.verb || 'a user'} (pid ${attempt.took.pid}), is gone — its record is taken over`);
      const release = () => {
        const record = readHolder(env);
        if (record?.token !== token) return false;
        try { rmSync(file, { force: true }); } catch { /* gone already */ }
        return true;
      };
      return { ok: true, release, tookOver: attempt.took || null, waitedMs: now() - began };
    }
    const at = now();
    if (at - began >= waitMs) {
      return {
        ok: false,
        holder: attempt.held,
        reason: `the deploy worktree is held by ${holderWords(attempt.held, at)} — waited ${Math.round((at - began) / 60_000)} min`,
      };
    }
    if (lastSaid === null || at - lastSaid >= sayMs) {
      say(`mc: waiting for the deploy worktree — held by ${holderWords(attempt.held, at)}`);
      lastSaid = at;
    }
    await sleep(pollMs);
  }
}
