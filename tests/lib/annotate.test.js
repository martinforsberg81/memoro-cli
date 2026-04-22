/**
 * Tests for client-side annotation detectors. Each detector is pure —
 * inputs are raw JSONL entries or parsed-transcript output, no filesystem
 * or network access (except readRepoManifest which is tested against a
 * tmp dir).
 *
 * See docs/plans/coding-profile.md.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAnnotations,
  detectLanguages,
  detectFrameworks,
  detectBuildTools,
  detectPackageManager,
  collectToolUseStats,
  estimateFilesTouched,
  computeDurationMinutes,
  extractCommitRefs,
  extractSlashCommands,
  extractTestCommands,
  readRepoManifest,
} from '../../src/lib/annotate.js';

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

function toolUseEntry(name, input) {
  return {
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, input }],
    },
  };
}

function textEntry(role, content) {
  return {
    message: { role, content: [{ type: 'text', text: content }] },
  };
}

function userCommand(slash) {
  return {
    message: { role: 'user', content: `<command-name>${slash}</command-name>\n<command-message>ignored</command-message>` },
  };
}

// ─────────────────────────────────────────────────────────────
// Language detection
// ─────────────────────────────────────────────────────────────

describe('detectLanguages', () => {
  test('ranks by tool_use file_path extensions and returns shares summing to ~1', () => {
    const entries = [
      toolUseEntry('Read',  { file_path: 'src/foo.js' }),
      toolUseEntry('Edit',  { file_path: 'src/bar.js' }),
      toolUseEntry('Write', { file_path: 'src/baz.ts' }),
      toolUseEntry('Read',  { file_path: 'migrations/0001.sql' }),
    ];
    const out = detectLanguages(entries);
    assert.equal(out[0].lang, 'javascript');
    // 2/4 = 0.5
    assert.equal(out[0].share, 0.5);
    // Total share ≈ 1
    const total = out.reduce((s, e) => s + e.share, 0);
    assert.ok(Math.abs(total - 1) < 0.05, `total share ${total}`);
  });

  test('counts code-block tags in assistant text', () => {
    const entries = [
      textEntry('assistant', 'Here is some code:\n```python\nprint(1)\n```\nAnd:\n```rust\nfn main() {}\n```'),
    ];
    const langs = detectLanguages(entries).map(l => l.lang);
    assert.ok(langs.includes('python'));
    assert.ok(langs.includes('rust'));
  });

  test('returns empty array when nothing looks like code', () => {
    assert.deepEqual(detectLanguages([]), []);
    assert.deepEqual(detectLanguages([textEntry('user', 'plain chat')]), []);
  });
});

// ─────────────────────────────────────────────────────────────
// Framework + build tool detection
// ─────────────────────────────────────────────────────────────

describe('detectFrameworks', () => {
  test('matches signatures in tool_use inputs only (ignores assistant prose)', () => {
    const entries = [
      toolUseEntry('Edit', {
        file_path: 'src/index.ts',
        new_string: "import { Hono } from 'hono'\nexport default app",
      }),
      toolUseEntry('Bash', { command: 'wrangler deploy' }),
      // Prose mentioning a framework must NOT count — users often discuss
      // frameworks they don't actually use.
      textEntry('assistant', "You could use `from 'react'` if you wanted."),
    ];
    const frameworks = detectFrameworks(entries);
    assert.ok(frameworks.includes('cloudflare-workers'));
    assert.ok(frameworks.includes('hono'));
    assert.ok(!frameworks.includes('react'), 'react should not match from prose alone');
  });
});

describe('detectBuildTools / detectPackageManager', () => {
  test('picks up npm and wrangler from Bash commands', () => {
    const entries = [
      toolUseEntry('Bash', { command: 'npm install foo' }),
      toolUseEntry('Bash', { command: 'wrangler dev' }),
      toolUseEntry('Bash', { command: 'cargo test' }),
    ];
    const tools = detectBuildTools(entries);
    assert.ok(tools.includes('npm'));
    assert.ok(tools.includes('wrangler'));
    assert.ok(tools.includes('cargo'));
    // detectPackageManager prefers pnpm>yarn>bun>npm, so here npm wins
    assert.equal(detectPackageManager(entries), 'npm');
  });

  test('prefers pnpm over npm when both appear', () => {
    const entries = [
      toolUseEntry('Bash', { command: 'npm install' }),
      toolUseEntry('Bash', { command: 'pnpm install' }),
    ];
    assert.equal(detectPackageManager(entries), 'pnpm');
  });
});

// ─────────────────────────────────────────────────────────────
// Tool-use stats / files touched / duration
// ─────────────────────────────────────────────────────────────

describe('collectToolUseStats / estimateFilesTouched', () => {
  test('counts by tool name and counts distinct files only', () => {
    const entries = [
      toolUseEntry('Read', { file_path: 'a.js' }),
      toolUseEntry('Read', { file_path: 'a.js' }),   // dup
      toolUseEntry('Edit', { file_path: 'b.js' }),
      toolUseEntry('Bash', { command: 'ls' }),
    ];
    assert.deepEqual(collectToolUseStats(entries), { Read: 2, Edit: 1, Bash: 1 });
    assert.equal(estimateFilesTouched(entries), 2);  // a.js, b.js
  });
});

describe('computeDurationMinutes', () => {
  test('computes delta in minutes, rounded', () => {
    const parsed = {
      startedAt: '2026-04-22T10:00:00Z',
      endedAt:   '2026-04-22T10:47:30Z',
    };
    assert.equal(computeDurationMinutes(parsed), 48);  // rounds 47.5 up
  });

  test('returns null for missing or invalid timestamps', () => {
    assert.equal(computeDurationMinutes({}), null);
    assert.equal(computeDurationMinutes({ startedAt: 'bad', endedAt: '2026-04-22T10:00:00Z' }), null);
    assert.equal(computeDurationMinutes({ startedAt: '2026-04-22T10:00:00Z', endedAt: '2026-04-22T09:00:00Z' }), null);
  });
});

// ─────────────────────────────────────────────────────────────
// Commit refs / slash commands / test commands
// ─────────────────────────────────────────────────────────────

describe('extractCommitRefs', () => {
  test('captures hex SHAs, rejects all-decimal strings', () => {
    const entries = [
      textEntry('assistant', 'I landed it as 7c4dde5ff and earlier in 0a9d9353a.'),
      textEntry('user', 'My phone is 8675309 — not a commit.'),
    ];
    const refs = extractCommitRefs(entries);
    assert.ok(refs.includes('7c4dde5ff'));
    assert.ok(refs.includes('0a9d9353a'));
    assert.ok(!refs.includes('8675309'));
  });
});

describe('extractSlashCommands', () => {
  test('parses <command-name> tags from user entries', () => {
    const entries = [userCommand('/exit'), userCommand('/review')];
    assert.deepEqual(extractSlashCommands(entries).sort(), ['/exit', '/review']);
  });
});

describe('extractTestCommands', () => {
  test('spots common runner invocations in Bash commands', () => {
    const entries = [
      toolUseEntry('Bash', { command: 'npm test' }),
      toolUseEntry('Bash', { command: 'node --test tests/foo.test.js' }),
      toolUseEntry('Bash', { command: 'cargo test' }),
    ];
    const cmds = extractTestCommands(entries);
    assert.ok(cmds.includes('npm test'));
    assert.ok(cmds.includes('node --test'));
    assert.ok(cmds.includes('cargo test'));
  });
});

// ─────────────────────────────────────────────────────────────
// Repo manifest
// ─────────────────────────────────────────────────────────────

describe('readRepoManifest', () => {
  test('returns null when cwd is missing', () => {
    assert.equal(readRepoManifest(null), null);
    assert.equal(readRepoManifest('/nonexistent/path/12345'), null);
  });

  test('parses a Node project with package.json + pnpm lockfile + tests dir + CI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memoro-cli-annot-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'my-app',
        dependencies:    { hono: '^4', 'd1-migrations': '^1' },
        devDependencies: { vitest: '^1', typescript: '^5' },
        scripts: { test: 'vitest run' },
      }));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
      mkdirSync(join(dir, 'tests'));
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), '');

      const out = readRepoManifest(dir);
      assert.equal(out.name, 'my-app');
      assert.equal(out.type, 'node');
      assert.equal(out.package_manager, 'pnpm');
      assert.deepEqual(out.deps_top10.sort(), ['d1-migrations', 'hono', 'typescript', 'vitest'].sort());
      assert.equal(out.has_tests_dir, true);
      assert.equal(out.has_ci, true);
      assert.equal(out.test_runner_detected, 'vitest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parses a Rust project with Cargo.toml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memoro-cli-annot-'));
    try {
      writeFileSync(join(dir, 'Cargo.toml'),
        '[package]\nname = "my-rust-app"\nversion = "0.1.0"\n\n[dependencies]\ntokio = "1"\nserde = "1"\n');
      const out = readRepoManifest(dir);
      assert.equal(out.name, 'my-rust-app');
      assert.equal(out.type, 'rust');
      assert.equal(out.package_manager, 'cargo');
      assert.deepEqual(out.deps_top10, ['tokio', 'serde']);
      assert.equal(out.test_runner_detected, 'cargo test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to a minimal manifest when no known config file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memoro-cli-annot-'));
    try {
      const out = readRepoManifest(dir);
      assert.equal(out.type, null);
      assert.equal(out.package_manager, null);
      assert.deepEqual(out.deps_top10, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Top-level compose
// ─────────────────────────────────────────────────────────────

describe('buildAnnotations', () => {
  test('composes both coding_context and repo_manifest from raw JSONL + cwd', () => {
    const raw = [
      JSON.stringify(toolUseEntry('Read',  { file_path: 'src/foo.js' })),
      JSON.stringify(toolUseEntry('Bash',  { command: 'npm test' })),
      JSON.stringify(textEntry('assistant', 'Landed as abcdef1.')),
    ].join('\n');
    const parsed = { startedAt: '2026-04-22T10:00:00Z', endedAt: '2026-04-22T10:15:00Z' };

    const out = buildAnnotations({ raw, parsed, cwd: null });
    assert.equal(out.coding_context.primary_languages[0].lang, 'javascript');
    assert.equal(out.coding_context.package_manager, 'npm');
    assert.equal(out.coding_context.duration_minutes, 15);
    assert.equal(out.coding_context.files_touched_estimate, 1);
    assert.ok(out.coding_context.test_commands_run.includes('npm test'));
    assert.ok(out.coding_context.commit_refs.includes('abcdef1'));
    assert.equal(out.repo_manifest, null);  // cwd=null
  });

  test('tolerates malformed JSONL lines without failing', () => {
    const raw = 'not json\n' + JSON.stringify(toolUseEntry('Read', { file_path: 'x.ts' })) + '\n{bad';
    const out = buildAnnotations({ raw, parsed: {}, cwd: null });
    assert.equal(out.coding_context.primary_languages[0].lang, 'typescript');
  });
});
