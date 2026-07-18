/**
 * `mc doctor` gives a non-mutating health view over local mc storage.
 */
import { buildStorageSnapshot } from '../storage-management.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  const snapshot = await buildStorageSnapshot({ minAgeMs: opts.minAgeMs });
  const out = {
    ok: snapshot.issues.length === 0,
    summary: snapshot.summary,
    issues: snapshot.issues,
  };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else printHuman(out);
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

function printHuman(out) {
  process.stdout.write(`mc doctor — ${out.ok ? 'ok' : 'issues found'}\n`);
  for (const issue of out.issues) {
    process.stdout.write(`  ${issue.severity}  ${issue.code}`);
    if (issue.count != null) process.stdout.write(`  count=${issue.count}`);
    process.stdout.write(`\n`);
  }
  if (!out.issues.length) process.stdout.write(`  no local storage issues detected\n`);
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
