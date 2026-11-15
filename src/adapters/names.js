/**
 * The registry's name tables, apart from the adapter modules.
 *
 * `index.js` is the registry; it imports these tables and every adapter.
 * This module imports nothing, so a caller that needs only the tools' names
 * on every mc call (the `--<tool>` flag sugar in `src/mc/commands/flags.js`)
 * reads them without loading the adapters. `index.js` refuses to load when
 * the tables and the adapters it imports disagree, so there is still one
 * list of tools.
 */

/** Known tools with no adapter yet, by adapter id. */
export const PLANNED = {
  'cursor':     { label: 'Cursor',     note: 'Stubbed — writes to .cursorrules; adapter coming in PR 4.1' },
  'windsurf':   { label: 'Windsurf',   note: 'Stubbed — writes to .windsurfrules; adapter coming in PR 4.1' },
};

/** Short name → adapter id, in registry order. See `resolveToolInput` in `index.js`. */
export const SHORT_NAME_TO_ID = {
  'claude':     'claude-code',
  'codex':      'codex',
  'agy':        'antigravity-cli',
};

/** Short names of the implemented tools (named and not planned), in registry order. */
export function implementedShortNames() {
  return Object.entries(SHORT_NAME_TO_ID).filter(([, id]) => !PLANNED[id]).map(([shortName]) => shortName);
}
