#!/usr/bin/env node

/**
 * Release contract for the fixed C1 source closure.
 *
 * This script never updates files. It discovers literal local ESM edges from
 * the credential-bearing entrypoints, adds the two explicit spawn/build inputs,
 * and compares that graph and every SHA-256 with c1-source-closure.js.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C1_SOURCE_CLOSURE_SHA256 } from '../../src/mc/broker/c1-source-closure.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..', '..');
const trustedBootstrap = 'src/mc/broker/c1-source-closure.js';
const roots = Object.freeze([
  'src/mc/broker/c1-lease-host.js',
  'src/mc/broker/c1-child.js',
  'scripts/security/managed-claude-c1-runtime.mjs',
]);
const explicitInputs = Object.freeze([
  'package.json',
  'scripts/security/managed-claude-c1-probe.c',
]);
const declaredDynamicExternalEdges = Object.freeze({
  'scripts/security/managed-claude-c1-runtime.mjs': [
    'import(pathToFileURL(config.srtModulePath).href)',
  ],
});

const discovered = new Set(explicitInputs);
const pending = [...roots];
while (pending.length) {
  const relativePath = pending.pop();
  if (discovered.has(relativePath)) continue;
  discovered.add(relativePath);
  const source = readProjectFile(relativePath, 'utf8');
  for (const edge of localImportEdges(source)) {
    const imported = normalizeProjectPath(resolve(dirname(resolve(packageRoot, relativePath)), edge));
    if (imported === trustedBootstrap) continue;
    if (!discovered.has(imported)) pending.push(imported);
  }
  const dynamic = nonLiteralDynamicImports(source);
  const declared = declaredDynamicExternalEdges[relativePath] || [];
  if (dynamic.length !== declared.length
    || dynamic.some((value, index) => value !== declared[index])) {
    fail(`undeclared dynamic import in ${relativePath}`);
  }
}

const actual = Object.fromEntries([...discovered].sort().map((relativePath) => [
  relativePath,
  sha256(readProjectFile(relativePath)),
]));
const expectedKeys = Object.keys(C1_SOURCE_CLOSURE_SHA256).sort();
const actualKeys = Object.keys(actual).sort();
if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
  fail(`source graph mismatch\nexpected: ${expectedKeys.join(', ')}\nactual:   ${actualKeys.join(', ')}`);
}
for (const path of actualKeys) {
  if (C1_SOURCE_CLOSURE_SHA256[path] !== actual[path]) {
    fail(`source digest mismatch: ${path}\nexpected ${C1_SOURCE_CLOSURE_SHA256[path]}\nactual   ${actual[path]}`);
  }
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
} else {
  process.stdout.write(`C1 source closure verified (${actualKeys.length} files)\n`);
}

function localImportEdges(source) {
  const edges = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) edges.push(match[1]);
  }
  return [...new Set(edges)];
}

function nonLiteralDynamicImports(source) {
  const expressions = [];
  for (const match of source.matchAll(/\bimport\s*\(/gu)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = matchingParenthesis(source, open);
    if (close < 0) fail('unclosed dynamic import');
    const expression = source.slice(open + 1, close).trim();
    if (!/^['"]/u.test(expression)) expressions.push(`import(${expression})`);
  }
  return expressions;
}

function matchingParenthesis(source, open) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')' && --depth === 0) {
      return index;
    }
  }
  return -1;
}

function normalizeProjectPath(path) {
  const real = realpathSync(path);
  const rel = relative(packageRoot, real);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    fail(`local source edge outside package root: ${path}`);
  }
  return rel.split(sep).join('/');
}

function readProjectFile(relativePath, encoding = null) {
  const path = resolve(packageRoot, relativePath);
  const real = realpathSync(path);
  const info = statSync(real);
  if (!info.isFile() || normalizeProjectPath(real) !== relativePath) {
    fail(`unsafe source path: ${relativePath}`);
  }
  return encoding ? readFileSync(real, encoding) : readFileSync(real);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  process.stderr.write(`C1 source closure check failed: ${message}\n`);
  process.exit(1);
}
