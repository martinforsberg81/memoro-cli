import { join } from 'node:path';
import { listLessons, readLesson, lessonWithLearning } from './desk-lessons.js';
import { learningLine, writeLearning } from './lesson-learning.js';
import { queueMerge } from './merger.js';
import { runnerDir, workRoot } from './paths.js';
import { processAlive, readClaim } from './resource-claim.js';
import { realLock } from './runner-lock.js';

export const learningClaimPath = (env) => join(runnerDir(env), 'learning.claim');
export function activeLearning(env) {
  const claim = readClaim(learningClaimPath(env));
  return env.MC_ROLE === 'learning' && env.MC_HEADLESS === '1' && env.MC_LEARNING_RUN
    && claim?.run === env.MC_LEARNING_RUN && processAlive(claim.pid) ? claim : null;
}

/** Compare and write under the runner lock. No git, GitHub or provider call holds it. */
export function updateLearning({ name, env, change, lock = realLock }) {
  return lock(workRoot(env), () => {
    const lesson = lessonWithLearning(readLesson(name, { env }), env);
    if (!lesson) throw new Error(`unknown lesson ${name}`);
    const entry = change(lesson);
    if (entry) writeLearning(lesson, entry, env);
    return entry;
  }, { strict: true, name: 'area-learning' });
}

const fields = 'number,url,state,headRefOid,baseRefName,mergedAt';
function readRemote(gh, cwd, args) {
  const r = gh(cwd, args);
  if (!r?.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** The publication owns one branch/head. Do not attribute another head or base to its evidence. */
export function publicationAnswer(entry, { repoPath, gh }) {
  if (entry.pr) return readRemote(gh, repoPath, ['pr', 'view', String(entry.pr), '--json', fields]);
  const rows = readRemote(gh, repoPath, ['pr', 'list', '--state', 'all', '--head', entry.branch, '--json', fields]);
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row.headRefOid === entry.head && row.baseRefName === 'main') ?? { state: 'NOT-FOUND' };
}

/** Turn a GitHub observation into a receipt. Unknown is never evidence of a merge or closure. */
export function answerPublication(entry, pr, { env, now, repoPath, queue = queueMerge }) {
  if (!pr) return null;
  const failed = { ...entry, pid: null, state: 'publication-failed', at: now.toISOString() };
  if (pr.state === 'NOT-FOUND') return failed;
  if (!['OPEN', 'MERGED', 'CLOSED'].includes(pr.state) || !Number.isSafeInteger(pr.number)
    || !pr.headRefOid || !pr.baseRefName) return null;
  if (pr.headRefOid !== entry.head || pr.baseRefName !== 'main') return failed;
  const seen = { ...entry, pid: null, pr: pr.number, reference: `${entry.repo}#${pr.number}`, url: pr.url };
  if (pr.state === 'MERGED') return { ...seen, state: 'corrected', at: Number.isFinite(Date.parse(pr.mergedAt)) ? pr.mergedAt : now.toISOString() };
  if (pr.state === 'CLOSED') return { ...seen, state: failed.state, at: failed.at };
  if (pr.state !== 'OPEN' || entry.state === 'publication-pending') return null;
  // Keep the same PR if interrupted between opening it and handing it to the merger.
  queue({ root: workRoot(env), repo: entry.repo, repoPath, pr: pr.number, branch: entry.branch, now, env });
  return { ...seen, state: 'publication-pending', at: now.toISOString() };
}

/** Ordinary chores answer each outstanding PR once, even when no session is due. */
export function reconcileAreaLearning({ env, now, repos, gh, queue, say = () => {} }) {
  const answers = new Map();
  for (const lesson of listLessons({ env })) {
    const entry = lesson.learning;
    if (entry?.legacy) {
      updateLearning({ name: lesson.name, env, change: current => current.learning?.legacy
        ? { ...entry, legacy: false, legacyBrief: true, evidence: current.evidence, at: current.dismissed_at } : null });
      continue;
    }
    if (!['publishing', 'publication-pending'].includes(entry?.state) || processAlive(entry.pid)) continue;
    const repoPath = repos.find(repo => repo.name === entry.repo)?.path;
    if (!repoPath) continue;
    const key = `${entry.repo}:${entry.pr ?? entry.branch}:${entry.head}`;
    try {
      if (!answers.has(key)) {
        const remote = publicationAnswer(entry, { repoPath, gh });
        answers.set(key, answerPublication(entry, remote, { env, now, repoPath, queue }));
      }
      const answer = answers.get(key);
      if (!answer) continue;
      const saved = updateLearning({ name: lesson.name, env, change: current => {
        if (JSON.stringify(current.learning) !== JSON.stringify(entry)) return null;
        return applyPublication(entry, answer);
      } });
      if (saved) say(learningLine(saved));
    } catch (error) { say(`learning: ${lesson.name} — could not reconcile publication (${error.message})`); }
  }
}

/** A grouped correction shares PR facts, not the evidence, links or retry count of another lesson. */
export function applyPublication(entry, answer) {
  const { state, pid, pr, reference, url, at } = answer;
  return { ...entry, state, pid, pr, reference, url, at,
    links: reference ? { ...entry.links, publication: reference } : entry.links };
}
