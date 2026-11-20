/** Read-only view of goals and goal-less main-red repairs waiting on Martin. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GOAL_FILE, LOG_FILE, entryHeadings, parseGoal, parseLog, renderGoalText, waitsOnPerson } from './goals.js';
import { deployMendPath, deployMendReading } from './deploy-repair.js';
import { mainMendReading } from './main-repair.js';
import { deskEntries } from './take-back-run.js';
import { programsHome } from './paths.js';

const NAME = /^[a-z0-9][a-z0-9-]*$/u;

/** Collect the live queue without repairing or writing any source record. */
export function collectMartinQueue({ selector = { kind: 'all' }, home = programsHome(), list = listDirectories, read = readSource } = {}) {
  const issues = [];
  const programmes = list(home, issues);
  const refs = [];
  if (selector.kind === 'programme' && (!NAME.test(selector.value) || !programmes.includes(selector.value))) return { error: `unknown or invalid programme ${selector.value}`, items: [], issues };
  if (selector.kind === 'goal') {
    const parts = selector.value.split('/');
    const [programme, goal] = parts;
    if (parts.length !== 2 || !NAME.test(programme) || !NAME.test(goal) || !programmes.includes(programme)) return { error: `unknown or invalid goal ${selector.value}`, items: [], issues };
    const names = list(join(home, programme, 'goals'), issues);
    if (!names.includes(goal)) return { error: `unknown or invalid goal ${selector.value}`, items: [], issues };
    refs.push([programme, goal]);
  } else {
    for (const programme of (selector.kind === 'programme' ? [selector.value] : programmes)) {
      for (const goal of list(join(home, programme, 'goals'), issues)) refs.push([programme, goal]);
    }
  }

  const items = [];
  const programme_context = new Map();
  for (const [programme, goal] of refs) {
    const dir = join(home, programme, 'goals', goal);
    const goalPath = join(dir, GOAL_FILE);
    const source = read(goalPath);
    if (source === null) {
      if (selector.kind === 'goal') return { error: `invalid goal ${selector.value}: unreadable ${goalPath}`, items: [], issues };
      issues.push({ path: goalPath, error: 'missing or unreadable GOAL.json' });
      continue;
    }
    const parsed = parseGoal(source);
    if (parsed.problems) {
      issues.push({ path: goalPath, error: parsed.problems.join('; ') });
      if (selector.kind === 'goal') return { error: `invalid goal ${selector.value}: ${parsed.problems.join('; ')}`, items: [], issues };
      continue;
    }
    if (parsed.stage === 'done' || parsed.stage === 'dropped' || !waitsOnPerson(parsed)) continue;
    const logPath = join(dir, LOG_FILE);
    const logText = read(logPath);
    if (logText === null) issues.push({ path: logPath, error: 'missing or unreadable LOG.md' });
    const log = parseLog(logText ?? '');
    const malformedEntries = entryHeadings(logText) - log.length;
    if (malformedEntries > 0) issues.push({ path: logPath, error: `${malformedEntries} malformed log entr${malformedEntries === 1 ? 'y' : 'ies'} could not be parsed` });
    const question = currentQuestion(log, parsed.status);
    const README = join(home, programme, 'README.md');
    let context = programme_context.get(programme);
    if (!context) {
      const readmeText = read(README);
      context = { programme, README: readmeText === null ? null : { path: README, text: readmeText } };
      if (readmeText === null) issues.push({ path: README, error: 'missing or unreadable README.md' });
      programme_context.set(programme, context);
    }
    const v2 = parsed.version === 2;
    const record = {
      programme, goal, reference: `${programme}/${goal}`, dir,
      version: parsed.version,
      stage: parsed.stage, status: parsed.status, phase: parsed.phase,
      title: parsed.title, goal_text: v2 ? parsed.outcome : parsed.goal,
      contract: v2 ? [...parsed.decisions, ...parsed.preserve].map((item) => item.text) : parsed.contract,
      exclusions: v2 ? parsed.out_of_scope.map((item) => item.text) : parsed.out_of_scope, criteria: parsed.success_criteria,
      documents: parsed.documents, goal_markdown: renderGoalText(parsed),
      question,
      log: log.slice(-3), log_path: logPath,
      log_reference: pathToFileURL(logPath).href,
      worktrees: parsed.repos.map((repo) => ({ repo, path: join(dir, repo) })),
      evidence_paths: parsed.documents.map((doc) => doc.path),
    };
    items.push(record);
  }
  if (selector.kind === 'all') {
    const root = dirname(home);
    let files = [];
    try { files = readdirSync(join(root, 'runner', 'main-mend')).filter((file) => file.endsWith('.json')); } catch (error) {
      if (error.code !== 'ENOENT') issues.push({ path: join(root, 'runner', 'main-mend'), error: error.message });
    }
    for (const file of files) {
      const repo = file.slice(0, -5);
      const reading = mainMendReading({ root, repo, read });
      if (reading.error) issues.push({ path: join(root, 'runner', 'main-mend', file), error: reading.error });
      for (const entry of reading.entries.filter((entry) => entry.state === 'Martin')) items.push({
        kind: 'main-red', reference: `main-red:${repo}/${entry.id}`, repo, file: entry.file, status: entry.state,
        reason: entry.reason, pr: entry.pr || null, session_log: entry.session_log, worktree: entry.worktree,
      });
    }
    // A deploy repair that reads Martin: its own file, never a desk item (the desk syncs goals and main-red only).
    const deploy = deployMendReading({ root, read });
    if (deploy.error) issues.push({ path: deployMendPath(root), error: deploy.error });
    if (deploy.entry?.state === 'Martin') items.push({
      kind: 'deploy-mend', reference: `deploy-mend:${deploy.entry.id}`, status: 'Martin', reason: deploy.entry.reason,
      session_log: deploy.entry.session_log, worktrees: deploy.entry.worktrees || [],
    });
    // A red release the runner did not take back (the red ledger, take-back-run.js): an act for the desk, from its own file.
    const reds = deskEntries({ env: { ...process.env, MC_WORK_ROOT: root }, read: (path) => {
      const text = read(path);
      if (text === null) throw Object.assign(new Error('missing or unreadable'), { code: 'ENOENT' });
      return text;
    } });
    if (reds.error) issues.push({ path: join(root, 'runner', 'check-red.json'), error: reds.error });
    for (const entry of reds.items) items.push({
      kind: 'take-back', reference: `take-back:${entry.started}`, status: 'Martin', sha: entry.sha, started: entry.started,
      reason: entry.reason, parts: entry.parts || [], repair: entry.repair || [], steps: entry.steps || [],
    });
  }
  // A pending structured question's timestamp is the ordering key. When a
  // runner blocked without one, retain its latest stage-entry time as evidence.
  items.sort((a, b) => {
    const left = a.question?.at || '\uffff'; const right = b.question?.at || '\uffff';
    return left.localeCompare(right) || a.reference.localeCompare(b.reference);
  });
  return { items, programme_context: [...programme_context.values()], issues: dedupeIssues(issues), selected: selector };
}

/**
 * The question of a goal that reads Martin, from its current run (the entries since the last one not
 * carrying status Martin): its newest structured `Martin is asked:` entry; else its newest goal-defect or
 * runner-stop entry (`goal defect:`, `no progress:`); else the entry that set the goal Martin. A later entry
 * that only carries the status is never the question.
 */
export function currentQuestion(log, status) {
  if (status !== 'Martin') return null;
  const start = log.findLastIndex((entry) => entry.status !== 'Martin') + 1;
  const current = log.slice(start).filter((entry) => entry.status === 'Martin' && !/^jev was asked:/mu.test(String(entry.comment || '')));
  for (let i = current.length - 1; i >= 0; i -= 1) {
    const entry = current[i];
    const comment = String(entry.comment || '');
    // Answered consultations retain Martin status but do not replace its
    // pending decision. Both ask writers label only unresolved calls this way.
    const q = comment.match(/^Martin is asked:\s*(.+)/mu);
    if (!q) continue;
    const options = [...comment.matchAll(/^Option ([a-z][a-z0-9_]*):\s*(.*)$/gmu)].map((m) => ({ key: m[1], text: m[2] }));
    const recommendation = comment.match(/^Recommended:\s*(\S+)/mu)?.[1] || null;
    const jev = comment.match(/^(jev unavailable:.*|jev:.*|jev not asked:.*|mc: jev did not settle it:.*|mc: reserved act .* — Martin decides, jev is not asked)$/gmu)?.at(-1) || null;
    return { at: entry.at, question: q[1], options, recommendation, jev, reason: comment };
  }
  const reported = current.findLast((x) => /^(goal defect|no progress):/u.test(String(x.comment || '')));
  const entry = reported || current[0];
  const comment = String(entry?.comment || '');
  return { at: entry?.at || null, reason: comment || entry?.done || 'The goal is Martin but the current log has no recorded reason.', limitation: 'No structured question/options/recommendation were recorded.' };
}

export function renderMartinQueue(result, { json = false } = {}) {
  if (json) return `${JSON.stringify({ ok: !result.error, ...result }, null, 2)}\n`;
  if (result.error) return `mc: ${result.error}\n`;
  if (!result.items.length) return `mc: no goals waiting on Martin${result.issues.length ? ` (${result.issues.length} unreadable/malformed source${result.issues.length === 1 ? '' : 's'} reported below)` : ''}\n${renderIssues(result.issues)}`;
  const noun = result.items.some((item) => ['main-red', 'deploy-mend', 'take-back'].includes(item.kind)) ? 'item' : 'goal';
  const lines = [`mc: ${result.items.length} ${noun}${result.items.length === 1 ? '' : 's'} waiting on Martin`];
  const shownProgrammes = new Set();
  for (const item of result.items) {
    if (item.kind === 'deploy-mend') {
      lines.push('', `${item.reference} · Martin`, 'Repair a stopped deploy (mc repo mend deploy <id> requeue|drop --reason "…")', item.reason || 'Recovery exhausted', `Session log: ${item.session_log || 'not recorded'}`);
      continue;
    }
    if (item.kind === 'take-back') {
      lines.push('', `${item.reference} · Martin`, `A red release was not taken back: ${String(item.sha || '').slice(0, 7)}${item.reason ? ` — ${item.reason}` : ''}`, ...item.steps,
        `It ends when a later release ships, or: mc deploy take-back --end ${item.started} --reason "…"`);
      continue;
    }
    if (item.kind === 'main-red') {
      lines.push('', `${item.reference} · Martin`, `Repair main's red: ${item.file}${item.pr ? ` · #${item.pr}` : ''}`, item.reason || 'Recovery exhausted', `Session log: ${item.session_log || 'not recorded'}`, `Worktree: ${item.worktree || 'not recorded'}`);
      continue;
    }
    lines.push('', `${item.reference} · ${item.stage} · ${item.status} · phase ${item.phase}`, `# ${item.title}`);
    if (!shownProgrammes.has(item.programme)) {
      const context = result.programme_context.find((p) => p.programme === item.programme);
      lines.push(`README: ${context?.README?.path || '(unreadable or missing)'}`);
      if (context?.README?.text) lines.push(context.README.text.trimEnd());
      shownProgrammes.add(item.programme);
    }
    lines.push(item.goal_markdown.trimEnd(), `Question: ${item.question?.question || item.question?.reason || 'No current question recorded.'}`);
    if (item.question?.options?.length) lines.push(`Options: ${item.question.options.map((o) => `${o.key}: ${o.text}`).join('; ')}`, `Recommended: ${item.question.recommendation || 'not recorded'}`);
    if (item.question?.jev) lines.push(`jev: ${item.question.jev}`);
    if (item.question?.question && item.question.reason) lines.push(`Source question record:\n${item.question.reason}`);
    if (item.question?.limitation) lines.push(item.question.limitation);
    lines.push(`LOG: [full LOG.md](${item.log_reference}) (${item.log.length} latest entries)`);
    for (const entry of item.log) {
      lines.push(`  ${entry.at} · ${entry.tool}${entry.role ? `/${entry.role}` : ''} · ${entry.stage} · ${entry.status}`);
      for (const [field, label] of [['done', 'Done'], ['comment', 'Comment'], ['next', 'Next']]) {
        if (entry[field]) lines.push(`    ${label}: ${entry[field]}`);
      }
    }
    lines.push(`Worktrees/evidence: ${[...(item.worktrees || []).map((w) => w.path), ...(item.evidence_paths || [])].join(', ') || '(none)'}`);
  }
  lines.push('', renderIssues(result.issues).trimEnd());
  return `${lines.filter(Boolean).join('\n')}\n`;
}

const renderIssues = (issues) => issues.map((issue) => `mc: source issue ${issue.path}: ${issue.error}`).join('\n') + (issues.length ? '\n' : '');
const dedupeIssues = (issues) => [...new Map(issues.map((i) => [`${i.path}\n${i.error}`, i])).values()];
function listDirectories(path, issues) {
  try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(); }
  catch (error) { if (error.code !== 'ENOENT') issues.push({ path, error: error.message }); return []; }
}
function readSource(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } }
