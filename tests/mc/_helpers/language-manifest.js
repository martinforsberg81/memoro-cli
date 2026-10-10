/** A cutover manifest of the shape memoro writes, trimmed to two acts. */
export function manifest(overrides = {}) {
  return {
    schema: 'memoro-language-cutover',
    version: 1,
    name: 'sv-forms-cutover',
    lang: 'sv',
    title: 'Swedish forms cutover',
    closes: ['language_form', 'language_chunk'],
    acts: [
      {
        id: 'ingest-saldo',
        title: 'Ingest SALDO into the local D1',
        target: 'local',
        check: ['node', 'scripts/language-library/ingest.js', '--lang=sv', '--verify', '--json'],
        execute: ['node', 'scripts/language-library/ingest.js', '--lang=sv', '--all', '--json'],
        credentials: [],
        requires_runnable: [],
        expect: {
          check: [{ path: 'verify.counts.forms', exact: 897392 }],
          execute: [{ path: 'verify.counts.forms', exact: 897392 }],
        },
        if_not: 'Stop.',
      },
      {
        id: 'selectors-clear',
        title: 'No unresolved selectors',
        target: 'production',
        check: ['node', 'scripts/language-library/grammar-selector-readiness-report.mjs', '--json'],
        execute: null,
        credentials: [],
        requires_runnable: [],
        expect: { check: [{ path: 'languages.sv.selectors.unresolved', advisory: 'none left' }], execute: [] },
        if_not: 'Look.',
        opens_gap: { until: 'ingest-saldo', says: 'a gap' },
      },
    ],
    ran: { on: '2026-10-09', note: 'ran once' },
    ...overrides,
  };
}
