/** A node test reporter: one JSON line per top-level test, for `test-times.js`. */
export default async function* timesReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { nesting, file, details } = event.data;
    if (nesting === 0 && file && details?.duration_ms != null) {
      yield `${JSON.stringify({ file, ms: details.duration_ms })}\n`;
    }
  }
}
