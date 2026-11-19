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
 * A runner announcement names the goal and second; only its matching trace can
 * establish a start. Colliding announcements within a second cannot safely be
 * matched to one trace. Missing or rotated records remain unknown.
 */
export function buildDispatches({ root, programme, goal, read }) {
  const dir = join(root, 'runner', 'log');
  const prefix = `goal:${programme}/${goal}: build starting (`;
  const lines = [read(join(dir, 'runner.log.1')), read(join(dir, 'runner.log'))]
    .filter(Boolean).flatMap((text) => text.split('\n'));
  const attempts = [];
  for (const line of lines) {
    const match = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\s+(.+)$/u);
    if (!match || !match[2].startsWith(prefix)) continue;
    attempts.push({ at: match[1] });
  }
  for (const attempt of attempts) {
    const stamp = attempt.at.replace(/[-:]/gu, '');
    const path = join(dir, `goal-${programme}-${goal}-${stamp}.jsonl`);
    attempt.trace = path;
    attempt.start = attempts.filter((other) => other.at === attempt.at).length === 1 && hasToolStart(read(path)) ? 'started' : 'unknown';
  }
  return attempts;
}
