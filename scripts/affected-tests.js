#!/usr/bin/env node
/**
 * Which test files a change reaches, for this repository.
 *
 * `mc test` asks a repository this question rather than answering it itself,
 * and until now memoro-cli had no answer: its `npm test` globs every file under
 * `tests/`, so every round measured 2,353 tests on both sides to land a
 * two-line change. That is the same cost memoro was paying, and the same fix
 * applies — it just has to be written in the terms this repository is built in.
 *
 * Two edges are followed, because a test depends on source in two different
 * ways and only one of them is visible to an import graph:
 *
 *  - **Imports.** A test that imports a module, directly or through any chain
 *    of modules, runs when that module changes. The closure is walked from each
 *    test file, so a change three modules deep still selects it.
 *  - **Pins.** A test that reads a source file as *text* — opens it, matches it
 *    with a regexp, asserts on its literal path — imports nothing and is
 *    invisible to the graph. This repository has such tests on purpose: the one
 *    asserting `repo-gate.js` contains no merge call is exactly this shape, and
 *    it is load-bearing. A path literal that resolves to a tracked file counts.
 *
 * And it fails closed, loudly. A changed file that neither edge explains — a
 * manifest, a lockfile, a config, anything outside `src/` and `tests/` — means
 * the question cannot be answered by walking this repository's own structure,
 * so the answer is the whole suite. Being slow is a cost; being wrong about
 * what a change reaches is the thing a gate exists to prevent, and there is no
 * version of this script worth having that guesses in that direction.
 *
 * Prints `{"files": [...], "why": {...}}` on stdout. `--why` prints the same
 * thing as prose, for a person deciding whether to trust it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.test\.(?:js|mjs|cjs)$/u;
const SOURCE_FILE = /\.(?:js|mjs|cjs)$/u;

/** Module specifiers, static and dynamic, with a literal path. */
const IMPORTS = [
  /(?:^|[\n;])\s*import\s[\s\S]*?from\s*(['"])([^'"]+)\1/gu,
  /(?:^|[\n;])\s*import\s*(['"])([^'"]+)\1/gu,
  /(?:^|[\n;])\s*export\s[\s\S]*?from\s*(['"])([^'"]+)\1/gu,
  /\bimport\(\s*(['"])([^'"]+)\1\s*\)/gu,
  /\brequire\(\s*(['"])([^'"]+)\1\s*\)/gu,
];

/**
 * A path literal with at least one directory segment. Single names ('index.js')
 * are excluded: across a few thousand files they are ambiguous, and inventing a
 * pin nobody makes is its own kind of wrong answer.
 */
const PIN_TOKEN = /(?:\.{1,2}\/)?(?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+\.[A-Za-z0-9]{1,6}/gu;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function tracked() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

/** What this branch changes against the base, the same set the gate compares. */
function changedAgainst(baseRef) {
  const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
  const committed = git(['diff', '--name-only', '-z', `${mergeBase}...HEAD`]).split('\0');
  const working = git(['status', '--porcelain', '-z']).split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3));
  return { mergeBase, paths: [...new Set([...committed, ...working].filter(Boolean))] };
}

/** A specifier resolved to a repo-relative path, or null when it leaves the repo. */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(ROOT, dirname(fromFile), specifier);
  const rel = relative(ROOT, target);
  if (rel.startsWith('..')) return null;
  for (const candidate of [rel, `${rel}.js`, join(rel, 'index.js')]) {
    if (existsSync(join(ROOT, candidate))) return candidate;
  }
  return null;
}

function readOr(path, fallback = '') {
  try { return readFileSync(join(ROOT, path), 'utf8'); } catch { return fallback; }
}

/** Direct imports of one file, as repo-relative paths. */
function importsOf(path, cache) {
  if (cache.has(path)) return cache.get(path);
  const source = readOr(path);
  const found = new Set();
  for (const pattern of IMPORTS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const target = resolveSpecifier(path, match[2]);
      if (target) found.add(target);
    }
  }
  const list = [...found];
  cache.set(path, list);
  return list;
}

/** Every source file a test reaches through imports, transitively. */
function closureOf(entry, cache) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const path = stack.pop();
    for (const next of importsOf(path, cache)) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

/** Tracked files a test names as a literal path, minus the ones it imports. */
function pinsOf(path, trackedSet, imported) {
  const source = readOr(path);
  const pins = new Set();
  for (const token of source.match(PIN_TOKEN) ?? []) {
    for (const candidate of [token.replace(/^\.\//u, ''), relative(ROOT, resolve(ROOT, dirname(path), token))]) {
      if (trackedSet.has(candidate) && !imported.has(candidate)) { pins.add(candidate); break; }
    }
  }
  return pins;
}

export function selectAffected({ baseRef = 'origin/main' } = {}) {
  const all = tracked();
  const trackedSet = new Set(all);
  const testFiles = all.filter((path) => TEST_FILE.test(path));
  const { mergeBase, paths: changed } = changedAgainst(baseRef);
  const changedSet = new Set(changed);

  // Anything the two edges cannot explain. A manifest, a lockfile, a workflow,
  // a config: real changes whose reach is not written down anywhere this script
  // can read, so it stops claiming to know and runs everything.
  const unexplained = changed.filter((path) => !SOURCE_FILE.test(path)
    || !(path.startsWith('src/') || path.startsWith('tests/') || path.startsWith('scripts/')));

  if (unexplained.length > 0) {
    return {
      files: testFiles,
      why: {
        reason: 'full-suite',
        base_ref: baseRef,
        merge_base: mergeBase,
        changed: changed.length,
        unexplained,
        note: 'a changed path is not source this script can trace, so the whole suite runs',
      },
    };
  }

  const cache = new Map();
  const selected = new Set();
  const because = {};
  for (const test of testFiles) {
    const reasons = [];
    if (changedSet.has(test)) reasons.push('changed-test-file');
    const imported = closureOf(test, cache);
    const hitImports = [...imported].filter((path) => changedSet.has(path));
    if (hitImports.length) reasons.push(`imports:${hitImports.slice(0, 3).join(',')}`);
    const hitPins = [...pinsOf(test, trackedSet, imported)].filter((path) => changedSet.has(path));
    if (hitPins.length) reasons.push(`pins:${hitPins.slice(0, 3).join(',')}`);
    if (reasons.length) { selected.add(test); because[test] = reasons; }
  }

  return {
    files: [...selected].sort(),
    why: {
      reason: 'affected',
      base_ref: baseRef,
      merge_base: mergeBase,
      changed: changed.length,
      test_files: testFiles.length,
      selected_by: because,
    },
  };
}

function main(argv) {
  const baseIndex = argv.indexOf('--base-ref');
  const baseRef = baseIndex >= 0 ? argv[baseIndex + 1] : 'origin/main';
  const result = selectAffected({ baseRef });
  if (argv.includes('--why')) {
    process.stdout.write(`${result.why.reason === 'full-suite'
      ? `the whole suite: ${result.why.unexplained.length} changed path(s) this script cannot trace — ${result.why.unexplained.slice(0, 5).join(', ')}`
      : `${result.files.length} of ${result.why.test_files} test files, from ${result.why.changed} changed path(s)`}\n`);
    for (const [file, reasons] of Object.entries(result.why.selected_by ?? {})) {
      process.stdout.write(`  ${file} — ${reasons.join('; ')}\n`);
    }
    return 0;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

// Through `realpathSync`, because macOS hands out `/var/...` for a directory
// whose real path is `/private/var/...`: comparing the two as written makes
// this script a silent no-op anywhere under a temporary directory, which is
// exactly where its own tests run it.
const invokedAs = process.argv[1] ? attempt(() => realpathSync(process.argv[1])) : null;
const selfPath = attempt(() => realpathSync(fileURLToPath(import.meta.url)));
if (invokedAs && selfPath && invokedAs === selfPath) {
  process.exit(main(process.argv.slice(2)));
}

function attempt(fn) {
  try { return fn(); } catch { return null; }
}
