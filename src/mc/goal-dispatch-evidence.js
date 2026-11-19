/** Read-only evidence about a goal's build dispatches from existing runner logs. */
import { join } from 'node:path';

/** Only a tool's own start event supplies its session identity. */
export function toolStartIds(text) {
  const ids = new Set();
  for (const line of String(text ?? '').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) ids.add(event.thread_id);
      if (event?.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string' && event.session_id) ids.add(event.session_id);
    } catch { /* Incomplete or non-JSON output is not a start event. */ }
  }
  return [...ids];
}

export function hasToolStart(text) { return toolStartIds(text).length > 0; }

/**
 * An announcement alone is not a tool boundary. Completed runs identify their
 * goal and tool session; a trace identifies the same session in its start event.
 * Match all three, and refuse ambiguous or missing records. The timestamp in a
 * trace stem is sampled before the announcement, not necessarily within one
 * second of it. The flattened stem alone never identifies a goal.
 */
export function buildDispatches({ root, programme, goal, read, list }) {
  const dir = join(root, 'runner', 'log');
  const lines = [read(join(dir, 'runner.log.1')), read(join(dir, 'runner.log'))]
    .filter(Boolean).flatMap((text) => text.split('\n'));
  const announcements = [];
  for (const line of lines) {
    const match = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\s+goal:([a-z0-9-]+)\/([a-z0-9-]+): (build|review|draft|mend) starting \(/u);
    if (match) announcements.push({ at: match[1], programme: match[2], goal: match[3], kind: match[4] });
  }
  const rows = String(read(join(dir, 'runs.tsv')) ?? '').trim().split('\n').map((line) => line.split('\t'));
  const header = rows.shift() ?? [];
  const runs = rows.map((cells) => Object.fromEntries(header.map((key, i) => [key, cells[i]])))
    .filter((row) => row.name === `goal:${programme}/${goal}` && row.kind === 'build-goal' && row.seconds !== '' && row.seconds !== '-' && Number.isFinite(Number(row.seconds)) && Number.isFinite(Date.parse(row.ts)));
  const files = (list?.(dir) ?? []).filter((name) => name.startsWith(`goal-${programme}-${goal}-`) && name.endsWith('.jsonl'));
  return announcements.filter((item) => item.programme === programme && item.goal === goal && item.kind === 'build').map((item) => {
    const at = Date.parse(item.at);
    // Runner durations are rounded and timestamps have second precision.
    const matching = runs.filter((row) => Math.abs(Date.parse(row.ts) - Number(row.seconds) * 1000 - at) <= 2000);
    const matches = matching.filter((row) => row.session && row.session !== '-').flatMap((row) => files.filter((name) => toolStartIds(read(join(dir, name))).includes(row.session)).map((name) => ({ row, name })));
    const trace = matching.length === 1 && matches.length === 1 && announcements.filter((other) => other.programme === programme && other.goal === goal && other.kind === 'build' && Math.abs(Date.parse(matches[0].row.ts) - Number(matches[0].row.seconds) * 1000 - Date.parse(other.at)) <= 2000).length === 1 ? join(dir, matches[0].name) : null;
    return { at: item.at, trace, start: trace ? 'started' : 'unknown' };
  });
}
