/**
 * `mc doctor` gives a non-mutating health view over local mc storage.
 */
import { buildStorageSnapshot } from '../storage-management.js';
import { listDevServers, summarizeDevServers } from '../dev-servers.js';

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
  const issues = [...snapshot.issues, ...devIssues];
  const out = {
    ok: issues.length === 0,
    summary: { ...snapshot.summary, dev_servers: devSummary },
    issues,
  };
  if (opts.json) stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else printHuman(out, stdout);
  return 0;
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
    if (issue.count != null) stdout.write(`  count=${issue.count}`);
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
