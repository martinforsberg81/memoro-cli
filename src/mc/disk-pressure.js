/**
 * Disk headroom for mc's own heavy work: one policy, shared by the runner,
 * `mc deploy` and Docker's start (goal mc/disk-headroom, 2026-11-05).
 *
 * The reading is the filesystem's own: `statfs` available bytes (`bavail` ×
 * `bsize`) on the volume under `~/mc/runner/scratch/`. Never a sum of file
 * sizes and never Docker's reclaimable estimate: those are what a cleanup
 * hopes for, and they are recorded beside the measured delta, not instead of it.
 * Decimal gigabytes throughout (1 GB = 1e9 bytes).
 *
 *   - `RESERVE_BYTES` (20 GB) is the floor kept for mc's operations.
 *   - Below `PRESSURE_BYTES` (30 GB) a pressure pass starts, and no new heavy
 *     work (a headless session, a deploy script, a stopped Docker runtime) is
 *     admitted unless the pass restores it. The 10 GB between the two is a
 *     policy headroom, not a measured bound on what a deploy writes.
 *   - A pass stops at `RECOVERY_BYTES` (40 GB) or when its safe steps are
 *     exhausted, and reports the shortfall.
 *
 * What it guarantees is narrow, and the page says so: a controlled workload.
 * An unrelated application, or a build already running, can still use the
 * disk; nothing here kills running work.
 *
 *   - **Unknown is not room.** A reading that fails is written down, shown,
 *     and refuses admission; cleanup and `mc tidy` still work.
 *   - **One pass at a time.** In a process, callers share one flight; across
 *     processes cleanup and admissions hold a lease in `disk-pressure.json`,
 *     taken under
 *     the runner lock, and a second process that finds it held does not run
 *     its own. A live holder excludes even another instance in the same process.
 *     Admission holds exclusion through allocation and spawn, then releases it;
 *     competing starts defer and remeasure on retry, never sharing a stale reading.
 *   - **A pass that cannot help waits.** One that ends below the pressure line
 *     sets a five-minute cooldown, persisted, so a restart does not loop. A
 *     healthy reading clears the pressure state and the cooldown.
 *   - **Quiet when healthy.** A healthy poll measures and writes nothing,
 *     unless it is the reading that ends a pressure state.
 *   - **Bounded history.** Each pass, and each refused admission, is one event
 *     in `disk-pressure-events.json`, of which the newest `EVENTS_KEEP` stay.
 *
 * Every door is injected (`createDiskPressure`), so the rules are tested on a
 * fake clock and a fake filesystem, with no disk filled.
 */
import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const GB = 1e9;
export const RESERVE_BYTES = 20 * GB;
export const PRESSURE_BYTES = 30 * GB;
export const RECOVERY_BYTES = 40 * GB;
/** A pass that ends below the pressure line is not tried again for this long. */
export const COOLDOWN_MS = 5 * 60 * 1000;
/** How often the runner and an active `mc deploy` read the disk. */
export const POLL_MS = 60 * 1000;
/** Events kept in `disk-pressure-events.json`. */
export const EVENTS_KEEP = 100;
/** Kept reasons and errors kept per step of an event. */
export const DETAIL_KEEP = 20;

export const STATE_FILE = 'disk-pressure.json';
export const EVENTS_FILE = 'disk-pressure-events.json';
export const SCHEMA = 'mc-disk-pressure';

export const POLICY = Object.freeze({ reserve_bytes: RESERVE_BYTES, pressure_bytes: PRESSURE_BYTES, recovery_bytes: RECOVERY_BYTES });

/** The limit, in a line a person reads: what this policy does not promise. */
export const LIMITATION = 'this holds back mc\'s new work only; other apps and running work can still fill the disk';

/** `2026-11-05T12:00Z`: an ISO stamp to the minute. */
function minute(at) {
  return typeof at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/u.test(at) ? `${at.slice(0, 16)}Z` : String(at);
}

/** `27.9 GB`, rounded down, so a disk just under a line never reads as at it. */
export function gb(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  return `${(Math.floor((bytes / GB) * 10) / 10).toFixed(1)} GB`;
}

/**
 * Available bytes for an unprivileged writer on the volume holding `path`, or
 * its nearest existing parent. Null when nothing can be read.
 */
export function statfsAvailable(path) {
  for (let at = path; ; at = dirname(at)) {
    try { const fs = statfsSync(at); return Number(fs.bavail) * Number(fs.bsize); } catch { /* try the parent */ }
    if (dirname(at) === at) return null;
  }
}

function message(error) {
  return String(error?.message || error).split('\n')[0].slice(0, 200);
}

/**
 * The policy over injected doors:
 *
 *   - `path` — where to measure; `stateDir` — where state and events live.
 *   - `freeBytes(path)` — available bytes, null or a throw is unknown.
 *   - `read(path)` text or null, `writeJson(path, value)` whole.
 *   - `now()` a Date or epoch ms; `pid`; `alive(pid)`.
 *   - `lock(fn)` — a short cross-process critical section (runner-lock.js).
 *   - `steps` — the pressure pass, in order: `{ name, run }`, `run()` resolving
 *     `{ ok, estimate_bytes, removed, kept: [{ path, why }], errors: [] }`.
 *     A step is asked only while the disk is below the recovery target.
 *   - `say(line)` — the caller's narration.
 */
export function createDiskPressure({
  path, stateDir, freeBytes = statfsAvailable, read, writeJson, now = () => Date.now(), pid = process.pid,
  alive = () => false, lock = (fn) => fn(), steps = [], say = () => {},
} = {}) {
  const token = randomUUID();
  // All state/event read-modify-writes share the strict short filesystem lock.
  // Nested synchronous helpers reuse that critical section, not the lease.
  let inLock = false;
  function critical(fn) {
    if (inLock) return fn();
    return lock(() => { inLock = true; try { return fn(); } finally { inLock = false; } });
  }
  const statePath = join(stateDir, STATE_FILE);
  const eventsPath = join(stateDir, EVENTS_FILE);
  const nowMs = () => { const value = now(); return value instanceof Date ? value.getTime() : Number(value); };
  const iso = (ms = nowMs()) => new Date(ms).toISOString();

  function readJson(file, fallback) {
    try {
      const value = JSON.parse(read(file) ?? 'null');
      return value && typeof value === 'object' ? value : fallback;
    } catch { return fallback; }
  }
  const readState = () => {
    const value = readJson(statePath, null);
    return value && !Array.isArray(value) ? value : null;
  };
  const writeState = (patch) => critical(() => {
    const next = { ...(readState() || {}), ...patch, schema: SCHEMA, version: 1, policy: POLICY, volume: path, at: iso() };
    writeJson(statePath, next);
    return next;
  });

  /** `{ available, known }`, read now. */
  function measure() {
    let available = null;
    try { available = freeBytes(path); } catch { available = null; }
    const known = Number.isFinite(available) && available >= 0;
    return { available: known ? available : null, known };
  }

  /** The persisted cooldown, when it still applies. */
  function cooldown(state = readState()) {
    const until = Date.parse(state?.cooldown_until || '');
    return Number.isFinite(until) && until > nowMs() ? { until: state.cooldown_until, why: state.cooldown_why || null } : null;
  }

  function appendEvent(event) {
    critical(() => {
      const kept = readJson(eventsPath, []);
      const list = Array.isArray(kept) ? kept : [];
      list.push(event);
      writeJson(eventsPath, list.slice(-EVENTS_KEEP));
    });
  }

  /** A healthy reading: the pressure state and its cooldown end, said once. */
  function healthy(reading, state) {
    if (!state || (state.status === 'healthy' && !state.cooldown_until)) return;
    writeState({ status: 'healthy', available_bytes: reading.available, cooldown_until: null, cooldown_why: null });
    if (state.status && state.status !== 'healthy') say(`disk: ${gb(reading.available)} free — pressure over`);
  }

  function unknown(state) {
    if (state?.status === 'unknown') return;
    writeState({ status: 'unknown', available_bytes: null });
    say('disk: free space could not be measured — no new heavy work is admitted until it can');
  }

  /** The lease: true when this process holds it now, else the holder. */
  function takeLease(trigger) {
    return critical(() => {
      const state = readState();
      const held = state?.lease;
      if (held && (held.pid === pid || alive(held.pid))) return { ok: false, holder: held };
      writeState({ lease: { pid, token, since: iso(), trigger } });
      return { ok: true };
    });
  }
  function dropLease() {
    critical(() => { if (readState()?.lease?.token === token) writeState({ lease: null }); });
  }

  let flight = null;

  /**
   * One pressure pass, shared: a caller that finds one in flight in this
   * process gets the same answer. Resolves `{ ran, skipped?, event?, after }`.
   */
  function relieve({ trigger = 'pressure', admission = null, leased = false } = {}) {
    if (flight) return flight;
    flight = (async () => {
      try { return await pass({ trigger, admission, leased }); } finally { flight = null; }
    })();
    return flight;
  }

  async function pass({ trigger, leased = false }) {
    const before = measure();
    const lease = leased ? { ok: true } : takeLease(trigger);
    if (!lease.ok) return { ran: false, skipped: 'busy', holder: lease.holder, after: before };
    try {
      if (!before.known) { unknown(readState()); return { ran: false, skipped: 'unknown', after: before }; }
      if (before.available >= PRESSURE_BYTES) { healthy(before, readState()); return { ran: false, skipped: 'healthy', after: before }; }
      const waiting = cooldown();
      if (waiting) return { ran: false, skipped: 'cooldown', cooldown: waiting, after: before };
      say(`disk: ${gb(before.available)} free, below ${gb(PRESSURE_BYTES)} (${trigger}) — tidying toward ${gb(RECOVERY_BYTES)}`);
      writeState({ status: 'pressure', available_bytes: before.available });
      const done = [];
      const errors = [];
      let current = before;
      for (const step of steps) {
        if (current.known && current.available >= RECOVERY_BYTES) break;
        const record = { name: step.name, ok: false, estimate_bytes: 0, removed: 0, kept: [], errors: [], available_after: null };
        try {
          const answer = await step.run({ trigger, available: current.available }) || {};
          record.ok = answer.ok !== false;
          record.estimate_bytes = Number(answer.estimate_bytes) || 0;
          record.removed = Number(answer.removed) || 0;
          record.kept = (answer.kept || []).slice(0, DETAIL_KEEP).map((item) => ({ path: item.path ?? null, why: String(item.why ?? '') }));
          record.kept_total = (answer.kept || []).length;
          record.errors = (answer.errors || []).slice(0, DETAIL_KEEP).map(String);
        } catch (error) {
          record.ok = false;
          record.errors = [message(error)];
        }
        current = measure();
        record.available_after = current.available;
        for (const error of record.errors) errors.push(`${step.name}: ${error}`);
        if (!record.ok && !record.errors.length) errors.push(`${step.name}: failed`);
        done.push(record);
      }
      const after = current;
      const failed = done.some((record) => !record.ok);
      const restored = after.known && after.available >= PRESSURE_BYTES;
      const recovered = after.known && after.available >= RECOVERY_BYTES;
      const delta = after.known ? after.available - before.available : null;
      const outcome = recovered ? 'recovered' : restored ? 'above-pressure' : !after.known ? 'unknown' : delta > 0 ? 'shortfall' : 'no-progress';
      const shortfall = after.known ? Math.max(0, RECOVERY_BYTES - after.available) : null;
      const event = {
        at: iso(), volume: path, trigger, before_bytes: before.available, after_bytes: after.available, measured_delta_bytes: delta,
        estimate_bytes: done.reduce((sum, record) => sum + record.estimate_bytes, 0),
        steps: done, errors, failed, outcome, shortfall_bytes: shortfall, admission: null,
      };
      const cool = !restored;
      writeState({
        status: restored ? 'healthy' : after.known ? 'pressure' : 'unknown',
        available_bytes: after.available,
        last_cleanup: {
          at: event.at, trigger, before_bytes: before.available, after_bytes: after.available, measured_delta_bytes: delta,
          estimate_bytes: event.estimate_bytes, outcome, failed, errors: errors.slice(0, DETAIL_KEEP),
        },
        shortfall_bytes: shortfall,
        cooldown_until: cool ? iso(nowMs() + COOLDOWN_MS) : null,
        cooldown_why: cool ? `${outcome}${failed ? ', a step failed' : ''}` : null,
      });
      appendEvent(event);
      const freed = delta === null ? 'unknown' : gb(Math.max(0, delta));
      say(`disk: pressure pass (${trigger}) ${outcome} — ${gb(before.available)} → ${gb(after.available)} free, measured ${freed} back`
        + `${shortfall ? `, ${gb(shortfall)} short of ${gb(RECOVERY_BYTES)}` : ''}${failed ? ` · failed: ${errors.slice(0, 3).join('; ') || 'a step failed'}` : ''}`
        + `${cool ? ` · next pass after ${COOLDOWN_MS / 60000} min` : ''}`);
      return { ran: true, event, after };
    } finally { if (!leased) dropLease(); }
  }

  /**
   * The cheap reading: no walk, no Docker. Below the pressure line a pass
   * starts at once unless the cooldown holds; healthy writes nothing.
   */
  async function poll({ trigger = 'poll' } = {}) {
    const reading = measure();
    if (!reading.known || reading.available >= PRESSURE_BYTES) {
      critical(() => {
        const state = readState();
        if (state?.lease && (state.lease.pid === pid || alive(state.lease.pid))) return;
        if (!reading.known) unknown(state);
        else healthy(reading, state);
      });
      return { status: reading.known ? 'healthy' : 'unknown', reading };
    }
    const relief = await relieve({ trigger });
    return { status: relief.after?.known && relief.after.available >= PRESSURE_BYTES ? 'healthy' : 'pressure', reading, relief };
  }

  let queue = Promise.resolve();

  /**
   * Whether new heavy work (`what`) may start now. Serialized in this
   * process and excluded across instances/processes by the shared lease.
   * With `hold`, the caller MUST release in finally after allocation/spawn,
   * not after running work completes. Competing starts defer. Resolves `{ admitted, available, reason, line }`.
   */
  function admit({ trigger = 'admission', what = 'new work', hold = false } = {}) {
    const answer = queue.then(async () => {
      let lease;
      try { lease = takeLease(trigger); } catch (error) {
        const reason = `disk policy lock unavailable: ${message(error)}`;
        return { admitted: false, available: null, reason, line: `disk: unknown free — ${what} not started: ${reason}` };
      }
      if (!lease.ok) {
        const reading = measure();
        const reason = `pid ${lease.holder.pid} is reclaiming space now or admitting work`;
        appendEvent({ at: iso(), volume: path, trigger, before_bytes: reading.available, after_bytes: reading.available, measured_delta_bytes: 0, estimate_bytes: 0, steps: [], errors: [], outcome: 'busy', admission: { admitted: false, trigger, what, available: reading.available, reason } });
        return { admitted: false, available: reading.available, reason, line: `disk: ${gb(reading.available)} free — ${what} not started: ${reason}` };
      }
      let retained = false;
      try {
        const result = await decide({ trigger, what });
        retained = result.admitted && hold;
        let released = false;
        return retained ? { ...result, recheck: () => decide({ trigger, what }), release: () => { if (!released) { released = true; dropLease(); } } } : result;
      } finally { if (!retained) dropLease(); }
    });
    queue = answer.catch(() => {});
    return answer;
  }

  async function decide({ trigger, what }) {
    let reading = measure();
    if (reading.known && reading.available >= PRESSURE_BYTES) { healthy(reading, readState()); return { admitted: true, available: reading.available, reason: null }; }
    let relief = null;
    if (reading.known) {
      relief = await relieve({ trigger, leased: true });
      reading = measure();
      if (reading.known && reading.available >= PRESSURE_BYTES) {
        if (relief.event) recordAdmission(relief.event, { admitted: true, trigger, what, available: reading.available });
        return { admitted: true, available: reading.available, reason: null };
      }
    }
    const reason = !reading.known
      ? 'free space could not be measured'
      : relief?.skipped === 'cooldown' ? `below ${gb(PRESSURE_BYTES)}; the last pressure pass could not restore it (${relief.cooldown.why}), next pass after ${relief.cooldown.until}`
        : relief?.skipped === 'busy' ? `below ${gb(PRESSURE_BYTES)}; pid ${relief.holder.pid} is reclaiming space now`
          : `below ${gb(PRESSURE_BYTES)} after tidying; safe candidates are exhausted`;
    const line = `disk: ${gb(reading.available)} free — ${what} not started: ${reason}`;
    const admission = { admitted: false, trigger, what, available: reading.available, reason };
    if (relief?.event) recordAdmission(relief.event, admission);
    else {
      appendEvent({
        at: iso(), volume: path, trigger, before_bytes: reading.available, after_bytes: reading.available, measured_delta_bytes: 0,
        estimate_bytes: 0, steps: [], errors: [], failed: false, outcome: relief?.skipped || (reading.known ? 'refused' : 'unknown'),
        shortfall_bytes: reading.known ? Math.max(0, RECOVERY_BYTES - reading.available) : null, admission,
      });
    }
    const state = readState();
    if (!reading.known && state?.status !== 'unknown') writeState({ status: 'unknown', available_bytes: null });
    writeState({ last_refusal: { at: iso(), trigger, what, available_bytes: reading.available, reason } });
    return { admitted: false, available: reading.available, reason, line };
  }

  /** An admission decided on a pass's result, written into that pass's event. */
  function recordAdmission(event, admission) {
    critical(() => {
      const list = readJson(eventsPath, []);
      if (!Array.isArray(list)) return;
      const index = list.findLastIndex((item) => item.at === event.at && item.trigger === event.trigger);
      if (index < 0) return;
      list[index] = { ...list[index], admission };
      writeJson(eventsPath, list.slice(-EVENTS_KEEP));
    });
  }

  /** What the page and `mc tidy --json` show: the state file and a fresh reading, no walk. */
  function status() {
    const reading = measure();
    const state = readState();
    return describe(state, reading, readJson(eventsPath, []), nowMs());
  }

  return { measure, poll, relieve, admit, status, readState, statePath, eventsPath };
}

/**
 * What the page and `mc tidy` show, read cheaply from this machine: the state
 * file and one statfs, no walk and no Docker. `read` and `freeBytes` are doors.
 */
export function diskSummary({ path, stateDir, read, freeBytes = statfsAvailable, nowMs = Date.now() }) {
  let state = null;
  try { state = JSON.parse(read(join(stateDir, STATE_FILE)) ?? 'null'); } catch { state = null; }
  let available = null;
  try { available = freeBytes(path); } catch { available = null; }
  const known = Number.isFinite(available) && available >= 0;
  return describe(state && typeof state === 'object' ? state : null, { known, available: known ? available : null }, [], nowMs);
}

/**
 * The state as a person reads it: `{ available_bytes, status, pressure,
 * cooldown_until, last_cleanup, shortfall_bytes, last_refusal, events,
 * policy, limitation, lines }`. `status` is from the reading now when there is
 * one; `lines` are the human ones.
 */
export function describe(state, reading, events = [], nowMs = Date.now()) {
  const known = reading?.known === true;
  const available = known ? reading.available : null;
  const status = !known ? 'unknown' : available >= PRESSURE_BYTES ? 'healthy' : 'pressure';
  const last = state?.last_cleanup || null;
  const cooldownUntil = state?.cooldown_until && Date.parse(state.cooldown_until) > nowMs ? state.cooldown_until : null;
  const lines = [];
  lines.push(!known
    ? 'disk: free space could not be measured — new sessions, deploys and Docker starts are refused'
    : status === 'healthy'
      ? `disk: ${gb(available)} free (measured) — healthy; pressure below ${gb(PRESSURE_BYTES)}, reserve ${gb(RESERVE_BYTES)}`
      : `disk: ${gb(available)} free (measured) — below ${gb(PRESSURE_BYTES)}: new sessions, deploys and Docker starts wait`);
  if (status !== 'healthy' && cooldownUntil) lines.push(`disk: next pass after ${minute(cooldownUntil)}`);
  return {
    available_bytes: available, status, pressure: status === 'pressure', cooldown_until: cooldownUntil,
    last_cleanup: last, shortfall_bytes: last && known ? Math.max(0, RECOVERY_BYTES - available) : null, last_refusal: state?.last_refusal || null,
    lease: state?.lease || null, events: Array.isArray(events) ? events.length : 0, policy: POLICY, limitation: LIMITATION, lines,
  };
}
