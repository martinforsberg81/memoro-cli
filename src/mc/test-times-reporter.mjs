/**
 * A node test reporter: one JSON line when each top-level test starts, and one
 * when it ends, for `test-times.js`. The start line is what lets a run that never
 * ends say which of its files had not finished (`runProgress`); the end line
 * carries the time, and is left without one when node gave none.
 */
export default async function* timesReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:start' && event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { nesting, file, details } = event.data;
    if (nesting !== 0 || !file) continue;
    if (event.type === 'test:start') {
      yield `${JSON.stringify({ file, started: true })}\n`;
      continue;
    }
    yield `${JSON.stringify({ file, done: true, ms: details?.duration_ms })}\n`;
  }
}
