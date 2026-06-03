/**
 * `mc adapter sync` — phase-2 portability (plan §13c).
 *
 * Coverage:
 *   - Pure helpers: markdownWrapperFor, computeStamp, extractStamp,
 *     detectDrift, planSync, summariseDrift.
 *   - In-process verb (runSyncWith with stubbed deps): happy paths +
 *     each negative branch (drift, --force, --dry-run, --tool, unknown
 *     tool, missing canonical, non-JSON error path).
 *   - Subprocess wiring: `mc adapter` reaches the verb, exit codes
 *     propagate, --help is friendly, unknown subcommand exits 2.
 *
 * Why in-process for most: file-system effects + canonical-content
 * variation are easier to drive through injected stubs than through a
 * temp git repo for every case. Subprocess tests still pin the bin
 * dispatch glue.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  markdownWrapperFor,
  computeStamp,
  extractStamp,
  detectDrift,
  planSync,
  summariseDrift,
  KNOWN_TOOL_NAMES,
} from '../../src/mc/adapter-sync.js';
import {
  parseSyncArgs,
  runSyncWith,
} from '../../src/mc/commands/adapter.js';
import {
  instructionsFile as claudeInstructions,
} from '../../src/adapters/claude-code.js';
import {
  instructionsFile as codexInstructions,
} from '../../src/adapters/codex.js';
import * as gemini from '../../src/adapters/gemini.js';
import { runMc } from './_helpers/cli.js';

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

describe('computeStamp', () => {
  it('produces a 12-char lowercase hex prefix of sha256', () => {
    const stamp = computeStamp('hello\n');
    assert.equal(stamp.length, 12);
    assert.match(stamp, /^[0-9a-f]{12}$/);
  });

  it('is deterministic — same input, same stamp', () => {
    assert.equal(computeStamp('payload'), computeStamp('payload'));
  });

  it('differs when content changes (avalanche)', () => {
    assert.notEqual(computeStamp('payload'), computeStamp('payload '));
  });

  it('throws on non-string input', () => {
    assert.throws(() => computeStamp(null));
    assert.throws(() => computeStamp(undefined));
    assert.throws(() => computeStamp(123));
  });
});

describe('markdownWrapperFor', () => {
  const base = {
    canonicalPath: 'docs/coding-agent-protocol.md',
    canonicalContent: '# canonical\nbody\n',
    toolLabel: 'Claude Code',
    wrapperPath: 'CLAUDE.md',
  };

  it('returns a deterministic string', () => {
    const a = markdownWrapperFor(base);
    const b = markdownWrapperFor(base);
    assert.equal(a, b);
  });

  it('embeds the canonical path as a markdown link', () => {
    const out = markdownWrapperFor(base);
    assert.match(out, /\[`docs\/coding-agent-protocol\.md`\]\(docs\/coding-agent-protocol\.md\)/);
  });

  it('embeds the tool label and wrapper path in the heading', () => {
    const out = markdownWrapperFor(base);
    assert.match(out, /# CLAUDE\.md/);
    assert.match(out, /Claude Code/);
  });

  it('embeds the 12-char canonical-content stamp in a comment', () => {
    const out = markdownWrapperFor(base);
    const stamp = computeStamp(base.canonicalContent);
    assert.ok(out.includes(`<!-- mc-adapter-sync:version=${stamp} -->`));
  });

  it('throws on missing required args', () => {
    assert.throws(() => markdownWrapperFor({ ...base, canonicalPath: '' }));
    assert.throws(() => markdownWrapperFor({ ...base, toolLabel: '' }));
    assert.throws(() => markdownWrapperFor({ ...base, wrapperPath: '' }));
    assert.throws(() => markdownWrapperFor({ ...base, canonicalContent: 42 }));
  });
});

describe('extractStamp', () => {
  it('returns the stamp when present', () => {
    const body = '# X\n\n<!-- mc-adapter-sync:version=abcdef012345 -->\n';
    assert.equal(extractStamp(body), 'abcdef012345');
  });

  it('returns null when no stamp is present', () => {
    assert.equal(extractStamp('# nothing here'), null);
  });

  it('returns null on non-string', () => {
    assert.equal(extractStamp(null), null);
    assert.equal(extractStamp(undefined), null);
  });
});

describe('detectDrift', () => {
  const canonicalContent = '# canonical\n';
  const expected = markdownWrapperFor({
    canonicalPath: 'docs/coding-agent-protocol.md',
    canonicalContent,
    toolLabel: 'Claude Code',
    wrapperPath: 'CLAUDE.md',
  });

  it('missing → state="missing"', () => {
    const d = detectDrift({ existing: null, expected, canonicalContent });
    assert.equal(d.state, 'missing');
    assert.equal(d.stamp, null);
    assert.equal(d.expectedStamp, computeStamp(canonicalContent));
  });

  it('byte-equal → state="up-to-date"', () => {
    const d = detectDrift({ existing: expected, expected, canonicalContent });
    assert.equal(d.state, 'up-to-date');
    assert.equal(d.stamp, d.expectedStamp);
  });

  it('stamp matches current canonical but content differs → "drift-edited"', () => {
    // Embed the *current* stamp but otherwise hand-edited content.
    const stamp = computeStamp(canonicalContent);
    const hacked = `# Something else\n\n<!-- mc-adapter-sync:version=${stamp} -->\n`;
    const d = detectDrift({ existing: hacked, expected, canonicalContent });
    assert.equal(d.state, 'drift-edited');
    assert.equal(d.stamp, stamp);
  });

  it('stamp missing or stale → "drift-stale"', () => {
    const noStamp = '# old hand-written wrapper\n';
    const d1 = detectDrift({ existing: noStamp, expected, canonicalContent });
    assert.equal(d1.state, 'drift-stale');
    assert.equal(d1.stamp, null);

    const staleStamp = '<!-- mc-adapter-sync:version=000000000000 -->\n';
    const d2 = detectDrift({ existing: staleStamp, expected, canonicalContent });
    assert.equal(d2.state, 'drift-stale');
    assert.equal(d2.stamp, '000000000000');
  });
});

describe('planSync', () => {
  const canonicalContent = '# canonical\n';
  const canonicalPath = 'docs/coding-agent-protocol.md';

  function makeReadStub(filesByPath) {
    return (abs) => Object.prototype.hasOwnProperty.call(filesByPath, abs)
      ? filesByPath[abs]
      : null;
  }

  it('clean state → action="create" per adapter', () => {
    const actions = planSync({
      adapters: [
        { id: 'claude-code', label: 'Claude Code',
          instructions: { path: 'CLAUDE.md', renderer: 'markdown-wrapper' } },
        { id: 'codex', label: 'Codex / GPT',
          instructions: { path: 'AGENTS.md', renderer: 'markdown-wrapper' } },
      ],
      canonicalPath,
      canonicalContent,
      resolveWrapperPath: (p) => `/repo/${p}`,
      readWrapper: makeReadStub({}),
    });
    assert.equal(actions.length, 2);
    for (const a of actions) {
      assert.equal(a.action, 'create');
      assert.equal(a.driftState, 'missing');
      assert.ok(a.expectedContent.includes(canonicalPath));
    }
  });

  it('idempotent — re-run after a write reports "noop"', () => {
    const expected = markdownWrapperFor({
      canonicalPath, canonicalContent,
      toolLabel: 'Claude Code', wrapperPath: 'CLAUDE.md',
    });
    const actions = planSync({
      adapters: [
        { id: 'claude-code', label: 'Claude Code',
          instructions: { path: 'CLAUDE.md', renderer: 'markdown-wrapper' } },
      ],
      canonicalPath,
      canonicalContent,
      resolveWrapperPath: (p) => `/repo/${p}`,
      readWrapper: makeReadStub({ '/repo/CLAUDE.md': expected }),
    });
    assert.equal(actions[0].action, 'noop');
    assert.equal(actions[0].driftState, 'up-to-date');
  });

  it('hand-edited file → action="drift"', () => {
    const actions = planSync({
      adapters: [
        { id: 'claude-code', label: 'Claude Code',
          instructions: { path: 'CLAUDE.md', renderer: 'markdown-wrapper' } },
      ],
      canonicalPath,
      canonicalContent,
      resolveWrapperPath: (p) => `/repo/${p}`,
      readWrapper: makeReadStub({ '/repo/CLAUDE.md': '# hand-written\n' }),
    });
    assert.equal(actions[0].action, 'drift');
    assert.equal(actions[0].driftState, 'drift-stale');
  });

  it('null instructions → "skip" with reason', () => {
    const actions = planSync({
      adapters: [
        { id: 'gemini-cli', label: 'Gemini CLI', instructions: null },
      ],
      canonicalPath,
      canonicalContent,
      resolveWrapperPath: (p) => `/repo/${p}`,
      readWrapper: makeReadStub({}),
    });
    assert.equal(actions[0].action, 'skip');
    assert.match(actions[0].reason, /instructionsFile/);
  });

  it('unknown renderer → "skip" with reason', () => {
    const actions = planSync({
      adapters: [
        { id: 'cursor', label: 'Cursor',
          instructions: { path: '.cursor/rules/x.mdc', renderer: 'cursor-mdc' } },
      ],
      canonicalPath,
      canonicalContent,
      resolveWrapperPath: (p) => `/repo/${p}`,
      readWrapper: makeReadStub({}),
    });
    assert.equal(actions[0].action, 'skip');
    assert.match(actions[0].reason, /unsupported renderer/);
  });
});

describe('summariseDrift', () => {
  it('reports first-N differing lines', () => {
    const out = summariseDrift({
      expected: 'a\nb\nc\nd\n',
      existing: 'a\nX\nc\nY\n',
      maxLines: 99,
    });
    const joined = out.join('\n');
    assert.match(joined, /line 2/);
    assert.match(joined, /expected: b/);
    assert.match(joined, /got:.*X/);
    assert.match(joined, /line 4/);
  });

  it('handles file-missing gracefully', () => {
    const out = summariseDrift({ expected: 'a\n', existing: null });
    assert.deepEqual(out, ['(file missing)']);
  });

  it('returns a benign note for whitespace-only differences', () => {
    // Same lines, identical char-for-char — covers the empty-diff branch.
    const out = summariseDrift({ expected: 'a\n', existing: 'a\n' });
    assert.match(out[0], /whitespace-only|trailing/);
  });
});

// ─────────────────────────────────────────────────────────────
// Adapter contract — instructionsFile() on each
// ─────────────────────────────────────────────────────────────

describe('instructionsFile() — adapter contract extension', () => {
  it('claude-code → CLAUDE.md + markdown-wrapper', () => {
    assert.deepEqual(claudeInstructions(), {
      path: 'CLAUDE.md',
      renderer: 'markdown-wrapper',
    });
  });

  it('codex → AGENTS.md + markdown-wrapper', () => {
    assert.deepEqual(codexInstructions(), {
      path: 'AGENTS.md',
      renderer: 'markdown-wrapper',
    });
  });

  it('gemini stub → null (phase 2 deliberate uncertainty)', () => {
    assert.equal(gemini.instructionsFile(), null);
  });
});

// ─────────────────────────────────────────────────────────────
// parseSyncArgs
// ─────────────────────────────────────────────────────────────

describe('parseSyncArgs', () => {
  it('accepts no args', () => {
    assert.deepEqual(parseSyncArgs([]), {
      tool: null, dryRun: false, force: false, json: false,
    });
  });

  it('parses --dry-run, --force, --json', () => {
    const opts = parseSyncArgs(['--dry-run', '--force', '--json']);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.force, true);
    assert.equal(opts.json, true);
  });

  it('parses --tool <name>', () => {
    assert.equal(parseSyncArgs(['--tool', 'claude-code']).tool, 'claude-code');
    assert.equal(parseSyncArgs(['--tool=codex']).tool, 'codex');
  });

  it('rejects --tool with missing value', () => {
    const r = parseSyncArgs(['--tool']);
    assert.match(r.error, /--tool/);
  });

  it('rejects --tool with value that looks like a flag', () => {
    const r = parseSyncArgs(['--tool', '--dry-run']);
    assert.match(r.error, /--tool/);
  });

  it('rejects unknown --tool name with a helpful list', () => {
    const r = parseSyncArgs(['--tool', 'bogus']);
    assert.match(r.error, /unknown --tool/);
    assert.match(r.error, /claude-code|codex|gemini/);
  });

  it('rejects unknown flag', () => {
    const r = parseSyncArgs(['--never-heard-of-it']);
    assert.match(r.error, /unknown flag/);
  });

  it('KNOWN_TOOL_NAMES is the union of registered adapter IDs', () => {
    assert.ok(KNOWN_TOOL_NAMES.has('claude-code'));
    assert.ok(KNOWN_TOOL_NAMES.has('codex'));
    assert.ok(KNOWN_TOOL_NAMES.has('gemini-cli'));
  });
});

// ─────────────────────────────────────────────────────────────
// runSyncWith — in-process verb with stub deps
// ─────────────────────────────────────────────────────────────

function makeDeps({ files = {}, adapters }) {
  const writes = [];
  const dep = {
    cwd: '/repo',
    repoRoot: () => '/repo',
    readFileText: (abs) => Object.prototype.hasOwnProperty.call(files, abs)
      ? files[abs]
      : null,
    writeFileText: (abs, body) => { writes.push({ abs, body }); files[abs] = body; },
    listAdapters: async () => adapters,
  };
  return { dep, writes, files };
}

const CANONICAL_REL = 'docs/coding-agent-protocol.md';
const CANONICAL_ABS = '/repo/' + CANONICAL_REL;
const CANONICAL_BODY = '# protocol\nbody\n';

const FULL_ADAPTERS = [
  { id: 'claude-code', label: 'Claude Code',
    instructions: { path: 'CLAUDE.md', renderer: 'markdown-wrapper' } },
  { id: 'codex', label: 'Codex / GPT',
    instructions: { path: 'AGENTS.md', renderer: 'markdown-wrapper' } },
  { id: 'gemini-cli', label: 'Gemini CLI', instructions: null },
];

// stdout/stderr capture
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

describe('runSyncWith — clean state', () => {
  it('writes both wrapper files and exits 0', async () => {
    const { dep, writes } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      adapters: FULL_ADAPTERS,
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 0, stdout);
    assert.equal(writes.length, 2);
    const wrote = writes.map((w) => w.abs).sort();
    assert.deepEqual(wrote, ['/repo/AGENTS.md', '/repo/CLAUDE.md']);
    assert.match(stdout, /CLAUDE\.md/);
    assert.match(stdout, /AGENTS\.md/);
    assert.match(stdout, /created/);
  });

  it('--json branch emits a parseable object', async () => {
    const { dep } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      adapters: FULL_ADAPTERS,
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: true }, dep));
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.canonical, CANONICAL_REL);
    assert.equal(parsed.written.length, 2);
    assert.equal(parsed.actions.length, 3);
  });
});

describe('runSyncWith — idempotency', () => {
  it('re-run on already-synced files writes nothing and exits 0', async () => {
    // Pre-populate the wrappers with the exact expected content.
    const expectedC = markdownWrapperFor({
      canonicalPath: CANONICAL_REL, canonicalContent: CANONICAL_BODY,
      toolLabel: 'Claude Code', wrapperPath: 'CLAUDE.md',
    });
    const expectedA = markdownWrapperFor({
      canonicalPath: CANONICAL_REL, canonicalContent: CANONICAL_BODY,
      toolLabel: 'Codex / GPT', wrapperPath: 'AGENTS.md',
    });
    const { dep, writes } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/CLAUDE.md': expectedC,
        '/repo/AGENTS.md': expectedA,
      },
      adapters: FULL_ADAPTERS,
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(writes.length, 0);
    assert.match(stdout, /up to date/);
  });
});

describe('runSyncWith — drift handling', () => {
  it('hand-edited wrapper without --force → exit 1, no writes', async () => {
    const { dep, writes } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/CLAUDE.md': '# I hand-edited this\n',
      },
      adapters: [FULL_ADAPTERS[0]],
    });
    const { code, stdout, stderr } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 1, `stderr: ${stderr} stdout: ${stdout}`);
    assert.equal(writes.length, 0);
    // The user-readable output (non-JSON) must surface the drift on stdout.
    assert.match(stdout, /DRIFT/);
    assert.match(stdout, /--force/);
  });

  it('--force overwrites drift, exits 0', async () => {
    const { dep, writes } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/CLAUDE.md': '# I hand-edited this\n',
      },
      adapters: [FULL_ADAPTERS[0]],
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: true, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(writes.length, 1);
    assert.match(stdout, /overwritten/);
  });

  it('--dry-run with drift → exit 1, no writes, drift surfaced', async () => {
    const { dep, writes } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/CLAUDE.md': '# hand\n',
      },
      adapters: [FULL_ADAPTERS[0]],
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: true, force: false, json: false }, dep));
    assert.equal(code, 1);
    assert.equal(writes.length, 0);
    assert.match(stdout, /DRIFT/);
  });

  it('--dry-run with --force previews overwrite but writes nothing', async () => {
    const { dep, writes } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/CLAUDE.md': '# hand\n',
      },
      adapters: [FULL_ADAPTERS[0]],
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: true, force: true, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(writes.length, 0);
    assert.match(stdout, /would overwrite/);
  });

  it('--json drift surfaces actions with drift_state for machine consumers', async () => {
    const { dep } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/CLAUDE.md': '# hand\n',
      },
      adapters: [FULL_ADAPTERS[0]],
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: true }, dep));
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.actions[0].action, 'drift');
    assert.equal(parsed.actions[0].drift_state, 'drift-stale');
  });
});

// ─────────────────────────────────────────────────────────────
// Drift-strip (Phase 2): a per-session grounding managed block in the
// wrapper is NOT adapter-sync canon, so it must be stripped BEFORE the
// byte-compare. Otherwise every grounded session would report its own
// CLAUDE.md as drift on the next `mc adapter sync`. The strip must be
// symmetric with how claude-code's writeGrounding writes the block
// (same markers) — verified here against the real markers + a real
// on-disk-shaped wrapper, not just a hand-rolled fixture.
// ─────────────────────────────────────────────────────────────

describe('runSyncWith — grounding block is not drift', () => {
  // Build the *exact* expected wrapper, then graft a grounding managed
  // block onto it (as a live grounded session would). Sync must see
  // "up to date", write nothing, exit 0.
  function wrapperWithGrounding() {
    const expected = markdownWrapperFor({
      canonicalPath: CANONICAL_REL, canonicalContent: CANONICAL_BODY,
      toolLabel: 'Claude Code', wrapperPath: 'CLAUDE.md',
    });
    const grounding = [
      '<!-- memoro:managed:grounding:begin -->',
      '# Session grounding',
      '',
      '## Your role',
      'You are the orchestrator.',
      '<!-- memoro:managed:grounding:end -->',
    ].join('\n');
    return expected + '\n' + grounding + '\n';
  }

  it('treats expected-wrapper + grounding block as up-to-date (no drift)', async () => {
    const { dep, writes } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/CLAUDE.md': wrapperWithGrounding(),
      },
      adapters: [FULL_ADAPTERS[0]],
    });
    const { code, stdout, stderr } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 0, `stderr:${stderr} stdout:${stdout}`);
    assert.equal(writes.length, 0, 'a grounding block must not trigger a re-write');
    assert.match(stdout, /up to date/);
    assert.ok(!/DRIFT/.test(stdout), 'grounding block must not be reported as drift');
  });

  it('still detects a genuine hand-edit even with a grounding block present', async () => {
    const handEdited = '# I hand-edited the wrapper\n'
      + '<!-- memoro:managed:grounding:begin -->\nbody\n<!-- memoro:managed:grounding:end -->\n';
    const { dep, writes } = makeDeps({
      files: {
        [CANONICAL_ABS]: CANONICAL_BODY,
        '/repo/CLAUDE.md': handEdited,
      },
      adapters: [FULL_ADAPTERS[0]],
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 1, 'real drift outside the grounding block must still be caught');
    assert.equal(writes.length, 0);
    assert.match(stdout, /DRIFT/);
  });
});

describe('runSyncWith — --tool scoping', () => {
  it('--tool claude-code only touches CLAUDE.md', async () => {
    const { dep, writes } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      adapters: FULL_ADAPTERS,
    });
    const { code } = await captureStreams(() =>
      runSyncWith({ tool: 'claude-code', dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].abs, '/repo/CLAUDE.md');
  });

  it('--tool gemini-cli with null instructions is a no-op skip (still exits 0)', async () => {
    const { dep, writes } = makeDeps({
      files: { [CANONICAL_ABS]: CANONICAL_BODY },
      adapters: FULL_ADAPTERS,
    });
    const { code, stdout } = await captureStreams(() =>
      runSyncWith({ tool: 'gemini-cli', dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(writes.length, 0);
    assert.match(stdout, /skipped/);
  });
});

describe('runSyncWith — missing canonical source', () => {
  it('emits a non-JSON stderr error and exits 2', async () => {
    const { dep } = makeDeps({ files: {}, adapters: FULL_ADAPTERS });
    const { code, stderr, stdout } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 2);
    // **Crucial per the test-only-JSON anti-pattern:** the non-JSON
    // error path must surface a friendly message on stderr.
    assert.match(stderr, /canonical source not found/);
    assert.equal(stdout, '');
  });

  it('--json also surfaces the error in machine-readable form', async () => {
    const { dep } = makeDeps({ files: {}, adapters: FULL_ADAPTERS });
    const { code, stdout, stderr } = await captureStreams(() =>
      runSyncWith({ tool: null, dryRun: false, force: false, json: true }, dep));
    assert.equal(code, 2);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /canonical source not found/);
    assert.match(stderr, /canonical source not found/);
  });
});

// ─────────────────────────────────────────────────────────────
// Subprocess wiring — dispatch glue only
// ─────────────────────────────────────────────────────────────

describe('mc adapter — subprocess wiring', () => {
  it('`mc adapter --help` exits 0 with the usage block', () => {
    const r = runMc(['adapter', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mc adapter — tool-portability operations/);
    assert.match(r.stdout, /sync/);
  });

  it('`mc adapter` with no subcommand prints help and exits 2', () => {
    const r = runMc(['adapter']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /mc adapter/);
  });

  it('`mc adapter bogus` exits 2 with a helpful error', () => {
    const r = runMc(['adapter', 'bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown adapter subcommand/);
  });

  it('`mc adapter sync --tool nope` exits 2 (unknown tool) — non-JSON error reaches stderr', () => {
    const r = runMc(['adapter', 'sync', '--tool', 'nope']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown --tool/);
  });

  it('`mc adapter sync --neverflag` exits 2 (unknown flag)', () => {
    const r = runMc(['adapter', 'sync', '--neverflag']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });
});
