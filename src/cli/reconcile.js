/**
 * `mc reconcile [--apply --only-safe] [--json]` (§9e).
 *
 * Surfaces three buckets per coordinator: safe_to_end (squash-phantoms),
 * branch_merged_recently (gh PR list match, informational), and
 * verify_and_end (transcript-mention PRs that merged in last 7d). The
 * file-overlap heuristic from the original plan is deferred to v2.
 *
 * `--apply --only-safe` is the cron-safe surface — acts ONLY on the
 * squash-phantom bucket (deterministic via cherry + content-diff).
 * Calls `mc end` for each entry; aggregates exit codes.
 */
import { readRegistry } from '../mc/registry.js';
import { classifyEntries, defaultGh } from '../mc/reconcile.js';
import * as endCmd from './end.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(`mc: ${opts.error}`); return 2; }

  const reg = readRegistry();
  const entries = reg.entries.filter((e) => (e.kind || 'work') === 'work');
  const result = await classifyEntries(entries, { gh: defaultGh() });

  if (opts.json) {
    console.log(JSON.stringify({
      ...result,
      cron_safe_action: 'safe_to_end',
    }, null, 2));
  } else {
    printHuman(result);
  }

  if (opts.apply && opts.onlySafe) {
    const names = result.actions.safe_to_end.map((s) => s.entry.name);
    if (names.length === 0) {
      if (!opts.json) process.stdout.write(`\n--apply --only-safe: nothing to do.\n`);
      return 0;
    }
    if (!opts.json) process.stdout.write(`\n--apply --only-safe: running \`mc end\` on ${names.length} session${names.length === 1 ? '' : 's'}...\n`);
    // `--apply --only-safe` is already the explicit automation consent
    // boundary. Forward it as `--force` because `mc end` otherwise requires
    // one interactive confirmation for every mutation batch.
    return endCmd.run([...names, '--force', opts.json ? '--json' : null].filter(Boolean));
  }

  return 0;
}

function printHuman(result) {
  const { safe_to_end, branch_merged_recently, verify_and_end } = result.actions;

  process.stdout.write(`mc reconcile —\n\n`);

  process.stdout.write(`✓ Safe to end (squash-phantoms) — ${safe_to_end.length} session${safe_to_end.length === 1 ? '' : 's'}\n`);
  for (const item of safe_to_end) {
    process.stdout.write(`    ${item.entry.name}  ${item.entry.branch}  [confidence: ${item.confidence}]\n`);
  }
  if (safe_to_end.length === 0) process.stdout.write(`    (none)\n`);

  process.stdout.write(`\n· Branch merged recently — ${branch_merged_recently.length} session${branch_merged_recently.length === 1 ? '' : 's'}\n`);
  for (const item of branch_merged_recently) {
    const prs = item.prs.map((p) => `#${p.number}`).join(', ');
    process.stdout.write(`    ${item.entry.name}  ${item.entry.branch}  ${prs}\n`);
  }
  if (branch_merged_recently.length === 0) process.stdout.write(`    (none)\n`);

  process.stdout.write(`\n? Verify and end (transcript-mentions) — ${verify_and_end.length} session${verify_and_end.length === 1 ? '' : 's'}\n`);
  for (const item of verify_and_end) {
    const prs = item.prs.map((p) => `#${p.number}`).join(', ');
    process.stdout.write(`    ${item.entry.name}  ${item.entry.branch}  ${prs}\n`);
  }
  if (verify_and_end.length === 0) process.stdout.write(`    (none)\n`);

  if (result.deferred_categories?.length) {
    process.stdout.write(`\nDeferred to v2: ${result.deferred_categories.join(', ')}\n`);
  }
  if (result.skipped?.length) {
    process.stdout.write(`\nSkipped: ${result.skipped.length} entries with no signals (use \`mc list\` to inspect)\n`);
  }

  // Authority lives in the verbs: point users at `mc end` / `mc list`
  // rather than restating their logic here.
  process.stdout.write(`\nTo act:\n`);
  process.stdout.write(`  mc reconcile --apply --only-safe   # SIGTERM-style cron safe: phantoms only\n`);
  process.stdout.write(`  mc end <name>                      # close one session by hand\n`);
  process.stdout.write(`  mc list --safe-to-end --names      # pipe into \`mc end\` for bulk close\n`);
}

function parseArgs(argv) {
  const opts = { json: false, apply: false, onlySafe: false };
  for (const a of argv) {
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--apply') { opts.apply = true; continue; }
    if (a === '--only-safe') { opts.onlySafe = true; continue; }
    return { error: `unknown flag: ${a}` };
  }
  if (opts.apply && !opts.onlySafe) {
    return { error: '--apply requires --only-safe (v1 will not auto-end non-phantoms)' };
  }
  return opts;
}
