/**
 * `mc status <name>` (§9a).
 *
 * Reads the registry entry, recomputes `open_question` from
 * `last_assistant_text` (heuristic-only), and returns the entry with
 * the safety verdict and derived fields.
 */
import { findEntry } from '../registry.js';
import { detectOpenQuestion } from '../open-question.js';
import { readConfig } from '../../lib/config.js';
import { readRepoPolicy, resolveEffectivePolicy } from '../policy.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }
  if (!opts.name) {
    console.error('mc: usage — `mc status <name> [--json]`');
    return 2;
  }

  const entry = findEntry(opts.name);
  if (!entry) {
    console.error(`mc: no such session "${opts.name}"`);
    return 1;
  }

  const open_question = entry.open_question ?? detectOpenQuestion(entry.last_assistant_text || '');
  let config = {};
  try { config = await readConfig(); } catch { /* status remains best-effort */ }
  const repoPolicy = readRepoPolicy({ worktreePath: entry.worktree_path });
  const effective_policy = resolveEffectivePolicy({ entry, repoPolicy, config });

  const out = {
    name: entry.name,
    branch: entry.branch,
    kind: entry.kind || 'work',
    safety_verdict: entry.safety_verdict || 'SAFE_TO_END',
    session_state: entry.session_state || 'no-session-yet',
    dirty_files: entry.dirty_files || 0,
    ahead: entry.ahead || 0,
    behind: entry.behind || 0,
    last_activity: entry.last_activity || null,
    last_user_msg: entry.last_user_msg ?? null,
    last_assistant_text: entry.last_assistant_text ?? null,
    open_question,
    tool: entry.tool ?? null,
    model_chain: entry.model_chain ?? [],
    worktree_path: entry.worktree_path ?? null,
    relaunch_command: `mc resume ${entry.name}`,
    effective_policy,
  };

  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  // Human-readable
  process.stdout.write(`${out.name}  ${out.branch}\n`);
  process.stdout.write(`  tool          ${out.tool || 'claude'}\n`);
  process.stdout.write(`  relaunch      ${out.relaunch_command}\n`);
  process.stdout.write(`  policy        ${formatPolicyLine(out.effective_policy)}\n`);
  process.stdout.write(`  verdict       ${out.safety_verdict}\n`);
  process.stdout.write(`  session       ${out.session_state}\n`);
  process.stdout.write(`  dirty files   ${out.dirty_files}\n`);
  process.stdout.write(`  ahead         ${out.ahead}\n`);
  if (out.open_question) process.stdout.write(`  PAUSED — awaiting answer\n`);
  if (out.last_assistant_text) {
    process.stdout.write(`  asst: ${out.last_assistant_text.slice(0, 200).replace(/\n+/g, ' ')}\n`);
  }
  return 0;
}

function formatPolicyLine(policy) {
  const tool = policy?.permissions?.rendered_for || 'claude';
  const targets = policy?.secrets?.materialisation_targets || [];
  const unsupported = unsupportedPermissionFields(policy);
  const supportSuffix = unsupported.length ? `; permissions unsupported: ${unsupported.join(', ')}` : '';
  if (!targets.length) return `${tool}: native auth owned by tool; no vault target${supportSuffix}`;
  const labels = targets.map((t) => `${t.provider || t.tool}/${t.source || 'target'}`).join(', ');
  return `${tool}: vault targets ${labels}${supportSuffix}`;
}

function unsupportedPermissionFields(policy) {
  const permissions = policy?.adapter_support?.permissions;
  if (!permissions || typeof permissions !== 'object') return [];
  return Object.entries(permissions)
    .filter(([, support]) => support === 'unsupported')
    .map(([field]) => field);
}

function parseArgs(argv) {
  const opts = { name: null, json: false };
  for (const a of argv) {
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    if (opts.name) return { error: `unexpected arg: ${a}` };
    opts.name = a;
  }
  return opts;
}
