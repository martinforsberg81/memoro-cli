/**
 * `mc adapter <subcommand>` (plan §13).
 *
 * Phase-2 surface: `mc adapter sync` materialises a thin per-tool
 * instruction-file wrapper (CLAUDE.md, AGENTS.md, …) from the canonical
 * `docs/coding-agent-protocol.md`. Other subcommands land in phase 3+
 * (`mc tool-switch` etc., see §13d).
 *
 * Subprocess invariants:
 *   - exits 0 when everything is in sync (or under --dry-run with no
 *     pending drift)
 *   - exits 1 when drift is detected without --force
 *   - exits 2 on misuse (unknown flag, unknown --tool, missing canonical)
 *
 * The verb writes via injected fs helpers so the pure-helper layer in
 * `../adapter-sync.js` stays testable in-process.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  planSync,
  defaultAdapterList,
  summariseDrift,
  KNOWN_TOOL_NAMES,
} from '../adapter-sync.js';
import {
  planMaterialise,
  CANON_DESTINATIONS,
} from '../canon-materialise.js';
import { readPackageCanon } from '../canon.js';
import { removeManagedBlock } from '../../lib/managed-block.js';
import {
  GROUNDING_BEGIN as CLAUDE_GROUNDING_BEGIN,
  GROUNDING_END as CLAUDE_GROUNDING_END,
} from '../../adapters/claude-code.js';
import {
  GROUNDING_BEGIN as CODEX_GROUNDING_BEGIN,
  GROUNDING_END as CODEX_GROUNDING_END,
} from '../../adapters/codex.js';

/**
 * Strip the per-session grounding managed block(s) from a wrapper's
 * content before drift comparison (Phase 2 drift-fix, extended for the
 * Phase 3 tool-switch).
 *
 * The grounding bundle (`mc` / `mc new` / `mc resume` write it at the
 * pre-launch slot) is per-session context, NOT adapter-sync canon. Left
 * in place it would make every grounded session's instruction file report
 * as drift on the next `mc adapter sync`. We remove it with the SAME
 * markers `writeGrounding` uses, so the strip is symmetric by construction.
 *
 * Phase 3 makes a session switchable between tools (claude-code ↔ codex)
 * in the same worktree. A switched session can leave BOTH adapters' markers
 * behind in a shared instruction file (e.g. AGENTS.md after a switch from
 * codex, or a stale block from a prior tool). So we strip every known
 * adapter's grounding markers, not just claude-code's — otherwise codex's
 * AGENTS.md would drift after a switch. Each adapter owns its own distinct
 * markers (re-exported here), so the set is the single source of truth.
 *
 * Pure + null-safe: a missing file (null) passes through untouched.
 */
const GROUNDING_MARKERS = [
  { beginMarker: CLAUDE_GROUNDING_BEGIN, endMarker: CLAUDE_GROUNDING_END },
  { beginMarker: CODEX_GROUNDING_BEGIN, endMarker: CODEX_GROUNDING_END },
];

export function stripGroundingBlock(content) {
  if (typeof content !== 'string') return content;
  let next = content;
  for (const markers of GROUNDING_MARKERS) {
    next = removeManagedBlock(next, markers);
  }
  return next;
}

export function comparableWrapperContent(content) {
  if (typeof content !== 'string') return content;
  const stripped = stripGroundingBlock(content);
  return stripped !== content && stripped.trim().length === 0 ? null : stripped;
}

const CANONICAL_PATH = 'docs/coding-agent-protocol.md';

export async function run(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return sub ? 0 : 2;
  }
  if (sub === 'sync') return runSync(rest);
  if (sub === 'materialise' || sub === 'materialize') return runMaterialise(rest);
  console.error(`mc: unknown adapter subcommand "${sub}". Try \`mc adapter --help\`.`);
  return 2;
}

function printHelp() {
  process.stdout.write(`mc adapter — tool-portability operations (plan §13)

USAGE
  mc adapter sync [--tool <name>] [--dry-run] [--force] [--json]
  mc adapter materialise [--dry-run] [--force] [--json]

VERBS
  sync         Materialise per-tool instruction-file wrappers (CLAUDE.md,
               AGENTS.md, …) from docs/coding-agent-protocol.md. Idempotent;
               safe to re-run. Refuses to overwrite hand-edited wrappers
               without --force.
  materialise  Copy the orchestrator canon shipped IN the mc package
               (coding-agent-protocol.md, agent-coordination.md,
               be-coordinator.md) into this repo's docs/ + .claude/, so any
               repo can carry the coordinator tooling. Idempotent; refuses
               to overwrite a differing file without --force.

FLAGS
  --tool <name>   (sync only) Limit to one adapter: claude-code | codex | gemini-cli
  --dry-run       Report actions without writing
  --force         Overwrite drift (hand-edited / differing files)
  --json          Machine-readable report

EXIT CODES
  0   all in sync / up to date (or dry-run, no pending drift)
  1   drift detected without --force
  2   misuse (unknown flag, unknown tool, missing canonical/package canon)
`);
}

// ─────────────────────────────────────────────────────────────
// `mc adapter sync`
// ─────────────────────────────────────────────────────────────

export function parseSyncArgs(argv) {
  const opts = { tool: null, dryRun: false, force: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--force')   { opts.force = true; continue; }
    if (a === '--json')    { opts.json = true; continue; }
    if (a === '--tool') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        return { error: '--tool requires a value' };
      }
      opts.tool = next;
      i++;
      continue;
    }
    if (a.startsWith('--tool=')) {
      opts.tool = a.slice('--tool='.length);
      if (!opts.tool) return { error: '--tool requires a value' };
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  if (opts.tool != null && !KNOWN_TOOL_NAMES.has(opts.tool)) {
    return {
      error: `unknown --tool "${opts.tool}". Known: ${[...KNOWN_TOOL_NAMES].join(', ')}`,
    };
  }
  return opts;
}

async function runSync(argv) {
  const opts = parseSyncArgs(argv);
  if (opts.error) {
    // Misuse → exit 2. Emit human-readable error AND a JSON shape on
    // --json (so machine consumers don't have to parse stderr).
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, error: opts.error }, null, 2));
    }
    console.error(`mc: ${opts.error}`);
    return 2;
  }

  // Inject the deps so the helpers are pure + the test can stub fs +
  // canonical reads without touching disk.
  return runSyncWith(opts, defaultDeps());
}

export function defaultDeps() {
  return {
    cwd: process.cwd(),
    repoRoot: defaultRepoRoot,
    readFileText: (abs) => existsSync(abs) ? readFileSync(abs, 'utf8') : null,
    readCanon: () => readPackageCanon(),
    writeFileText: (abs, body) => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, { encoding: 'utf8' });
    },
    listAdapters: defaultAdapterList,
  };
}

function defaultRepoRoot(cwd) {
  // git toplevel is the right scope for project-level wrappers; fall
  // back to cwd if we can't find one (e.g. running from a non-git
  // checkout — sync still works against the current dir).
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || cwd;
  } catch {
    return cwd;
  }
}

/**
 * In-process entry point for tests. Same surface as `runSync` but with
 * deps explicit. The verb body lives here.
 */
export async function runSyncWith(opts, deps) {
  const root = deps.repoRoot(deps.cwd);
  const canonicalAbs = join(root, CANONICAL_PATH);
  const canonicalContent = resolveCanonicalContent(deps, canonicalAbs);
  if (canonicalContent == null) {
    const msg = `canonical source not found at ${CANONICAL_PATH} and no package canon is available — run \`mc adapter materialise\` or reinstall mc.`;
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    }
    console.error(`mc: ${msg}`);
    return 2;
  }

  const allAdapters = await deps.listAdapters();
  const adapters = opts.tool
    ? allAdapters.filter((a) => a.id === opts.tool)
    : allAdapters;

  const resolveWrapperPath = (relPath) => isAbsolute(relPath) ? relPath : join(root, relPath);
  // Strip the per-session grounding block before the byte-compare — it's
  // not adapter-sync canon, so it must not be read as drift (Phase 2).
  const readWrapper = (abs) => comparableWrapperContent(deps.readFileText(abs));

  const actions = planSync({
    adapters,
    canonicalPath: CANONICAL_PATH,
    canonicalContent,
    resolveWrapperPath,
    readWrapper,
  });

  // Decide what to write. `drift` is written only with --force.
  const writes = [];
  const driftActions = [];
  for (const a of actions) {
    if (a.action === 'create') writes.push(a);
    else if (a.action === 'drift') {
      driftActions.push(a);
      if (opts.force) writes.push(a);
    }
  }

  // Perform writes unless --dry-run.
  const written = [];
  if (!opts.dryRun) {
    for (const a of writes) {
      try {
        deps.writeFileText(a.absPath, a.expectedContent);
        written.push(a.wrapperPath);
      } catch (err) {
        const msg = `failed to write ${a.wrapperPath}: ${err.message}`;
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        }
        console.error(`mc: ${msg}`);
        return 2;
      }
    }
  }

  const driftBlocked = driftActions.length > 0 && !opts.force;
  const exitCode = driftBlocked ? 1 : 0;

  if (opts.json) {
    console.log(JSON.stringify({
      ok: !driftBlocked,
      dry_run: opts.dryRun,
      force: opts.force,
      canonical: CANONICAL_PATH,
      actions: actions.map(serialiseAction),
      written,
    }, null, 2));
    return exitCode;
  }

  printHuman({ actions, opts, written, driftBlocked });
  return exitCode;
}

export function resolveCanonicalContent(deps, canonicalAbs) {
  const repoLocal = deps.readFileText(canonicalAbs);
  if (repoLocal != null) return repoLocal;
  const canon = typeof deps.readCanon === 'function' ? deps.readCanon() : null;
  return typeof canon?.protocol === 'string' && canon.protocol.trim().length
    ? canon.protocol
    : null;
}

function serialiseAction(a) {
  return {
    adapter: a.adapterId,
    label: a.adapterLabel,
    wrapper_path: a.wrapperPath,
    action: a.action,
    drift_state: a.driftState ?? null,
    expected_stamp: a.expectedStamp ?? null,
    current_stamp: a.currentStamp ?? null,
    reason: a.reason ?? null,
  };
}

function printHuman({ actions, opts, written, driftBlocked }) {
  const mode = opts.dryRun ? '[dry-run] ' : '';
  process.stdout.write(`mc adapter sync ${mode}— canonical: ${CANONICAL_PATH}\n\n`);
  if (actions.length === 0) {
    process.stdout.write('  (no adapters matched)\n');
    return;
  }
  for (const a of actions) {
    const padded = (a.adapterLabel || a.adapterId).padEnd(14);
    if (a.action === 'skip') {
      process.stdout.write(`  · ${padded}skipped — ${a.reason}\n`);
      continue;
    }
    const wpath = (a.wrapperPath || '').padEnd(20);
    if (a.action === 'noop') {
      process.stdout.write(`  ✓ ${padded}${wpath}up to date\n`);
      continue;
    }
    if (a.action === 'create') {
      const verb = opts.dryRun ? 'would create' : 'created';
      process.stdout.write(`  + ${padded}${wpath}${verb}\n`);
      continue;
    }
    if (a.action === 'drift') {
      if (opts.force) {
        const verb = opts.dryRun ? 'would overwrite (--force)' : 'overwritten (--force)';
        process.stdout.write(`  ! ${padded}${wpath}${verb}\n`);
      } else {
        process.stdout.write(`  ✗ ${padded}${wpath}DRIFT — ${a.driftState}\n`);
        for (const line of summariseDrift({
          existing: a.existingContent,
          expected: a.expectedContent,
        })) {
          process.stdout.write(`  ${line}\n`);
        }
      }
    }
  }
  if (driftBlocked) {
    process.stdout.write(`\n  Drift detected — refusing to overwrite without --force.\n`);
    process.stdout.write(`  Either edit ${CANONICAL_PATH} (the canonical) and re-sync,\n`);
    process.stdout.write(`  or run \`mc adapter sync --force\` if you mean to discard the local edit.\n`);
  } else if (!opts.dryRun && written.length > 0) {
    process.stdout.write(`\n  Wrote ${written.length} file${written.length === 1 ? '' : 's'}.\n`);
  }
}

// ─────────────────────────────────────────────────────────────
// `mc adapter materialise`
// ─────────────────────────────────────────────────────────────

export function parseMaterialiseArgs(argv) {
  const opts = { dryRun: false, force: false, json: false };
  for (const a of argv) {
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--force')   { opts.force = true; continue; }
    if (a === '--json')    { opts.json = true; continue; }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
}

async function runMaterialise(argv) {
  const opts = parseMaterialiseArgs(argv);
  if (opts.error) {
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, error: opts.error }, null, 2));
    }
    console.error(`mc: ${opts.error}`);
    return 2;
  }
  return runMaterialiseWith(opts, defaultMaterialiseDeps());
}

export function defaultMaterialiseDeps() {
  return {
    cwd: process.cwd(),
    repoRoot: defaultRepoRoot,
    // Package canon is the source of truth (resolved from mc's OWN install
    // root, never cwd — see canon.js). Soft-degrades a broken install to
    // all-null without throwing.
    readCanon: () => readPackageCanon(),
    readFileText: (abs) => existsSync(abs) ? readFileSync(abs, 'utf8') : null,
    writeFileText: (abs, body) => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, { encoding: 'utf8' });
    },
  };
}

/**
 * In-process entry point for tests. Same surface as `runMaterialise` but
 * with deps explicit. The verb body lives here.
 *
 * Exit-before-side-effect (Pattern 3): the whole plan is computed and the
 * drift decision is made BEFORE any write, so a drift refusal leaves the
 * repo untouched (no half-materialised state).
 */
export async function runMaterialiseWith(opts, deps) {
  const root = deps.repoRoot(deps.cwd);
  const canon = deps.readCanon();

  // A wholly-broken install (no canon at all) is misuse → exit 2 with a
  // clear message on BOTH the human and --json paths. Partial installs
  // (some files present) materialise what's there and skip the rest.
  const anyCanon = canon && Object.values(canon).some((v) => typeof v === 'string' && v.length);
  if (!anyCanon) {
    const msg = 'no package canon found — the mc install looks broken (missing canon/ dir). Reinstall mc.';
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    }
    console.error(`mc: ${msg}`);
    return 2;
  }

  const resolveDest = (relPath) => isAbsolute(relPath) ? relPath : join(root, relPath);
  const readDest = (abs) => deps.readFileText(abs);

  const actions = planMaterialise({ canon, resolveDest, readDest });

  // Decide what to write. `drift` is written only with --force.
  const writes = [];
  const driftActions = [];
  for (const a of actions) {
    if (a.action === 'create') writes.push(a);
    else if (a.action === 'drift') {
      driftActions.push(a);
      if (opts.force) writes.push(a);
    }
  }

  // Exit-before-side-effect (Pattern 3): if any file drifts and --force was
  // not given, abort the WHOLE materialise — write nothing, not even the
  // clean creates. A partial materialise (some files, not others) is a
  // half-state we refuse to leave behind. With --force the drifted files are
  // already in `writes`, so this guard is a no-op and everything lands.
  const driftBlocked = driftActions.length > 0 && !opts.force;

  const written = [];
  if (!opts.dryRun && !driftBlocked) {
    for (const a of writes) {
      try {
        deps.writeFileText(a.absPath, a.packagedContent);
        written.push(a.destPath);
      } catch (err) {
        const msg = `failed to write ${a.destPath}: ${err.message}`;
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        }
        console.error(`mc: ${msg}`);
        return 2;
      }
    }
  }

  const exitCode = driftBlocked ? 1 : 0;

  if (opts.json) {
    console.log(JSON.stringify({
      ok: !driftBlocked,
      dry_run: opts.dryRun,
      force: opts.force,
      destinations: CANON_DESTINATIONS,
      actions: actions.map(serialiseMaterialiseAction),
      written,
    }, null, 2));
    return exitCode;
  }

  printMaterialiseHuman({ actions, opts, written, driftBlocked });
  return exitCode;
}

function serialiseMaterialiseAction(a) {
  return {
    canon: a.key,
    dest_path: a.destPath,
    action: a.action,
    drift_state: a.driftState ?? null,
    reason: a.reason ?? null,
  };
}

function printMaterialiseHuman({ actions, opts, written, driftBlocked }) {
  const mode = opts.dryRun ? '[dry-run] ' : '';
  process.stdout.write(`mc adapter materialise ${mode}— canon from the mc package\n\n`);
  for (const a of actions) {
    const dpath = (a.destPath || '').padEnd(40);
    if (a.action === 'skip') {
      process.stdout.write(`  · ${dpath}skipped — ${a.reason}\n`);
      continue;
    }
    if (a.action === 'noop') {
      process.stdout.write(`  ✓ ${dpath}up to date\n`);
      continue;
    }
    if (a.action === 'create') {
      const verb = opts.dryRun ? 'would create' : 'created';
      process.stdout.write(`  + ${dpath}${verb}\n`);
      continue;
    }
    if (a.action === 'drift') {
      if (opts.force) {
        const verb = opts.dryRun ? 'would overwrite (--force)' : 'overwritten (--force)';
        process.stdout.write(`  ! ${dpath}${verb}\n`);
      } else {
        process.stdout.write(`  ✗ ${dpath}DRIFT — differs from package canon\n`);
        for (const line of summariseDrift({
          existing: a.existingContent,
          expected: a.packagedContent,
        })) {
          process.stdout.write(`  ${line}\n`);
        }
      }
    }
  }
  if (driftBlocked) {
    process.stdout.write(`\n  Drift detected — refusing to overwrite without --force.\n`);
    process.stdout.write(`  A local copy differs from the package canon. Re-run with\n`);
    process.stdout.write(`  \`mc adapter materialise --force\` to discard the local edit,\n`);
    process.stdout.write(`  or leave it if the divergence is intentional.\n`);
  } else if (!opts.dryRun && written.length > 0) {
    process.stdout.write(`\n  Wrote ${written.length} file${written.length === 1 ? '' : 's'}.\n`);
  }
}
