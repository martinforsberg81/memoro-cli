/**
 * `mc tool-switch <tool> [--dry-run] [--force] [--json]` (plan §13d).
 *
 * Make a different coding tool the default for future bare `mc` / `mc new`
 * invocations. Existing sessions keep their stored tool until the user
 * relaunches them explicitly with `mc resume <name> --codex/--claude`.
 *
 * Five phases per §13d:
 *   1. Resolve the target adapter (`claude-code` | `codex` | `gemini-cli`).
 *   2. Verify the target is installed + authed via the adapter's own
 *      `getStatus()`. The install/auth hint string is surfaced verbatim —
 *      authority lives in the verbs (pattern 1), so we never re-author
 *      the hint here.
 *   3. Persist the new default in `~/.memoro/config.json` under
 *      `defaultTool`. (Consumer wiring in `mc new` / `mc resume` lands as
 *      a follow-up — they still hardcode 'claude' today. The switch is
 *      a no-op for them until that follow-up ships; this is documented
 *      in the PR body so it can't slip silently.)
 *   4. Run `mc adapter sync` for the target tool only by calling
 *      `runSyncWith({ tool, force, dryRun }, deps)`. Drift on the target
 *      without `--force` aborts the switch.
 *   5. After the target sync succeeds, surface drift state across ALL
 *      tools (not just the target) using `planSync` — the "drift surface"
 *      mentioned in §13d step 5. Co-existence is by design; we never
 *      touch other tools' files in this verb.
 *
 * `--dry-run` reports what would change (default-tool flip + sync plan)
 * without writing anything.
 *
 * Exit codes:
 *   0   switch succeeded (or --dry-run with no blockers)
 *   1   refused (tool not ready, drift without --force, sync failed)
 *   2   misuse (unknown adapter, unknown flag, missing positional)
 */

import { readConfig, updateConfig } from '../../lib/config.js';
import {
  defaultAdapterList,
  planSync,
  KNOWN_TOOL_NAMES,
} from '../adapter-sync.js';
import {
  runSyncWith,
  defaultDeps as defaultSyncDeps,
  resolveCanonicalContent,
  comparableWrapperContent,
} from './adapter.js';

const CANONICAL_PATH = 'docs/coding-agent-protocol.md';

export async function run(argv) {
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printHelp();
    return 0;
  }

  const opts = parseArgs(argv);
  if (opts.error) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: opts.error }, null, 2));
    }
    console.error(`mc: ${opts.error}`);
    if (!opts.json) printUsage();
    return 2;
  }

  return runSwitchWith(opts, defaultDeps());
}

function printHelp() {
  process.stdout.write(`mc tool-switch — set the default coding tool (plan §13d)

USAGE
  mc tool-switch <tool> [--dry-run] [--force] [--json]

ARGUMENTS
  <tool>          One of: ${[...KNOWN_TOOL_NAMES].join(', ')}

FLAGS
  --dry-run       Report planned changes without writing
  --force         Overwrite drift on the target tool's instruction file
  --json          Machine-readable report

WHAT IT DOES
  1. Verifies the target tool is installed + authenticated
  2. Updates the persisted default tool (~/.memoro/config.json)
  3. Runs \`mc adapter sync --tool <tool>\` for the target
  4. Reports drift across all tools at the end

This does not touch existing sessions. To relaunch one existing session with
a different tool, exit the current tool completely and run:
  mc resume <name> --codex
  mc resume <name> --claude

EXIT CODES
  0   success (or dry-run with no blockers)
  1   refused (not ready, drift without --force, sync failed)
  2   misuse (unknown adapter, unknown flag, missing positional)
`);
}

function printUsage() {
  console.error(`Usage: mc tool-switch <tool> [--dry-run] [--force] [--json]`);
}

// ─────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { tool: null, dryRun: false, force: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--force')   { opts.force = true; continue; }
    if (a === '--json')    { opts.json = true; continue; }
    if (a.startsWith('--')) {
      // Preserve json-state on error so the dispatcher can emit JSON if
      // requested (a flag-order corner case the user shouldn't suffer).
      return { error: `unknown flag: ${a}`, json: opts.json };
    }
    if (opts.tool != null) {
      return { error: `unexpected positional arg: ${a}`, json: opts.json };
    }
    opts.tool = a;
  }
  if (!opts.tool) {
    return { error: 'a tool name is required (e.g. `mc tool-switch codex`)', json: opts.json };
  }
  if (!KNOWN_TOOL_NAMES.has(opts.tool)) {
    return {
      error: `unknown tool "${opts.tool}". Known: ${[...KNOWN_TOOL_NAMES].join(', ')}`,
      json: opts.json,
    };
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a tool name to its adapter module. Returns `{ adapter }` on
 * success or `{ error }` on miss. Pure — `adapters` is the same list
 * `defaultAdapterList()` returns plus the live module reference, so the
 * caller can call `getStatus()` on it.
 */
export function resolveTargetAdapter(name, adapters) {
  if (!name) return { error: 'tool name required' };
  const adapter = adapters.find((a) => a.id === name);
  if (!adapter) {
    return {
      error: `unknown tool "${name}". Known: ${adapters.map((a) => a.id).join(', ')}`,
    };
  }
  return { adapter };
}

/**
 * Decide whether the target is "ready enough" to become the default.
 *
 * Contract — matches the adapter `getStatus()` shape:
 *   - installed: boolean
 *   - authenticated: true | false | null  (null = can't headlessly verify)
 *   - hint: string (install or sign-in command — surfaced verbatim)
 *
 * Rules:
 *   - installed === false       → block, surface hint
 *   - authenticated === false   → block, surface hint
 *   - authenticated === null    → allow (some adapters, e.g. Codex, can't
 *                                  verify auth without launching the TUI;
 *                                  treat as a soft pass per §11a)
 *   - installed && authenticated truthy → allow
 *
 * Pure: input → decision. The caller emits the message.
 */
export function evaluateReadiness(status) {
  if (!status || status.installed === false) {
    return { ok: false, reason: 'not-installed', hint: status?.hint ?? null };
  }
  if (status.authenticated === false) {
    return { ok: false, reason: 'not-authenticated', hint: status?.hint ?? null };
  }
  // authenticated === true OR null — both pass.
  return { ok: true, authenticated: status.authenticated };
}

/**
 * Compose the switch plan — what would change in this invocation. Pure;
 * the caller decides whether to execute it (dry-run or live).
 *
 * @param {object} arg
 * @param {string} arg.target               - adapter id we're switching to
 * @param {string|null} arg.previous        - current persisted default (or null)
 * @returns {{ targetChanged: boolean, previous: string|null, current: string }}
 */
export function composeSwitchPlan({ target, previous }) {
  return {
    target,
    previous: previous ?? null,
    targetChanged: previous !== target,
  };
}

// ─────────────────────────────────────────────────────────────
// Impure verb body — driven by injected deps for testability
// ─────────────────────────────────────────────────────────────

/**
 * Default deps (injected in tests). Each external syscall is a portal so
 * test code can stub it without touching disk / spawning processes.
 *
 *   listAdapters         — async; returns descriptor list ({id, label,
 *                          instructions}) + module ref via `mod`. The
 *                          adapter modules are imported eagerly so
 *                          `getStatus` is callable.
 *   getStatusFor         — async; (adapterId) → adapter status shape
 *   syncDeps             — deps object passed to `runSyncWith` (so tests
 *                          can stub fs + canonical reads without going
 *                          to real disk)
 *   readDefaultTool      — async () → string|null
 *   writeDefaultTool     — async (toolId) → void
 *   runSync              — async (opts, deps) → exit code (delegates to
 *                          the existing `runSyncWith`)
 */
export function defaultDeps() {
  return {
    listAdapters: defaultAdaptersWithModules,
    getStatusFor: async (id) => {
      const mod = await loadAdapterModule(id);
      if (!mod?.getStatus) {
        // Phase-2 stub adapters (e.g. gemini-cli today) don't expose
        // getStatus. Surface that explicitly rather than masquerading
        // as "not installed".
        return {
          installed: false,
          version: null,
          authenticated: null,
          hint: `${id} adapter is a phase-2 stub — no status probe yet (plan §13f phase 5).`,
          detailLines: [],
        };
      }
      return mod.getStatus();
    },
    syncDeps: defaultSyncDeps(),
    readDefaultTool: async () => (await readConfig()).defaultTool ?? null,
    writeDefaultTool: async (id) => { await updateConfig({ defaultTool: id }); },
    runSync: (opts, deps) => runSyncWith(opts, deps),
  };
}

/**
 * Resolve adapter id → adapter module. Centralised so the
 * `defaultAdapterList` (descriptor list) and the live-module loader stay
 * in sync. Returns null for ids we don't know — caller maps to a clean
 * error in that case.
 */
async function loadAdapterModule(id) {
  if (id === 'claude-code')  return await import('../../adapters/claude-code.js');
  if (id === 'codex')        return await import('../../adapters/codex.js');
  if (id === 'gemini-cli')   return await import('../../adapters/gemini.js');
  return null;
}

async function defaultAdaptersWithModules() {
  // Re-uses the descriptor shape adapter-sync owns. We don't ship modules
  // here — the verb fetches them via `getStatusFor`, which keeps the
  // descriptor pure and small.
  return defaultAdapterList();
}

/**
 * In-process verb entry — same surface as `run` but with all deps
 * explicit. Tests drive this directly.
 */
export async function runSwitchWith(opts, deps) {
  const adapters = await deps.listAdapters();
  const resolution = resolveTargetAdapter(opts.tool, adapters);
  if (resolution.error) {
    return emitError(resolution.error, 2, opts);
  }
  const target = resolution.adapter;

  // ── Phase 2: readiness check ─────────────────────────────────────
  let status;
  try {
    status = await deps.getStatusFor(target.id);
  } catch (err) {
    return emitError(
      `failed to probe ${target.id}: ${err?.message ?? String(err)}`,
      1, opts,
    );
  }
  const ready = evaluateReadiness(status);
  if (!ready.ok) {
    const reasonMsg = ready.reason === 'not-installed'
      ? `${target.label} is not installed`
      : `${target.label} is not authenticated`;
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        error: reasonMsg,
        reason: ready.reason,
        hint: ready.hint ?? null,
        tool: target.id,
      }, null, 2));
    }
    // Always surface human-readable error on stderr too — the non-JSON
    // path is what the user sees (pattern: tests cover non-JSON error
    // paths too).
    console.error(`mc: ${reasonMsg}`);
    if (ready.hint) console.error(`    → ${ready.hint}`);
    return 1;
  }

  // ── Phase 3: compose plan (read previous default) ────────────────
  const previous = await deps.readDefaultTool();
  const plan = composeSwitchPlan({ target: target.id, previous });

  // ── Phase 4: run sync for the target tool ────────────────────────
  // Capture sync output so we can fold it into our own report shape.
  // The sync verb itself writes to stdout/stderr; we wrap it to keep
  // the surface composable. Drift on the target without --force exits 1
  // — we propagate that decision verbatim.
  const captured = await captureWrites(() =>
    deps.runSync(
      { tool: target.id, dryRun: opts.dryRun, force: opts.force, json: opts.json },
      deps.syncDeps,
    ),
  );
  if (captured.code === 2) {
    // sync misuse (e.g. missing canonical) — surface its message + bail.
    process.stderr.write(captured.stderr);
    if (opts.json && captured.stdout) process.stdout.write(captured.stdout);
    return 2;
  }
  if (captured.code === 1) {
    // sync refused (drift detected, target tool only). Print the sync
    // output verbatim and abort — don't flip the default.
    process.stdout.write(captured.stdout);
    process.stderr.write(captured.stderr);
    if (!opts.json) {
      process.stderr.write(`\nmc: refusing to switch to ${target.id} — target instruction file has drift. Re-run with --force to overwrite.\n`);
    }
    return 1;
  }

  // ── Phase 3 (write): persist the new default. Dry-run skips. ─────
  if (!opts.dryRun && plan.targetChanged) {
    try {
      await deps.writeDefaultTool(target.id);
    } catch (err) {
      return emitError(
        `failed to persist default tool: ${err?.message ?? String(err)}`,
        1, opts,
      );
    }
  }

  // ── Phase 5: drift surface across all tools ──────────────────────
  // Pure: re-use planSync directly (the same authority runSyncWith uses).
  // No writes; this is a read-only summary the user can act on.
  const allDrift = await computeAllToolsDrift(adapters, deps.syncDeps);

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      tool: target.id,
      previous: plan.previous,
      current: plan.target,
      target_changed: plan.targetChanged,
      dry_run: opts.dryRun,
      sync: { actions: extractSyncActions(captured.stdout, opts.json) },
      drift: allDrift,
    }, null, 2));
    return 0;
  }

  // Human-readable: print the sync block (already in captured.stdout),
  // then our own summary on top.
  printHumanReport({
    plan,
    targetLabel: target.label,
    dryRun: opts.dryRun,
    syncOutput: captured.stdout,
    drift: allDrift,
  });
  return 0;
}

function emitError(msg, code, opts) {
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  }
  console.error(`mc: ${msg}`);
  return code;
}

/**
 * Capture stdout / stderr written by a callee and return them as strings,
 * plus the callee's return code. Used so we can compose `runSyncWith`
 * inside this verb without its prints stomping our own structured output.
 *
 * Caveat: this is a process-global swap; tests that run in parallel within
 * the same process must not invoke this concurrently. `node --test` runs
 * each test as its own task — single-threaded within the file — so this
 * is safe for our test layout.
 */
async function captureWrites(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  const origError = console.error;
  process.stdout.write = (s) => { out.push(typeof s === 'string' ? s : s.toString()); return true; };
  process.stderr.write = (s) => { err.push(typeof s === 'string' ? s : s.toString()); return true; };
  console.log = (...args) => { out.push(args.join(' ') + '\n'); };
  console.error = (...args) => { err.push(args.join(' ') + '\n'); };
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
  }
}

/**
 * Compute drift across ALL tools (not just the target). Pure-ish: it
 * calls back into the same deps the sync verb uses for fs reads + the
 * canonical text, then runs the pure `planSync`. Returns a compact shape
 * for both --json and the human report.
 */
async function computeAllToolsDrift(adapters, syncDeps) {
  try {
    const root = syncDeps.repoRoot(syncDeps.cwd);
    const { join, isAbsolute } = await import('node:path');
    const canonicalAbs = join(root, CANONICAL_PATH);
    const canonicalContent = resolveCanonicalContent(syncDeps, canonicalAbs);
    if (canonicalContent == null) {
      return { ok: false, error: 'canonical source not found and no package canon is available', actions: [] };
    }
    const resolveWrapperPath = (rel) => isAbsolute(rel) ? rel : join(root, rel);
    const readWrapper = (abs) => comparableWrapperContent(syncDeps.readFileText(abs));
    const actions = planSync({
      adapters,
      canonicalPath: CANONICAL_PATH,
      canonicalContent,
      resolveWrapperPath,
      readWrapper,
    });
    return {
      ok: true,
      actions: actions.map((a) => ({
        tool: a.adapterId,
        path: a.wrapperPath,
        action: a.action,
        drift_state: a.driftState ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), actions: [] };
  }
}

/**
 * Try to recover the structured sync actions from its --json output so we
 * can attach them to our own --json envelope. Best-effort: if the parse
 * fails (e.g. sync printed human output), surface an empty array — the
 * cross-tool drift block has the same info anyway.
 */
function extractSyncActions(captured, jsonMode) {
  if (!jsonMode) return [];
  try {
    const parsed = JSON.parse(captured.trim());
    return parsed.actions ?? [];
  } catch {
    return [];
  }
}

function printHumanReport({ plan, targetLabel, dryRun, syncOutput, drift }) {
  const tag = dryRun ? ' [dry-run]' : '';
  process.stdout.write(`mc tool-switch${tag} — target: ${plan.target} (${targetLabel})\n\n`);

  if (plan.previous === plan.target) {
    process.stdout.write(`  · default tool already ${plan.target}; no change\n`);
  } else if (dryRun) {
    process.stdout.write(`  + would set default tool: ${plan.previous ?? '(unset)'} → ${plan.target}\n`);
  } else {
    process.stdout.write(`  ✓ default tool: ${plan.previous ?? '(unset)'} → ${plan.target}\n`);
  }

  // Sync block (verbatim from the inner verb — keeps its formatting).
  if (syncOutput && syncOutput.trim().length) {
    process.stdout.write(`\n${syncOutput}`);
    if (!syncOutput.endsWith('\n')) process.stdout.write('\n');
  }

  // Cross-tool drift surface.
  process.stdout.write(`\nCross-tool drift (from ${CANONICAL_PATH}):\n`);
  if (!drift.ok) {
    process.stdout.write(`  · could not compute (${drift.error})\n`);
    return;
  }
  for (const a of drift.actions) {
    const pathStr = a.path ? a.path.padEnd(20) : '(no wrapper)       '.padEnd(20);
    const id = (a.tool || '?').padEnd(14);
    if (a.action === 'noop')   process.stdout.write(`  ✓ ${id}${pathStr}up to date\n`);
    else if (a.action === 'create') process.stdout.write(`  + ${id}${pathStr}missing — run \`mc adapter sync\`\n`);
    else if (a.action === 'drift')  process.stdout.write(`  ✗ ${id}${pathStr}DRIFT (${a.drift_state})\n`);
    else if (a.action === 'skip')   process.stdout.write(`  · ${id}${pathStr}skipped\n`);
  }
}
