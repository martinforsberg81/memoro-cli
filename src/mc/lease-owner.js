/**
 * The way back for a lease whose holder never came back.
 *
 * A lease is taken by a command and given back by the same command's end. Cut
 * the command short — a shell timeout, a kill, a pane closed — and nothing is
 * left that knows to release it. That is how PM held the suite right for two
 * hours and twenty-five minutes on 2026-08-23: the gate round on #10861 was
 * killed by its own shell's timeout, the round's `finally` never ran, and the
 * board said "held 2h 25m · nothing running" to nobody in particular while a
 * track waited twenty minutes, asked twice, and wrote a letter. Same shape as
 * the load harness's kill that never landed and the caffeinate nobody cleans
 * up: everything we take needs a way back that does not assume we arrived.
 *
 * The way back is the process. A lease taken *for the length of a process* —
 * a gate round — records that process's pid. A lease whose recorded process
 * is gone is orphaned: nobody is using it, and nobody can give it back, so
 * the next claim takes it and says so in the log, and the board shows it as
 * what it is rather than as a holder who walked away. A lease taken by hand
 * (`mc suite claim`) records no pid — the claiming process ends at once and
 * the person is the holder — and keeps today's rule: no expiry, a person or
 * the PM decides, with `--force`, written down.
 *
 * Liveness is asked of the kernel, not of a clock: `kill -0` answers whether
 * the pid exists. A pid that exists but belongs to somebody else's process
 * answers EPERM, which is "alive" for this purpose — the one false answer
 * that matters is "dead" said of a running round, and EPERM never says it.
 * Pid reuse is the remaining gap: a number freed and handed to another
 * process reads as alive, which errs toward the old behaviour (held), never
 * toward taking a lease somebody is using.
 */

/** Is there a process with this pid right now? `null` when there is no pid to ask about. */
export function processAlive(pid, { kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * The owner fields a lease reports: the recorded pid, whether it is alive,
 * and the one conclusion drawn from them. Read from the raw file so the two
 * lease kinds answer identically.
 */
export function ownerState(raw, { kill } = {}) {
  const pid = Number.isInteger(raw?.owner_pid) && raw.owner_pid > 0 ? raw.owner_pid : null;
  const alive = pid === null ? null : processAlive(pid, kill ? { kill } : {});
  return { owner_pid: pid, owner_alive: alive, orphaned: pid !== null && alive === false };
}

/** One sentence for a board row or a refusal: what the owner's absence means. */
export function orphanLine(lease) {
  if (!lease?.orphaned) return null;
  return `its process (pid ${lease.owner_pid}) is gone — the next claim takes it`;
}
