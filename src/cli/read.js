/**
 * `mc read <name> [--last N] [--json]` — name-resolving rename of
 * `mc sessions read`.
 *
 * Foundation scope: arg-parsing + registry-name resolution. The actual
 * transcript fetch reuses `mc sessions read` plumbing in a follow-up.
 */
import { formatEntryResolutionError, resolveEntry } from '../mc/registry.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }
  if (!opts.name) {
    console.error('mc: usage — `mc read <name> [--last N]`');
    return 2;
  }

  const resolved = resolveEntry(opts.name);
  if (!resolved.ok) {
    console.error(`mc: ${formatEntryResolutionError(opts.name, resolved)}`);
    return 1;
  }
  const entry = resolved.entry;

  // Live fetch wiring lands when the sessions-read pipe is plumbed
  // through here. For now, signal what we'd do.
  const out = {
    ok: false,
    name: entry.name,
    session_id: entry.session_id || null,
    repository_id: entry.repository_id || null,
    coding_session_id: entry.coding_session_id || null,
    last: opts.last,
    note: 'live read not yet wired through `mc read` — use `mc sessions read <id>` for now',
  };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else console.error(`mc: ${out.note}`);
  return 1;
}

function parseArgs(argv) {
  const opts = { name: null, last: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') {
      const v = argv[++i];
      if (!/^\d+$/.test(String(v))) {
        return { error: `--last expects an integer, got "${v}"` };
      }
      opts.last = Number(v);
      continue;
    }
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    if (opts.name) return { error: `unexpected arg: ${a}` };
    opts.name = a;
  }
  return opts;
}
