/** Main's red is runner lane work, never a goal (Martin, 2026-11-13). */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { readTextOrNull } from './goals.js';
import { dequeue, mergesPath, parseQueue } from './merge-queue.js';
import { realLock } from './runner-lock.js';
import { mcHome, workRoot } from './paths.js';
import { mainRedPath } from './selector-miss.js';

/** Final states: a later red of the file is a new entry, and the entry's worktree is the runner's to remove. */
export const FINISHED = ['landed', 'dropped'];
/** The states in which an entry still owns its branch, its pull request and its worktree. */
export const UNFINISHED = ['queued', 'running', 'published', 'Martin'];

export function mainMendPath(root, repo) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(repo)) throw new Error(`invalid main-mend repository: ${repo}`);
  return join(root, 'runner', 'main-mend', `${repo}.json`);
}

export function readMainMends({ root = workRoot(), repo, read = readTextOrNull }) {
  const text = read(mainMendPath(root, repo));
  if (text == null) return [];
  const value = typeof text === 'string' ? JSON.parse(text) : text;
  if (value?.version !== 1 || !Array.isArray(value.entries)) throw new Error(`invalid main-mend state for ${repo}`);
  return value.entries;
}

/** Every read-patch-write uses the runner's lock and whole-file atomic write. */
export function updateMainMends({ root = workRoot(), repo, read = readTextOrNull, write = writeJsonAtomic, lock = realLock }, change) {
  return lock(root, () => {
    const entries = readMainMends({ root, repo, read });
    const result = change(entries);
    write(mainMendPath(root, repo), { version: 1, entries });
    return result;
  }, { name: 'main-mend', strict: true });
}

/** Shared by merge rounds and the runner's full run; finder is stable across repeats. */
export function shapeMainRedTest(test) {
  return {
    file: test.file,
    name: test.name,
    ...(test.at ? { at: test.at } : {}),
    error: (test.error || []).slice(0, 12),
    ...(test.detail?.length ? { detail: test.detail.slice(0, 40) } : {}),
    ...(test.stack?.length ? { stack: test.stack.slice(0, 20) } : {}),
  };
}

export function requestMainRepair({ repo, base, files, tests = [], commands = [], checks = [], pr = null, contains = null, now = () => new Date(), ...state }) {
  try {
    const red = [...new Set(files || [])].filter(Boolean).sort();
    const members = [...red.map(file => ({ file })), ...commands.map(command => ({
      file: `command:${command.packageScript}`, command,
    })), ...checks.map(check => ({ file: check.key, check }))];
    if (!repo || !base || !members.length) return { skipped: 'nothing to repair' };
    return updateMainMends({ ...state, repo }, (entries) => {
      const created = []; const open = []; const finished = []; const stale = []; const staleMembers = [];
      for (const { file, command, check } of members) {
        // A check member is once-only on its key in any state: a finished one is returned, never made again.
        const pending = entries.find((entry) => entry.file === file && (check || !FINISHED.includes(entry.state)));
        if (pending) { (check && FINISHED.includes(pending.state) ? finished : open).push(pending.id); continue; }
        const latest = [...entries].reverse().find((entry) => entry.file === file);
        if (!check && latest?.state === 'landed' && latest.landed_commit && contains) {
          let includesRepair = null;
          try { includesRepair = contains(latest.landed_commit, base); } catch { /* unknown ancestry opens a fresh entry */ }
          if (includesRepair === false) { stale.push(latest.id); staleMembers.push({ id: latest.id, file, landed_commit: latest.landed_commit, pr: latest.pr }); continue; }
        }
        const id = randomUUID();
        entries.push({ id, file, tests: tests.filter((test) => test.file === file), base,
          ...(command ? { command } : {}),
          ...(check ? { check: { part: check.part, why: check.why, sha: check.sha, started: check.started, verdict: check.verdict, taken_back: Boolean(check.taken_back) } } : {}),
          finder: check?.finder || (pr ? `round of ${repo}#${pr}` : 'the full run'),
          state: 'queued', failures: 0, created: now().toISOString() });
        created.push(id);
      }
      // `finished`: check members already made and since landed or dropped (a check member is once-only, in any state).
      return { created, open, ...(checks.length ? { finished } : {}), stale, ...(stale.length ? { stale_members: staleMembers } : {}) };
    });
  } catch (error) { return { skipped: error?.message || String(error) }; }
}

/** The key of a check member: one per red part of one release's check. */
export const checkMemberKey = (part, started) => `check:${part}@${started}`;

/** The batch identity survives retries, new requests never join a used branch. */
export function mainMendBranch(repo, entries) {
  return entries[0].branch || `mend/main-${repo}-${createHash('sha256').update(entries.map((entry) => entry.id).sort().join('\n')).digest('hex').slice(0, 12)}`;
}

/** Two attempts; a third is held for Martin, with the most recent session evidence. */
export function failMainMend(entry, reason) {
  entry.failures = (entry.failures || 0) + 1;
  entry.state = entry.failures >= 2 ? 'Martin' : 'queued';
  entry.reason = reason;
}

/** mc publish records ownership BEFORE queueing: a fast merger may finish before the session. */
export function publishMainMend({ repo, branch, pr, ...state }) {
  if (!branch?.startsWith(`mend/main-${repo}-`)) return;
  return updateMainMends({ ...state, repo }, (entries) => {
    for (const entry of entries) if (entry.branch === branch && entry.state === 'running') {
      entry.pr = Number(pr); entry.state = 'published';
    }
  });
}

/** Transient requeues are handled by the merger, not counted as failed attempts. */
export function answerMainMend({ repo, pr, landed, reason, commit = null, ...state }) {
  return updateMainMends({ ...state, repo }, (entries) => {
    const answered = entries.filter((entry) => entry.pr === Number(pr) && ['published', 'running'].includes(entry.state));
    for (const entry of answered) {
      if (landed) { entry.state = 'landed'; if (commit) entry.landed_commit = commit; }
      else failMainMend(entry, reason);
    }
    return answered;
  });
}

/** What the desk found when it requeued a held repair, for the next session to start from. */
function answersOf(entries) {
  const lines = entries.filter((entry) => entry.answered?.verb === 'requeue' && entry.answered.reason)
    .map((entry) => `${entry.file}: ${entry.answered.reason} (${entry.answered.by}, ${entry.answered.at})`);
  return lines.length ? `The desk requeued this repair with what it found:\n${lines.join('\n')}\n` : '';
}

/** What a `check:` member asks of its session, in its own words (the mend role's main-red section says how it is proved). */
function checkMemberText(entry) {
  const { sha = '', why = '', verdict = '', started = '', taken_back: back } = entry.check;
  return `${entry.file} at base ${entry.base}:\n` +
    `production's check after the deploy of ${String(sha).slice(0, 7)} (started ${started}) was red with ${why || 'no reason given'}. ` +
    `${back ? 'The release was taken back; production serves the version before it.' : 'The release was not taken back.'} ` +
    `Read the verdict ${verdict || '(its file is gone)'} and the check log beside it, find the cause at base, repair it in ${entry.repo || 'the repository'}, and prove the repair with the gate on what you changed. Do not deploy: the next deploy of a later green commit ships it.`;
}

export function mainMendPrompt({ repo, entries, branch, worktree, history = [], root = mcHome(), exists = () => false }) {
  const files = entries.filter(entry => !entry.command && !entry.check).map(entry => entry.file);
  const checks = [
    ...(files.length ? [`mc gate --fresh ${files.join(' ')}`] : []),
    ...entries.filter(entry => entry.command).map(entry => `mc gate --fresh --command ${entry.command.id || entry.command.packageScript}`),
  ];
  const proof = checks.length
    ? `Prove ${checks.join(' and ')} GREEN (none of these checks SETTLED), then bare mc gate.`
    : 'Prove the repair with mc gate on the files you changed (none of these checks SETTLED), then bare mc gate.';
  const pathFor = (entry) => mainRedPath(root, repo, entry.base);
  const testsFor = (entry) => (entry.tests || []).map((test) => {
    const detail = test.detail || [];
    const printed = new Set(detail.map(line => line.trim()));
    return [
      `  ${test.name ?? '(unnamed test)'}`, ...(test.at ? [`    at ${test.at}`] : []),
      ...(test.error || []).map(line => `    ${line}`), ...detail.map(line => `    ${line}`),
      ...(test.stack || []).filter(line => !printed.has(line.trim())).map(line => `    ${line}`),
    ].join('\n');
  }).join('\n');
  const memberText = (entry) => {
    if (entry.check) return checkMemberText({ ...entry, repo });
    if (entry.command) return `${entry.file} at base ${entry.base}:\n${JSON.stringify(entry.command, null, 2)}`;
    const record = pathFor(entry);
    const prior = history.filter(old => old.file === entry.file && FINISHED.includes(old.state)).map(old =>
      `Earlier ${old.file}: state ${old.state}; PR #${old.pr ?? 'none'}; landed_commit ${old.landed_commit || 'unknown'}; ${old.reason || 'no reason recorded'}`);
    return `${entry.file} at base ${entry.base}:\n${testsFor(entry)}\n` +
      `${exists(record) ? `Retained main-red record: ${record}` : `No retained main-red record: ${record}`}\n` +
      (prior.length ? `${prior.join('\n')}\n` : '');
  };
  return `You are a main-red mend session, headless, with no goal. Work in ${worktree} on ${branch}.\n` +
    `Repair main's red in ${repo}, found by ${entries[0].finder}. Read the main-red section of your mend role; write no GOAL.json, LOG.md or proposal.\n` +
    entries.map(memberText).join('\n') +
    `\nRead where each assertion failed before you run anything. A red that is green alone at the same commit is not ended as unreproducible: when the recorded failure names a missing executable, browser, library or service, classify it as the main-red section says; otherwise the test depends on load, timing or order, and the repair is to the test or the code it exposes.\n` +
    `\nPrevious outcome: ${entries[0].reason || 'first attempt'}; session log: ${entries[0].session_log || 'none'}.\n` +
    answersOf(entries) +
    `${proof} No wide selection is required for landing. Commit and mc publish --title "Repair main's red: ${entries.map((entry) => entry.file).join(', ')}" --body-file <file in MC_SCRATCH>. The body records cause and gate evidence. End after publication; the runner records the outcome. Another red member is not yours.`;
}

/** Status readers retain unreadable-state evidence instead of calling it an empty queue. */
export function mainMendReading({ repo, ...state }) {
  try { return { entries: readMainMends({ repo, ...state }).filter((entry) => !FINISHED.includes(entry.state)), error: null }; }
  catch (error) { return { entries: [], error: error.message }; }
}

class Refusal extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * The desk's answer to a repair held on Martin: `requeue` or `drop`. Returns `{ ok: true, line }` or
 * `{ ok: false, code, error }` (2: refused, nothing written; 1: could not be done, the entry still reads Martin).
 * Every step is its own hold of the runner lock and none is nested, which the lock is not built for: the
 * state is read with no lock (readMainMends); the pull request is viewed, closed and confirmed with no lock
 * held; its merge-queue row is taken out under the `merges` hold; the state is written in one `updateMainMends`
 * hold, on the entry as read again there. `gh(cwd, args)` answers `{ ok, stdout, stderr }`.
 */
export function answerHeldMend({ root = workRoot(), repo, id, verb, reason, role, repoPath = null, now = () => new Date(),
  read = readTextOrNull, write = writeJsonAtomic, lock = realLock, gh = null, readQueue = readTextOrNull,
  writeQueue = (path, entries) => writeJsonAtomic(path, entries) }) {
  const state = { root, repo, read, write, lock };
  try {
    const text = String(reason ?? '').trim();
    if (!['requeue', 'drop'].includes(verb)) throw new Refusal(`mc repo mend <repo> <id> requeue|drop --reason "<text>": ${verb ?? 'no verb'} is not one`, 2);
    if (!text) throw new Refusal(`${verb} needs --reason "<text>": what the desk found, for the next session or the record`, 2);
    const label = `${repo}/${id}`;
    try { mainMendPath(root, repo); } catch { throw new Refusal(`${repo} is not a repository name`, 2); }
    let entries;
    try { entries = readMainMends(state); } catch (error) { throw new Refusal(`the main-red state of ${repo} cannot be read (${error.message})`, 1); }
    const found = entries.find((entry) => entry.id === id);
    if (!found) throw new Refusal(`no main-red entry ${label}`, 2);
    if (found.state !== 'Martin') throw new Refusal(`main-red ${label} reads ${found.state}, not Martin; only a held repair is answered`, 2);
    const answered = () => ({ verb, by: role, at: now().toISOString(), reason: text });
    const stale = (entry) => new Refusal(`main-red ${label} now reads ${entry ? entry.state : 'nothing'}, not Martin; nothing was written`, 1);
    if (verb === 'requeue') {
      updateMainMends(state, (all) => {
        const entry = all.find((x) => x.id === id);
        if (entry?.state !== 'Martin') throw stale(entry);
        Object.assign(entry, { state: 'queued', failures: 0, answered: answered() });
      });
      return { ok: true, line: `main-red ${label} (${found.file}) requeued; the runner takes it at its next pick, on ${found.branch || 'its own branch'}` };
    }
    // drop: the pull request first, with no lock held.
    const pr = found.pr ? Number(found.pr) : null;
    const carriedBy = (all) => pr != null && all.some((x) => x.id !== id && Number(x.pr) === pr && UNFINISHED.includes(x.state));
    const shared = carriedBy(entries);
    let closed = false;
    if (pr != null && !shared) {
      if (!gh || !repoPath) throw new Refusal(`${repo} is not a repository mc knows; its pull request #${pr} cannot be checked`, 1);
      const view = () => { const r = gh(repoPath, ['pr', 'view', String(pr), '--json', 'state']); try { return r.ok ? JSON.parse(r.stdout || 'null')?.state ?? null : null; } catch { return null; } };
      let at = view();
      if (at == null) throw new Refusal(`GitHub could not say where ${repo}#${pr} stands; the entry still reads Martin`, 1);
      if (at === 'OPEN') {
        const result = gh(repoPath, ['pr', 'close', String(pr), '--comment', `The main-red repair of ${found.file} was dropped: ${text}`]);
        if (!result.ok) throw new Refusal(`GitHub could not close ${repo}#${pr} (${result.stderr?.trim() || 'close failed'}); the entry still reads Martin`, 1);
        at = view(); closed = true;
        if (at !== 'CLOSED' && at !== 'MERGED') throw new Refusal(`GitHub did not confirm ${repo}#${pr} closed; the entry still reads Martin`, 1);
      } else if (at !== 'CLOSED' && at !== 'MERGED') throw new Refusal(`GitHub returned an unknown state for ${repo}#${pr}; the entry still reads Martin`, 1);
      try {
        lock(root, () => {
          const path = mergesPath(root);
          writeQueue(path, dequeue(parseQueue(readQueue(path)), { repo, pr }));
        }, { name: 'merges' });
      } catch (error) { throw new Refusal(`the merge queue could not be updated (${error?.message || error}); the entry still reads Martin`, 1); }
    }
    updateMainMends(state, (all) => {
      const entry = all.find((x) => x.id === id);
      if (entry?.state !== 'Martin') throw stale(entry);
      if (shared && !carriedBy(all)) throw new Refusal(`main-red ${label} still reads Martin: ${repo}#${pr} was left open for another repair that no longer carries it; run the verb again`, 1);
      Object.assign(entry, { state: 'dropped', answered: answered() });
    });
    return { ok: true, line: `main-red ${label} (${found.file}) dropped${closed ? `; ${repo}#${pr} closed` : pr != null ? `; ${repo}#${pr} left ${shared ? 'open, another repair carries it' : 'as it was'}` : ''}` };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, error: error.message };
    return { ok: false, code: 1, error: error?.message || String(error) };
  }
}

/**
 * The one removal of a finished repair's worktree. A finished entry (landed or dropped) names the tree it used;
 * the tree goes, without force, unless an entry that is queued, running, published or Martin still names it, a
 * `runner/current-*.json` names it as its worktree (`currents()`, paths), or `busy(entry)` says its owner still
 * runs. A path that no longer exists is skipped: git is not called and nothing is reported. `git(cwd, args)`
 * answers `{ ok, stderr }`. Returns `{ removed, kept, inUse }`: `kept` is what git refused, with its stderr
 * (uncommitted work, a session still exiting), `inUse` what was left for the entry or session that still needs it.
 */
export function removeFinishedWorktrees({ root = workRoot(), repo, repoPath, git, exists, read = readTextOrNull, currents = null, busy = () => false }) {
  const result = { removed: [], kept: [], inUse: [] };
  let entries;
  try { entries = readMainMends({ root, repo, read }); } catch { return result; }
  const wanted = new Set(entries.filter((entry) => UNFINISHED.includes(entry.state) && entry.worktree).map((entry) => entry.worktree));
  for (const path of (currents ?? (() => currentWorktrees({ root, read })))()) if (path) wanted.add(path);
  const finished = entries.filter((entry) => FINISHED.includes(entry.state) && entry.worktree);
  for (const path of new Set(finished.map((entry) => entry.worktree))) {
    if (!exists(path)) continue;
    if (wanted.has(path) || finished.some((entry) => entry.worktree === path && busy(entry))) { result.inUse.push(path); continue; }
    const removed = git(repoPath, ['worktree', 'remove', path]);
    if (removed.ok) result.removed.push(path);
    else result.kept.push({ path, reason: removed.stderr?.trim() || 'git refused cleanup' });
  }
  return result;
}

/** The worktrees the runner's sessions are standing in: `runner/current-*.json`. */
function currentWorktrees({ root, read }) {
  let files = [];
  try { files = readdirSync(join(root, 'runner')).filter((file) => /^current-.+\.json$/u.test(file)); } catch { return []; }
  return files.map((file) => { try { return JSON.parse(read(join(root, 'runner', file)))?.worktree ?? null; } catch { return null; } });
}
