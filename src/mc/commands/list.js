/**
 * `mc list [--all|--rich|--json|--names|--tree]` plus filters from §9d:
 *   --awaiting   --idle [--since 6h]   --safe-to-end   --has-unmerged   --active
 */
import { readRegistry } from '../registry.js';
import { scanDaemons } from '../orphan-daemons.js';
import { checkAndPrintFreshInstall } from '../first-run.js';

const DEFAULT_IDLE_CUTOFF_MIN = 6 * 60;
const ACTIVE_CUTOFF_MIN = 5;

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  if (opts.orphans) return runOrphans(opts);

  // §11d: friendly first-run hint to stderr. Doesn't short-circuit —
  // `mc list` on an empty registry is a valid call ("(no sessions)")
  // and the hint just nudges the user toward setup. JSON / --names
  // callers stay machine-parseable because the hint goes to stderr.
  await checkAndPrintFreshInstall();

  const reg = readRegistry();
  let entries = reg.entries.slice();

  // Default scope: user-facing sessions. --all expands to internal/legacy
  // orchestration entries too (fanout phases, isolation fixtures, etc.).
  if (!opts.all && !opts.tree) {
    entries = entries.filter((e) => ['work', 'project'].includes(e.kind || 'work'));
  }

  // §9d filters — each operates on the registry's stored fields. The
  // registry is responsible for keeping them fresh (a follow-up command
  // `mc refresh` will rederive them).
  if (opts.awaiting) entries = entries.filter((e) => e.open_question === true);
  if (opts.safeToEnd) entries = entries.filter((e) => e.safety_verdict === 'SAFE_TO_END');
  if (opts.hasUnmerged) {
    entries = entries.filter((e) =>
      (e.ahead || 0) > 0 && e.safety_verdict !== 'IS_SQUASH_PHANTOM',
    );
  }
  if (opts.active) {
    entries = entries.filter((e) =>
      e.session_state === 'live' || isWithinMinutes(e.last_activity, ACTIVE_CUTOFF_MIN),
    );
  }
  if (opts.idle) {
    const cutoffMin = parseDurationMinutes(opts.since) ?? DEFAULT_IDLE_CUTOFF_MIN;
    entries = entries.filter((e) => {
      if (e.session_state === 'live') return false;
      if (isWithinMinutes(e.last_activity, ACTIVE_CUTOFF_MIN)) return false;
      return !isWithinMinutes(e.last_activity, cutoffMin);
    });
  }

  // --rich currently just hands back the stored derived fields; the
  // refresh step would update them in place before listing. For now the
  // registry fixtures the tests inject already have these populated.
  const projected = entries.map((e) => projectEntry(e, opts.rich));

  if (opts.tree) return emitTree(projected, opts);

  if (opts.names) {
    for (const e of projected) process.stdout.write(`${e.name}\n`);
    return 0;
  }
  if (opts.json) {
    console.log(JSON.stringify({ entries: projected }, null, 2));
    return 0;
  }

  // Human-readable default
  for (const e of projected) {
    const parts = [
      e.name.padEnd(20),
      (e.branch || '').padEnd(28),
      (e.safety_verdict || '').padEnd(20),
      (e.session_state || '').padEnd(8),
    ];
    if (e.open_question) parts.push('PAUSED');
    process.stdout.write(parts.join('  ') + '\n');
  }
  if (projected.length === 0) process.stdout.write('(no sessions)\n');

  // §9j: footer-level annotation for orphan daemons. Scan is best-effort;
  // a missing pid dir or unreadable file silently yields zero.
  try {
    const scan = scanDaemons();
    const orphanCount = scan.orphan.length;
    const staleCount = scan.stale.length;
    if (orphanCount > 0 || staleCount > 0) {
      const bits = [];
      if (orphanCount > 0) bits.push(`${orphanCount} orphan-daemon${orphanCount === 1 ? '' : 's'}`);
      if (staleCount > 0) bits.push(`${staleCount} stale pidfile${staleCount === 1 ? '' : 's'}`);
      process.stdout.write(`\n⚠  ${bits.join(', ')} — run \`mc gc --reap-orphans\` to clean up\n`);
    }
  } catch { /* best effort */ }
  return 0;
}

function runOrphans(opts) {
  const scan = scanDaemons();
  if (opts.json) {
    console.log(JSON.stringify({
      orphan: scan.orphan.map((e) => ({
        pid_file: e.pidFile, llm_session_id: e.llmSessionId,
        pid: e.pid, ppid: e.ppid, age_ms: e.ageMs,
      })),
      stale: scan.stale.map((e) => ({
        pid_file: e.pidFile, llm_session_id: e.llmSessionId,
        pid: e.pid, reason: e.reason,
      })),
    }, null, 2));
    return 0;
  }
  if (scan.orphan.length === 0 && scan.stale.length === 0) {
    process.stdout.write('(no orphan daemons)\n');
    return 0;
  }
  for (const e of scan.orphan) {
    const ageMin = Math.floor(e.ageMs / 60_000);
    process.stdout.write(`orphan  pid=${e.pid}  age=${ageMin}m  ${e.llmSessionId}\n`);
  }
  for (const e of scan.stale) {
    process.stdout.write(`stale   ${e.reason}  ${e.llmSessionId}\n`);
  }
  return 0;
}

function projectEntry(e, rich) {
  const base = {
    name: e.name,
    branch: e.branch,
    kind: e.kind || 'work',
    safety_verdict: e.safety_verdict || 'SAFE_TO_END',
    session_state: e.session_state || 'no-session-yet',
    dirty_files: e.dirty_files || 0,
    ahead: e.ahead || 0,
    last_activity: e.last_activity || null,
    open_question: !!e.open_question,
    parent: e.parent ?? null,
    role: e.role ?? null,
    focus: e.focus ?? null,
    memoro_node: e.memoro_node ?? null,
  };
  if (!rich) return base;
  return {
    ...base,
    last_user_msg: e.last_user_msg ?? null,
    last_assistant_text: e.last_assistant_text ?? null,
    tool: e.tool ?? null,
    model_chain: e.model_chain ?? [],
    worktree_path: e.worktree_path ?? null,
    parent: e.parent ?? null,
    role: e.role ?? null,
    focus: e.focus ?? null,
    memoro_node: e.memoro_node ?? null,
    brief_path: e.brief_path ?? null,
  };
}

function emitTree(entries, opts) {
  const byParent = new Map();
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (const e of entries) {
    const parent = e.parent || null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(e);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  const roots = (byParent.get(null) || [])
    .concat(entries.filter((e) => e.parent && !byName.has(e.parent)))
    .filter((e, i, arr) => arr.findIndex((x) => x.name === e.name) === i);

  if (opts.json) {
    console.log(JSON.stringify({ entries, roots: roots.map((e) => e.name) }, null, 2));
    return 0;
  }
  if (roots.length === 0) {
    process.stdout.write('(no sessions)\n');
    return 0;
  }

  const seen = new Set();
  const render = (entry, depth = 0) => {
    if (seen.has(entry.name)) return;
    seen.add(entry.name);
    const indent = '  '.repeat(depth);
    const bits = [
      entry.name,
      entry.session_state || 'unknown',
      entry.tool || '',
      entry.branch || '',
    ].filter(Boolean);
    const suffix = entry.memoro_node ? `  node=${entry.memoro_node}` : '';
    process.stdout.write(`${indent}${bits.join('  ')}${suffix}\n`);
    for (const child of byParent.get(entry.name) || []) render(child, depth + 1);
  };
  for (const root of roots) render(root, 0);
  return 0;
}

function isWithinMinutes(isoString, minutes) {
  if (!isoString) return false;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) < minutes * 60_000;
}

/** "30m" / "6h" / "1d" / "90" (defaults to minutes) → minutes. */
export function parseDurationMinutes(spec) {
  if (spec == null) return null;
  const m = String(spec).trim().match(/^(\d+)([smhd])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  if (unit === 's') return n / 60;
  if (unit === 'm') return n;
  if (unit === 'h') return n * 60;
  if (unit === 'd') return n * 60 * 24;
  return null;
}

function parseArgs(argv) {
  const opts = {
    all: false, rich: false, json: false, names: false, tree: false,
    awaiting: false, idle: false, since: null,
    safeToEnd: false, hasUnmerged: false, active: false,
    orphans: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--all': opts.all = true; break;
      case '--rich': opts.rich = true; break;
      case '--json': opts.json = true; break;
      case '--names': opts.names = true; break;
      case '--tree': opts.tree = true; opts.rich = true; break;
      case '--awaiting': opts.awaiting = true; break;
      case '--idle': opts.idle = true; break;
      case '--since': opts.since = argv[++i]; break;
      case '--safe-to-end': opts.safeToEnd = true; break;
      case '--has-unmerged': opts.hasUnmerged = true; break;
      case '--active': opts.active = true; break;
      case '--orphans': opts.orphans = true; break;
      default:
        if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
        return { error: `unexpected positional arg: ${a}` };
    }
  }
  return opts;
}
