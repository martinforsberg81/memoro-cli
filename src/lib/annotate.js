/**
 * Client-side observation annotations.
 *
 * Deterministic enrichment attached to every session upload. Zero LLM,
 * zero privacy surface (metadata only — no code bodies, no user prose
 * beyond what the cleaned transcript already sends). Purpose: give the server-side
 * coding extractors sharper signal than prose alone can carry.
 *
 * See docs/plans/coding-profile.md.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexFunctionArgs } from './codex.js';

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Build { coding_context, repo_manifest } from a raw transcript + parsed
 * messages + optional repo cwd. Returns both fields always; values fall
 * back to safe empties when signal is absent.
 *
 * @param {Object} args
 * @param {string} args.raw       - full JSONL transcript
 * @param {Object} args.parsed    - output of parseTranscript()
 * @param {string|null} args.cwd  - session cwd (from hook event), if known
 */
export function buildAnnotations({ raw, parsed, cwd }) {
  const entries = parseJsonl(raw);
  return {
    coding_context: buildCodingContext(entries, parsed),
    repo_manifest: cwd ? readRepoManifest(cwd) : null,
  };
}

// ─────────────────────────────────────────────────────────────
// coding_context — transcript-derived stats (deterministic)
// ─────────────────────────────────────────────────────────────

export function buildCodingContext(entries, parsed) {
  return {
    ai_session: {
      tool: parsed?.source || null,
      provider: parsed?.modelProvider || null,
      model: parsed?.modelName || null,
      tool_version: parsed?.toolVersion || null,
      originator: parsed?.originator || null,
      client_source: parsed?.clientSource || null,
    },
    primary_languages:     detectLanguages(entries),
    frameworks_detected:   detectFrameworks(entries),
    build_tools_seen:      detectBuildTools(entries),
    package_manager:       detectPackageManager(entries),
    tools_invoked:         collectToolUseStats(entries),
    files_touched_estimate: estimateFilesTouched(entries),
    duration_minutes:      computeDurationMinutes(parsed),
    commit_refs:           extractCommitRefs(entries),
    slash_commands_used:   extractSlashCommands(entries),
    test_commands_run:     extractTestCommands(entries),
  };
}

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java', kt: 'kotlin',
  rb: 'ruby',
  swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  html: 'html', css: 'css', scss: 'scss',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
};

/**
 * Rank languages by mention frequency. Sources: tool_use input file paths
 * (primary signal), code-block tags in assistant text, and file-like
 * tokens anywhere in entries.
 */
export function detectLanguages(entries) {
  const counts = new Map();
  const bump = (lang) => counts.set(lang, (counts.get(lang) || 0) + 1);

  // 1. tool_use file paths (file_path, path, notebook_path)
  forEachToolUse(entries, (block) => {
    const input = block.input || {};
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const p = input[key];
      if (typeof p === 'string') {
        const lang = extToLang(p);
        if (lang) bump(lang);
      }
    }
  });

  // 2. code-block tags in assistant text — ```ts, ```py, etc.
  forEachTextBlock(entries, 'assistant', (text) => {
    for (const m of text.matchAll(/```([a-zA-Z0-9_+-]+)/g)) {
      const tag = m[1].toLowerCase();
      const lang = EXT_TO_LANG[tag] || (tag in LANG_ALIASES ? LANG_ALIASES[tag] : null);
      if (lang) bump(lang);
    }
  });

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];

  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([lang, count]) => ({ lang, share: Number((count / total).toFixed(2)) }));
}

const LANG_ALIASES = {
  typescript: 'typescript', javascript: 'javascript',
  python: 'python', rust: 'rust', golang: 'go',
  bash: 'shell', shell: 'shell', sh: 'shell',
};

/**
 * Small signature table. Matches against tool_use inputs (file paths +
 * command text) and occasional framework-name strings in prose.
 */
const FRAMEWORK_SIGS = [
  { name: 'cloudflare-workers', patterns: [/\bwrangler\b/, /cloudflare:workers/, /@cloudflare\/workers-types/, /\bdurable-objects\b/] },
  { name: 'react',              patterns: [/from ['"]react['"]/, /\breact-dom\b/] },
  { name: 'next',               patterns: [/from ['"]next\//, /\bnext (dev|build|start)\b/] },
  { name: 'vue',                patterns: [/from ['"]vue['"]/, /\bvue-router\b/] },
  { name: 'svelte',             patterns: [/from ['"]svelte\//, /sveltekit/i] },
  { name: 'astro',              patterns: [/from ['"]astro/, /\bastro dev\b/] },
  { name: 'express',            patterns: [/from ['"]express['"]/, /require\(['"]express['"]\)/] },
  { name: 'hono',               patterns: [/from ['"]hono['"]/] },
  { name: 'fastapi',            patterns: [/from fastapi\b/, /\buvicorn\b/] },
  { name: 'django',             patterns: [/from django\b/, /\bmanage\.py\b/] },
  { name: 'flask',              patterns: [/from flask\b/] },
  { name: 'rails',              patterns: [/Rails\.application/, /\bbin\/rails\b/] },
  { name: 'actix',              patterns: [/\bactix_web\b/] },
  { name: 'tokio',              patterns: [/\btokio::/] },
  { name: 'spring',             patterns: [/org\.springframework/] },
];

export function detectFrameworks(entries) {
  // Scan tool_use inputs only — those are the actual code being read,
  // written, or executed. Prose matches are too lossy: a user or
  // assistant mentioning "react" or "django" in passing shouldn't mark
  // that framework as part of the user's stack.
  //
  // Caveat: a single session that edits a file containing framework-name
  // string literals (e.g. editing this very module's signature table)
  // will trip multiple detectors. Per-session noise is expected; the
  // server-side curator handles it via repeated-evidence weighting.
  const hit = new Set();
  forEachToolUse(entries, (block) => {
    const input = block.input || {};
    for (const val of Object.values(input)) {
      if (typeof val !== 'string') continue;
      for (const sig of FRAMEWORK_SIGS) {
        if (sig.patterns.some(re => re.test(val))) hit.add(sig.name);
      }
    }
  });
  return [...hit];
}

const BUILD_TOOL_SIGS = [
  { name: 'npm',     patterns: [/\bnpm (install|run|test|ci|i)\b/, /\bnpx\b/] },
  { name: 'pnpm',    patterns: [/\bpnpm (install|run|test)\b/] },
  { name: 'yarn',    patterns: [/\byarn (install|run|test)\b/] },
  { name: 'bun',     patterns: [/\bbun (install|run|test)\b/] },
  { name: 'wrangler',patterns: [/\bwrangler (dev|deploy|tail)\b/] },
  { name: 'cargo',   patterns: [/\bcargo (build|test|run|check)\b/] },
  { name: 'uv',      patterns: [/\buv (run|pip|sync)\b/] },
  { name: 'pip',     patterns: [/\bpip install\b/] },
  { name: 'go',      patterns: [/\bgo (build|test|run|mod)\b/] },
  { name: 'make',    patterns: [/^make\b/m, /\bmake -/] },
  { name: 'docker',  patterns: [/\bdocker (run|build|compose)\b/] },
  { name: 'gradle',  patterns: [/\bgradlew?\b/, /\bgradle (build|test)\b/] },
  { name: 'mvn',     patterns: [/\bmvn\b/] },
];

export function detectBuildTools(entries) {
  const hit = new Set();
  const commands = collectBashCommands(entries);
  const blob = commands.join('\n');
  for (const sig of BUILD_TOOL_SIGS) {
    if (sig.patterns.some(re => re.test(blob))) hit.add(sig.name);
  }
  return [...hit];
}

/**
 * Pick one canonical package manager if a matching one is present. Gives
 * the backend a quick single-value answer without having to guess from
 * the free-form build_tools_seen list.
 */
export function detectPackageManager(entries) {
  const tools = detectBuildTools(entries);
  for (const candidate of ['pnpm', 'yarn', 'bun', 'npm', 'cargo', 'uv', 'pip', 'go']) {
    if (tools.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Count tool_use blocks by tool name across the session. E.g.
 *   { Read: 20, Edit: 15, Bash: 7, Grep: 3 }
 */
export function collectToolUseStats(entries) {
  const counts = {};
  forEachToolUse(entries, (block) => {
    const name = block.name || 'unknown';
    counts[name] = (counts[name] || 0) + 1;
  });
  return counts;
}

/** Distinct file paths referenced in tool_use inputs. */
export function estimateFilesTouched(entries) {
  const paths = new Set();
  forEachToolUse(entries, (block) => {
    const input = block.input || {};
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const p = input[key];
      if (typeof p === 'string' && p.trim()) paths.add(p.trim());
    }
  });
  return paths.size;
}

/** Session duration from earliest to latest timestamp in the parsed messages. */
export function computeDurationMinutes(parsed) {
  if (!parsed?.startedAt || !parsed?.endedAt) return null;
  const start = Date.parse(parsed.startedAt);
  const end = Date.parse(parsed.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.round((end - start) / 60000);
}

/** 7-40-char hex strings that look like commit SHAs, dedup'd. */
export function extractCommitRefs(entries) {
  const out = new Set();
  const pattern = /\b[0-9a-f]{7,40}\b/g;
  forEachTextBlock(entries, 'any', (text) => {
    for (const m of text.matchAll(pattern)) {
      const s = m[0];
      // Reject all-decimal (phone numbers, ids) and obvious timestamps.
      if (!/[a-f]/.test(s)) continue;
      out.add(s);
    }
  });
  return [...out].slice(0, 20);
}

/** `<command-name>/foo</command-name>` mentions from Claude Code user entries. */
export function extractSlashCommands(entries) {
  const out = new Set();
  forEachTextBlock(entries, 'user', (text) => {
    for (const m of text.matchAll(/<command-name>([^<]+)<\/command-name>/g)) {
      const name = m[1].trim();
      if (name) out.add(name);
    }
  });
  return [...out];
}

const TEST_RUNNER_PATTERNS = [
  /\bnpm test\b/,
  /\bnpm run test(:[a-z-]+)?\b/,
  /\bpnpm (test|run test)\b/,
  /\byarn test\b/,
  /\bjest\b/,
  /\bvitest\b/,
  /\bmocha\b/,
  /\bpytest\b/,
  /\bcargo test\b/,
  /\bgo test\b/,
  /\bnode --test\b/,
  /\brails test\b/,
];

/** Dedup'd list of test-runner invocations spotted in Bash tool_use calls. */
export function extractTestCommands(entries) {
  const out = new Set();
  const commands = collectBashCommands(entries);
  for (const cmd of commands) {
    for (const re of TEST_RUNNER_PATTERNS) {
      const m = cmd.match(re);
      if (m) out.add(m[0]);
    }
  }
  return [...out];
}

// ─────────────────────────────────────────────────────────────
// repo_manifest — top-level project config on disk
// ─────────────────────────────────────────────────────────────

/**
 * Read a small bundle of repo metadata from the cwd. Only metadata — no
 * code, no user content — so it's privacy-safe.
 *
 * Supports package.json (Node), Cargo.toml (Rust), pyproject.toml (Python),
 * go.mod (Go). First matching manifest wins; others are ignored.
 */
export function readRepoManifest(cwd) {
  if (!cwd || !isExistingDir(cwd)) return null;

  const manifest = detectRepoManifest(cwd);
  if (!manifest) return {
    name: basename(cwd),
    type: null,
    package_manager: null,
    deps_top10: [],
    has_tests_dir: detectTestsDir(cwd),
    has_ci: detectCI(cwd),
    test_runner_detected: null,
  };

  return {
    ...manifest,
    has_tests_dir: detectTestsDir(cwd),
    has_ci: detectCI(cwd),
  };
}

function detectRepoManifest(cwd) {
  const pkgJson = readJsonSafe(join(cwd, 'package.json'));
  if (pkgJson) {
    const deps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
    const depsTop10 = Object.keys(deps).slice(0, 10);
    const hasTestScript = !!pkgJson.scripts?.test;
    return {
      name: pkgJson.name || basename(cwd),
      type: 'node',
      package_manager: detectPackageManagerFromFs(cwd),
      deps_top10: depsTop10,
      test_runner_detected: detectTestRunnerFromDeps(deps) || (hasTestScript ? 'script' : null),
    };
  }

  const cargoToml = readTextSafe(join(cwd, 'Cargo.toml'));
  if (cargoToml) {
    return {
      name: extractTomlKey(cargoToml, /^\s*name\s*=\s*"([^"]+)"/m) || basename(cwd),
      type: 'rust',
      package_manager: 'cargo',
      deps_top10: extractCargoDeps(cargoToml),
      test_runner_detected: 'cargo test',
    };
  }

  const pyproject = readTextSafe(join(cwd, 'pyproject.toml'));
  if (pyproject) {
    return {
      name: extractTomlKey(pyproject, /^\s*name\s*=\s*"([^"]+)"/m) || basename(cwd),
      type: 'python',
      package_manager: isExistingFile(join(cwd, 'uv.lock')) ? 'uv' : 'pip',
      deps_top10: extractPyprojectDeps(pyproject),
      test_runner_detected: /pytest/i.test(pyproject) ? 'pytest' : null,
    };
  }

  const goMod = readTextSafe(join(cwd, 'go.mod'));
  if (goMod) {
    const match = goMod.match(/^module\s+(\S+)/m);
    return {
      name: match ? basename(match[1]) : basename(cwd),
      type: 'go',
      package_manager: 'go',
      deps_top10: extractGoModDeps(goMod),
      test_runner_detected: 'go test',
    };
  }

  return null;
}

function detectPackageManagerFromFs(cwd) {
  if (isExistingFile(join(cwd, 'pnpm-lock.yaml')))   return 'pnpm';
  if (isExistingFile(join(cwd, 'yarn.lock')))        return 'yarn';
  if (isExistingFile(join(cwd, 'bun.lockb')))        return 'bun';
  if (isExistingFile(join(cwd, 'package-lock.json'))) return 'npm';
  return 'npm';  // sensible default for Node projects
}

function detectTestRunnerFromDeps(deps) {
  for (const name of ['vitest', 'jest', 'mocha', 'ava', '@playwright/test']) {
    if (deps[name]) return name;
  }
  return null;
}

function detectTestsDir(cwd) {
  return ['tests', 'test', '__tests__'].some(d => isExistingDir(join(cwd, d)));
}

function detectCI(cwd) {
  return isExistingDir(join(cwd, '.github', 'workflows'))
      || isExistingFile(join(cwd, '.circleci', 'config.yml'))
      || isExistingFile(join(cwd, '.gitlab-ci.yml'));
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function parseJsonl(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

/**
 * Iterate every tool_use block in the transcript. Tool blocks can appear
 * in assistant.message.content[] with type:'tool_use'.
 */
function forEachToolUse(entries, fn) {
  for (const entry of entries) {
    if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call') {
      fn({
        name: mapCodexToolName(entry.payload.name),
        input: parseCodexFunctionArgs(entry.payload.arguments),
      });
      continue;
    }
    const content = entry?.message?.content || entry?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') fn(block);
    }
  }
}

/**
 * Iterate text content blocks. Role filter: 'user' | 'assistant' | 'any'.
 * Works on both flattened text entries and structured content arrays.
 */
function forEachTextBlock(entries, roleFilter, fn) {
  for (const entry of entries) {
    const role = entry.role || entry.message?.role || entry.payload?.role || entry.type;
    if (roleFilter !== 'any') {
      if (roleFilter === 'user' && role !== 'user' && role !== 'human') continue;
      if (roleFilter === 'assistant' && role !== 'assistant' && role !== 'model') continue;
    }
    const content = entry?.payload?.content ?? entry?.message?.content ?? entry?.content ?? entry?.text;
    if (typeof content === 'string') {
      fn(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if ((block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') && typeof block.text === 'string') fn(block.text);
      else if (typeof block?.text === 'string' && !block.type) fn(block.text);
    }
  }
}

/** All Bash tool_use command strings in order. */
function collectBashCommands(entries) {
  const out = [];
  forEachToolUse(entries, (block) => {
    if ((block.name === 'Bash' || block.name === 'exec_command') && typeof block.input?.command === 'string') {
      out.push(block.input.command);
    }
  });
  return out;
}

function mapCodexToolName(name) {
  if (name === 'exec_command') return 'Bash';
  if (name === 'apply_patch') return 'Edit';
  return name || 'unknown';
}

function extToLang(path) {
  const m = path.match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return null;
  return EXT_TO_LANG[m[1].toLowerCase()] || null;
}

function basename(p) {
  const parts = String(p).split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function readTextSafe(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null; }
  catch { return null; }
}

function readJsonSafe(path) {
  const text = readTextSafe(path);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function isExistingDir(path) {
  try { return existsSync(path) && statSync(path).isDirectory(); }
  catch { return false; }
}

function isExistingFile(path) {
  try { return existsSync(path) && statSync(path).isFile(); }
  catch { return false; }
}

function extractTomlKey(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

function extractCargoDeps(text) {
  const out = [];
  // Capture everything from [dependencies] up to the next section header
  // (a `[` at the start of a line) or end of input. Using lookahead with
  // an explicit `\n\[` avoids `m`-flag's $=end-of-line, which would stop
  // at the first blank line after the header.
  const section = text.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (!section) return out;
  for (const line of section[1].split('\n')) {
    const m = line.match(/^\s*([a-zA-Z0-9_-]+)\s*=/);
    if (m) out.push(m[1]);
    if (out.length >= 10) break;
  }
  return out;
}

function extractPyprojectDeps(text) {
  const out = [];
  // [project.dependencies] or project.dependencies = [...]
  const block = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return out;
  for (const m of block[1].matchAll(/"([a-zA-Z0-9_.-]+)[^"]*"/g)) {
    out.push(m[1]);
    if (out.length >= 10) break;
  }
  return out;
}

function extractGoModDeps(text) {
  const out = [];
  // `require ( ... )` block
  const block = text.match(/^require\s*\(([\s\S]*?)\)/m);
  const lines = block ? block[1].split('\n') : text.split('\n').filter(l => l.startsWith('require '));
  for (const line of lines) {
    const m = line.match(/^\s*(?:require\s+)?(\S+)\s+v/);
    if (m) out.push(m[1]);
    if (out.length >= 10) break;
  }
  return out;
}
