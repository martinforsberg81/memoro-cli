/**
 * `mc doctor` gives a non-mutating health view over local mc storage.
 */
import { buildStorageSnapshot } from '../mc/storage-management.js';
import { readRegistry } from '../mc/registry.js';
import { inspectLocalBrokerSessionForEntry } from '../core/liveness/presence.js';
import { listDevServers, summarizeDevServers } from '../mc/dev-servers.js';
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
  const snapshot = await buildSnapshot({ minAgeMs: opts.minAgeMs });
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
    inspectPresence: deps.inspectPresence || inspectLocalBrokerSessionForEntry,
  });

  const issues = [...snapshot.issues, ...devIssues, ...transcriptIssues, ...liveness.issues];
  const out = {
    ok: issues.length === 0,
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
  const opts = { json: false, minAgeMs: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
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
