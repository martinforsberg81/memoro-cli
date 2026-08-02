/**
 * Import-boundary ratchet for the layered structure.
 *
 * Layers (src/<layer>/…): cli, runtime, adapters, capabilities, vault,
 * lib, commands (legacy memoro CLI), mc (legacy core awaiting
 * consolidation), root (bin entrypoints).
 *
 * Two guarantees:
 *  1. HARD RULES hold absolutely (e.g. only the bin root may import cli).
 *  2. The cross-layer edge set may only SHRINK: every observed edge must
 *     be in ALLOWED_EDGES. When consolidation removes the last import of
 *     a kind, delete its row here so it cannot silently come back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALLOWED_EDGES = new Set([
  'adapters -> capabilities',
  'adapters -> lib',
  'adapters -> mc',
  'adapters -> runtime',
  'adapters -> vault',
  'capabilities -> adapters',
  'capabilities -> commands',
  'capabilities -> lib',
  'capabilities -> mc',
  'capabilities -> runtime',
  'cli -> adapters',
  'cli -> capabilities',
  'cli -> core',
  'cli -> commands',
  'cli -> lib',
  'cli -> mc',
  'cli -> root',
  'cli -> runtime',
  'cli -> vault',
  'core -> runtime',
  'commands -> adapters',
  'commands -> lib',
  'commands -> mc',
  'commands -> runtime',
  'lib -> adapters',
  'lib -> commands',
  'mc -> adapters',
  'mc -> capabilities',
  'mc -> core',
  'mc -> commands',
  'mc -> lib',
  'mc -> runtime',
  'mc -> vault',
  'root -> adapters',
  'root -> cli',
  'root -> commands',
  'root -> lib',
  'root -> mc',
  'root -> runtime',
  'root -> vault',
  'runtime -> adapters',
  'runtime -> capabilities',
  'runtime -> commands',
  'runtime -> lib',
  'runtime -> mc',
  'runtime -> vault',
  'vault -> adapters',
  'vault -> commands',
  'vault -> lib',
  'vault -> mc',
  'vault -> runtime',
]);

// Absolute rules — never baseline material. The command surface is a
// consumer of every other layer, never a dependency of one.
const CLI_IMPORTERS_ALLOWED = new Set(['root', 'cli']);

function layerOf(repoRelative) {
  if (!repoRelative.startsWith('src/')) return null;
  const top = repoRelative.slice(4).split('/')[0];
  return top.endsWith('.js') ? 'root' : top;
}

function collectSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function observedEdges() {
  const edges = new Map();
  const specRe = /(?:from\s+|import\s*\(\s*|new URL\(\s*)['"](\.[^'"]*)['"]/g;
  for (const file of collectSourceFiles(path.join(ROOT, 'src'))) {
    const repoRelative = path.relative(ROOT, file);
    const from = layerOf(repoRelative);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(specRe)) {
      const target = path.relative(ROOT, path.resolve(path.dirname(file), match[1]));
      const to = layerOf(target);
      if (!to || from === to) continue;
      const edge = `${from} -> ${to}`;
      if (!edges.has(edge)) edges.set(edge, []);
      edges.get(edge).push(repoRelative);
    }
  }
  return edges;
}

test('only the bin root may import the cli layer', () => {
  const offenders = [...observedEdges().entries()]
    .filter(([edge]) => edge.endsWith('-> cli')
      && !CLI_IMPORTERS_ALLOWED.has(edge.split(' ')[0]))
    .flatMap(([edge, files]) => files.map((file) => `${edge} (${file})`));
  assert.deepEqual(offenders, []);
});

test('cross-layer imports only shrink — no new edge kinds', () => {
  const unexpected = [...observedEdges().entries()]
    .filter(([edge]) => !ALLOWED_EDGES.has(edge))
    .flatMap(([edge, files]) => files.slice(0, 3).map((file) => `${edge} (${file})`));
  assert.deepEqual(
    unexpected,
    [],
    'New cross-layer dependency kind. If this direction is genuinely '
    + 'right, add it to ALLOWED_EDGES deliberately — otherwise invert or '
    + 'relocate the dependency.',
  );
});
