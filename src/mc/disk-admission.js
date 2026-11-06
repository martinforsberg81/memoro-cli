/**
 * The disk policy (disk-pressure.js) on this machine's real doors, for a
 * process that is not the runner: `mc deploy`'s deployer and Docker's
 * `ensure`. The runner builds its own on its injected deps (`run.js`), with
 * the same state file, lease and steps, plus the archive of finished goals.
 *
 * The steps of a pass here are tidy's file rules and, unless `docker: false`,
 * Docker's images unused for three days on a runtime that is already up.
 * `ensure` asks with `docker: false`: a pass inside a start must not prune
 * through the runtime it is about to start, and `tidyDocker` without `start`
 * never starts one anyway. BuildKit's cache is never pruned (mc-tidy.md).
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from './atomic-write.js';
import { createDiskPressure } from './disk-pressure.js';
import { tidyDocker } from './docker.js';
import { log } from './logger.js';
import { runnerDir, runnerScratchDir, workRoot } from './paths.js';
import { realLock } from './runner-lock.js';
import { pidAlive } from './status-collect.js';
import { runTidy } from './tidy.js';

/** Docker's `1.2GB`, `512MB`, `0B` as bytes (decimal, as Docker prints them); 0 when it says nothing readable. */
export function sizeBytes(text) {
  const match = /^([\d.]+)\s*([kKMGT]?)B$/u.exec(String(text ?? '').trim());
  if (!match) return 0;
  const scale = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[match[2]];
  return Math.round(Number(match[1]) * scale) || 0;
}

/** `runTidy`'s answer as a pressure step: its targets' bytes are the estimate, never the result. */
export function tidyStep(ran) {
  const list = ran?.list || {};
  const applied = ran?.outcome?.applied || [];
  const kept = [
    ...applied.filter((item) => !item.ok),
    ...(list.kept || []).filter((item) => item.rule === 'S' || item.rule === 'B' || item.rule === 'error'),
  ];
  return {
    ok: true, estimate_bytes: (list.targets || []).reduce((sum, item) => sum + (item.bytes || 0), 0),
    removed: ran?.outcome?.removed || 0, kept, errors: [],
  };
}

/**
 * `tidyDocker`'s answer as a pressure step: a failed prune fails the step,
 * and what Docker says it reclaimed is an estimate, not the measured delta. A
 * runtime that is down is left down and is no failure.
 */
export function dockerStep(answer) {
  const failed = (answer?.pruned || []).filter((item) => !item.ok);
  const errors = failed.map((item) => `${item.what}: ${item.detail}`);
  if (answer?.reason && answer.up) errors.push(answer.reason);
  return {
    ok: errors.length === 0,
    estimate_bytes: (answer?.pruned || []).reduce((sum, item) => sum + sizeBytes(item.reclaimed), 0),
    removed: (answer?.pruned || []).filter((item) => item.ok).length,
    kept: answer?.up ? [] : [{ path: 'docker', why: `runtime left as it is — ${answer?.reason || 'not running'}` }],
    errors,
  };
}

/** The policy on the real disk, state under `~/mc/runner/`, the runner lock for the lease. */
export function mcDiskPressure({ env = process.env, docker = true, say = (line) => log('disk', { line }) } = {}) {
  return createDiskPressure({
    path: runnerScratchDir(env),
    stateDir: runnerDir(env),
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    writeJson: (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
    now: () => Date.now(),
    pid: process.pid,
    alive: pidAlive,
    lock: (fn) => realLock(workRoot(env), fn, { strict: true, name: 'disk-pressure' }),
    say,
    steps: [
      { name: 'tidy', run: async () => tidyStep(runTidy({ apply: true, pressure: true, env })) },
      ...(docker ? [{ name: 'docker-images', run: async () => dockerStep(await tidyDocker({ apply: true, env })) }] : []),
    ],
  });
}
