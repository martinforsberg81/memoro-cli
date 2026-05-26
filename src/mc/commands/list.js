/**
 * `mc list [--all|--rich|--json|--names]` plus filters from §9d:
 *   --awaiting   --idle [--since 6h]   --safe-to-end   --has-unmerged   --active
 */
import { readRegistry } from '../registry.js';

const DEFAULT_IDLE_CUTOFF_MIN = 6 * 60;
const ACTIVE_CUTOFF_MIN = 5;

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  const reg = readRegistry();
  let entries = reg.entries.slice();

  // Default scope: only "work" entries. --all expands to everything.
  if (!opts.all) entries = entries.filter((e) => (e.kind || 'work') === 'work');

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
  };
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
    all: false, rich: false, json: false, names: false,
    awaiting: false, idle: false, since: null,
    safeToEnd: false, hasUnmerged: false, active: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--all': opts.all = true; break;
      case '--rich': opts.rich = true; break;
      case '--json': opts.json = true; break;
      case '--names': opts.names = true; break;
      case '--awaiting': opts.awaiting = true; break;
      case '--idle': opts.idle = true; break;
      case '--since': opts.since = argv[++i]; break;
      case '--safe-to-end': opts.safeToEnd = true; break;
      case '--has-unmerged': opts.hasUnmerged = true; break;
      case '--active': opts.active = true; break;
      default:
        if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
        return { error: `unexpected positional arg: ${a}` };
    }
  }
  return opts;
}
