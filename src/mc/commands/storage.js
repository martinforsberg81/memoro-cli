/**
 * `mc storage` exposes local memory/disk hygiene without mutating state.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ACCOUNTS } from '../../commands/auth.js';
import { getApiUrl, readConfig } from '../../lib/config.js';
import { getSecret } from '../../lib/keychain.js';
import {
  buildStorageSnapshot,
  explainSessionStorage,
} from '../storage-management.js';
import {
  applyStorageRepairPlan,
  buildStorageRepairPlan,
} from '../storage-repair.js';
import { parseDurationMs } from '../storage-policy.js';
import {
  formatEntryResolutionError,
  readRegistry,
  readRegistryStrict,
  resolveEntry,
  writeRegistry,
} from '../registry.js';
import {
  applyManagedCodexRecovery,
  inspectManagedCodexRecovery,
  publicManagedCodexRecovery,
} from '../managed-codex-recovery.js';
import {
  applyTranscriptPrunePlan,
  buildTranscriptPrunePlan,
} from '../transcript-prune.js';

const DEFAULT_MISSING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DEPS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GENERATED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEPENDENCY_DIRS = ['node_modules'];
const GENERATED_DIRS = ['.cache', '.next', '.turbo', '.vite', 'coverage', 'playwright-report', 'test-results'];

export async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  if (opts.verb === 'explain') {
    const registry = readRegistry();
    const resolved = resolveEntry(opts.name, { registry, cwd: process.cwd() });
    if (!resolved.ok) {
      const message = formatEntryResolutionError(opts.name, resolved);
      if (opts.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
      else console.error(`mc: ${message}`);
      return 1;
    }
    const detail = await explainSessionStorage(resolved.entry.session_id, { registry });
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
    const loadRegistry = opts.dryRun
      ? (deps.readRegistry || deps.readRegistryStrict || readRegistry)
      : (deps.readRegistryStrict || deps.readRegistry || readRegistryStrict);
    const registry = loadRegistry({ persistMigration: !opts.dryRun });
    const selected = opts.name
      ? resolveEntry(opts.name, { registry, cwd: process.cwd() })
      : null;
    if (selected && !selected.ok) {
      const out = {
        ok: false,
        reason: selected.reason,
        message: formatEntryResolutionError(opts.name, selected),
      };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else console.error(`mc: ${out.message}`);
      return 1;
    }
    if (opts.managedProviderRecovery) {
      const entry = selected?.entry || null;
      if (!entry) {
        const out = {
          ok: false,
          recoverable: false,
          reason: 'managed-recovery-entry-missing',
        };
        if (opts.json) console.log(JSON.stringify(out, null, 2));
        else printManagedRecovery(out, opts.dryRun);
        return 1;
      }
      const inspected = await (deps.inspectManagedCodexRecovery
        || inspectManagedCodexRecovery)({
        entry,
        registry,
        deps: deps.managedRecoveryDeps || {},
      });
      if (!inspected.ok || opts.dryRun) {
        const out = {
          dry_run: opts.dryRun,
          ...publicManagedCodexRecovery(inspected),
        };
        if (opts.json) console.log(JSON.stringify(out, null, 2));
        else printManagedRecovery(out, opts.dryRun);
        return inspected.ok ? 0 : 1;
      }
      const portal = await (deps.resolveManagedRecoveryPortal
        || resolveManagedRecoveryPortal)();
      if (!portal?.ok) {
        const out = {
          ok: false,
          recoverable: false,
          reason: portal?.reason || 'managed-recovery-memoro-auth-missing',
        };
        if (opts.json) console.log(JSON.stringify(out, null, 2));
        else printManagedRecovery(out, false);
        return 1;
      }
      const applied = await (deps.applyManagedCodexRecovery
        || applyManagedCodexRecovery)({
        inspection: inspected,
        portal: portal.portal,
        deps: deps.managedRecoveryDeps || {},
      });
      const out = {
        dry_run: false,
        ...publicManagedCodexRecovery(applied),
      };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else printManagedRecovery(out, false);
      return applied.ok ? 0 : 1;
    }
    const plan = await buildStorageRepairPlan({
      registry,
      includeProviderBackfill: opts.providerBackfill,
      names: selected?.entry?.session_id ? [selected.entry.session_id] : null,
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
    const registry = readRegistry({ persistMigration: !opts.dryRun });
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

  if (opts.verb === 'prune-transcripts') {
    const plan = buildTranscriptPrunePlan({
      registry: readRegistry({ persistMigration: !opts.dryRun }),
      olderThanMs: opts.olderThanMs,
    });
    if (opts.dryRun) {
      const out = { dry_run: true, ...plan };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else printPruneTranscripts(out, null);
      return 0;
    }
    const result = applyTranscriptPrunePlan(plan);
    const out = { dry_run: false, ...plan, result };
    if (opts.json) console.log(JSON.stringify({ dry_run: false, ...result }, null, 2));
    else printPruneTranscripts(out, result);
    return result.ok ? 0 : 1;
  }

  if (opts.verb === 'prune-deps') {
    const snapshot = await buildStorageSnapshot({
      registry: readRegistry({ persistMigration: !opts.dryRun }),
      minAgeMs: opts.minAgeMs,
      includeDisk: false,
    });
    const plan = buildDependencyPrunePlan(snapshot, {
      olderThanMs: opts.olderThanMs,
    });
    if (opts.dryRun) {
      const out = { dry_run: true, ...plan };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else printPruneDeps(out);
      return 0;
    }
    const result = applyDependencyPrunePlan(plan);
    const out = { dry_run: false, ...result };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else printPruneDeps(out);
    return result.ok ? 0 : 1;
  }

  if (opts.verb === 'prune-generated') {
    const snapshot = await buildStorageSnapshot({
      registry: readRegistry({ persistMigration: !opts.dryRun }),
      minAgeMs: opts.minAgeMs,
      includeDisk: false,
    });
    const plan = buildGeneratedPrunePlan(snapshot, {
      olderThanMs: opts.olderThanMs,
    });
    if (opts.dryRun) {
      const out = { dry_run: true, ...plan };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else printPruneGenerated(out);
      return 0;
    }
    const result = applyDirectoryPrunePlan(plan);
    const out = { dry_run: false, ...result };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else printPruneGenerated(out);
    return result.ok ? 0 : 1;
  }

  const snapshot = await buildStorageSnapshot({ minAgeMs: opts.minAgeMs });
  if (opts.verb === 'candidates') {
    const out = {
      runtime: snapshot.runtime,
      dependency_snapshots: snapshot.dependency_snapshots,
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
    managedProviderRecovery: false,
    olderThanMs: DEFAULT_MISSING_RETENTION_MS,
    olderThanSet: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    opts.verb = args.shift();
  }
  if (!['status', 'candidates', 'explain', 'repair', 'prune-missing', 'prune-deps', 'prune-generated', 'prune-transcripts'].includes(opts.verb)) {
    return { error: 'usage: mc storage [status|candidates|explain <name>|repair [name]|prune-missing|prune-deps|prune-generated|prune-transcripts] [--json]' };
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
    if (a === '--managed-provider-recovery') { opts.managedProviderRecovery = true; continue; }
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
  if (['repair', 'prune-missing', 'prune-deps', 'prune-generated', 'prune-transcripts'].includes(opts.verb) && !opts.dryRun && !opts.apply) {
    return { error: `mc storage ${opts.verb} requires --dry-run or --apply` };
  }
  if (!['repair', 'prune-missing', 'prune-deps', 'prune-generated', 'prune-transcripts'].includes(opts.verb) && (opts.dryRun || opts.apply)) {
    return { error: '--dry-run and --apply are only valid with mc storage repair, prune-missing, prune-deps, prune-generated, or prune-transcripts' };
  }
  if (opts.verb !== 'repair' && opts.providerBackfill) {
    return { error: '--provider-backfill is only valid with mc storage repair' };
  }
  if (opts.verb !== 'repair' && opts.managedProviderRecovery) {
    return { error: '--managed-provider-recovery is only valid with mc storage repair' };
  }
  if (opts.managedProviderRecovery && !opts.name) {
    return { error: '--managed-provider-recovery requires one exact repair session name' };
  }
  if (opts.managedProviderRecovery && opts.providerBackfill) {
    return { error: '--managed-provider-recovery cannot be combined with --provider-backfill' };
  }
  if (!['prune-missing', 'prune-deps', 'prune-generated', 'prune-transcripts'].includes(opts.verb) && opts.olderThanSet) {
    return { error: '--older-than is only valid with mc storage prune-missing, prune-deps, or prune-generated' };
  }
  if (opts.verb === 'prune-deps' && !opts.olderThanSet) opts.olderThanMs = DEFAULT_DEPS_RETENTION_MS;
  if (opts.verb === 'prune-generated' && !opts.olderThanSet) opts.olderThanMs = DEFAULT_GENERATED_RETENTION_MS;
  return opts;
}

async function resolveManagedRecoveryPortal() {
  const config = await readConfig();
  const apiUrl = getApiUrl([]) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  return apiUrl && token
    ? { ok: true, portal: { apiUrl, token } }
    : { ok: false, reason: 'managed-recovery-memoro-auth-missing' };
}

function buildMissingPrunePlan(registry, {
  olderThanMs = DEFAULT_MISSING_RETENTION_MS,
  now = Date.now(),
} = {}) {
  const nowMs = resolveNowMs(now);
  const candidates = [];
  for (const entry of registry?.entries || []) {
    if (entry?.worktree_missing !== true) continue;
    const anchorMs = entryRetentionAnchorMs(entry);
    const ageMs = Number.isFinite(anchorMs) ? Math.max(0, nowMs - anchorMs) : Infinity;
    if (ageMs < olderThanMs) continue;
    candidates.push({
      session_id: entry.session_id || null,
      repository_id: entry.repository_id || null,
      name: entry.name,
      branch: entry.branch || null,
      worktree_path: entry.worktree_path || null,
      retention_anchor_at: Number.isFinite(anchorMs) ? new Date(anchorMs).toISOString() : null,
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
  // Match modern candidates by opaque identities and legacy candidates by
  // their complete historic tuple, then
  // re-check the tombstone predicate. Filtering by name alone once removed
  // 81 entries from an 8-candidate dry-run: historic same-named entries —
  // including ones whose worktrees existed — shared names with tombstones.
  // Apply must remove precisely what dry-run showed.
  const keys = new Set((plan?.candidates || []).map(missingPruneKey));
  const removed = [];
  const entries = (registry?.entries || []).filter((entry) => {
    const match = entry?.worktree_missing === true && keys.has(missingPruneKey(entry));
    if (match) {
      removed.push({
        session_id: entry.session_id || null,
        repository_id: entry.repository_id || null,
        name: entry.name,
        branch: entry.branch || null,
        worktree_path: entry.worktree_path || null,
      });
    }
    return !match;
  });
  write({ ...(registry || {}), entries });
  return {
    ok: true,
    removed,
    counts: { total: removed.length },
  };
}

function missingPruneKey(value) {
  if (value?.session_id && value?.repository_id) {
    return `id:${value.repository_id}:${value.session_id}`;
  }
  return [value?.name || '', value?.branch || '', value?.worktree_path || ''].join('\n');
}

function buildDependencyPrunePlan(snapshot, {
  olderThanMs = DEFAULT_DEPS_RETENTION_MS,
  now = Date.now(),
} = {}) {
  return buildDirectoryPrunePlan(snapshot, {
    olderThanMs,
    now,
    dirs: DEPENDENCY_DIRS,
    requireIgnored: false,
  });
}

function buildGeneratedPrunePlan(snapshot, {
  olderThanMs = DEFAULT_GENERATED_RETENTION_MS,
  now = Date.now(),
} = {}) {
  return buildDirectoryPrunePlan(snapshot, {
    olderThanMs,
    now,
    dirs: GENERATED_DIRS,
    requireIgnored: true,
  });
}

function buildDirectoryPrunePlan(snapshot, {
  olderThanMs,
  now,
  dirs,
  requireIgnored,
} = {}) {
  const nowMs = resolveNowMs(now);
  const candidates = [];
  for (const item of snapshot?.worktrees || []) {
    const entry = item?.entry || {};
    const worktreePath = nonEmpty(item?.git?.worktree_path || entry.worktree_path);
    if (!worktreePath || !item?.git?.exists) continue;
    if (entry?.worktree_missing === true) continue;
    if (isProtectedDependencyEntry(entry, item)) continue;

    const anchorMs = entryRetentionAnchorMs(entry);
    const ageMs = Number.isFinite(anchorMs) ? Math.max(0, nowMs - anchorMs) : Infinity;
    if (ageMs < olderThanMs) continue;

    for (const dirName of dirs || []) {
      const path = join(worktreePath, dirName);
      if (!isDependencyPruneTarget(path)) continue;
      if (requireIgnored && !isGitIgnored(worktreePath, dirName)) continue;
      const bytes = duBytes(path);
      candidates.push({
        name: entry.name || null,
        branch: entry.branch || item?.git?.current_branch || null,
        worktree_path: worktreePath,
        path,
        kind: dirName,
        git_ignored: requireIgnored ? true : null,
        retention_anchor_at: Number.isFinite(anchorMs) ? new Date(anchorMs).toISOString() : null,
        age_ms: Number.isFinite(ageMs) ? ageMs : null,
        disk_bytes: bytes,
        reclaimable_bytes: bytes,
      });
    }
  }
  candidates.sort(compareDependencyCandidates);
  return {
    ok: true,
    generated_at: new Date(nowMs).toISOString(),
    older_than_ms: olderThanMs,
    candidates,
    counts: {
      total: candidates.length,
      reclaimable_bytes: sumBytes(candidates),
    },
  };
}

function applyDependencyPrunePlan(plan, {
  rm = rmSync,
} = {}) {
  return applyDirectoryPrunePlan(plan, { rm });
}

function applyDirectoryPrunePlan(plan, {
  rm = rmSync,
} = {}) {
  const removed = [];
  const failed = [];
  for (const candidate of plan?.candidates || []) {
    try {
      rm(candidate.path, { recursive: true, force: true });
      removed.push(candidate);
    } catch (err) {
      failed.push({
        ...candidate,
        error: err.message || String(err),
      });
    }
  }
  return {
    ok: failed.length === 0,
    removed,
    failed,
    counts: {
      total: removed.length,
      failed: failed.length,
      reclaimable_bytes: sumBytes(removed),
    },
  };
}

function isProtectedDependencyEntry(entry, item) {
  if (item?.live) return true;
  const state = typeof entry?.session_state === 'string' ? entry.session_state.trim().toLowerCase() : '';
  return state === 'live' || state === 'active';
}

function entryRetentionAnchorMs(entry) {
  let latest = null;
  for (const value of [
    entry?.last_opened_at,
    entry?.last_observed_at,
    entry?.last_activity,
    entry?.last_exit_at,
    entry?.last_started_at,
    entry?.created_at,
  ]) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (latest == null || parsed > latest) latest = parsed;
  }
  return latest;
}

function isDependencyPruneTarget(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isGitIgnored(worktreePath, relativePath) {
  const r = spawnSync('git', ['-C', worktreePath, 'check-ignore', '-q', '--', relativePath], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

function duBytes(path) {
  if (!path || !existsSync(path)) return 0;
  const r = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const n = Number((r.stdout || '').trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n * 1024 : null;
}

function compareDependencyCandidates(a, b) {
  const reclaimA = Number.isFinite(Number(a?.reclaimable_bytes)) ? Number(a.reclaimable_bytes) : 0;
  const reclaimB = Number.isFinite(Number(b?.reclaimable_bytes)) ? Number(b.reclaimable_bytes) : 0;
  if (reclaimA !== reclaimB) return reclaimB - reclaimA;
  return String(a?.name || '').localeCompare(String(b?.name || ''));
}

function sumBytes(items) {
  return (items || []).reduce((sum, item) => {
    const n = Number(item?.reclaimable_bytes);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
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
  process.stdout.write(`  dependency snapshots ${formatBytes(snapshot.disk?.dependency_snapshots)} (${s.dependency_snapshots.total}, ${s.dependency_snapshots.candidates} stale)\n`);
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
  process.stdout.write(`stale dep snapshots ${out.dependency_snapshots.counts.candidates}\n`);
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

function printManagedRecovery(out, dryRun) {
  if (!out?.ok) {
    process.stderr.write(`mc: managed provider recovery unavailable (${out?.reason || 'unknown'})\n`);
    return;
  }
  if (dryRun) {
    process.stdout.write(`would recover managed provider session  ${out.name}  ${out.provider_session_id}\n`);
    for (const action of out.actions || []) process.stdout.write(`  ${action}\n`);
    return;
  }
  process.stdout.write(`recovered managed provider session  ${out.name}  ${out.provider_session_id}\n`);
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

function printPruneTranscripts(out, result) {
  const plan = out;
  const candidates = plan.candidates || [];
  const kept = plan.counts?.kept || {};
  if (!candidates.length) {
    process.stdout.write(`(no orphaned provider transcripts to prune — ${kept.protected ?? 0} protected, ${kept.recent ?? 0} recent)\n`);
    return;
  }
  const bySource = { codex: { n: 0, bytes: 0 }, claude: { n: 0, bytes: 0 } };
  for (const item of candidates) {
    const bucket = bySource[item.source] || (bySource[item.source] = { n: 0, bytes: 0 });
    bucket.n += 1;
    bucket.bytes += item.bytes;
  }
  const status = result ? 'pruned' : 'would prune';
  // A prune must be reviewable before it is applied: name every file, not
  // just a count. Sorted largest-first by the plan builder.
  for (const item of candidates) {
    const ageDays = Math.floor((item.age_ms || 0) / 86_400_000);
    process.stdout.write(`${status}  ${formatMb(item.bytes).padStart(8)}  ${String(ageDays).padStart(3)}d  ${item.source.padEnd(6)}  ${item.path}\n`);
  }
  for (const [source, stats] of Object.entries(bySource)) {
    if (!stats.n) continue;
    process.stdout.write(`total  ${source}: ${stats.n} transcript${stats.n === 1 ? '' : 's'}  (${formatMb(stats.bytes)})\n`);
  }
  process.stdout.write(`kept: ${kept.protected ?? 0} protected (resumable or live), ${kept.recent ?? 0} recent\n`);
  if (result?.errors?.length) {
    for (const err of result.errors) process.stdout.write(`failed  ${err.path}  ${err.error}\n`);
  }
}

function formatMb(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function printPruneDeps(out) {
  const candidates = out.candidates || out.removed || [];
  if (!candidates.length) {
    process.stdout.write('(no dependency directories to prune)\n');
    return;
  }
  const status = out.dry_run ? 'would prune' : 'pruned';
  for (const item of candidates) {
    process.stdout.write(`${status}  ${item.name || '-'}  ${item.kind}  ${formatBytes(item.reclaimable_bytes)}\n`);
  }
  if (out.failed?.length) {
    for (const item of out.failed) {
      process.stdout.write(`failed  ${item.name || '-'}  ${item.kind}  ${item.error}\n`);
    }
  }
}

function printPruneGenerated(out) {
  const candidates = out.candidates || out.removed || [];
  if (!candidates.length) {
    process.stdout.write('(no generated directories to prune)\n');
    return;
  }
  const status = out.dry_run ? 'would prune' : 'pruned';
  for (const item of candidates) {
    process.stdout.write(`${status}  ${item.name || '-'}  ${item.kind}  ${formatBytes(item.reclaimable_bytes)}\n`);
  }
  if (out.failed?.length) {
    for (const item of out.failed) {
      process.stdout.write(`failed  ${item.name || '-'}  ${item.kind}  ${item.error}\n`);
    }
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

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
