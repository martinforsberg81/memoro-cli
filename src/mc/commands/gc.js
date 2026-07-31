/**
 * `mc gc [--dry-run] [--json]` (§2).
 *
 * Reaps worktrees where session is dead AND branch is fully merged AND
 * the worktree is clean. Live sessions, dirty worktrees, and unmerged
 * work are all preserved — the user opted into one of those states.
 *
 * Decision matrix:
 *   session_state=dead  && ahead=0 && dirty_files=0 → eligible
 *   (any other combo)                                → skip
 *
 * Branch deletion is best-effort and follows the same logic as `mc end`:
 * delete with `-d` (refuses if not merged) so we never lose work.
 */
import { existsSync } from 'node:fs';
import {
  formatEntryResolutionError,
  readRegistry,
  readRegistryStrict,
  removeEntryIfMatches,
  resolveEntry,
} from '../registry.js';
import { git, tryGit, primaryWorktree, branchExists } from '../git.js';
import { scanDaemons, reapOrphans, DEFAULT_MIN_AGE_MS } from '../orphan-daemons.js';
import { removeBrokerSessionForEntry } from '../broker/session-cleanup.js';
import {
  DEFAULT_SIDECAR_MIN_AGE_MS,
  reapRuntimeSidecars,
  reapZombieHosts,
  scanRuntimeSidecars,
} from '../sidecar-cleanup.js';
import {
  listDevServers,
  removeDevServerRegistryManifest,
} from '../dev-servers.js';
import {
  reapRuntimeCleanup,
  scanRuntimeCleanup,
  staleWorktreeCandidates,
} from '../storage-management.js';
import {
  DEFAULT_DEPENDENCY_SNAPSHOT_MIN_AGE_MS,
  dependencySnapshotScanJson,
  reapDependencySnapshots,
  scanDependencySnapshots,
} from '../dependency-snapshot-storage.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  if (opts.allSafe) {
    return runAllSafe(opts);
  }

  if (opts.runtime) {
    return runRuntime(opts);
  }

  if (opts.dependencySnapshots) {
    return runDependencySnapshots(opts);
  }

  if (opts.sidecars) {
    return runSidecars(opts);
  }

  if (opts.reapOrphans) {
    return runReapOrphans(opts);
  }

  const reg = readRegistry({ persistMigration: !opts.dryRun });
  let candidates;
  if (opts.staleWorktrees) {
    const stale = await staleWorktreeCandidates(reg, {
      includeUnlaunched: opts.onlyNames.length > 0,
    });
    if (stale.warning) console.error(`mc: ${stale.warning}`);
    candidates = stale.candidates;
  } else {
    candidates = reg.entries.filter(isEligible);
  }
  const requestedNames = opts.onlyNames;
  const notCandidates = [];
  if (requestedNames.length) {
    const requestedIds = new Set();
    for (const name of requestedNames) {
      const resolved = resolveEntry(name, { registry: reg, cwd: process.cwd() });
      if (!resolved.ok) {
        if (['ambiguous-session-name', 'ambiguous-legacy-session'].includes(resolved.reason)) {
          console.error(`mc: ${formatEntryResolutionError(name, resolved)}`);
          return 1;
        }
        notCandidates.push(name);
        continue;
      }
      if (!candidates.some((candidate) => candidate.session_id === resolved.entry.session_id)) {
        notCandidates.push(name);
        continue;
      }
      requestedIds.add(resolved.entry.session_id);
    }
    candidates = candidates.filter((candidate) => requestedIds.has(candidate.session_id));
  }

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      ...(requestedNames.length ? { requested_names: requestedNames, not_candidates: notCandidates } : {}),
      candidates: candidates.map((c) => ({
        name: c.name,
        branch: c.branch,
        worktree_path: c.worktree_path,
        reason: c.reason || null,
        dirty_files: c.dirty_files || 0,
        ahead: c.ahead || 0,
        disk_bytes: c.disk_bytes ?? null,
        reclaimable_bytes: c.reclaimable_bytes ?? null,
      })),
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      for (const c of out.candidates) {
        process.stdout.write(`${c.name}  ${c.branch}\n`);
      }
      if (candidates.length === 0) process.stdout.write('(no candidates)\n');
    }
    return 0;
  }

  const result = await reapWorktrees(candidates);
  if (requestedNames.length) {
    result.requested_names = requestedNames;
    result.not_candidates = notCandidates;
  }
  emitWorktreeResult(result, opts);
  return result.ok ? 0 : 1;
}

async function reapWorktrees(candidates) {
  const removed = [];
  const errors = [];
  for (const c of candidates) {
    try {
      verifyGcCandidateIdentity(c);
      await removeBrokerSessionForEntry(c);
      const primary = c.worktree_path && existsSync(c.worktree_path)
        ? primaryWorktree(c.worktree_path)
        : c.primary_worktree || primaryWorktree(process.cwd());
      if (!primary) throw new Error(`no primary worktree found for ${c.name}`);
      if (c.worktree_path && existsSync(c.worktree_path)) {
        git(primary, ['worktree', 'remove', '--force', c.worktree_path]);
      } else {
        tryGit(primary, ['worktree', 'prune']);
      }
      if (c.branch && branchExists(primary, c.branch)) {
        tryGit(primary, ['branch', '-d', c.branch]);
      }
      const removedEntry = removeEntryIfMatches(c.session_id, {
        session_id: c.session_id,
        repository_id: c.repository_id,
        worktree_path: c.worktree_path,
        branch: c.branch,
        tool_session_source: c.tool_session_source,
        tool_session_id: c.tool_session_id,
        tool_transcript_path: c.tool_transcript_path,
      });
      if (!removedEntry.ok) throw new Error(`registry removal failed (${removedEntry.reason})`);
      removed.push({ name: c.name, branch: c.branch });
    } catch (err) {
      errors.push({ name: c.name, error: err.message });
    }
  }

  return { ok: errors.length === 0, removed, ...(errors.length ? { errors } : {}) };
}

function verifyGcCandidateIdentity(candidate) {
  if (!candidate?.session_id || !candidate?.repository_id) {
    throw new Error('registry identity unavailable');
  }
  const current = readRegistryStrict().entries.find((entry) => (
    entry.session_id === candidate.session_id
  ));
  if (!current
    || current.repository_id !== candidate.repository_id
    || current.worktree_path !== candidate.worktree_path
    || current.branch !== candidate.branch) {
    throw new Error('registry entry changed before cleanup');
  }
}

function emitWorktreeResult(result, opts) {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const r of result.removed) process.stdout.write(`✓ removed ${r.name}\n`);
    for (const e of result.errors || []) process.stdout.write(`✗ ${e.name} — ${e.error}\n`);
  }
}

function isEligible(entry) {
  if (entry.session_state !== 'dead') return false;
  if ((entry.dirty_files || 0) > 0) return false;
  if ((entry.ahead || 0) > 0) return false;
  return true;
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    json: false,
    reapOrphans: false,
    sidecars: false,
    reapZombieHosts: false,
    staleWorktrees: false,
    runtime: false,
    dependencySnapshots: false,
    allSafe: false,
    apply: false,
    minAgeMs: DEFAULT_MIN_AGE_MS,
    minAgeSet: false,
    onlyNames: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--apply') { opts.apply = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--reap-orphans') { opts.reapOrphans = true; continue; }
    if (a === '--stale-worktrees') { opts.staleWorktrees = true; continue; }
    if (a === '--runtime') {
      opts.runtime = true;
      if (opts.minAgeMs === DEFAULT_MIN_AGE_MS) opts.minAgeMs = DEFAULT_SIDECAR_MIN_AGE_MS;
      continue;
    }
    if (a === '--dependency-snapshots' || a === '--snapshots') {
      opts.dependencySnapshots = true;
      continue;
    }
    if (a === '--all-safe') {
      opts.allSafe = true;
      if (opts.minAgeMs === DEFAULT_MIN_AGE_MS) opts.minAgeMs = DEFAULT_SIDECAR_MIN_AGE_MS;
      continue;
    }
    if (a === '--sidecars') {
      opts.sidecars = true;
      if (opts.minAgeMs === DEFAULT_MIN_AGE_MS) opts.minAgeMs = DEFAULT_SIDECAR_MIN_AGE_MS;
      continue;
    }
    if (a === '--reap-zombie-hosts') {
      opts.reapZombieHosts = true;
      continue;
    }
    if (a === '--min-age') {
      const v = argv[++i];
      const ms = parseDurationMs(v);
      if (ms == null) return { error: `--min-age expects a duration like 5m / 30s / 1h, got "${v}"` };
      opts.minAgeMs = ms;
      opts.minAgeSet = true;
      continue;
    }
    if (a === '--only') {
      const v = argv[++i];
      const names = parseNameList(v);
      if (!names.length) return { error: '--only expects one or more comma-separated session names' };
      opts.onlyNames.push(...names);
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  if (opts.dryRun && opts.apply) return { error: '--dry-run and --apply cannot be combined' };
  const modes = [opts.reapOrphans, opts.sidecars, opts.staleWorktrees, opts.runtime, opts.dependencySnapshots, opts.allSafe].filter(Boolean).length;
  if (modes > 1) return { error: '--reap-orphans, --sidecars, --runtime, --dependency-snapshots, --stale-worktrees, and --all-safe cannot be combined' };
  if (opts.onlyNames.length && !opts.staleWorktrees) {
    return { error: '--only can only be used with --stale-worktrees' };
  }
  if (opts.reapZombieHosts && !opts.sidecars) {
    return { error: '--reap-zombie-hosts can only be used with --sidecars' };
  }
  if (opts.allSafe && !opts.dryRun && !opts.apply) {
    return { error: '--all-safe requires --dry-run or --apply' };
  }
  if (opts.dependencySnapshots && !opts.dryRun && !opts.apply) {
    return { error: '--dependency-snapshots requires --dry-run or --apply' };
  }
  return opts;
}

function parseNameList(value) {
  return String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function parseDurationMs(spec) {
  if (spec == null) return null;
  const m = String(spec).trim().match(/^(\d+)([smhd])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60_000;
  if (unit === 'h') return n * 3_600_000;
  if (unit === 'd') return n * 86_400_000;
  return null;
}

function runReapOrphans(opts) {
  const scan = scanDaemons({ minAgeMs: opts.minAgeMs });

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      orphan: scan.orphan.map(toOrphanJson),
      stale: scan.stale.map(toStaleJson),
    };
    if (opts.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      printOrphanScan(scan, null);
    }
    return 0;
  }

  const outcome = reapOrphans(scan);
  if (opts.json) {
    console.log(JSON.stringify({
      ok: outcome.reaped.every((r) => r.signaled) && outcome.unlinked.every((u) => u.removed),
      reaped: outcome.reaped,
      unlinked: outcome.unlinked,
    }, null, 2));
  } else {
    printOrphanScan(scan, outcome);
  }
  return 0;
}

async function runSidecars(opts) {
  const scan = await scanRuntimeSidecars({ minAgeMs: opts.minAgeMs });
  // Orphan dev-server manifests are bookkeeping for processes that are
  // gone or replaced — removing them never touches a process.
  const orphanDevManifests = (await listDevServers().catch(() => []))
    .filter((server) => server.state === 'orphan');

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      candidates: scan.candidates,
      zombie_hosts: scan.zombie_hosts,
      orphan_dev_manifests: orphanDevManifests.map(devManifestJson),
      counts: scan.counts,
    };
    if (opts.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      printSidecarScan(scan, null);
      printOrphanDevManifests(orphanDevManifests, null);
      printZombieHosts(scan, null, opts);
    }
    return 0;
  }

  const outcome = reapRuntimeSidecars(scan);
  const devOutcome = { removed: [], errors: [] };
  for (const server of orphanDevManifests) {
    try {
      removeDevServerRegistryManifest(server.instance_id);
      devOutcome.removed.push(devManifestJson(server));
    } catch (err) {
      devOutcome.errors.push({ ...devManifestJson(server), error: err?.message || String(err) });
    }
  }
  // Zombie hosts hold living processes; reaping them is opt-in only.
  const zombieOutcome = opts.reapZombieHosts
    ? await reapZombieHosts(scan.zombie_hosts)
    : null;
  const ok = outcome.ok
    && (zombieOutcome ? zombieOutcome.ok : true)
    && devOutcome.errors.length === 0;
  if (opts.json) {
    console.log(JSON.stringify({
      ok,
      removed: outcome.removed,
      ...(outcome.errors ? { errors: outcome.errors } : {}),
      orphan_dev_manifests_removed: devOutcome.removed,
      ...(devOutcome.errors.length ? { orphan_dev_manifest_errors: devOutcome.errors } : {}),
      ...(zombieOutcome
        ? {
          zombie_hosts_removed: zombieOutcome.removed,
          ...(zombieOutcome.errors ? { zombie_host_errors: zombieOutcome.errors } : {}),
        }
        : { zombie_hosts: scan.zombie_hosts }),
      counts: scan.counts,
    }, null, 2));
  } else {
    printSidecarScan(scan, outcome);
    printOrphanDevManifests(orphanDevManifests, devOutcome);
    printZombieHosts(scan, zombieOutcome, opts);
  }
  return ok ? 0 : 1;
}

function devManifestJson(server) {
  return {
    instance_id: server.instance_id,
    service: server.service || null,
    session_name: server.session_name || null,
    worktree_path: server.worktree_path || null,
  };
}

function printOrphanDevManifests(orphans, outcome) {
  if (!orphans.length) return;
  if (outcome) {
    for (const item of outcome.removed) {
      process.stdout.write(`removed orphan dev manifest  ${item.service || item.instance_id}  (${item.session_name || 'unknown session'})\n`);
    }
    for (const item of outcome.errors) {
      process.stdout.write(`orphan dev manifest failed  ${item.instance_id}  ${item.error}\n`);
    }
    return;
  }
  for (const server of orphans) {
    process.stdout.write(`orphan dev manifest  ${server.service || server.instance_id}  (${server.session_name || 'unknown session'}, would remove)\n`);
  }
}

function printZombieHosts(scan, outcome, opts) {
  const zombies = scan.zombie_hosts || [];
  if (zombies.length === 0) return;
  if (outcome) {
    for (const item of outcome.removed) {
      process.stdout.write(`reaped zombie host  ${item.session_id}  pid=${item.pid ?? '?'}\n`);
    }
    for (const item of outcome.errors || []) {
      process.stdout.write(`zombie host failed  ${item.session_id}  ${item.error}\n`);
    }
    return;
  }
  for (const item of zombies) {
    process.stdout.write(`zombie host  ${item.session_id}  pid=${item.pid ?? '?'}  (daemon alive, session unreachable)\n`);
  }
  if (!opts.reapZombieHosts) {
    process.stdout.write('⚠  reaping kills the daemon AND its tool process — rerun with `mc gc --sidecars --reap-zombie-hosts` to remove them\n');
  }
}

async function runRuntime(opts) {
  const scan = await scanRuntimeCleanup({ minAgeMs: opts.minAgeMs });

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      runtime: runtimeDryRunJson(scan),
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else printRuntimeScan(scan, { outcome: null });
    return 0;
  }

  const outcome = reapRuntimeCleanup(scan);
  if (opts.json) console.log(JSON.stringify({ ok: outcome.ok, runtime: outcome }, null, 2));
  else printRuntimeScan(scan, { outcome });
  return outcome.ok ? 0 : 1;
}

function runDependencySnapshots(opts) {
  const scan = scanDependencySnapshots({
    minAgeMs: snapshotMinAge(opts),
  });
  if (opts.dryRun) {
    const out = { dry_run: true, dependency_snapshots: dependencySnapshotScanJson(scan) };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else printDependencySnapshots(scan, null);
    return 0;
  }
  const outcome = reapDependencySnapshots(scan);
  if (opts.json) console.log(JSON.stringify({ ok: outcome.ok, dependency_snapshots: outcome }, null, 2));
  else printDependencySnapshots(scan, outcome);
  return outcome.ok ? 0 : 1;
}

async function runAllSafe(opts) {
  const reg = readRegistry({ persistMigration: !opts.dryRun });
  const runtime = await scanRuntimeCleanup({ minAgeMs: opts.minAgeMs, registry: reg });
  const stale = await staleWorktreeCandidates(reg);
  if (stale.warning) console.error(`mc: ${stale.warning}`);
  const worktreeCandidates = stale.candidates;
  const dependencySnapshots = scanDependencySnapshots({ minAgeMs: snapshotMinAge(opts) });

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      runtime: runtimeDryRunJson(runtime),
      dependency_snapshots: dependencySnapshotScanJson(dependencySnapshots),
      stale_worktrees: worktreeCandidates.map(toWorktreeCandidateJson),
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      printRuntimeScan(runtime, { outcome: null });
      printDependencySnapshots(dependencySnapshots, null);
      printWorktreeCandidates(worktreeCandidates);
    }
    return 0;
  }

  const runtimeOutcome = reapRuntimeCleanup(runtime);
  const worktreeOutcome = await reapWorktrees(worktreeCandidates);
  const dependencySnapshotOutcome = reapDependencySnapshots(dependencySnapshots);
  const result = {
    ok: runtimeOutcome.ok && worktreeOutcome.ok && dependencySnapshotOutcome.ok,
    runtime: runtimeOutcome,
    dependency_snapshots: dependencySnapshotOutcome,
    worktrees: worktreeOutcome,
  };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    printRuntimeScan(runtime, { outcome: runtimeOutcome });
    printDependencySnapshots(dependencySnapshots, dependencySnapshotOutcome);
    emitWorktreeResult(worktreeOutcome, opts);
  }
  return result.ok ? 0 : 1;
}

function snapshotMinAge(opts) {
  return opts.minAgeSet ? opts.minAgeMs : DEFAULT_DEPENDENCY_SNAPSHOT_MIN_AGE_MS;
}

function runtimeDryRunJson(scan) {
  return {
    counts: scan.counts,
    daemons: {
      orphan: scan.daemons.orphan.map(toOrphanJson),
      stale: scan.daemons.stale.map(toStaleJson),
      live_count: scan.daemons.live.length,
    },
    sidecars: {
      candidates: scan.sidecars.candidates,
      counts: scan.sidecars.counts,
    },
  };
}

function toWorktreeCandidateJson(c) {
  return {
    name: c.name,
    branch: c.branch,
    worktree_path: c.worktree_path,
    reason: c.reason || null,
    dirty_files: c.dirty_files || 0,
    ahead: c.ahead || 0,
    disk_bytes: c.disk_bytes ?? null,
    reclaimable_bytes: c.reclaimable_bytes ?? null,
  };
}

function toOrphanJson(e) {
  return { pid_file: e.pidFile, llm_session_id: e.llmSessionId, pid: e.pid, ppid: e.ppid, age_ms: e.ageMs };
}
function toStaleJson(e) {
  return { pid_file: e.pidFile, llm_session_id: e.llmSessionId, pid: e.pid, reason: e.reason };
}

function printOrphanScan(scan, outcome) {
  if (scan.orphan.length === 0 && scan.stale.length === 0) {
    process.stdout.write('(no orphan daemons)\n');
    return;
  }
  const reaped = Array.isArray(outcome?.reaped) ? outcome.reaped : [];
  const unlinked = Array.isArray(outcome?.unlinked) ? outcome.unlinked : [];
  for (const e of scan.orphan) {
    const status = outcome ? (reaped.find((r) => r.pidFile === e.pidFile)?.signaled ? '✓ SIGTERMed' : '✗ kill failed') : '(would SIGTERM)';
    process.stdout.write(`orphan  pid=${e.pid}  ${e.llmSessionId}  ${status}\n`);
  }
  for (const e of scan.stale) {
    const status = outcome ? (unlinked.find((u) => u.pidFile === e.pidFile)?.removed ? '✓ unlinked' : '✗ unlink failed') : '(would unlink)';
    process.stdout.write(`stale   ${e.reason}  ${e.llmSessionId}  ${status}\n`);
  }
}

function printSidecarScan(scan, outcome) {
  if (scan.candidates.length === 0) {
    process.stdout.write('(no stale sidecars)\n');
    return;
  }
  const removed = Array.isArray(outcome?.removed) ? outcome.removed : [];
  for (const item of scan.candidates) {
    const status = outcome
      ? (removed.find((r) => r.path === item.path) ? '✓ removed' : '✗ remove failed')
      : '(would remove)';
    process.stdout.write(`${item.kind}  ${item.session_id}  ${status}\n`);
  }
}

function printRuntimeScan(scan, { outcome }) {
  printOrphanScan(scan.daemons, outcome?.daemons || null);
  printSidecarScan(scan.sidecars, outcome?.sidecars || null);
}

function printWorktreeCandidates(candidates) {
  if (!candidates.length) {
    process.stdout.write('(no stale worktrees)\n');
    return;
  }
  for (const c of candidates) {
    process.stdout.write(`worktree  ${c.name}  ${c.branch}  (would remove)\n`);
  }
}

function printDependencySnapshots(scan, outcome) {
  const items = outcome?.removed || scan.candidates;
  if (!items.length) {
    process.stdout.write('(no stale dependency snapshots)\n');
    return;
  }
  for (const item of items) {
    const status = outcome ? '✓ removed' : '(would remove)';
    process.stdout.write(`dependency-snapshot  ${item.digest.slice(0, 12)}  ${item.state}  ${status}\n`);
  }
  for (const item of outcome?.skipped || []) {
    process.stdout.write(`dependency-snapshot  ${item.digest.slice(0, 12)}  skipped (${item.reason})\n`);
  }
}
