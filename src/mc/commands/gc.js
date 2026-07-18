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
import { readRegistry, removeEntry } from '../registry.js';
import { git, tryGit, primaryWorktree, branchExists } from '../git.js';
import { scanDaemons, reapOrphans, DEFAULT_MIN_AGE_MS } from '../orphan-daemons.js';
import { removeBrokerSessionForEntry } from '../broker/session-cleanup.js';
import {
  DEFAULT_SIDECAR_MIN_AGE_MS,
  reapRuntimeSidecars,
  scanRuntimeSidecars,
} from '../sidecar-cleanup.js';
import {
  reapRuntimeCleanup,
  scanRuntimeCleanup,
  staleWorktreeCandidates,
} from '../storage-management.js';

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

  if (opts.sidecars) {
    return runSidecars(opts);
  }

  if (opts.reapOrphans) {
    return runReapOrphans(opts);
  }

  const reg = readRegistry();
  const candidates = opts.staleWorktrees
    ? await staleWorktreeCandidates(reg)
    : reg.entries.filter(isEligible);

  if (opts.dryRun) {
    const out = {
      dry_run: true,
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
  emitWorktreeResult(result, opts);
  return result.ok ? 0 : 1;
}

async function reapWorktrees(candidates) {
  const removed = [];
  const errors = [];
  for (const c of candidates) {
    try {
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
      removeEntry(c.name);
      removed.push({ name: c.name, branch: c.branch });
    } catch (err) {
      errors.push({ name: c.name, error: err.message });
    }
  }

  return { ok: errors.length === 0, removed, ...(errors.length ? { errors } : {}) };
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
    staleWorktrees: false,
    runtime: false,
    allSafe: false,
    apply: false,
    minAgeMs: DEFAULT_MIN_AGE_MS,
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
    if (a === '--min-age') {
      const v = argv[++i];
      const ms = parseDurationMs(v);
      if (ms == null) return { error: `--min-age expects a duration like 5m / 30s / 1h, got "${v}"` };
      opts.minAgeMs = ms;
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  if (opts.dryRun && opts.apply) return { error: '--dry-run and --apply cannot be combined' };
  const modes = [opts.reapOrphans, opts.sidecars, opts.staleWorktrees, opts.runtime, opts.allSafe].filter(Boolean).length;
  if (modes > 1) return { error: '--reap-orphans, --sidecars, --runtime, --stale-worktrees, and --all-safe cannot be combined' };
  if (opts.allSafe && !opts.dryRun && !opts.apply) {
    return { error: '--all-safe requires --dry-run or --apply' };
  }
  return opts;
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

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      candidates: scan.candidates,
      counts: scan.counts,
    };
    if (opts.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      printSidecarScan(scan, null);
    }
    return 0;
  }

  const outcome = reapRuntimeSidecars(scan);
  if (opts.json) {
    console.log(JSON.stringify({
      ok: outcome.ok,
      removed: outcome.removed,
      ...(outcome.errors ? { errors: outcome.errors } : {}),
      counts: scan.counts,
    }, null, 2));
  } else {
    printSidecarScan(scan, outcome);
  }
  return outcome.ok ? 0 : 1;
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

async function runAllSafe(opts) {
  const reg = readRegistry();
  const runtime = await scanRuntimeCleanup({ minAgeMs: opts.minAgeMs, registry: reg });
  const worktreeCandidates = await staleWorktreeCandidates(reg);

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      runtime: runtimeDryRunJson(runtime),
      stale_worktrees: worktreeCandidates.map(toWorktreeCandidateJson),
    };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      printRuntimeScan(runtime, { outcome: null });
      printWorktreeCandidates(worktreeCandidates);
    }
    return 0;
  }

  const runtimeOutcome = reapRuntimeCleanup(runtime);
  const worktreeOutcome = await reapWorktrees(worktreeCandidates);
  const result = {
    ok: runtimeOutcome.ok && worktreeOutcome.ok,
    runtime: runtimeOutcome,
    worktrees: worktreeOutcome,
  };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    printRuntimeScan(runtime, { outcome: runtimeOutcome });
    emitWorktreeResult(worktreeOutcome, opts);
  }
  return result.ok ? 0 : 1;
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
