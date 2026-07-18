/**
 * `mc storage` exposes local memory/disk hygiene without mutating state.
 */
import {
  buildStorageSnapshot,
  explainSessionStorage,
} from '../storage-management.js';
import {
  applyStorageRepairPlan,
  buildStorageRepairPlan,
} from '../storage-repair.js';
import { parseDurationMs } from '../storage-policy.js';
import { readRegistry, writeRegistry } from '../registry.js';

const DEFAULT_MISSING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  if (opts.verb === 'explain') {
    const detail = await explainSessionStorage(opts.name);
    if (!detail) {
      if (opts.json) console.log(JSON.stringify({ ok: false, error: `session not found: ${opts.name}` }, null, 2));
      else console.error(`mc: session not found: ${opts.name}`);
      return 1;
    }
    if (opts.json) console.log(JSON.stringify({ ok: true, ...detail }, null, 2));
    else printExplain(detail);
    return 0;
  }

  if (opts.verb === 'repair') {
    const registry = readRegistry();
    const plan = await buildStorageRepairPlan({
      registry,
      includeProviderBackfill: opts.providerBackfill,
      names: opts.name ? [opts.name] : null,
    });
    if (opts.dryRun) {
      const out = { dry_run: true, ...plan };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else printRepair(out);
      return 0;
    }
    const result = applyStorageRepairPlan(registry, plan);
    const out = { dry_run: false, ...result };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else printRepair(out);
    return result.ok ? 0 : 1;
  }

  if (opts.verb === 'prune-missing') {
    const registry = readRegistry();
    const plan = buildMissingPrunePlan(registry, {
      olderThanMs: opts.olderThanMs,
    });
    if (opts.dryRun) {
      const out = { dry_run: true, ...plan };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else printPruneMissing(out);
      return 0;
    }
    const result = applyMissingPrunePlan(registry, plan);
    const out = { dry_run: false, ...result };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else printPruneMissing(out);
    return result.ok ? 0 : 1;
  }

  const snapshot = await buildStorageSnapshot({ minAgeMs: opts.minAgeMs });
  if (opts.verb === 'candidates') {
    const out = {
      runtime: snapshot.runtime,
      stale_worktrees: snapshot.stale_worktrees,
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else printCandidates(out);
    return 0;
  }

  if (opts.json) console.log(JSON.stringify(snapshot, null, 2));
  else printStatus(snapshot);
  return 0;
}

function parseArgs(argv) {
  const opts = {
    verb: 'status',
    name: null,
    json: false,
    minAgeMs: undefined,
    dryRun: false,
    apply: false,
    providerBackfill: false,
    olderThanMs: DEFAULT_MISSING_RETENTION_MS,
    olderThanSet: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    opts.verb = args.shift();
  }
  if (!['status', 'candidates', 'explain', 'repair', 'prune-missing'].includes(opts.verb)) {
    return { error: 'usage: mc storage [status|candidates|explain <name>|repair [name]|prune-missing] [--json]' };
  }
  if (opts.verb === 'explain') {
    const name = args.shift();
    if (!name || name.startsWith('-')) return { error: 'usage: mc storage explain <name> [--json]' };
    opts.name = name;
  }
  if (opts.verb === 'repair' && args[0] && !args[0].startsWith('-')) {
    opts.name = args.shift();
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--apply') { opts.apply = true; continue; }
    if (a === '--provider-backfill') { opts.providerBackfill = true; continue; }
    if (a === '--older-than') {
      const ms = parseDurationMs(args[++i]);
      if (ms == null) return { error: `--older-than expects a duration like 7d / 1h / 0s, got "${args[i]}"` };
      opts.olderThanMs = ms;
      opts.olderThanSet = true;
      continue;
    }
    if (a === '--min-age') {
      const ms = parseDurationMs(args[++i]);
      if (ms == null) return { error: `--min-age expects a duration like 5m / 30s / 1h, got "${args[i]}"` };
      opts.minAgeMs = ms;
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  if (opts.dryRun && opts.apply) return { error: '--dry-run and --apply cannot be combined' };
  if (['repair', 'prune-missing'].includes(opts.verb) && !opts.dryRun && !opts.apply) {
    return { error: `mc storage ${opts.verb} requires --dry-run or --apply` };
  }
  if (!['repair', 'prune-missing'].includes(opts.verb) && (opts.dryRun || opts.apply)) {
    return { error: '--dry-run and --apply are only valid with mc storage repair or prune-missing' };
  }
  if (opts.verb !== 'repair' && opts.providerBackfill) {
    return { error: '--provider-backfill is only valid with mc storage repair' };
  }
  if (opts.verb !== 'prune-missing' && opts.olderThanSet) {
    return { error: '--older-than is only valid with mc storage prune-missing' };
  }
  return opts;
}

function buildMissingPrunePlan(registry, {
  olderThanMs = DEFAULT_MISSING_RETENTION_MS,
  now = Date.now(),
} = {}) {
  const nowMs = resolveNowMs(now);
  const candidates = [];
  for (const entry of registry?.entries || []) {
    if (entry?.worktree_missing !== true) continue;
    const markedAtMs = missingMarkedAtMs(entry);
    const ageMs = Number.isFinite(markedAtMs) ? Math.max(0, nowMs - markedAtMs) : Infinity;
    if (ageMs < olderThanMs) continue;
    candidates.push({
      name: entry.name,
      branch: entry.branch || null,
      worktree_path: entry.worktree_path || null,
      marked_at: Number.isFinite(markedAtMs) ? new Date(markedAtMs).toISOString() : null,
      age_ms: Number.isFinite(ageMs) ? ageMs : null,
    });
  }
  return {
    ok: true,
    generated_at: new Date(nowMs).toISOString(),
    older_than_ms: olderThanMs,
    candidates,
    counts: { total: candidates.length },
  };
}

function applyMissingPrunePlan(registry, plan, {
  write = writeRegistry,
} = {}) {
  const names = new Set((plan?.candidates || []).map((candidate) => candidate.name));
  const next = {
    ...(registry || {}),
    entries: (registry?.entries || []).filter((entry) => !names.has(entry.name)),
  };
  write(next);
  return {
    ok: true,
    removed: plan?.candidates || [],
    counts: { total: names.size },
  };
}

function missingMarkedAtMs(entry) {
  for (const value of [
    entry?.last_storage_repair_at,
    entry?.last_opened_at,
    entry?.last_activity,
    entry?.created_at,
  ]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveNowMs(now) {
  if (typeof now === 'function') return Number(now());
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

function printStatus(snapshot) {
  const s = snapshot.summary;
  process.stdout.write(`mc storage\n`);
  process.stdout.write(`  home                 ${snapshot.mc_home}\n`);
  process.stdout.write(`  total                ${formatBytes(snapshot.disk?.total)}\n`);
  process.stdout.write(`  worktrees            ${formatBytes(snapshot.disk?.worktrees)}\n`);
  process.stdout.write(`  registry entries     ${s.registry_entries}\n`);
  process.stdout.write(`  stale runtime        ${s.runtime.orphan_daemons + s.runtime.stale_pidfiles + s.runtime.sidecar_candidates}\n`);
  process.stdout.write(`  stale worktrees      ${s.worktrees.stale_candidates}\n`);
  process.stdout.write(`  dirty/ahead          ${s.worktrees.dirty}/${s.worktrees.ahead}\n`);
  process.stdout.write(`  provider backfills   ${s.provider.missing_native_id}\n`);
  if (snapshot.issues.length) {
    process.stdout.write(`\nIssues\n`);
    for (const issue of snapshot.issues) {
      process.stdout.write(`  ${issue.severity}  ${issue.code}`);
      if (issue.count != null) process.stdout.write(`  count=${issue.count}`);
      process.stdout.write(`\n`);
    }
  }
}

function printCandidates(out) {
  const runtimeCount = out.runtime.counts.orphan_daemons
    + out.runtime.counts.stale_pidfiles
    + out.runtime.counts.sidecar_candidates;
  process.stdout.write(`runtime candidates  ${runtimeCount}\n`);
  process.stdout.write(`stale worktrees     ${out.stale_worktrees.length}\n`);
  for (const item of out.stale_worktrees) {
    process.stdout.write(`  ${item.name}  ${item.branch}  ${formatBytes(item.reclaimable_bytes)}\n`);
  }
}

function printRepair(out) {
  const actions = out.actions || out.applied || [];
  if (!actions.length) {
    process.stdout.write('(no storage repairs)\n');
    return;
  }
  for (const action of actions) {
    const status = out.dry_run ? 'would' : 'applied';
    process.stdout.write(`${status} ${action.type}  ${action.name}  ${action.reason}\n`);
  }
}

function printPruneMissing(out) {
  const candidates = out.candidates || out.removed || [];
  if (!candidates.length) {
    process.stdout.write('(no missing registry entries to prune)\n');
    return;
  }
  const status = out.dry_run ? 'would prune' : 'pruned';
  for (const item of candidates) {
    process.stdout.write(`${status}  ${item.name}  ${item.branch || '-'}\n`);
  }
}

function printExplain(detail) {
  process.stdout.write(`mc storage explain ${detail.entry.name}\n`);
  process.stdout.write(`  state        ${detail.entry.session_state}\n`);
  process.stdout.write(`  tool         ${detail.entry.tool || '-'}\n`);
  process.stdout.write(`  provider     ${detail.provider.resumable ? 'resumable' : 'missing-native-id'}\n`);
  process.stdout.write(`  live         ${detail.live ? 'yes' : 'no'}\n`);
  process.stdout.write(`  worktree     ${detail.git.exists ? detail.git.worktree_path : 'missing'}\n`);
  process.stdout.write(`  dirty/ahead  ${detail.git.dirty_files ?? '-'}/${detail.git.ahead ?? '-'}\n`);
  process.stdout.write(`  cleanup      ${detail.cleanup_candidate ? detail.cleanup_reason : 'not-a-candidate'}\n`);
}

function formatBytes(value) {
  if (value == null) return 'unknown';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}
