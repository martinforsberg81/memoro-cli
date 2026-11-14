/** Main's red is runner lane work, never a goal (Martin, 2026-11-13). */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { readTextOrNull } from './goals.js';
import { realLock } from './runner-lock.js';
import { workRoot } from './paths.js';

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

/** Shared by merge rounds and the daily full run; finder is stable across repeats. */
export function requestMainRepair({ repo, base, files, tests = [], pr = null, now = () => new Date(), ...state }) {
  try {
    const red = [...new Set(files || [])].filter(Boolean).sort();
    if (!repo || !base || !red.length) return { skipped: 'nothing to repair' };
    return updateMainMends({ ...state, repo }, (entries) => {
      const created = []; const open = [];
      for (const file of red) {
        const pending = entries.find((entry) => entry.file === file && entry.state !== 'landed');
        if (pending) { open.push(pending.id); continue; }
        const id = randomUUID();
        entries.push({ id, file, tests: tests.filter((test) => test.file === file), base,
          finder: pr ? `round of ${repo}#${pr}` : 'the full run',
          state: 'queued', failures: 0, created: now().toISOString() });
        created.push(id);
      }
      return { created, open };
    });
  } catch (error) { return { skipped: error?.message || String(error) }; }
}

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
export function answerMainMend({ repo, pr, landed, reason, ...state }) {
  return updateMainMends({ ...state, repo }, (entries) => {
    const answered = entries.filter((entry) => entry.pr === Number(pr) && ['published', 'running'].includes(entry.state));
    for (const entry of answered) {
      if (landed) entry.state = 'landed';
      else failMainMend(entry, reason);
    }
    return answered;
  });
}

export function mainMendPrompt({ repo, entries, branch, worktree }) {
  return `You are a main-red mend session, headless, with no goal. Work in ${worktree} on ${branch}.\n` +
    `Repair main's red in ${repo}, found by ${entries[0].finder}. Read the main-red section of your mend role; write no GOAL.json, LOG.md or proposal.\n` +
    entries.map((entry) => `${entry.file} at base ${entry.base}:\n${JSON.stringify(entry.tests, null, 2)}`).join('\n') +
    `\nPrevious outcome: ${entries[0].reason || 'first attempt'}; session log: ${entries[0].session_log || 'none'}.\n` +
    `Prove mc gate --fresh ${entries.map((entry) => entry.file).join(' ')} GREEN (none of these files SETTLED), then mc gate --whole-selection. Commit and mc publish --title "Repair main's red: ${entries.map((entry) => entry.file).join(', ')}" --body-file <file in MC_SCRATCH>. The body records cause and gate evidence. End after publication; the runner records the outcome. Another red file is not yours.`;
}

/** Status readers retain unreadable-state evidence instead of calling it an empty queue. */
export function mainMendReading({ repo, ...state }) {
  try { return { entries: readMainMends({ repo, ...state }).filter((entry) => entry.state !== 'landed'), error: null }; }
  catch (error) { return { entries: [], error: error.message }; }
}
