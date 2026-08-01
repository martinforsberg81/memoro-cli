/**
 * `mc tool-switch` — phase-3 portability (plan §13d).
 *
 * Coverage:
 *   - Pure helpers: parseArgs, resolveTargetAdapter, evaluateReadiness,
 *     composeSwitchPlan.
 *   - In-process verb (runSwitchWith with stubbed deps): happy path,
 *     each negative branch (unknown tool, tool-not-installed,
 *     not-authenticated, target-drift without --force, --force overrides,
 *     --dry-run does not persist), plus the cross-tool drift surface
 *     report.
 *   - Both --json and human-readable error paths covered (per the
 *     "tests cover non-JSON error paths too" pattern).
 *   - Subprocess wiring: `mc tool-switch --help` exits 0, missing
 *     positional exits 2 with a friendly message.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  resolveTargetAdapter,
  evaluateReadiness,
  composeSwitchPlan,
  runSwitchWith,
} from '../../src/cli/tool-switch.js';
import { runSyncWith as realRunSyncWith } from '../../src/cli/adapter.js';
import { markdownWrapperFor } from '../../src/mc/adapter-sync.js';
import { runMc } from './_helpers/cli.js';

// ─────────────────────────────────────────────────────────────
// parseArgs
// ─────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('accepts a known tool', () => {
    const r = parseArgs(['codex']);
    assert.equal(r.tool, 'codex');
    assert.equal(r.dryRun, false);
    assert.equal(r.force, false);
    assert.equal(r.json, false);
  });

  it('parses --dry-run / --force / --json in any order', () => {
    const r = parseArgs(['--dry-run', 'codex', '--force', '--json']);
    assert.equal(r.tool, 'codex');
    assert.equal(r.dryRun, true);
    assert.equal(r.force, true);
    assert.equal(r.json, true);
  });

  it('rejects a missing tool positional', () => {
    const r = parseArgs([]);
    assert.match(r.error, /tool name is required/);
  });

  it('rejects an unknown tool with a known-list hint', () => {
    const r = parseArgs(['bogus']);
    assert.match(r.error, /unknown tool "bogus"/);
    assert.match(r.error, /claude-code|codex|gemini-cli/);
  });

  it('rejects unknown flags', () => {
    const r = parseArgs(['--never-heard-of-it', 'codex']);
    assert.match(r.error, /unknown flag/);
  });

  it('rejects --here; existing sessions switch tool via mc open <name> --codex', () => {
    const r = parseArgs(['codex', '--here']);
    assert.match(r.error, /unknown flag: --here/);
  });

  it('rejects an extra positional', () => {
    const r = parseArgs(['codex', 'extra']);
    assert.match(r.error, /unexpected positional/);
  });

  it('preserves --json state even when an error is raised (so the dispatcher can emit JSON)', () => {
    const r = parseArgs(['--json', 'bogus']);
    assert.equal(r.json, true);
    assert.match(r.error, /unknown tool/);
  });
});

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

const ADAPTERS = [
  { id: 'claude-code', label: 'Claude Code',
    instructions: { path: 'CLAUDE.md', renderer: 'markdown-wrapper' } },
  { id: 'codex', label: 'Codex / GPT',
    instructions: { path: 'AGENTS.md', renderer: 'markdown-wrapper' } },
  { id: 'gemini-cli', label: 'Gemini CLI', instructions: null },
];

describe('resolveTargetAdapter', () => {
  it('returns the adapter on hit', () => {
    const r = resolveTargetAdapter('codex', ADAPTERS);
    assert.equal(r.adapter?.id, 'codex');
    assert.equal(r.error, undefined);
  });
  it('returns an error with the known-list on miss', () => {
    const r = resolveTargetAdapter('cursor', ADAPTERS);
    assert.match(r.error, /unknown tool "cursor"/);
    assert.match(r.error, /claude-code|codex/);
  });
  it('requires a name', () => {
    const r = resolveTargetAdapter('', ADAPTERS);
    assert.match(r.error, /required/);
  });
});

describe('evaluateReadiness', () => {
  it('accepts strict managed readiness evidence', () => {
    const r = evaluateReadiness({
      schema: 'mc-managed-provider-readiness/v1',
      ok: true,
      tool_id: 'codex',
      provider_adapter_id: 'codex-managed-local-v1',
      reason: null,
      hint: null,
    });
    assert.equal(r.ok, true);
    assert.equal(r.managed, true);
  });

  it('preserves a managed adapter refusal and its repair hint', () => {
    const r = evaluateReadiness({
      schema: 'mc-managed-provider-readiness/v1',
      ok: false,
      tool_id: 'gemini-cli',
      provider_adapter_id: null,
      reason: 'managed-provider-tool-unsupported',
      hint: 'No complete managed provider adapter is installed for this tool.',
    });
    assert.equal(r.ok, false);
    assert.equal(r.managed, true);
    assert.equal(r.reason, 'managed-provider-tool-unsupported');
    assert.match(r.hint, /complete managed provider adapter/);
  });

  it('rejects when not installed', () => {
    const r = evaluateReadiness({ installed: false, authenticated: null, hint: 'Install with: brew install foo' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-installed');
    assert.match(r.hint, /Install with/);
  });

  it('rejects when explicitly unauthenticated', () => {
    const r = evaluateReadiness({ installed: true, authenticated: false, hint: 'Run `foo login`' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-authenticated');
  });

  it('allows authenticated:null (some adapters cannot headlessly verify)', () => {
    const r = evaluateReadiness({ installed: true, authenticated: null });
    assert.equal(r.ok, true);
    assert.equal(r.authenticated, null);
  });

  it('allows fully-ready', () => {
    const r = evaluateReadiness({ installed: true, authenticated: true });
    assert.equal(r.ok, true);
  });

  it('rejects null status with sensible defaults', () => {
    const r = evaluateReadiness(null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-installed');
  });
});

describe('composeSwitchPlan', () => {
  it('detects a change', () => {
    const p = composeSwitchPlan({ target: 'codex', previous: 'claude-code' });
    assert.equal(p.targetChanged, true);
    assert.equal(p.previous, 'claude-code');
    assert.equal(p.target, 'codex');
  });
  it('detects no change when previous matches', () => {
    const p = composeSwitchPlan({ target: 'codex', previous: 'codex' });
    assert.equal(p.targetChanged, false);
  });
  it('handles null previous', () => {
    const p = composeSwitchPlan({ target: 'codex', previous: null });
    assert.equal(p.targetChanged, true);
    assert.equal(p.previous, null);
  });
});

// ─────────────────────────────────────────────────────────────
// runSwitchWith — in-process verb with stub deps
// ─────────────────────────────────────────────────────────────

const CANONICAL_REL = 'docs/coding-agent-protocol.md';
const CANONICAL_ABS = '/repo/' + CANONICAL_REL;
const CANONICAL_BODY = '# protocol\nbody\n';

/**
 * Build deps that mirror `defaultDeps()` shape but with everything
 * stubbed — no real fs, no real adapter modules, no real config writes.
 *
 * `files` is a virtual filesystem (abs-path → string content).
 * `statuses` is { adapterId: getStatus()-shape }.
 * `defaultTool` is the persisted default (null = unset).
 */
function makeDeps({
  files = {},
  adapters = ADAPTERS,
  statuses = {},
  defaultTool = null,
  packageCanon = null,
} = {}) {
  const writes = [];
  const configWrites = [];
  const state = { defaultTool };

  const syncDeps = {
    cwd: '/repo',
    repoRoot: () => '/repo',
    readFileText: (abs) => Object.prototype.hasOwnProperty.call(files, abs)
      ? files[abs]
      : null,
    readCanon: () => packageCanon,
    writeFileText: (abs, body) => { writes.push({ abs, body }); files[abs] = body; },
    listAdapters: async () => adapters,
  };

  // Real `runSyncWith` from adapter.js (the brief says "DO NOT
  // re-implement sync"). The syncDeps we pass are virtual, so it stays
  // hermetic.
  return {
    deps: {
      listAdapters: async () => adapters,
      getStatusFor: async (id) => statuses[id] ?? null,
      syncDeps,
      readDefaultTool: async () => state.defaultTool,
      writeDefaultTool: async (id) => { state.defaultTool = id; configWrites.push(id); },
      runSync: (opts, _syncDeps) => realRunSyncWith(opts, _syncDeps),
    },
    writes,
    configWrites,
    state,
    files,
  };
}

// stdout/stderr capture (same shape as the adapter-sync.test.js helper).
function captureStreams(fn) {
  const out = []; const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { out.push(typeof s === 'string' ? s : s.toString()); return true; };
  process.stderr.write = (s) => { err.push(typeof s === 'string' ? s : s.toString()); return true; };
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => { out.push(args.join(' ') + '\n'); };
  console.error = (...args) => { err.push(args.join(' ') + '\n'); };
  return fn().then((code) => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
    return { code, stdout: out.join(''), stderr: err.join('') };
  }, (e) => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
    throw e;
  });
}

// Ready statuses — Codex authenticated:null is the realistic shape.
const READY = {
  'claude-code': { installed: true, version: '2.1.0', authenticated: true, hint: null, detailLines: [] },
  'codex':       { installed: true, version: '0.5.0', authenticated: null, hint: null, detailLines: [] },
  'gemini-cli':  { installed: true, version: null,    authenticated: null, hint: null, detailLines: [] },
};

describe('runSwitchWith — happy path', () => {
  it('switches from claude-code → codex, persists default, writes AGENTS.md, exits 0', async () => {
    const { deps, writes, state } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: READY,
      defaultTool: 'claude-code',
    });
    const { code, stdout } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: false }, deps));
    assert.equal(code, 0, stdout);
    assert.equal(state.defaultTool, 'codex');
    // The sync inside the switch wrote AGENTS.md (CLAUDE.md is untouched
    // since --tool scopes the sync to codex).
    assert.deepEqual(writes.map(w => w.abs), ['/repo/AGENTS.md']);
    assert.match(stdout, /codex/);
    assert.match(stdout, /default tool/);
  });

  it('--json emits a parseable envelope with previous + current + drift', async () => {
    const { deps } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: READY,
      defaultTool: null,
    });
    const { code, stdout } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: true }, deps));
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tool, 'codex');
    assert.equal(parsed.previous, null);
    assert.equal(parsed.current, 'codex');
    assert.equal(parsed.target_changed, true);
    assert.ok(Array.isArray(parsed.drift.actions));
    // All three adapters should appear in the drift surface.
    const ids = parsed.drift.actions.map(a => a.tool).sort();
    assert.deepEqual(ids, ['claude-code', 'codex', 'gemini-cli']);
  });

  it('switching to the already-current tool is a no-op for the default but still syncs', async () => {
    const { deps, state } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: READY,
      defaultTool: 'codex',
    });
    const { code, stdout } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: false }, deps));
    assert.equal(code, 0);
    assert.equal(state.defaultTool, 'codex');
    assert.match(stdout, /already codex|no change/);
  });

  it('switches in an ordinary repo with no repo-local canonical by using package canon', async () => {
    const { deps, writes, state } = makeDeps({
      files: {},
      statuses: READY,
      defaultTool: 'claude-code',
      packageCanon: { protocol: CANONICAL_BODY },
    });
    const { code, stdout, stderr } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: false }, deps));
    assert.equal(code, 0, `stdout: ${stdout} stderr: ${stderr}`);
    assert.equal(state.defaultTool, 'codex');
    assert.deepEqual(writes.map((w) => w.abs), ['/repo/AGENTS.md']);
    assert.match(writes[0].body, /docs\/coding-agent-protocol\.md/);
  });
});

describe('runSwitchWith — refusals (not ready)', () => {
  it('tool-not-installed → exit 1, hint surfaced verbatim, no default flip, no writes', async () => {
    const { deps, writes, state } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: {
        ...READY,
        'codex': { installed: false, version: null, authenticated: null,
          hint: 'Install Codex CLI from openai/codex', detailLines: [] },
      },
      defaultTool: 'claude-code',
    });
    const { code, stdout, stderr } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: false }, deps));
    assert.equal(code, 1, `stdout: ${stdout} stderr: ${stderr}`);
    assert.equal(writes.length, 0);
    assert.equal(state.defaultTool, 'claude-code');
    // Crucial: human-readable error reaches stderr (not just --json).
    assert.match(stderr, /not installed/);
    assert.match(stderr, /Install Codex CLI/);
  });

  it('tool-not-installed --json → JSON shape on stdout AND human msg on stderr', async () => {
    const { deps } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: {
        ...READY,
        'codex': { installed: false, version: null, authenticated: null,
          hint: 'Install Codex CLI', detailLines: [] },
      },
    });
    const { code, stdout, stderr } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: true }, deps));
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'not-installed');
    assert.equal(parsed.tool, 'codex');
    assert.match(parsed.hint, /Install Codex/);
    // Stderr still carries the human-readable summary so non-JSON
    // consumers (e.g. piping --json | jq while watching stderr) still see it.
    assert.match(stderr, /not installed/);
  });

  it('explicitly unauthenticated → exit 1, reason="not-authenticated"', async () => {
    const { deps } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: {
        ...READY,
        'claude-code': { installed: true, version: '2.1', authenticated: false,
          hint: 'Run `claude` and complete sign-in', detailLines: [] },
      },
    });
    const { code, stderr } = await captureStreams(() =>
      runSwitchWith({ tool: 'claude-code', dryRun: false, force: false, json: false }, deps));
    assert.equal(code, 1);
    assert.match(stderr, /not authenticated/);
    assert.match(stderr, /sign-in/);
  });

  it('authenticated:null still passes (Codex-style)', async () => {
    const { deps, state } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: READY,
    });
    const { code } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: false }, deps));
    assert.equal(code, 0);
    assert.equal(state.defaultTool, 'codex');
  });
});

describe('runSwitchWith — drift warnings', () => {
  it('persists the default but does not overwrite the target wrapper when it has drift', async () => {
    const { deps, writes, state } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/AGENTS.md': '# I hand-edited this\n',
      },
      statuses: READY,
      defaultTool: 'claude-code',
    });
    const { code, stdout, stderr } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: false }, deps));
    assert.equal(code, 0, `stdout: ${stdout} stderr: ${stderr}`);
    assert.equal(writes.length, 0);
    assert.equal(state.defaultTool, 'codex');
    // The drift surface (from the inner sync) reaches stdout.
    assert.match(stdout, /DRIFT/);
    // The switch wrapper adds its own --force pointer without making
    // wrapper drift look like a failed default switch.
    assert.match(stdout, /default tool/);
    assert.match(stdout, /--force/);
    assert.equal(stderr, '');
  });

  it('--json reports sync refusal while still reporting a successful switch', async () => {
    const { deps, state } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/AGENTS.md': '# I hand-edited this\n',
      },
      statuses: READY,
      defaultTool: 'claude-code',
    });
    const { code, stdout } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: true }, deps));
    assert.equal(code, 0);
    assert.equal(state.defaultTool, 'codex');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.current, 'codex');
    assert.equal(parsed.sync.ok, false);
    assert.equal(parsed.sync.refused, true);
    assert.match(parsed.sync.warning, /--force/);
  });

  it('--force overwrites target drift and flips default', async () => {
    const { deps, writes, state } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/AGENTS.md': '# I hand-edited this\n',
      },
      statuses: READY,
      defaultTool: 'claude-code',
    });
    const { code } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: true, json: false }, deps));
    assert.equal(code, 0);
    assert.equal(state.defaultTool, 'codex');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].abs, '/repo/AGENTS.md');
  });
});

describe('runSwitchWith — --dry-run', () => {
  it('does not flip default, does not write, but reports the plan', async () => {
    const { deps, writes, state } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: READY,
      defaultTool: 'claude-code',
    });
    const { code, stdout } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: true, force: false, json: false }, deps));
    assert.equal(code, 0);
    assert.equal(state.defaultTool, 'claude-code');
    assert.equal(writes.length, 0);
    assert.match(stdout, /would set default/);
  });

  it('--dry-run --json carries dry_run:true and target_changed:true', async () => {
    const { deps } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      statuses: READY,
      defaultTool: 'claude-code',
    });
    const { stdout } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: true, force: false, json: true }, deps));
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.target_changed, true);
  });

  it('--dry-run with target drift still reports the default switch plan', async () => {
    const { deps, writes, state } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/AGENTS.md': '# I hand-edited this\n',
      },
      statuses: READY,
      defaultTool: 'claude-code',
    });
    const { code, stdout } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: true, force: false, json: false }, deps));
    assert.equal(code, 0);
    assert.equal(state.defaultTool, 'claude-code');
    assert.equal(writes.length, 0);
    assert.match(stdout, /would set default/);
    assert.match(stdout, /--force/);
  });

  it('works in an ordinary repo with no repo-local canonical by using package canon', async () => {
    const { deps, writes, state } = makeDeps({
      files: {},
      statuses: READY,
      defaultTool: 'claude-code',
      packageCanon: { protocol: CANONICAL_BODY },
    });
    const { code, stdout, stderr } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: true, force: false, json: true }, deps));
    assert.equal(code, 0, `stdout: ${stdout} stderr: ${stderr}`);
    assert.equal(writes.length, 0);
    assert.equal(state.defaultTool, 'claude-code');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tool, 'codex');
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.drift.ok, true);
    const codex = parsed.sync.actions.find((a) => a.adapter === 'codex');
    assert.equal(codex.action, 'create');
  });
});

describe('runSwitchWith — cross-tool drift surface', () => {
  it('reports up-to-date for tools whose wrapper matches', async () => {
    const expectedAgents = markdownWrapperFor({
      canonicalPath: CANONICAL_REL,
      canonicalContent: CANONICAL_BODY,
      toolLabel: 'Codex / GPT',
      wrapperPath: 'AGENTS.md',
    });
    const { deps } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/AGENTS.md': expectedAgents,
      },
      statuses: READY,
    });
    const { code, stdout } = await captureStreams(() =>
      runSwitchWith({ tool: 'codex', dryRun: false, force: false, json: true }, deps));
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    const codex = parsed.drift.actions.find(a => a.tool === 'codex');
    assert.equal(codex.action, 'noop');
    const claude = parsed.drift.actions.find(a => a.tool === 'claude-code');
    assert.equal(claude.action, 'create'); // missing on disk
    const gemini = parsed.drift.actions.find(a => a.tool === 'gemini-cli');
    assert.equal(gemini.action, 'skip');
  });
});

// ─────────────────────────────────────────────────────────────
// Subprocess wiring — bin-mc.js dispatch glue only
// ─────────────────────────────────────────────────────────────

describe('mc tool-switch — subprocess wiring', () => {
  it('`mc tool-switch --help` exits 0 with usage', () => {
    const r = runMc(['tool-switch', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mc tool-switch/);
    assert.match(r.stdout, /USAGE/);
    assert.doesNotMatch(r.stdout, /--here/);
    assert.match(r.stdout, /mc open <name> --codex/);
  });

  it('`mc tool-switch` (no positional) exits 2 with friendly error', () => {
    const r = runMc(['tool-switch']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /tool name is required/);
  });

  it('`mc tool-switch bogus` exits 2 with known-list hint', () => {
    const r = runMc(['tool-switch', 'bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown tool/);
    assert.match(r.stderr, /claude-code|codex|gemini-cli/);
  });

  it('`mc tool-switch --neverflag codex` exits 2 (unknown flag)', () => {
    const r = runMc(['tool-switch', '--neverflag', 'codex']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });
});
