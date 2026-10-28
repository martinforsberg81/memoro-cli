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
export const GATE_MEASUREMENT_VERSION = 3;

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
export function findGreen({ root = mcHome(), repo, tree, selection, version = GATE_MEASUREMENT_VERSION, evidence = null, checks = null }) {
  if (evidence !== null && !checks) return null;
  if (!repo || !tree || !selection) return null;
  let found = null;
  for (const line of readLines(greensPath(root))) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.repo === repo && entry.tree === tree && entry.selection === selection && entry.gate_version === version
      && receiptMatches(entry, { root, evidence, version, checks })) found = entry;
  }
  return found;
}

/**
 * The last green recorded for a pull request's own head tree that can carry a
 * delta (ruling 47): same repository, same tree, same version, and a `base`
 * and `files` to compute the delta from. Records written before those fields
 * existed are never returned — they can only be matched exactly.
 */
export function findGreenForHead({ root = mcHome(), repo, headTree, version = GATE_MEASUREMENT_VERSION, evidence = null }) {
  if (!repo || !headTree) return null;
  let found = null;
  for (const line of readLines(greensPath(root))) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.repo !== repo || entry.gate_version !== version) continue;
    if ((entry.head_tree ?? entry.tree) !== headTree) continue;
    if (typeof entry.base !== 'string' || !entry.base || !Array.isArray(entry.files)) continue;
    if (!receiptMatches(entry, { root, evidence, version })) continue;
    found = entry;
  }
  return found;
}

function readLines(path) {
  if (!existsSync(path)) return [];
  try { return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()); } catch { return []; }
}

/** A declaration can change outside Git (the operator table). Keep it, and the
 * effective test flags, in the measurement identity rather than trusting names. */
export function gateConfiguration(declaration, flags = []) {
  return digest({ declaration, flags });
}

export function commandIdentity(command) {
  return digest({ packageScript: command.packageScript, passBaseRef: Boolean(command.passBaseRef),
    unavailableExitCode: command.unavailableExitCode ?? null, needs: [...(command.needs || [])].sort() });
}

/** Stronger than the legacy selection hash: flags and command invocation
 * semantics matter to autonomous consumers, not just filenames/script names. */
export function checksHash(coverage) {
  return digest({ files: [...coverage.files].sort(), commands: coverage.commands.map(commandIdentity).sort(),
    flags: coverage.flags || [], pattern: coverage.pattern ?? null });
}

export function fullCoverage(coverage) {
  return coverage?.kind === 'affected' && coverage.pattern === null && Array.isArray(coverage.flags)
    && !coverage.flags.some((flag) => /^--test-(name-pattern|skip-pattern|only|shard)(=|$)/u.test(flag));
}

/** Read the immutable measurement itself, never just a mutable cache claim.
 * The run is a gate-run ID; optional session/revision bindings must match too.
 * Missing identity/configuration is uncertainty, not permission to reuse. */
export function readGreenReceipt({ root = mcHome(), repo, repository, run, sessionRun = null,
  goalRevision = null, configuration, version = GATE_MEASUREMENT_VERSION } = {}) {
  if (!repo || !repository || !/^[a-zA-Z0-9-]+$/u.test(run || '') || !configuration) return null;
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(root, 'gate-evidence', `${run}.json`), 'utf8')); } catch { return null; }
  if (receipt?.schema !== 'mc-session-gate-evidence' || receipt.version !== 1 || receipt.gate_version !== version
    || receipt.repo !== repo || receipt.repository !== repository || receipt.run !== run
    || receipt.session_run !== sessionRun || receipt.goal_revision !== goalRevision
    || receipt.configuration !== configuration || receipt.outcome !== 'green' || receipt.exit !== 0
    || receipt.stopped_at != null || !/^[0-9a-f]{40,64}$/u.test(receipt.tree || '')
    || !/^[0-9a-f]{40,64}$/u.test(receipt.base || '') || !receipt.fingerprint
    || !Number.isFinite(Date.parse(receipt.started)) || !(Date.parse(receipt.ended) >= Date.parse(receipt.started))) return null;
  const coverage = receipt.coverage;
  const execution = receipt.execution;
  if (!Array.isArray(coverage?.files) || !Array.isArray(coverage.commands) || !Array.isArray(coverage.flags)
    || coverage.files.some((file) => typeof file !== 'string' || !file)
    || coverage.commands.some((command) => typeof command?.packageScript !== 'string' || !command.packageScript
      || (command.needs != null && (!Array.isArray(command.needs) || command.needs.some((need) => typeof need !== 'string'))))
    || coverage.flags.some((flag) => typeof flag !== 'string')
    || !(coverage.files.length || coverage.commands.length) || !Array.isArray(execution?.commands)
    || execution.commands.length !== coverage.commands.length
    || execution.commands.some((command) => !command || command.exit !== 0 || command.ok !== true || command.error)) return null;
  const tests = execution.tests;
  if (coverage.files.length && !(tests?.exit === 0 && tests.finished === true && tests.totals?.tests > 0
    && tests.totals?.pass > 0 && tests.totals?.fail === 0 && !tests.totals?.cancelled)) return null;
  return receipt;
}

function receiptMatches(entry, { root, evidence, version, checks = null }) {
  // Legacy v1 cache records remain readable only to legacy consumers.
  if (!entry.receipt) return evidence === null;
  let raw;
  try { raw = JSON.parse(readFileSync(entry.receipt, 'utf8')); } catch { return false; }
  if (!raw || typeof raw !== 'object') return false;
  const context = evidence || { repository: raw.repository, run: raw.run, sessionRun: raw.session_run,
    goalRevision: raw.goal_revision, configuration: raw.configuration };
  const receipt = readGreenReceipt({ ...context, root, repo: entry.repo, version });
  if (!receipt || entry.receipt !== join(root, 'gate-evidence', `${receipt.run}.json`) || !fullCoverage(receipt.coverage)) return false;
  if (evidence !== null && checks) {
    try { if (checksHash(receipt.coverage) !== checksHash(checks)) return false; } catch { return false; }
  }
  if ((entry.files && !Array.isArray(entry.files)) || (entry.commands && !Array.isArray(entry.commands))) return false;
  return receipt.tree === entry.tree && (entry.head_tree ?? entry.tree) === receipt.tree
    && entry.base === receipt.base && entry.selection === selectionHash(receipt.coverage)
    && (!entry.files || digest([...entry.files].sort()) === digest([...receipt.coverage.files].sort()))
    && (!entry.commands || digest([...entry.commands].sort()) === digest(receipt.coverage.commands.map((c) => c.packageScript).sort()));
}

function digest(value) {
  const ordered = (item) => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
