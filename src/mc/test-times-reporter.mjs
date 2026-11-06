/**
 * A node test reporter, for `test-times.js`. One JSON line when each top-level
 * test starts and one when it ends, which lets a run that never ends say which
 * of its files had not finished (`runProgress`); the end line carries the file's
 * time, and is left without one when node gave none. Every test that ends, at any
 * nesting, also gets a line of its own with its name, its line and its time
 * (`testsMeasured`): what `mc gate` reports for the tests a change touches. A
 * describe block (a suite) gets none; its tests do. A test that failed says so
 * (`failed`), and one that node cut at its time limit says the limit
 * (`timeout`, in ms): what `recordTooSlow` keeps. A skipped or todo test ran
 * nothing and gets no line. A file whose run ended gets `{ file, ended, ok }`
 * last, `ok` when node counted no failed or cancelled test in it: the only
 * proof a resumed gate takes that the whole file ran (`fileOutcomes`).
 */
export default async function* timesReporter(source) {
  for await (const event of source) {
    // Node reports a file's summary once its process has ended (`test:summary`
    // with the file); a file cut before then never gets one. Its top-level tests
    // are not enough: node reports a test's start only when it reports the test,
    // so a file killed between two tests looks as if every test it began ended.
    if (event.type === 'test:summary' && event.data?.file) {
      const counts = event.data.counts || {};
      yield `${JSON.stringify({ file: event.data.file, ended: true, ok: event.data.success === true && !(counts.failed > 0) && !(counts.cancelled > 0) })}\n`;
      continue;
    }
    if (event.type !== 'test:start' && event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { nesting, file, details, name, line, skip, todo } = event.data;
    if (!file) continue;
    if (event.type === 'test:start') {
      if (nesting === 0) yield `${JSON.stringify({ file, started: true })}\n`;
      continue;
    }
    // A describe block is a suite, not a test: its time is its tests' time again.
    if (details?.type !== 'suite' && !skip && !todo) {
      const test = { name, line, ms: details?.duration_ms };
      if (event.type === 'test:fail') {
        test.failed = true;
        const limit = timeLimitOf(details?.error);
        if (limit) test.timeout = limit;
      }
      yield `${JSON.stringify({ file, test })}\n`;
    }
    if (nesting === 0) yield `${JSON.stringify({ file, done: true, ms: details?.duration_ms })}\n`;
  }
}

/** The limit a test was cut at, from node's own error (`test timed out after 1000ms`), or null for any other failure. */
function timeLimitOf(error) {
  if (!error || error.failureType !== 'testTimeoutFailure') return null;
  const match = /timed out after\s+(\d+)\s*ms/u.exec(String(error.message || ''));
  return match ? Number(match[1]) : null;
}
