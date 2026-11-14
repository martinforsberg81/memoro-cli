/**
 * The greens `mc gate` measured, for the merger to read (ruling 44).
 *
 * A session runs `mc gate` on its tree before it publishes; the merger then
 * built the same tree and measured it again, the suite and every command gate
 * the selection named, minutes later and for nothing. Now a green `mc gate` on
 * an unchanged measured tree is written down here — the tree, the selection
 * it measured as a hash, and the version of what both sides measure — and a merge round whose
 * candidate is that tree, with that selection (or a covered subset), under that version, runs only
 * the pull request's own tests (`runGate`).
 *
 * The record is the claim "this exact tree was measured green with this exact
 * selection". A valid full receipt can also cover a smaller selection on the
 * same tree; everything outside that proof is measured as always.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { mcHome } from './paths.js';
import { timeoutValues } from './gate-local.js';

/**
 * What a recorded green and a merge round must both be measuring, as a number.
 * Bumped whenever what either side measures changes — what `mc gate` runs or
 * records, what the round's selection is, what the merger skips on a match —
 * so a green measured under the old meaning is never read under the new one.
 * 4: a receipt names each member as ran or reused (`members`), and a resumed
 * green's reused files need no test run of their own (`filesComplete`).
 * 5: a receipt binds the resolved execution identity (the effective timeout and
 * its provenance, forced exit, Node version) and proves it with the argv each
 * batch was spawned with (`executionComplete`). Every earlier green lacks that
 * proof, bound or unbound, and is never read as one.
 */
export const GATE_MEASUREMENT_VERSION = 5;

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

/** The last valid same-tree green covering the selection, or null. */
export function findGreen({ root = mcHome(), repo, tree, selection, version = GATE_MEASUREMENT_VERSION, evidence = null, checks = null, onMiss = () => {} }) {
  if (evidence !== null && !checks) return null;
  if (!repo || !tree || !selection) return null;
  let found = null;
  for (const line of readLines(greensPath(root))) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.repo !== repo || entry.tree !== tree) continue;
    if (entry.gate_version !== version) { onMiss({ why: 'receipt-invalid', reason: 'version' }); continue; }
    if (!receiptMatches(entry, { root, evidence, version, onInvalid: onMiss })) continue;
    if (entry.selection === selection && receiptMatches(entry, { root, evidence, version, checks, onInvalid: onMiss })) found = entry;
    // Only a durable full receipt can establish a superset; legacy cache claims cannot.
    else if (entry.receipt && checks && receiptMatches(entry, { root, evidence, version, checks, superset: true })) found = entry;
    else onMiss({ why: 'selection-differs', receipt_files: entry.files?.length ?? null,
      selected_files: checks?.files?.length ?? null, receipt_commands: entry.commands?.length ?? null,
      selected_commands: checks?.commands?.length ?? null });
  }
  return found;
}

/**
 * The last green recorded for a pull request's own head tree that can carry a
 * delta (ruling 47): same repository, same tree, same version, and a `base`
 * and `files` to compute the delta from. Records written before those fields
 * existed are never returned — they can only be matched exactly.
 */
export function findGreenForHead({ root = mcHome(), repo, headTree, version = GATE_MEASUREMENT_VERSION, evidence = null, onMiss = () => {} }) {
  if (!repo || !headTree) return null;
  let found = null;
  for (const line of readLines(greensPath(root))) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.repo !== repo) continue;
    if ((entry.head_tree ?? entry.tree) !== headTree) continue;
    if (entry.gate_version !== version) { onMiss({ why: 'receipt-invalid', reason: 'version' }); continue; }
    if (!receiptMatches(entry, { root, evidence, version, onInvalid: onMiss })) continue;
    if (typeof entry.base !== 'string' || !entry.base || !Array.isArray(entry.files)) {
      onMiss({ why: 'delta-fallback', kind: 'missing-base-or-files' }); continue;
    }
    found = entry;
  }
  return found;
}

function readLines(path) {
  if (!existsSync(path)) return [];
  try { return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()); } catch { return []; }
}

/** A declaration can change outside Git (the operator table). Keep it, the
 * requested test flags and the resolved execution identity (`executionIdentity`)
 * in the measurement identity rather than trusting names. */
export function gateConfiguration(declaration, flags = [], execution = null) {
  return digest({ declaration, flags, execution });
}

export function commandIdentity(command) {
  return digest({ packageScript: command.packageScript, passBaseRef: Boolean(command.passBaseRef),
    unavailableExitCode: command.unavailableExitCode ?? null, needs: [...(command.needs || [])].sort() });
}

/** Stronger than the legacy selection hash: flags and command invocation
 * semantics matter to a bound receipt, not just filenames/script names. */
export function checksHash(coverage) {
  return digest({ files: [...coverage.files].sort(), commands: coverage.commands.map(commandIdentity).sort(),
    flags: coverage.flags || [], pattern: coverage.pattern ?? null, execution: coverage.execution ?? null });
}

const TIMEOUT_SOURCES = Object.freeze(['declaration', 'script', 'default']);

/**
 * Whether a receipt proves the test policy it was planned with was the one
 * spawned (contract B). The coverage carries the planned identity
 * (`coverage.execution`: timeout, its provenance, forced exit, Node version);
 * the requested flags must state exactly that timeout (none, for `default`);
 * and every batch the run spawned must say, from its own argv, the same
 * timeout and Node version, force its exit, and carry the requested flags
 * before its file paths. The files the batches ran are exactly the files the
 * attempt ran itself, so a missing batch cannot hide behind the others.
 * Reused members need no batch. A run that ran no file needs none either.
 */
export function executionComplete(coverage, execution, members = null) {
  const identity = coverage?.execution;
  if (!identity || typeof identity !== 'object' || !Number.isInteger(identity.timeoutMs) || identity.timeoutMs <= 0
    || !TIMEOUT_SOURCES.includes(identity.timeoutSource) || identity.forceExit !== true
    || typeof identity.nodeVersion !== 'string' || !identity.nodeVersion) return false;
  const flags = Array.isArray(coverage.flags) ? coverage.flags.map(String) : null;
  if (!flags || !Array.isArray(coverage.files)) return false;
  const stated = timeoutValues(flags);
  if (identity.timeoutSource === 'default' ? stated.length !== 0
    : stated.length !== 1 || Number(stated[0]) !== identity.timeoutMs) return false;
  const claims = members == null ? [] : Array.isArray(members.files) ? members.files.filter((member) => member?.how === 'reused') : null;
  if (!claims || claims.some((member) => typeof member?.file !== 'string')) return false;
  const reused = new Set(claims.map((member) => member.file));
  const ran = coverage.files.filter((file) => !reused.has(file));
  const batches = execution?.tests?.batches;
  if (!ran.length) return !Array.isArray(batches) || batches.length === 0;
  if (!Array.isArray(batches) || !batches.length) return false;
  const covered = new Set();
  for (const batch of batches) {
    if (!batch || typeof batch !== 'object' || !Array.isArray(batch.files) || !batch.files.length || !Array.isArray(batch.argv)
      || batch.nodeVersion !== identity.nodeVersion || typeof batch.node !== 'string' || !batch.node
      || batch.timeoutSource !== identity.timeoutSource || batch.timeoutMs !== identity.timeoutMs || batch.forceExit !== true) return false;
    const argv = batch.argv.map(String);
    const first = argv.length - batch.files.length;
    if (first < 0 || JSON.stringify(argv.slice(first)) !== JSON.stringify(batch.files)) return false;
    const timeouts = argv.filter((word) => word.startsWith('--test-timeout'));
    if (timeouts.length !== 1 || timeouts[0] !== `--test-timeout=${identity.timeoutMs}` || argv.indexOf(timeouts[0]) >= first) return false;
    const forced = argv.indexOf('--test-force-exit');
    if (forced < 0 || forced >= first) return false;
    for (let i = 0; i < flags.length; i += 1) {
      if (flags[i].startsWith('--test-timeout')) { if (flags[i] === '--test-timeout') i += 1; continue; }
      const at = argv.indexOf(flags[i]);
      if (at < 0 || at >= first) return false;
    }
    // A file may be launched twice: a red file the round settles runs alone (`gate-settle.js`).
    for (const file of batch.files) covered.add(file);
  }
  const asked = new Set(coverage.files);
  return [...covered].every((file) => asked.has(file)) && ran.every((file) => covered.has(file));
}

export function fullCoverage(coverage) {
  return coverage?.kind === 'affected' && coverage.pattern === null && Array.isArray(coverage.flags)
    && !coverage.flags.some((flag) => /^--test-(name-pattern|skip-pattern|only|shard)(=|$)/u.test(flag));
}

/** A positively classified change may have no own tests. Unknown or legacy
 * empty answers are not this contract, nor are named/filtered/wide requests. */
export function classifiedEmptyChange(selection) {
  return Array.isArray(selection?.files) && selection.files.length === 0
    && Array.isArray(selection.commands) && selection.commands.length === 0
    && selection.why?.reason === 'change' && Array.isArray(selection.why.unexplained)
    && selection.why.unexplained.length === 0;
}

export function emptyChangeCoverage(coverage) {
  return fullCoverage(coverage) && typeof coverage.selector === 'string' && Boolean(coverage.selector)
    && classifiedEmptyChange({ ...coverage, why: coverage.emptyChange });
}

/** Read the immutable measurement itself, never just a mutable cache claim.
 * The run is a gate-run ID; optional session/revision bindings must match too.
 * Missing identity/configuration is uncertainty, not permission to reuse. */
export function readGreenReceipt({ root = mcHome(), repo, repository, run, sessionRun = null,
  goalRevision = null, configuration, version = GATE_MEASUREMENT_VERSION, onInvalid = () => {} } = {}) {
  const refused = (reason) => { onInvalid({ why: 'receipt-invalid', reason }); return null; };
  if (!repo || !repository || !/^[a-zA-Z0-9-]+$/u.test(run || '') || !configuration) return refused('configuration');
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(root, 'gate-evidence', `${run}.json`), 'utf8')); } catch { return refused('files'); }
  if (receipt?.schema !== 'mc-session-gate-evidence' || receipt.version !== 1 || receipt.gate_version !== version) return refused('version');
  if (receipt.repo !== repo || receipt.repository !== repository || receipt.run !== run
    || receipt.session_run !== sessionRun || receipt.goal_revision !== goalRevision
    || receipt.configuration !== configuration) return refused('configuration');
  if (receipt.outcome !== 'green' || receipt.exit !== 0
    || receipt.stopped_at != null || !/^[0-9a-f]{40,64}$/u.test(receipt.tree || '')
    || !/^[0-9a-f]{40,64}$/u.test(receipt.base || '') || !receipt.fingerprint
    || !Number.isFinite(Date.parse(receipt.started)) || !(Date.parse(receipt.ended) >= Date.parse(receipt.started))) return refused('execution');
  const coverage = receipt.coverage;
  const execution = receipt.execution;
  if (!Array.isArray(coverage?.files) || !Array.isArray(coverage.commands) || !Array.isArray(coverage.flags)
    || coverage.files.some((file) => typeof file !== 'string' || !file)
    || coverage.commands.some((command) => typeof command?.packageScript !== 'string' || !command.packageScript
      || (command.needs != null && (!Array.isArray(command.needs) || command.needs.some((need) => typeof need !== 'string'))))
    || coverage.flags.some((flag) => typeof flag !== 'string')
    || !(coverage.files.length || coverage.commands.length || emptyChangeCoverage(coverage)) || !Array.isArray(execution?.commands)
    || execution.commands.length !== coverage.commands.length
    || execution.commands.some((command) => !command || command.exit !== 0 || command.ok !== true || command.error
      || (command.state === 'reused' && (typeof command.from !== 'string' || !command.from)))) return refused('execution');
  if (!filesComplete(coverage, execution, receipt.members)) return refused('files');
  if (!executionComplete(coverage, execution, receipt.members)) return refused('execution');
  return receipt;
}

/**
 * Whether every covered test file has a passing result: the files this attempt
 * ran passed in its own finished run, and each file it reused names the earlier
 * run it passed in. A reused member that did not pass, or names no source, or is
 * not covered, is never complete. No `members` is a run that reused nothing.
 */
export function filesComplete(coverage, execution, members = null) {
  if (!Array.isArray(coverage?.files)) return false;
  const claims = members == null ? [] : Array.isArray(members.files) ? members.files.filter((member) => member?.how === 'reused') : null;
  if (!claims || claims.some((member) => member.outcome !== 'passed' || typeof member.from !== 'string' || !member.from
    || !coverage.files.includes(member.file))) return false;
  const reused = new Set(claims.map((member) => member.file));
  const ran = coverage.files.filter((file) => !reused.has(file));
  const tests = execution?.tests;
  return !ran.length || (tests?.exit === 0 && tests.finished === true && tests.totals?.tests > 0
    && tests.totals?.pass > 0 && tests.totals?.fail === 0 && !tests.totals?.cancelled);
}

function receiptMatches(entry, { root, evidence, version, checks = null, superset = false, onInvalid = () => {} }) {
  const refused = (reason) => { onInvalid({ why: 'receipt-invalid', reason }); return false; };
  // Legacy v1 cache records remain readable only to legacy consumers.
  if (!entry.receipt) return evidence === null || refused('files');
  let raw;
  try { raw = JSON.parse(readFileSync(entry.receipt, 'utf8')); } catch { return refused('files'); }
  if (!raw || typeof raw !== 'object') return refused('files');
  const context = evidence || { repository: raw.repository, run: raw.run, sessionRun: raw.session_run,
    goalRevision: raw.goal_revision, configuration: raw.configuration };
  const receipt = readGreenReceipt({ ...context, root, repo: entry.repo, version, onInvalid });
  if (!receipt) return false;
  if (entry.receipt !== join(root, 'gate-evidence', `${receipt.run}.json`) || !fullCoverage(receipt.coverage)) return refused('files');
  if (checks && (evidence !== null || superset)) {
    try {
      const coverage = receipt.coverage;
      if (superset) {
        const commands = new Set(coverage.commands.map(commandIdentity));
        if (!checks.files.every((file) => coverage.files.includes(file))
          || !checks.commands.every((command) => commands.has(commandIdentity(command)))) return false;
      }
      if (checksHash(superset ? { ...coverage, files: checks.files, commands: checks.commands } : coverage) !== checksHash(checks)) return false;
    } catch { return false; }
  }
  if ((entry.files && !Array.isArray(entry.files)) || (entry.commands && !Array.isArray(entry.commands))) return refused('files');
  return (receipt.tree === entry.tree && (entry.head_tree ?? entry.tree) === receipt.tree
    && entry.base === receipt.base && entry.selection === selectionHash(receipt.coverage)
    && (!entry.files || digest([...entry.files].sort()) === digest([...receipt.coverage.files].sort()))
    && (!entry.commands || digest([...entry.commands].sort()) === digest(receipt.coverage.commands.map((c) => c.packageScript).sort()))) || refused('files');
}

function digest(value) {
  const ordered = (item) => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
