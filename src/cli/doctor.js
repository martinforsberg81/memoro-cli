/**
 * `mc doctor` — diagnose AND repair.
 *
 * mc heals itself first; doctor is the user's second line. Everything
 * loss-free (registry metadata: stale live rows, worktree-missing flags)
 * is FIXED by default and reported as fixed — the user is never handed
 * homework a machine can do. Anything destructive (transcript pruning,
 * teardown) stays behind its explicit command, and anything requiring a
 * human hand (exiting a live tool) stays an issue with the exact way out.
 * `--dry-run` reports without touching anything.
 */
import { buildStorageSnapshot, scanRuntimeCleanup } from '../mc/storage-management.js';
import { reapOrphans } from '../mc/orphan-daemons.js';
import { reapRuntimeSidecars } from '../mc/sidecar-cleanup.js';
import { readRegistry } from '../mc/registry.js';
import {
  applyStorageRepairPlan,
  buildStorageRepairPlan,
} from '../mc/storage-repair.js';
import {
  repairDefaultBranchSquatters,
  scanDefaultBranchSquatters,
} from '../mc/default-branch-repair.js';
import { inspectLocalBrokerSessionForEntry } from '../core/liveness/presence.js';
import { listDevServers, summarizeDevServers } from '../mc/dev-servers.js';
import { listLocalBrokerAndHostSessions } from '../runtime/broker/session-hosts.js';
import { buildTranscriptPrunePlan } from '../mc/transcript-prune.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }

  const buildSnapshot = deps.buildStorageSnapshot || buildStorageSnapshot;
  const list = deps.listDevServers || listDevServers;

  // Repair BEFORE diagnosing: loss-free registry fixes are applied first
  // so the remaining issues are the ones a machine genuinely cannot fix.
  const fixed = [];
  try {
    const registry = (deps.readRegistry || readRegistry)({ persistMigration: !opts.dryRun });
    const plan = await (deps.buildStorageRepairPlan || buildStorageRepairPlan)({ registry });
    if (plan.actions.length > 0) {
      if (!opts.dryRun) {
        (deps.applyStorageRepairPlan || applyStorageRepairPlan)(registry, plan);
      }
      for (const action of plan.actions) {
        fixed.push({
          status: opts.dryRun ? 'would-fix' : 'fixed',
          code: action.reason,
          name: action.name,
        });
      }
    }
  } catch { /* doctor stays best-effort; unfixed rows surface as issues below */ }

  // A session worktree holding the repo's default branch leaves the
  // primary checkout detached (and a symlinked global mc stale). Freed
  // loss-free by detaching in place; blocked squats surface as issues.
  const branchIssues = [];
  try {
    const squatters = (deps.scanDefaultBranchSquatters || scanDefaultBranchSquatters)();
    const repaired = (deps.repairDefaultBranchSquatters || repairDefaultBranchSquatters)(
      squatters,
      { apply: !opts.dryRun },
    );
    for (const item of repaired.fixed) {
      fixed.push({
        status: opts.dryRun ? 'would-fix' : 'fixed',
        code: item.code,
        name: item.worktree_path,
      });
    }
    branchIssues.push(...repaired.issues);
  } catch { /* doctor stays best-effort */ }

  // Runtime debris that is pure bookkeeping — sidecar dirs (broker-host,
  // guard-bin) whose host process is gone, pidfiles of dead daemons — is
  // removed here: loss-free, no process is touched. Living processes
  // (orphan daemons, zombie hosts) stay issues with their explicit
  // opt-in command; killing is never a side effect of a checkup.
  const listOnce = sharedSessionListing();
  try {
    const runtimeScan = await (deps.scanRuntimeCleanup || scanRuntimeCleanup)({
      minAgeMs: opts.minAgeMs,
      listSessions: listOnce,
    });
    if (opts.dryRun) {
      for (const item of runtimeScan.sidecars.candidates) {
        fixed.push({ status: 'would-fix', code: 'stale-sidecar-removed', name: item.path });
      }
      for (const item of runtimeScan.daemons.stale) {
        fixed.push({ status: 'would-fix', code: 'stale-pidfile-removed', name: item.pidFile });
      }
    } else {
      const sidecars = (deps.reapRuntimeSidecars || reapRuntimeSidecars)(runtimeScan.sidecars);
      for (const item of sidecars.removed) {
        fixed.push({ status: 'fixed', code: 'stale-sidecar-removed', name: item.path });
      }
      const pidfiles = (deps.reapOrphans || reapOrphans)({
        orphan: [],
        stale: runtimeScan.daemons.stale,
      });
      for (const item of pidfiles.unlinked) {
        if (item.removed) {
          fixed.push({ status: 'fixed', code: 'stale-pidfile-removed', name: item.pidFile });
        }
      }
    }
  } catch { /* doctor stays best-effort */ }

  const snapshot = await buildSnapshot({ minAgeMs: opts.minAgeMs, listSessions: listOnce });
  const devServers = await Promise.resolve().then(() => list()).catch(() => []);
  const devSummary = summarizeDevServers(devServers);
  const devIssues = [];
  if (devSummary.unhealthy) {
    devIssues.push({ severity: 'warning', code: 'dev-servers-unhealthy', count: devSummary.unhealthy });
  }
  if (devSummary.orphan) {
    devIssues.push({ severity: 'warning', code: 'dev-servers-orphan', count: devSummary.orphan });
  }
  // Provider transcripts accumulate invisibly when sessions end outside
  // mc (closed tabs, crashes, side sessions) — surface the orphaned bulk
  // so it never silently eats the disk again.
  const transcriptIssues = [];
  let transcriptSummary = null;
  try {
    const plan = (deps.buildTranscriptPrunePlan || buildTranscriptPrunePlan)();
    transcriptSummary = plan.counts;
    if (plan.counts.total > 0) {
      transcriptIssues.push({
        severity: 'cleanup',
        code: 'orphan-transcripts',
        count: plan.counts.total,
        mb: Math.round(plan.counts.bytes / (1024 * 1024)),
        hint: 'mc storage prune-transcripts --dry-run',
      });
    }
  } catch { /* doctor stays best-effort */ }

  // Session liveness: every live-marked registry row is judged by THE
  // liveness engine, and each verdict names its exact loss-free remedy.
  // This closes the old dead-end where failure messages said "run mc
  // doctor" and doctor had nothing to say about session hosts.
  const liveness = await collectSessionLivenessIssues({
    readRegistryImpl: deps.readRegistry || readRegistry,
    inspectPresence: deps.inspectPresence
      || ((entry) => inspectLocalBrokerSessionForEntry(entry, {
        deps: { listLocalBrokerAndHostSessions: listOnce },
      })),
  });

  const issues = [...snapshot.issues, ...branchIssues, ...devIssues, ...transcriptIssues, ...liveness.issues];
  const out = {
    ok: issues.length === 0,
    fixed,
    summary: {
      ...snapshot.summary,
      dev_servers: devSummary,
      sessions: liveness.summary,
      ...(transcriptSummary ? { provider_transcripts: transcriptSummary } : {}),
    },
    issues,
  };
  if (opts.json) stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else printHuman(out, stdout);
  return 0;
}

// One broker+host enumeration shared by every per-row probe in a doctor
// run — re-listing per row compounds socket timeouts into a hang.
function sharedSessionListing() {
  let rows = null;
  return async () => {
    if (!rows) rows = listLocalBrokerAndHostSessions().catch(() => []);
    return rows;
  };
}

async function collectSessionLivenessIssues({ readRegistryImpl, inspectPresence }) {
  const summary = { live_rows: 0, confirmed_live: 0, exited: 0, unreachable: 0, unknown: 0 };
  const issues = [];
  let entries = [];
  try {
    entries = readRegistryImpl()?.entries || [];
  } catch {
    return { summary, issues };
  }
  for (const entry of entries) {
    if (entry?.session_state !== 'live' || !entry?.coding_session_id) continue;
    summary.live_rows += 1;
    const presence = await Promise.resolve(inspectPresence(entry))
      .catch(() => ({ verdict: 'unknown' }));
    const verdict = presence?.verdict || 'unknown';
    if (verdict === 'live') {
      summary.confirmed_live += 1;
      continue;
    }
    summary[verdict] = (summary[verdict] || 0) + 1;
    if (verdict === 'exited') {
      issues.push({
        severity: 'warning',
        code: 'session-live-row-exited',
        name: entry.name,
        hint: `'mc open ${entry.name}' resumes from the trusted journal, or 'mc storage repair --apply'`,
      });
    } else if (verdict === 'unreachable') {
      issues.push({
        severity: 'warning',
        code: 'session-runtime-unreachable',
        name: entry.name,
        hint: `exit the running tool in its terminal (Ctrl+D), then 'mc open ${entry.name}' — nothing is deleted`,
      });
    } else {
      issues.push({
        severity: 'warning',
        code: 'session-liveness-unknown',
        name: entry.name,
        hint: "'mc storage repair --apply' reconciles stale live rows",
      });
    }
  }
  return { summary, issues };
}

function parseArgs(argv) {
  const opts = { json: false, minAgeMs: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--min-age') {
      const ms = parseDurationMs(argv[++i]);
      if (ms == null) return { error: `--min-age expects a duration like 5m / 30s / 1h, got "${argv[i]}"` };
      opts.minAgeMs = ms;
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
}

function printHuman(out, stdout = process.stdout) {
  stdout.write(`mc doctor — ${out.ok ? 'ok' : 'issues found'}\n`);
  for (const fix of out.fixed || []) {
    stdout.write(`  ${fix.status}  ${fix.code}`);
    if (fix.name) stdout.write(`  session=${fix.name}`);
    stdout.write(`\n`);
  }
  for (const issue of out.issues) {
    stdout.write(`  ${issue.severity}  ${issue.code}`);
    if (issue.name) stdout.write(`  session=${issue.name}`);
    if (issue.count != null) stdout.write(`  count=${issue.count}`);
    if (issue.mb != null) stdout.write(`  size=${issue.mb}MB`);
    if (issue.hint) stdout.write(`  → ${issue.hint}`);
    stdout.write(`\n`);
  }
  if (!out.issues.length) stdout.write(`  no local storage or dev-server issues detected\n`);
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
