/**
 * The greens `mc gate` measured, for the merger to read (ruling 44).
 *
 * A session runs `mc gate` on its tree before it publishes; the merger then
 * built the same tree and measured it again, the suite and every command gate
 * the selection named, minutes later and for nothing. Now a green `mc gate` on
 * an unchanged measured tree is written down here — the tree, the selection
 * it measured as a hash, and the version of what both sides measure — and a merge round whose
 * candidate is that tree, with that selection, under that version, runs only
 * the pull request's own tests (`runGate`).
 *
 * The record is the claim "this exact tree was measured green with this exact
 * selection". Anything less than all three matching is not that claim, and the
 * round measures as it always did.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { mcHome } from './paths.js';

/**
 * What a recorded green and a merge round must both be measuring, as a number.
 * Bumped whenever what either side measures changes — what `mc gate` runs or
 * records, what the round's selection is, what the merger skips on a match —
 * so a green measured under the old meaning is never read under the new one.
 */
export const GATE_MEASUREMENT_VERSION = 2;

/** How many greens the file keeps: the last ones, which are the ones still unmerged. */
export const GATE_GREENS_KEPT = 2000;

export function greensPath(root = mcHome()) {
  return join(root, 'gate-greens.jsonl');
}

/**
 * The selection as one hash: its test files and command gates, each sorted, as
 * the declared `select` command printed them. Both sides hash the parsed
 * output through this one function, so the same answer is the same bytes.
 */
export function selectionHash(parsed) {
  const files = (Array.isArray(parsed?.files) ? parsed.files : []).map(String).filter(Boolean).sort();
  const commands = (Array.isArray(parsed?.commands) ? parsed.commands : [])
    .map((entry) => ({ packageScript: String(entry?.packageScript ?? ''), passBaseRef: Boolean(entry?.passBaseRef) }))
    .sort((a, b) => (a.packageScript < b.packageScript ? -1 : a.packageScript > b.packageScript ? 1 : Number(a.passBaseRef) - Number(b.passBaseRef)));
  return createHash('sha256').update(JSON.stringify({ files, commands })).digest('hex');
}

/**
 * Appends one green `{ repo, tree, selection, gate_version, at, session }` —
 * since ruling 47 also `{ head_tree, base, files, commands }` — and keeps the
 * last 2,000.
 */
export function recordGreen({ root = mcHome(), entry }) {
  const path = greensPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines = [...readLines(path), JSON.stringify(entry)].slice(-GATE_GREENS_KEPT);
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, `${lines.join('\n')}\n`);
  renameSync(next, path);
}

/** The last recorded green matching all four, or null. */
export function findGreen({ root = mcHome(), repo, tree, selection, version = GATE_MEASUREMENT_VERSION }) {
  if (!repo || !tree || !selection) return null;
  let found = null;
  for (const line of readLines(greensPath(root))) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.repo === repo && entry.tree === tree && entry.selection === selection && entry.gate_version === version) found = entry;
  }
  return found;
}

/**
 * The last green recorded for a pull request's own head tree that can carry a
 * delta (ruling 47): same repository, same tree, same version, and a `base`
 * and `files` to compute the delta from. Records written before those fields
 * existed are never returned — they can only be matched exactly.
 */
export function findGreenForHead({ root = mcHome(), repo, headTree, version = GATE_MEASUREMENT_VERSION }) {
  if (!repo || !headTree) return null;
  let found = null;
  for (const line of readLines(greensPath(root))) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.repo !== repo || entry.gate_version !== version) continue;
    if ((entry.head_tree ?? entry.tree) !== headTree) continue;
    if (typeof entry.base !== 'string' || !entry.base || !Array.isArray(entry.files)) continue;
    found = entry;
  }
  return found;
}

function readLines(path) {
  if (!existsSync(path)) return [];
  try { return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()); } catch { return []; }
}
