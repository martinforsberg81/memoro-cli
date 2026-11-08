/** Read-only view of goals currently waiting on Martin. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GOAL_FILE, LOG_FILE, parseGoal, parseLog, renderGoalText, waitsOnPerson } from './goals.js';
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
    const malformedEntries = (String(logText ?? '').match(/^## /gmu) || []).length - log.length;
    if (malformedEntries > 0) issues.push({ path: logPath, error: `${malformedEntries} malformed log entr${malformedEntries === 1 ? 'y' : 'ies'} could not be parsed` });
    const question = currentQuestion(log, parsed.status);
    const README = join(home, programme, 'README.md');
    let context = programme_context.get(programme);
    if (!context) {
      const readmeText = read(README);
      context = { programme, README: readmeText === null ? null : { path: README, text: readmeText }, rulings: [] };
      if (readmeText === null) issues.push({ path: README, error: 'missing or unreadable README.md' });
      programme_context.set(programme, context);
    }
    const rulings = parsed.repos.flatMap((repo) => {
      const candidates = [join(home, programme, repo, 'docs', 'project', programme, 'rulings.md'), join(dir, repo, 'docs', 'project', programme, 'rulings.md')];
      const found = candidates.flatMap((path) => { const text = read(path); return text === null ? [] : [{ repo, path, text }]; });
      for (const ruling of found) if (!context.rulings.some((item) => item.path === ruling.path)) context.rulings.push(ruling);
      return found.map((item) => item.path);
    });
    const record = {
      programme, goal, reference: `${programme}/${goal}`, dir,
      stage: parsed.stage, status: parsed.status, phase: parsed.phase,
      title: parsed.title, goal_text: parsed.goal, contract: parsed.contract,
      exclusions: parsed.out_of_scope, criteria: parsed.success_criteria,
      documents: parsed.documents, goal_markdown: renderGoalText(parsed),
      question,
      log: log.slice(-3), log_path: logPath,
      log_reference: pathToFileURL(logPath).href,
      worktrees: parsed.repos.map((repo) => ({ repo, path: join(dir, repo) })),
      evidence_paths: parsed.documents.map((doc) => doc.path),
      rulings,
    };
    items.push(record);
  }
  // A pending structured question's timestamp is the ordering key. When a
  // runner blocked without one, retain its latest stage-entry time as evidence.
  items.sort((a, b) => {
    const left = a.question?.at || '\uffff'; const right = b.question?.at || '\uffff';
    return left.localeCompare(right) || a.reference.localeCompare(b.reference);
  });
  return { items, programme_context: [...programme_context.values()], issues: dedupeIssues(issues), selected: selector };
}

/** Preserve the newest unresolved structured question, not merely the log tail. */
export function currentQuestion(log, status) {
  if (status !== 'Martin') return null;
  let start = log.findLastIndex((entry) => entry.status !== 'Martin') + 1;
  const current = log.slice(start).filter((entry) => entry.status === 'Martin');
  for (let i = current.length - 1; i >= 0; i -= 1) {
    const entry = current[i];
    const comment = String(entry.comment || '');
    const q = comment.match(/(?:Martin is asked|jev was asked):\s*(.+)/u);
    if (!q) continue;
    const options = [...comment.matchAll(/^Option ([a-z][a-z0-9_]*):\s*(.*)$/gmu)].map((m) => ({ key: m[1], text: m[2] }));
    const recommendation = comment.match(/^Recommended:\s*(\S+)/mu)?.[1] || null;
    const jev = comment.match(/^(jev unavailable:.*|jev:.*|jev not asked:.*)$/gmu)?.at(-1) || null;
    return { at: entry.at, question: q[1], options, recommendation, jev, reason: comment };
  }
  const entry = current.at(-1) || log.at(-1);
  const comment = String(entry?.comment || '');
  return { at: entry?.at || null, reason: comment || entry?.done || 'The goal is Martin but the current log has no recorded reason.', limitation: 'No structured question/options/recommendation were recorded.' };
}

export function renderMartinQueue(result, { json = false } = {}) {
  if (json) return `${JSON.stringify({ ok: !result.error, ...result }, null, 2)}\n`;
  if (result.error) return `mc: ${result.error}\n`;
  if (!result.items.length) return `mc: no goals waiting on Martin${result.issues.length ? ` (${result.issues.length} unreadable/malformed source${result.issues.length === 1 ? '' : 's'} reported below)` : ''}\n${renderIssues(result.issues)}`;
  const lines = [`mc: ${result.items.length} goal${result.items.length === 1 ? '' : 's'} waiting on Martin`];
  const shownProgrammes = new Set();
  for (const item of result.items) {
    lines.push('', `${item.reference} · ${item.stage} · ${item.status} · phase ${item.phase}`, `# ${item.title}`);
    if (!shownProgrammes.has(item.programme)) {
      const context = result.programme_context.find((p) => p.programme === item.programme);
      lines.push(`README: ${context?.README?.path || '(unreadable or missing)'}`);
      if (context?.README?.text) lines.push(context.README.text.trimEnd());
      for (const ruling of context?.rulings || []) lines.push(`Rulings (${ruling.repo}): ${ruling.path}\n${ruling.text.trimEnd()}`);
      shownProgrammes.add(item.programme);
    }
    lines.push(item.goal_markdown.trimEnd(), `Question: ${item.question?.question || item.question?.reason || 'No current question recorded.'}`);
    if (item.question?.options?.length) lines.push(`Options: ${item.question.options.map((o) => `${o.key}: ${o.text}`).join('; ')}`, `Recommended: ${item.question.recommendation || 'not recorded'}`);
    if (item.question?.jev) lines.push(`jev: ${item.question.jev}`);
    if (item.question?.limitation) lines.push(item.question.limitation);
    lines.push(`LOG: [full LOG.md](${item.log_reference}) (${item.log.length} latest entries)`, ...item.log.map((e) => `  ${e.at} · ${e.tool}${e.role ? `/${e.role}` : ''} · ${e.status}: ${e.comment || e.done || e.next || '—'}`));
    lines.push(`Worktrees/evidence: ${[...(item.worktrees || []).map((w) => w.path), ...(item.evidence_paths || [])].join(', ') || '(none)'}`, `Rulings references: ${(item.rulings || []).join(', ') || '(none)'}`);
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
