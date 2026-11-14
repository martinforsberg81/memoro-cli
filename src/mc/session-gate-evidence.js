/** Immutable local measurements. A receipt describes checks, not permission to
 * publish or merge. Limited runs never enter the merger's full-selection cache. */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { GATE_MEASUREMENT_VERSION, checksHash, commandIdentity, emptyChangeCoverage, executionComplete, filesComplete, fullCoverage, greensPath, readGreenReceipt, recordGreen, selectionHash } from './gate-greens.js';
import { run as runGit } from './git.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Git's prospective commit tree plus raw worktree bytes, in a disposable
 * index. Ignored untracked files (dependencies, scratch output) are
 * deliberately excluded. */
export function captureWorktree(cwd) {
  const temp = mkdtempSync(join(tmpdir(), 'mc-gate-index-'));
  const index = join(temp, 'index');
  const git = (args, isolated = false, input) => {
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    if (isolated) {
      // A copied index's fsmonitor token and untracked cache are not trusted.
      Object.assign(env, { GIT_INDEX_FILE: index, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.untrackedCache', GIT_CONFIG_VALUE_1: 'false' });
    }
    const run = runGit(cwd, args, { env, input, timeoutMs: 60_000, maxBuffer: 64 << 20 });
    if (run.error || run.status !== 0) throw new Error(`cannot fingerprint worktree: git ${args[0]} (${run.error?.code || run.status})`);
    return run.stdout;
  };
  try {
    const repository = realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
    const tracked = git(['ls-files', '--cached', '-z']);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
    // The real index's stat cache spares rehashing every file: from HEAD, a
    // 16k-file checkout took half a minute per fingerprint. Only a copy whose
    // every entry is ordinary: assume-unchanged, skip-worktree or unmerged
    // entries would hide bytes, so then the index starts from HEAD.
    let seeded = false;
    try {
      const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
      const { atimeMs, mtimeMs } = statSync(real);
      copyFileSync(real, index);
      // Git's racy-entry check compares against the index file's own mtime.
      utimesSync(index, atimeMs / 1000, mtimeMs / 1000);
      seeded = git(['ls-files', '-v', '-z'], true).split('\0').every((entry) => !entry || entry.startsWith('H '));
    } catch { seeded = false; }
    if (!seeded) {
      rmSync(index, { force: true });
      git(['read-tree', 'HEAD'], true);
      // Include staged additions even when .gitignore would now hide them. This
      // also refreshes skip-worktree/assume-unchanged entries from actual bytes.
      if (tracked) git(['add', '-A', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], true, tracked);
    }
    git(['add', '-A', '--', '.'], true);
    if (git(['ls-files', '--stage'], true).split('\n').some((line) => line.startsWith('160000 '))) {
      throw new Error('cannot fingerprint submodule worktree content');
    }
    const tree = git(['write-tree'], true).trim();
    const paths = [...new Set((tracked + untracked + git(['ls-files', '--cached', '-z'], true)).split('\0').filter(Boolean))].sort();
    const raw = paths.map((path) => {
      try {
        const stat = lstatSync(join(cwd, path));
        if (stat.isSymbolicLink()) return [path, 'symlink', hash(readlinkSync(join(cwd, path), { encoding: 'buffer' }))];
        if (!stat.isFile()) throw new Error(`cannot fingerprint non-file ${path}`);
        return [path, stat.mode & 0o111 ? 'executable' : 'file', hash(readFileSync(join(cwd, path)))];
      } catch (error) {
        // The tree records deletions. Raw missing-path markers would change
        // merely because committing removes those paths from the real index.
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }).filter(Boolean);
    return Object.freeze({ repository, tree, fingerprint: hash(JSON.stringify(raw)) });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function sameContent(a, b) {
  return Boolean(a?.repository && a?.tree && a?.fingerprint
    && a.repository === b?.repository && a.tree === b?.tree && a.fingerprint === b?.fingerprint);
}

/**
 * The selector's own output for one run, as a versioned sidecar: the exact stdout
 * bytes (`raw.text`, with their digest), the parsed whole (`parsed`), the source
 * command, base and cwd, the content it was read on, and the normalised plan the
 * run executed. Attribution only: nothing here is executed protection, and no
 * receipt verdict reads it. Refuses to write output that does not parse to its
 * own parsed content.
 */
export function selectorSidecar({ run, repo, configuration = null, sessionRun = null, source, content, raw, plan = null }) {
  if (typeof raw?.text !== 'string' || JSON.stringify(JSON.parse(raw.text)) !== JSON.stringify(raw.content)) {
    throw new Error('selector output and its parsed content disagree');
  }
  return `${JSON.stringify({
    schema: 'mc-selector-evidence', version: 1, gate_version: GATE_MEASUREMENT_VERSION, repo, run, session_run: sessionRun, configuration,
    source: { command: source.command, base: source.base, cwd: source.cwd },
    content: { repository: content.repository, tree: content.tree, fingerprint: content.fingerprint },
    raw: { text: raw.text, sha256: hash(raw.text), bytes: Buffer.byteLength(raw.text) },
    parsed: raw.content, plan,
  }, null, 2)}\n`;
}

/**
 * One run's sidecar, created whole or not at all: written to a temporary file, then
 * linked under its final name, which fails if anything already holds that name.
 * Only byte-identical content may be retried; a different one is refused, never
 * overwritten.
 */
export function persistSelectorEvidence({ root, run, bytes }) {
  if (!/^[a-zA-Z0-9-]+$/u.test(run)) throw new Error('invalid gate run id');
  const dir = join(root, 'gate-evidence');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${run}.selector.json`);
  const temp = join(dir, `.${run}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    try { linkSync(temp, path); }
    catch (error) { if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== bytes) throw error; }
  } finally { rmSync(temp, { force: true }); }
  return { path, file: basename(path), sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
}

/** No running/unknown/empty/partially executed attempt can become green. */
export function gateReceipt({ measurement, before, after, result, started, ended, selector = null }) {
  const coverage = result.coverage || null;
  const execution = result.execution || null;
  const commands = execution?.commands || [];
  // A resumed attempt is complete when every reused member passed earlier on this
  // content and its own work completed (`filesComplete`).
  const members = result.members ?? null;
  const complete = Boolean(coverage && (coverage.files.length || coverage.commands.length || emptyChangeCoverage(coverage))
    && !(result.commands || []).some((command) => command.settled)
    && filesComplete(coverage, execution, members) && executionComplete(coverage, execution, members)
    && commands.length === coverage.commands.length
    && commands.every((command) => command.exit === 0 && command.ok === true && !command.error
      && (command.state !== 'reused' || (typeof command.from === 'string' && command.from))));
  const unchanged = sameContent(measurement.candidate, before) && sameContent(before, after);
  const valid = Boolean(measurement.repo && measurement.run && /^[0-9a-f]{40,64}$/u.test(measurement.base || '')
    && Number.isFinite(Date.parse(started)) && Date.parse(ended) >= Date.parse(started));
  const outcome = !unchanged ? 'invalid' : result.ok === true && result.code === 0 && complete && valid ? 'green'
    : result.code === 1 ? 'red' : 'incomplete';
  return freeze(JSON.parse(JSON.stringify({
    schema: 'mc-session-gate-evidence', version: 1, gate_version: GATE_MEASUREMENT_VERSION,
    repo: measurement.repo, repository: measurement.candidate.repository, run: measurement.run,
    session_run: measurement.session_run ?? null, goal_revision: measurement.goal_revision ?? null,
    configuration: measurement.configuration ?? null,
    base: measurement.base, tree: measurement.candidate.tree, fingerprint: measurement.candidate.fingerprint,
    started, ended, outcome, coverage, execution, exit: result.code ?? null,
    stopped_at: result.stopped_at ?? null, members, resumed: result.resumed ?? null,
    // Optional references, not verdict inputs: the selector sidecar this run wrote
    // (or why it could not), and the phase intervals (`phaseLedger`). A receipt
    // without them is as complete as one with them.
    selector: selector ?? null, phases: result.phases ?? null,
  })));
}

/** Exclusive creation, with byte-identical retry only. There is no mutable
 * "latest green" receipt; cache entries only point back to completed receipts. */
export function persistGateReceipt({ root, receipt }) {
  if (!/^[a-zA-Z0-9-]+$/u.test(receipt.run)) throw new Error('invalid gate run id');
  const dir = join(root, 'gate-evidence');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${receipt.run}.json`);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== bytes) throw error;
  }
  // The content index a later attempt resumes from (`findResumable`): one empty
  // marker per run under its content key. Losing one costs only the reuse.
  if (receipt.members && receipt.outcome !== 'invalid' && receipt.repository && receipt.tree && receipt.fingerprint) {
    try {
      const index = join(dir, 'content', contentKey(receipt.repo, receipt));
      mkdirSync(index, { recursive: true, mode: 0o700 });
      writeFileSync(join(index, receipt.run), '', { flag: 'wx', mode: 0o600 });
    } catch { /* the next attempt on this content measures in full */ }
  }
  // Retention follows the durable write and can never fail it (docs/technical/mc-gate-evidence.md, Retention).
  try { pruneGateEvidence({ root }); } catch { /* skipped: the next session gate tries again */ }
  return path;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Retention horizons by file mtime (docs/technical/mc-gate-evidence.md, Retention). */
export const RETENTION = Object.freeze({ selectorMs: 7 * DAY_MS, receiptMs: 30 * DAY_MS, tempMs: DAY_MS, everyMs: DAY_MS / 24 });
const PRUNED = '.pruned';
const RECEIPT_FILE = /^([a-zA-Z0-9-]+)\.json$/u;
const SELECTOR_FILE = /^([a-zA-Z0-9-]+)\.selector\.json$/u;
const TEMP_FILE = /^\.([a-zA-Z0-9-]+)\.[0-9a-f]{12}\.tmp$/u;
const RUN_ID = /^[a-zA-Z0-9-]+$/u;
const CONTENT_KEY = /^[0-9a-f]{64}$/u;

/** The mtime of a regular file, or null when it is absent or not one. */
function fileMtime(path) {
  try { const stat = lstatSync(path); return stat.isFile() ? stat.mtimeMs : null; } catch { return null; }
}

function namesIn(path) {
  try { return readdirSync(path); } catch { return []; }
}

/** The receipt files some gate-greens.jsonl line names. A line that does not parse names none. */
function receiptsNamedByGreens(root) {
  const named = new Set();
  let text = '';
  try { text = readFileSync(greensPath(root), 'utf8'); } catch { return named; }
  for (const line of text.split('\n')) {
    try { const entry = JSON.parse(line); if (typeof entry?.receipt === 'string') named.add(basename(entry.receipt)); }
    catch { /* not a green line */ }
  }
  return named;
}

/**
 * Bounded, best-effort retention of `<root>/gate-evidence/`, at most once an hour (the
 * `.pruned` marker's mtime). Ages are file mtimes. Removes: selector sidecars over 7
 * days; receipts over 30 days that no gate-greens.jsonl line names through `receipt`;
 * temporary files over a day; content-index markers whose receipt is gone, and content
 * directories left empty. Only names the writers produce are touched. Returns the
 * removed names, or [] when it ran within the hour. A removal that fails is skipped.
 */
export function pruneGateEvidence({ root, now = Date.now() }) {
  const dir = join(root, 'gate-evidence');
  const marker = join(dir, PRUNED);
  const last = fileMtime(marker);
  if (last !== null && now - last < RETENTION.everyMs) return [];
  writeFileSync(marker, '', { mode: 0o600 });
  const removed = [];
  const remove = (path, name) => { try { rmSync(path); removed.push(name); } catch { /* the next run retries */ } };
  const aged = (path, horizonMs) => { const mtime = fileMtime(path); return mtime !== null && now - mtime > horizonMs; };
  const named = receiptsNamedByGreens(root);
  for (const name of namesIn(dir)) {
    const path = join(dir, name);
    if (RECEIPT_FILE.test(name)) { if (!named.has(name) && aged(path, RETENTION.receiptMs)) remove(path, name); }
    else if (SELECTOR_FILE.test(name)) { if (aged(path, RETENTION.selectorMs)) remove(path, name); }
    else if (TEMP_FILE.test(name) && aged(path, RETENTION.tempMs)) remove(path, name);
  }
  const content = join(dir, 'content');
  for (const key of namesIn(content)) {
    if (!CONTENT_KEY.test(key)) continue;
    const keyDir = join(content, key);
    for (const run of namesIn(keyDir)) {
      const path = join(keyDir, run);
      if (RUN_ID.test(run) && fileMtime(join(dir, `${run}.json`)) === null && fileMtime(path) !== null) remove(path, `content/${key}/${run}`);
    }
    if (!namesIn(keyDir).length) { try { rmdirSync(keyDir); removed.push(`content/${key}/`); } catch { /* not empty after all */ } }
  }
  return removed;
}

/** One directory name for one repository's exact content: repository, tree and raw-byte fingerprint. */
export function contentKey(repo, content) {
  return hash(JSON.stringify([repo, content.repository, content.tree, content.fingerprint]));
}

const FILTERING = /^--test-(name-pattern|skip-pattern|only|shard)(=|$)/u;

/**
 * What earlier attempts on this exact content already proved passing (Martin,
 * 2026-11-06: a rerun on unchanged content resumes; any change runs it all).
 * A source is a persisted receipt of another run with the same repo and
 * repository, the same tree and fingerprint, the same measurement version,
 * configuration and test flags, no name pattern, and valid content. From it, a
 * test file it ran and saw pass (`fileOutcomes`), and a command it ran to exit
 * 0, ok and available; a command that passes the base is a source only on the
 * same base. What it reused itself is not a source: every reuse names the run
 * that ran it. Later attempts win. Returns `{ files, commands }`, maps of file
 * and `commandIdentity` to `{ from, … }`; empty when the request may not resume.
 */
export function findResumable({ root, measurement, flags = [], pattern = null } = {}) {
  const found = { files: new Map(), commands: new Map() };
  const candidate = measurement?.candidate;
  if (!root || !measurement?.repo || !measurement.configuration || !candidate?.repository || !candidate.tree || !candidate.fingerprint
    || pattern != null || !Array.isArray(flags) || flags.some((flag) => FILTERING.test(flag))) return found;
  const dir = join(root, 'gate-evidence');
  let runs = [];
  try { runs = readdirSync(join(dir, 'content', contentKey(measurement.repo, candidate))); } catch { return found; }
  const receipts = [];
  for (const run of runs) {
    if (!/^[a-zA-Z0-9-]+$/u.test(run) || run === measurement.run) continue;
    let receipt = null;
    try { receipt = JSON.parse(readFileSync(join(dir, `${run}.json`), 'utf8')); } catch { continue; }
    if (receipt?.schema !== 'mc-session-gate-evidence' || receipt.version !== 1 || receipt.gate_version !== GATE_MEASUREMENT_VERSION
      || receipt.run !== run || receipt.repo !== measurement.repo || !sameContent(receipt, candidate)
      || receipt.configuration !== measurement.configuration || receipt.outcome === 'invalid'
      || ['content-changed', 'evidence'].includes(receipt.stopped_at)
      || receipt.coverage?.pattern !== null || JSON.stringify(receipt.coverage?.flags) !== JSON.stringify(flags)
      || !Array.isArray(receipt.members?.files) || !Array.isArray(receipt.members?.commands)
      || !Array.isArray(receipt.coverage?.commands) || !Number.isFinite(Date.parse(receipt.ended))
      || !executionComplete(receipt.coverage, receipt.execution, receipt.members)) continue;
    receipts.push(receipt);
  }
  receipts.sort((a, b) => Date.parse(a.ended) - Date.parse(b.ended) || a.run.localeCompare(b.run));
  for (const receipt of receipts) {
    for (const member of receipt.members.files) {
      if (member?.how !== 'ran' || member.outcome !== 'passed' || typeof member.file !== 'string') continue;
      found.files.set(member.file, { from: receipt.run, seconds: member.seconds ?? null, tests: Array.isArray(member.tests) ? member.tests : [] });
    }
    receipt.members.commands.forEach((member, index) => {
      const command = receipt.coverage.commands[index];
      const ran = receipt.execution?.commands?.[index];
      if (member?.how !== 'ran' || member.outcome !== 'passed' || !command || command.packageScript !== member.packageScript
        || ran?.exit !== 0 || ran.ok !== true || ran.unavailable || ran.error) return;
      if (command.passBaseRef && receipt.base !== measurement.base) return;
      found.commands.set(commandIdentity(command), { from: receipt.run, packageScript: command.packageScript });
    });
  }
  return found;
}

/** Only an entire unfiltered selector result is compatible with the existing
 * cache. Named files are still limited even if they happen to equal it. */
export function recordReceiptGreen({ root, receipt, path }) {
  if (receipt.outcome !== 'green' || !fullCoverage(receipt.coverage)) return false;
  recordGreen({ root, entry: {
    repo: receipt.repo, tree: receipt.tree, head_tree: receipt.tree, base: receipt.base,
    selection: selectionHash(receipt.coverage), gate_version: receipt.gate_version,
    at: receipt.ended, session: receipt.session_run || receipt.run,
    files: receipt.coverage.files, commands: receipt.coverage.commands.map((command) => command.packageScript),
    receipt: path,
  } });
  return true;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** A receipt for a frozen head. The caller supplies a frozen local head
 * and an independently observed pushed SHA (not a tracking-ref assumption).
 * This lookup grants no publication/merge authority and performs no push. */
export function findPublicationReceipt({ root, cwd, repo, run, sessionRun = null, goalRevision = null,
  head, pushed, selection, configuration } = {}) {
  if (!/^[0-9a-f]{40,64}$/u.test(head || '') || pushed !== head
    || !Array.isArray(selection?.files) || !Array.isArray(selection.commands)) return null;
  try {
    const git = (ref) => {
      const result = runGit(cwd, ['rev-parse', '--verify', ref], { timeoutMs: 60_000 });
      if (result.status !== 0 || result.error) throw new Error('commit unavailable');
      return result.stdout.trim();
    };
    if (git('HEAD') !== head) return null;
    const content = captureWorktree(cwd);
    if (git(`${head}^{tree}`) !== content.tree) return null;
    const receipt = readGreenReceipt({ root, repo, repository: content.repository, run, sessionRun, goalRevision, configuration });
    if (!receipt || !sameContent(receipt, content) || !fullCoverage(receipt.coverage)
      || checksHash(receipt.coverage) !== checksHash(selection)) return null;
    return freeze(receipt);
  } catch { return null; }
}
