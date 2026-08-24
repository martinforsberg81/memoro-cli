#!/usr/bin/env node
/**
 * What the entry points actually reach, and what nothing does.
 *
 * The proof behind every slice of the old-surface cut (2026-08-24): the gate
 * could not measure during that work (its suite was the flaky dead surface
 * being removed), so a removal rested on this instead — a file no live entry
 * point reaches is a file nothing runs. Roots: `src/mc-cli.js` (the `mc`
 * binary) and `src/bin.js` (the `memoro-cli` binary the Claude hooks call for
 * provider-artifact capture, heartbeat and session upload).
 *
 *   node scripts/reachable.mjs             the counts
 *   node scripts/reachable.mjs --unreached every src file no root reaches
 *   node scripts/reachable.mjs --roots a.js,b.js   choose the roots
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const args = process.argv.slice(2);
const rootsFlag = args.indexOf('--roots');
const roots = rootsFlag !== -1 ? args[rootsFlag + 1].split(',') : ['src/mc-cli.js', 'src/bin.js'];
const seen = new Set();
const queue = [...roots];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  // `from '...'`, `import('...')`, AND any quoted relative `.js` path —
  // the CLI dispatches commands through `import(modules[command])`, a
  // variable the first two forms cannot see, so the module map's string
  // values would read as unreached. Following every quoted `./*.js` literal
  // over-approximates reach, which is the safe direction: it never calls a
  // live file dead. Non-path strings that happen to end in .js simply do
  // not resolve and are ignored.
  for (const m of text.matchAll(/'(\.\.?\/[^']+?\.js)'/gu)) {
    const target = normalize(join(dirname(file), m[1]));
    if (existsSync(target)) queue.push(target);
  }
}
const all = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.js')) all.push(path);
  }
}('src'));
const unreached = all.filter((f) => !seen.has(f)).sort();
const countLines = (files) => files.reduce((s, f) => s + readFileSync(f, 'utf8').split('\n').length, 0);
if (args.includes('--unreached')) {
  for (const f of unreached) process.stdout.write(`${f}\n`);
} else {
  process.stdout.write(`roots: ${roots.join(', ')}\n`);
  process.stdout.write(`reached   ${all.length - unreached.length} files, ${countLines(all.filter((f) => seen.has(f)))} lines\n`);
  process.stdout.write(`unreached ${unreached.length} files, ${countLines(unreached)} lines\n`);
}
