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

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  if (opts.reapOrphans) {
    return runReapOrphans(opts);
  }

  const reg = readRegistry();
  const candidates = reg.entries.filter(isEligible);

  if (opts.dryRun) {
    const out = {
      dry_run: true,
      candidates: candidates.map((c) => ({
        name: c.name,
        branch: c.branch,
        worktree_path: c.worktree_path,
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

  const primary = primaryWorktree(process.cwd()) || (candidates[0] && primaryWorktree(candidates[0].worktree_path));
  const removed = [];
  const errors = [];
  for (const c of candidates) {
    try {
      await removeBrokerSessionForEntry(c);
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

  const result = { ok: errors.length === 0, removed, ...(errors.length ? { errors } : {}) };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const r of removed) process.stdout.write(`✓ removed ${r.name}\n`);
    for (const e of errors) process.stdout.write(`✗ ${e.name} — ${e.error}\n`);
  }
  return result.ok ? 0 : 1;
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
    minAgeMs: DEFAULT_MIN_AGE_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--reap-orphans') { opts.reapOrphans = true; continue; }
    if (a === '--min-age') {
      const v = argv[++i];
      const ms = parseDurationMs(v);
      if (ms == null) return { error: `--min-age expects a duration like 5m / 30s / 1h, got "${v}"` };
      opts.minAgeMs = ms;
      continue;
    }
    return { error: `unknown flag: ${a}` };
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
      printOrphanScan(scan, { reaped: null });
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
  for (const e of scan.orphan) {
    const status = outcome ? (outcome.reaped.find((r) => r.pidFile === e.pidFile)?.signaled ? '✓ SIGTERMed' : '✗ kill failed') : '(would SIGTERM)';
    process.stdout.write(`orphan  pid=${e.pid}  ${e.llmSessionId}  ${status}\n`);
  }
  for (const e of scan.stale) {
    const status = outcome ? (outcome.unlinked.find((u) => u.pidFile === e.pidFile)?.removed ? '✓ unlinked' : '✗ unlink failed') : '(would unlink)';
    process.stdout.write(`stale   ${e.reason}  ${e.llmSessionId}  ${status}\n`);
  }
}
