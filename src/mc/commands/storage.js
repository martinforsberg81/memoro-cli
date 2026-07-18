/**
 * `mc storage` exposes local memory/disk hygiene without mutating state.
 */
import {
  buildStorageSnapshot,
  explainSessionStorage,
} from '../storage-management.js';

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
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    opts.verb = args.shift();
  }
  if (!['status', 'candidates', 'explain'].includes(opts.verb)) {
    return { error: 'usage: mc storage [status|candidates|explain <name>] [--json] [--min-age <duration>]' };
  }
  if (opts.verb === 'explain') {
    const name = args.shift();
    if (!name || name.startsWith('-')) return { error: 'usage: mc storage explain <name> [--json]' };
    opts.name = name;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--min-age') {
      const ms = parseDurationMs(args[++i]);
      if (ms == null) return { error: `--min-age expects a duration like 5m / 30s / 1h, got "${args[i]}"` };
      opts.minAgeMs = ms;
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
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
    process.stdout.write(`  ${item.name}  ${item.branch}\n`);
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

function formatBytes(value) {
  if (value == null) return 'unknown';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}
