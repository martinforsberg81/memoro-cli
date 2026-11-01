/** Fail-closed recovery for the autonomous runner seam. Never signal
 * a pid read from disk; live/unknown previous workers keep the workarea held. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { captureWorktree, sameContent } from './session-gate-evidence.js';
import { GATE_LANES, SESSION_LANE, releaseGateLock } from './gate-lock.js';
import { processAlive } from './resource-claim.js';
import { writeJsonAtomic } from './atomic-write.js';
import { validateControlState } from './session-control.js';

export function sessionGit(cwd, args, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd, encoding, timeout: 60_000, maxBuffer: 64 << 20 });
  if (result.error || result.status !== 0) throw new Error(`session snapshot: git ${args[0]} failed`);
  return result.stdout;
}
export const sessionGitDir = cwd => sessionGit(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']).trim();
export function groupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** The worker writes its result only after bounded children settle. A dead
 * worker without that evidence may have orphaned detached test groups: wait
 * for controlled recovery, never reap its lane just because its pid is dead. */
export function reconcileSessionGate(gitDir, { alive = processAlive } = {}) {
  const path = join(gitDir, 'mc-gate.json');
  if (!existsSync(path)) return { ok: true };
  let lock; let request; let result;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error('invalid gate pid');
    if (alive(lock.pid)) return { ok: false, reason: 'gate-worker-alive', pid: lock.pid };
    request = JSON.parse(readFileSync(lock.request, 'utf8'));
    result = JSON.parse(readFileSync(`${lock.request}.result`, 'utf8'));
    const exit = readFileSync(`${lock.log}.exit`, 'utf8').trim();
    if (typeof result.ok !== 'boolean' || !Number.isSafeInteger(result.code) || result.code < 0
      || !/^[0-9]+$/u.test(exit) || Number(exit) !== result.code
      || ![...GATE_LANES, SESSION_LANE].includes(request.reservation?.lane) || !request.reservation.root) throw new Error('unknown gate completion');
  } catch { return { ok: false, reason: 'gate-children-unknown', pid: lock?.pid ?? null }; }
  // releaseGateLock checks both pid and claim generation; a successor is kept.
  releaseGateLock({ ...request.reservation, pid: lock.pid });
  const current = JSON.parse(readFileSync(path, 'utf8'));
  if (current.request === lock.request && current.pid === lock.pid) rmSync(path);
  return { ok: true, gate: { pid: lock.pid, code: result.code } };
}

/** Immutable bytes, not just dangling git object IDs. Includes tracked and
 * nonignored untracked content, executable/symlink bits and the staged diff.
 * Never checkout/reset/stash the builder's worktree. */
export function assertSessionDirectory(cwd, directory) {
  const inside = relative(realpathSync(cwd), join(realpathSync(dirname(directory)), basename(directory)));
  if (inside !== '..' && !inside.startsWith(`../`) && !isAbsolute(inside)) throw new Error('session artifacts must be outside the worktree');
}
export function preserveSession({ cwd, directory, control, telemetry, process: processResult }) {
  assertSessionDirectory(cwd, directory);
  // The directory exists by now; also reject a symlink back into the worktree.
  assertSessionDirectory(cwd, realpathSync(directory));
  const target = join(directory, 'snapshot');
  mkdirSync(target, { mode: 0o700 }); // exclusive attempt; never replace a snapshot
  const content = captureWorktree(cwd);
  // Copy raw bytes rather than git archive: export-ignore and clean filters
  // must not silently lose the builder's files. Symlinks are copied, not read.
  const paths = new Set(sessionGit(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  for (const path of paths) {
    const fromRoot = relative(resolve(cwd), resolve(cwd, path));
    if (isAbsolute(path) || fromRoot === '..' || fromRoot.startsWith('../')) throw new Error('unsafe snapshot path');
    try { lstatSync(join(cwd, path)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const destination = join(target, 'files', path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(join(cwd, path), destination, { dereference: false, verbatimSymlinks: true });
  }
  if (!sameContent(content, captureWorktree(cwd))) throw new Error('worktree changed during snapshot');
  writeFileSync(join(target, 'index.patch'), sessionGit(cwd, ['diff', '--cached', '--binary', 'HEAD']), { mode: 0o600 });
  writeJsonAtomic(join(target, 'checkpoint.json'), { control, telemetry, process: processResult,
    content, head: sessionGit(cwd, ['rev-parse', 'HEAD']).trim(), status: sessionGit(cwd, ['status', '--porcelain=v1']) });
  return target;
}

export function reconcilePreviousSession(gitDir, { publication = null } = {}) {
  const path = join(gitDir, 'mc-autonomous-session.json');
  if (!existsSync(path)) return reconcileSessionGate(gitDir);
  try {
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) return { ok: false, reason: 'previous-start-unknown' };
    if (groupAlive(previous.pid)) return { ok: false, reason: 'previous-process-group-alive', pid: previous.pid };
    if (!previous.process_closed || previous.control_persisted === false || previous.unreconciled_tools
      || !previous.snapshot || !existsSync(join(previous.snapshot, 'checkpoint.json'))) {
      return { ok: false, reason: 'previous-snapshot-required', pid: previous.pid };
    }
    const checkpoint = JSON.parse(readFileSync(join(previous.snapshot, 'checkpoint.json'), 'utf8'));
    validateControlState(checkpoint.control);
    if (!isDeepStrictEqual(checkpoint.control.binding, previous.binding) || checkpoint.control.binding.run_id !== previous.run_id
      || checkpoint.process?.group_dead !== true || sessionGitDir(previous.cwd) !== gitDir) {
      return { ok: false, reason: 'previous-snapshot-mismatch' };
    }
    // A gate still running when the snapshot was taken might subsequently
    // change code. Do not recover from an older snapshot without noticing.
    const head = sessionGit(previous.cwd, ['rev-parse', 'HEAD']).trim();
    if (!sameContent(checkpoint.content, captureWorktree(previous.cwd))) return { ok: false, reason: 'previous-worktree-changed' };
    if (checkpoint.head !== head) {
      // Recovery may have committed the already measured bytes, then crashed
      // before refreshing its snapshot. This exception permits only that tree
      // on the same run/revision and descendant history, never new content.
      if (!publication || publication.run_id !== previous.run_id
        || publication.goal_revision !== previous.binding.goal_revision
        || publication.tree !== checkpoint.content.tree || (publication.head && publication.head !== head)
        || sessionGit(previous.cwd, ['rev-parse', 'HEAD^{tree}']).trim() !== publication.tree
        || sessionGit(previous.cwd, ['status', '--porcelain']).trim()) return { ok: false, reason: 'previous-worktree-changed' };
      sessionGit(previous.cwd, ['merge-base', '--is-ancestor', checkpoint.head, head]);
    }
    return reconcileSessionGate(gitDir);
  } catch { return { ok: false, reason: 'previous-session-unreadable' }; }
}

/** The prior normal run was reconciled before fresh main integration. Keep its
 * manifest with its immutable snapshot so the new supervisor does not mistake
 * deliberate main integration for changes by a still-running predecessor. */
export function retirePreviousSession(gitDir, runId) {
  const path = join(gitDir, 'mc-autonomous-session.json');
  if (!existsSync(path)) return;
  const bytes = readFileSync(path, 'utf8');
  const manifest = JSON.parse(bytes);
  if (manifest.run_id !== runId || !reconcilePreviousSession(gitDir).ok) throw new Error('previous normal session is not reconciled');
  const archived = join(dirname(manifest.snapshot), 'retired-manifest.json');
  try { writeFileSync(archived, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || readFileSync(archived, 'utf8') !== bytes) throw error; }
  rmSync(path);
}
