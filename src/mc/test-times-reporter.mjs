/**
 * A node test reporter, for `test-times.js`. One JSON line when each top-level
 * test starts and one when it ends, which lets a run that never ends say which
 * of its files had not finished (`runProgress`); the end line carries the file's
 * time, and is left without one when node gave none. Every test that ends, at any
 * nesting, also gets a line of its own with its name, its line and its time
 * (`testsMeasured`): what `mc gate` reports for the tests a change touches. A
 * describe block (a suite) gets none; its tests do.
 */
export default async function* timesReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:start' && event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { nesting, file, details, name, line } = event.data;
    if (!file) continue;
    if (event.type === 'test:start') {
      if (nesting === 0) yield `${JSON.stringify({ file, started: true })}\n`;
      continue;
    }
    // A describe block is a suite, not a test: its time is its tests' time again.
    if (details?.type !== 'suite') yield `${JSON.stringify({ file, test: { name, line, ms: details?.duration_ms } })}\n`;
    if (nesting === 0) yield `${JSON.stringify({ file, done: true, ms: details?.duration_ms })}\n`;
  }
}
