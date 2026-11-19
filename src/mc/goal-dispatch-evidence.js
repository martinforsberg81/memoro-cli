/** Read-only evidence about a goal's build dispatches from the runner's existing logs. */
import { join } from 'node:path';

/** A tool's own session-start event, not a file, PID, exit, or announcement. */
export function hasToolStart(text) {
  for (const line of String(text ?? '').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) return true;
      if (event?.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string' && event.session_id) return true;
    } catch { /* Incomplete or non-JSON output is not a start event. */ }
  }
  return false;
}

/**
 * The stem is sampled before the announcement and can be earlier; only
 * the same and previous second are considered here, so older traces stay unknown. A stem flattens the two names, so different goal names can
 * collide. A trace is attributable only when the recorded announcements and
 * existing candidate traces give it a unique owner and a unique candidate.
 * Rotated or missing announcements cannot establish identity on their own;
 * callers must additionally correlate the completed run before claiming a start.
 */
export function buildDispatches({ root, programme, goal, read }) {
  const dir = join(root, 'runner', 'log');
  const lines = [read(join(dir, 'runner.log.1')), read(join(dir, 'runner.log'))]
    .filter(Boolean).flatMap((text) => text.split('\n'));
  const announcements = [];
  for (const line of lines) {
    const match = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\s+goal:([a-z0-9-]+)\/([a-z0-9-]+): (build|review|draft|mend) starting \(/u);
    if (!match) continue;
    const time = Date.parse(match[1]);
    const paths = [time - 1000, time].map((ms) => {
      const stamp = new Date(ms).toISOString().replace(/\.000Z$/u, 'Z').replace(/[-:]/gu, '');
      return join(dir, `goal-${match[2]}-${match[3]}-${stamp}.jsonl`);
    });
    announcements.push({ at: match[1], programme: match[2], goal: match[3], kind: match[4], paths });
  }
  const owners = new Map();
  for (const item of announcements) for (const path of item.paths) owners.set(path, (owners.get(path) ?? 0) + 1);
  return announcements.filter((item) => item.programme === programme && item.goal === goal && item.kind === 'build').map((item) => {
    const candidates = item.paths.filter((path) => read(path) !== null);
    const trace = candidates.length === 1 && owners.get(candidates[0]) === 1 ? candidates[0] : null;
    return { at: item.at, trace, start: trace && hasToolStart(read(trace)) ? 'started' : 'unknown' };
  });
}
