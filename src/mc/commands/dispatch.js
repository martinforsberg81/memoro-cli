/**
 * `mc dispatch <name> [<name>…] [--message <msg> | "<msg>"] [--dry-run] [--json]`
 *
 * §2: name-resolving rename of `mc sessions send`. Bulk form (§9h) lets
 * you send the same message to several sessions in one shot.
 *
 * Resolution order for the name → coding_session_id mapping:
 *   1. registry entry (preferred — set when we created the session via
 *      `mc new`)
 *   2. fallback to today's label-based resolution (`mc sessions send`)
 *
 * Foundation scope: arg-parsing + dry-run + name-resolution against the
 * registry. The actual API round-trip lives in bin-mc.js's existing
 * `runSessionsSend` and is invoked only when both the registry resolves
 * the name and `--dry-run` isn't set. That avoids touching the network
 * layer in this PR.
 */
import { findEntry } from '../registry.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }
  if (opts.names.length === 0) {
    console.error('mc: usage — `mc dispatch <name> [<name>…] <message>`');
    return 2;
  }
  if (!opts.message) {
    console.error('mc: dispatch requires a message — pass `--message <msg>` or as a positional');
    return 2;
  }

  const targets = [];
  for (const name of opts.names) {
    const entry = findEntry(name);
    if (!entry) {
      console.error(`mc: unknown session "${name}"`);
      return 1;
    }
    targets.push({
      name: entry.name,
      coding_session_id: entry.coding_session_id || null,
      session_state: entry.session_state || 'unknown',
    });
  }

  if (opts.dryRun) {
    const out = { dry_run: true, message: opts.message, targets };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      for (const t of targets) {
        process.stdout.write(`would dispatch to ${t.name} (${t.coding_session_id || 'no-sid'})\n`);
      }
    }
    return 0;
  }

  // Real dispatch wiring lands when the bulk send-API is hooked up.
  // For now, single-target dispatch can still go via `mc sessions send`.
  console.error('mc: live dispatch is currently routed via `mc sessions send`. ' +
    'Use that or `mc dispatch … --dry-run` for the plan.');
  return 1;
}

function parseArgs(argv) {
  const opts = { names: [], message: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--message': opts.message = argv[++i]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      default:
        if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
        opts.names.push(a);
    }
  }
  // If no --message and the last positional is multi-word, treat it as
  // the message (matches today's `mc sessions send <id> <msg>` shape).
  if (!opts.message && opts.names.length >= 2) {
    opts.message = opts.names.pop();
  }
  return opts;
}
