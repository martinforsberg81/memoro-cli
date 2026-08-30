/**
 * Keep the machine awake for as long as the runner is running.
 *
 * `mc run` is an all-day process, and this laptop is configured to sleep after
 * one minute of idle on battery (`pmset -g custom`: `sleep 1` on battery,
 * `sleep 0` on AC). A runner that is doing nothing for ten minutes between
 * rounds — which is its normal, correct behaviour — is exactly what that
 * setting is for, so an unattended run on battery stops without anybody
 * deciding it should.
 *
 * ## Why `caffeinate -w` and not a timeout
 *
 * `caffeinate` can hold an assertion for a fixed number of seconds, and every
 * shape of that is wrong here: too short and the runner sleeps mid-day, too
 * long and a caffeinate outlives the run that wanted it and keeps a laptop
 * awake in somebody's bag. `-w <pid>` ties the assertion to a process instead
 * of to a clock — it holds until that pid exits and then exits itself.
 *
 * That also survives the failure this whole area has been about: a runner
 * killed with SIGKILL runs no cleanup, and there is nothing to clean up,
 * because caffeinate is watching the pid rather than waiting to be told.
 *
 * ## What it can and cannot assert
 *
 * `-i` prevents idle *system* sleep, and it is the one that matters: it holds
 * on battery as well as on AC.
 * `-m` prevents the disk idling down under a run that is mostly waiting.
 * `-s` prevents system sleep, and caffeinate(8) is explicit that this
 * assertion "is valid only when system is running on AC power" — so it is
 * asked for and simply does nothing on battery. Harmless to include and
 * dishonest to describe as more than it is.
 *
 * `-d` is deliberately NOT asked for. Keeping the display lit all night costs
 * battery and screen for nothing: display sleep does not stop a process.
 *
 * ## The lid
 *
 * Closing the lid is not an idle timeout and no assertion suppresses it. On
 * Apple Silicon the machine sleeps on lid close unless it is in clamshell mode
 * (external display and power) or `pmset -a disablesleep 1` is set, which is a
 * sudo, machine-wide, persists-until-changed setting and therefore an
 * operator's decision rather than something a verb does on their behalf. So
 * this module does what it can do and `mc run` says plainly what it did not,
 * rather than leaving somebody to discover it from an empty log the next
 * morning.
 */
import { spawn, spawnSync } from 'node:child_process';

/** What was actually asserted, so the caller can say it rather than assume it. */
export const AWAKE_FLAGS = Object.freeze(['-i', '-m', '-s']);

/**
 * Hold the machine awake until `pid` exits.
 *
 * Returns what happened, always — an unsupported platform and a missing
 * binary are reported, never thrown. A runner must not fail to start because
 * the machine could not be kept awake; it should run and say so.
 */
export function keepAwake({
  pid = process.pid,
  platform = process.platform,
  spawner = spawn,
  onAC = null,
} = {}) {
  if (platform !== 'darwin') {
    return { ok: false, reason: 'not-darwin', pid: null, flags: [], note: `no sleep assertion on ${platform}` };
  }
  try {
    const child = spawner('caffeinate', [...AWAKE_FLAGS, '-w', String(pid)], {
      stdio: 'ignore',
      // Detached so it is not in the runner's process group: a signal sent to
      // the group would otherwise take the assertion down with the thing it is
      // supposed to outlive by exactly one moment.
      detached: true,
    });
    // Nothing waits on it and nothing reads from it; unref so its existence
    // cannot hold this process open a millisecond past its own work.
    child.unref?.();
    if (!child?.pid) return { ok: false, reason: 'caffeinate-did-not-start', pid: null, flags: [], note: 'caffeinate did not start' };
    return {
      ok: true,
      reason: null,
      pid: child.pid,
      flags: [...AWAKE_FLAGS],
      watching: pid,
      note: awakeNote({ onAC }),
    };
  } catch (error) {
    return { ok: false, reason: 'caffeinate-missing', pid: null, flags: [], note: error?.message || 'caffeinate could not be run' };
  }
}

/**
 * The sentence `mc run` prints. It names the limit rather than the feature,
 * because the feature is the part nobody is going to be surprised by.
 */
export function awakeNote({ onAC = null } = {}) {
  const power = onAC === true ? ' (on AC: system sleep held too)'
    : onAC === false ? ' (on battery: -s does nothing, idle sleep is still held)'
      : '';
  return `idle sleep and disk sleep held for the length of this run${power}; a closed lid still sleeps the machine`;
}

/**
 * Whether the machine is on AC right now, or null if it will not say.
 *
 * Only ever used to phrase the note above accurately. Nothing branches on it:
 * the same flags are asked for either way, because the power source can change
 * halfway through a run and an assertion chosen at start would then be the
 * wrong one with nobody watching.
 */
export function onACPower({ runner = null } = {}) {
  try {
    const exec = runner || ((cmd, args) => spawnSyncText(cmd, args));
    const out = exec('pmset', ['-g', 'batt']);
    if (typeof out !== 'string') return null;
    if (/drawing from ['"]?AC Power/iu.test(out)) return true;
    if (/drawing from ['"]?Battery Power/iu.test(out)) return false;
    return null;
  } catch { return null; }
}

function spawnSyncText(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  return result?.stdout ?? null;
}
