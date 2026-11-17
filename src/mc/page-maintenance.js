/**
 * MAINTENANCE's sources: what waits for somebody to handle it, one row per source (docs/technical/mc-ui.md, MAINTENANCE).
 *
 * `SOURCES` is the list the frame walks, in the order it draws: a new source is one more entry here and one reader in
 * `maintenanceSection`'s `readers`. A reader returns a reading `{ count, oldest_seconds, summary, tone, groups, … }` and
 * may throw; a reader that throws is that row, red, saying why — a source never disappears because its read failed. A
 * source with no reader at all (`none`) says so on its row.
 *
 * The readings are pure builders over read data, so a test feeds them fixtures; the reads that touch the machine are
 * `read*` below and are called only by `collectPage`. This module imports nothing from the page's renderers.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readAreas } from './areas.js';
import { areaKeysOnDisk, keyProposalsDir } from './area-proposals.js';
import { LATE_DAYS, listLessons } from './desk-lessons.js';
import { run } from './git.js';
import { ageWords } from './page-cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_S = 7 * 24 * 60 * 60;

/** The sources in the order the frame draws them. `verb` is what handles one; `none` is the row of a source with no reader. */
export const SOURCES = [
  { id: 'feedback', label: 'User feedback', verb: '', none: "no source — memoro's product feedback was retired (migration 0213)" },
  { id: 'proposals', label: 'Proposals', verb: 'mc proposals' },
  { id: 'lessons', label: 'Lessons', verb: 'mc martin' },
  { id: 'errors', label: 'Errors', verb: 'mc helper --intake' },
  { id: 'tests', label: 'Tests', verb: 'mc gate' },
  { id: 'deps', label: 'Dependencies', verb: 'mc deps' },
  { id: 'intake', label: 'Intake', verb: '~/mc/intake' },
  { id: 'areas', label: 'Areas', verb: '' },
  { id: 'strays', label: 'Strays', verb: '' },
];

const WAITS = ['yellow'];
const QUIET = ['grey'];
const seconds = (ms, now) => Math.max(0, Math.round((now.getTime() - ms) / 1000));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** How long, for the age of the oldest: hours and minutes as the page says them, days in words. */
export function howLong(secs) {
  if (secs == null) return 'unknown age';
  return secs >= 48 * 3600 ? `${Math.round(secs / 86400)} days` : ageWords(secs);
}
/** A calendar-day age as the areas row says it. */
export function dayWords(days) {
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
}
const oldestOf = (list) => (list.length ? Math.max(...list) : null);

/**
 * The one row a source's reading becomes, or the red row of a source whose read failed. `readers` is `{ <id>: () => reading }`.
 * The row: `{ id, label, verb, state: 'ok'|'error'|'none', count, oldest_seconds, summary, tone, error, …the reading }`.
 */
export function maintenanceSection({ readers = {}, sources = SOURCES } = {}) {
  return {
    sources: sources.map((source) => {
      const base = { id: source.id, label: source.label, verb: source.verb || '' };
      if (source.none) return { ...base, state: 'none', count: null, oldest_seconds: null, summary: source.none, tone: QUIET, error: null };
      const reader = readers[source.id];
      let reading;
      try {
        if (typeof reader !== 'function') throw new Error('no reader is wired for this source');
        reading = reader();
        if (!reading || typeof reading !== 'object') throw new Error('the reader returned nothing');
      } catch (error) {
        const why = String(error?.message || error).replace(/\s+/gu, ' ').trim();
        return { ...base, state: 'error', count: null, oldest_seconds: null, summary: `unreadable — ${why}`, tone: ['red'], error: why };
      }
      const problems = reading.problems?.length ? reading.problems : null;
      return {
        ...base,
        state: problems ? 'error' : 'ok',
        count: reading.count ?? null,
        oldest_seconds: reading.oldest_seconds ?? null,
        summary: reading.summary ?? '',
        tone: problems ? ['red'] : reading.tone || QUIET,
        error: problems ? problems.join('; ') : null,
        ...Object.fromEntries(Object.entries(reading).filter(([key]) => !['count', 'oldest_seconds', 'summary', 'tone', 'problems'].includes(key))),
      };
    }),
  };
}

/* ------------------------------------------------------------------ readings */

/**
 * Proposals: `areas` is `[{ area, files }]`, the files directly under each `~/mc/areas/<repo>/<area>/proposals/`
 * (`area` its key `<repo>/<area>`). A file is `{ name, at }` — the instant it is dated, in ms. Counted and aged by area.
 */
export function proposalsReading({ areas = [], now = new Date() } = {}) {
  const waiting = areas.filter((entry) => entry.files.length);
  const count = waiting.reduce((sum, entry) => sum + entry.files.length, 0);
  const age = (files) => { const ats = files.map((file) => file.at).filter(Number.isFinite); return ats.length ? seconds(Math.min(...ats), now) : null; };
  const oldest = age(waiting.flatMap((entry) => entry.files));
  const parts = [`${count} waiting in ${plural(waiting.length, 'area')}`];
  if (oldest != null) parts.push(`oldest ${howLong(oldest)}`);
  return {
    count, oldest_seconds: oldest, summary: parts.join(' · '), tone: count ? WAITS : QUIET,
    groups: waiting.map((entry) => ({ label: entry.area, count: entry.files.length, oldest_seconds: age(entry.files) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

/** Lessons, as `mc martin lessons` lists them: `lessons` are `listLessons`' rows. What waits is the open and the carried. */
export function lessonsReading({ lessons = [], now = new Date() } = {}) {
  const by = (state) => lessons.filter((lesson) => lesson.state === state);
  const open = by('open'); const carried = by('in-goal');
  const live = [...open, ...carried];
  const age = (lesson) => seconds(Date.parse(lesson.at), now);
  const late = live.filter((lesson) => Math.floor(age(lesson) / 86400) > LATE_DAYS);
  const landedWeek = by('landed').filter((lesson) => Number.isFinite(Date.parse(lesson.landed_at)) && seconds(Date.parse(lesson.landed_at), now) <= WEEK_S);
  const oldest = oldestOf(live.map(age).filter(Number.isFinite));
  const group = (label, list, named) => ({ label, count: list.length, oldest_seconds: oldestOf(list.map(age).filter(Number.isFinite)), ...(named ? { items: list.map((lesson) => lesson.name) } : {}) });
  return {
    count: live.length, open: open.length, in_goal: carried.length, late: late.length, landed_week: landedWeek.length,
    oldest_seconds: oldest,
    summary: `${open.length} open · ${carried.length} in a goal · ${late.length} late · ${landedWeek.length} landed this week`,
    tone: late.length ? ['red'] : live.length ? WAITS : QUIET,
    groups: [group('open', open, true), group('in a goal', carried, true), group('landed', by('landed')), group('dismissed', by('dismissed'))],
  };
}

/** Errors per repository, from the helper's newest digest of each (`intakeSection`'s `repos`). */
export function errorsReading({ intake = null } = {}) {
  const digests = intake?.repos || [];
  if (!digests.length) return { count: null, oldest_seconds: null, summary: 'no digest collected', tone: WAITS, groups: [] };
  const groups = digests.map((digest) => ({
    label: digest.repo, count: digest.first ? null : digest.new_errors, critical: digest.critical, high: digest.high,
    age_seconds: digest.age_seconds, first: Boolean(digest.first),
  }));
  const known = groups.filter((group) => group.count != null);
  const count = known.length ? known.reduce((sum, group) => sum + group.count, 0) : null;
  const oldest = oldestOf(groups.map((group) => group.age_seconds).filter(Number.isFinite));
  const last = intake?.last_run;
  const summary = [...groups.map((group) => `${group.label} ${group.count == null ? 'no baseline' : `${group.count} new`}`),
    oldest != null ? `collected ${ageWords(oldest)} ago` : 'collection age unknown',
    ...(last && !last.ok ? ['last collection failed'] : [])].join(' · ');
  return {
    count, oldest_seconds: oldest, summary, groups,
    tone: groups.some((group) => group.critical) || (last && !last.ok) ? ['red'] : count ? WAITS : QUIET,
  };
}

/** The last full test per repository, from `checksSection`. `missing` is the repositories whose reading could not be read. */
export function testsReading({ checks = null, missing = [] } = {}) {
  const repos = checks?.repos || [];
  const groups = repos.map((repo) => ({
    label: repo.repo, red: repo.test ? repo.test.red : null, age_seconds: repo.test?.age_seconds ?? null, short: repo.test?.short ?? null, never: !repo.test,
  }));
  const known = groups.filter((group) => group.red != null);
  const count = known.reduce((sum, group) => sum + group.red, 0);
  const oldest = oldestOf(groups.map((group) => group.age_seconds).filter(Number.isFinite));
  const say = (group) => (group.never ? `${group.label} never run` : `${group.label} ${group.red == null ? '? red' : `${group.red} red`}, ${ageWords(group.age_seconds)} ago`);
  return {
    count: known.length ? count : null, oldest_seconds: oldest, summary: groups.map(say).join(' · ') || 'no repository', groups,
    tone: count ? ['red'] : groups.some((group) => group.never || group.red == null) ? WAITS : QUIET,
    problems: missing.length ? missing.map((name) => `${name}: nightly history unreadable`) : null,
  };
}

/** The last dependency audit per repository, from `checksSection`. */
export function depsReading({ checks = null } = {}) {
  const repos = checks?.repos || [];
  const groups = repos.map((repo) => ({
    label: repo.repo, critical: repo.deps?.critical ?? null, high: repo.deps?.high ?? null, age_seconds: repo.deps?.age_seconds ?? null, short: repo.deps?.short ?? null, never: !repo.deps,
  }));
  const count = groups.reduce((sum, group) => sum + (group.critical || 0) + (group.high || 0), 0);
  const oldest = oldestOf(groups.map((group) => group.age_seconds).filter(Number.isFinite));
  const say = (group) => (group.never ? `${group.label} never read` : group.critical || group.high ? `${group.label} ${group.critical} critical · ${group.high} high` : `${group.label} 0`);
  return {
    count: groups.some((group) => !group.never) ? count : null, oldest_seconds: oldest,
    summary: [...groups.map(say), ...(oldest != null ? [`read ${ageWords(oldest)} ago`] : [])].join(' · ') || 'no repository', groups,
    tone: groups.some((group) => group.critical) ? ['red'] : count || groups.some((group) => group.never) ? WAITS : QUIET,
  };
}

/** What lies directly in `~/mc/intake` that is not an errors digest: `files` is `[{ name, at }]`. */
export function intakeReading({ files = [], now = new Date() } = {}) {
  const ats = files.map((file) => file.at).filter(Number.isFinite);
  const oldest = ats.length ? seconds(Math.min(...ats), now) : null;
  return {
    count: files.length, oldest_seconds: oldest,
    summary: files.length ? `${files.length} waiting · oldest ${howLong(oldest)}` : 'nothing waiting',
    tone: files.length ? WAITS : QUIET,
    groups: files.length ? [{ label: 'waiting', count: files.length, oldest_seconds: oldest, items: files.map((file) => file.name) }] : [],
  };
}

/** The area pages: `pages` is `[{ repo, page, name, changed_at, aims }]`, `problems` what could not be read. */
export function areasReading({ pages = [], problems = [], now = new Date() } = {}) {
  const rows = pages.map((page) => {
    const changed = Date.parse(page.changed_at);
    return { ...page, age_days: Number.isFinite(changed) ? Math.floor(seconds(changed, now) / 86400) : null, age_seconds: Number.isFinite(changed) ? seconds(changed, now) : null };
  }).sort((a, b) => (a.age_seconds ?? Infinity) - (b.age_seconds ?? Infinity) || a.name.localeCompare(b.name));
  const known = rows.filter((row) => row.age_days != null);
  const newest = known.length ? known[0].age_days : null;
  const first = known.filter((row) => row.age_days === newest);
  const rest = known.filter((row) => row.age_days !== newest);
  const parts = [plural(rows.length, 'page')];
  if (first.length) parts.push(`last changed ${dayWords(newest)} (${first.length})`);
  if (rest.length) {
    const lowest = rest[0].age_days; const highest = rest.at(-1).age_days;
    parts.push(`the rest ${lowest === highest ? dayWords(lowest) : `${lowest}–${dayWords(highest)}`}`);
  }
  return {
    count: rows.length, oldest_seconds: oldestOf(known.map((row) => row.age_seconds)), summary: parts.join(' · '), tone: QUIET,
    areas: rows, problems: problems.length ? problems : null,
  };
}

/** The strays: `items` are `maintenanceItems`' (page-overview.js) — what belongs to no programme. */
export function straysReading({ items = [] } = {}) {
  return {
    count: items.length, oldest_seconds: null,
    summary: items.length ? `${items.length} outside the programmes` : 'none',
    tone: items.some((item) => item.tone?.includes('red')) ? ['red'] : items.length ? WAITS : QUIET,
    items: items.map((item) => ({ key: item.key, label: item.label, text: item.text, tone: item.tone, children: item.children || [] })),
  };
}

/* --------------------------------------------------------------------- reads */

const dated = /^(\d{4})-(\d{2})-(\d{2})(?=-)/u;
/** The instant a file is dated: the date its name begins with, else when it was last written. */
function datedAt(name, mtimeMs) {
  const match = dated.exec(name);
  const day = match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) : NaN;
  return Number.isFinite(day) ? day : mtimeMs;
}

/** The files directly in `dir`, not directories: `[{ name, at }]`. A directory that is not there holds none; one that cannot be read throws. */
export function readFiles(dir, { keep = () => true, exists = existsSync } = {}) {
  if (!exists(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => ({ name: entry.name, at: datedAt(entry.name, statSync(join(dir, entry.name)).mtimeMs) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every area's waiting proposals on disk, `[{ area, files }]` for `proposalsReading`; an archive is not read. */
export function readProposals({ env }) {
  return areaKeysOnDisk(env).map((area) => ({ area, files: readFiles(keyProposalsDir(area, env), { keep: (name) => name.endsWith('.md') }) }));
}

/** `lessons` for `lessonsReading`, from the desk's lesson files. */
export function readLessons({ env }) { return listLessons({ env }); }

/** The intake files that are not an errors digest. */
export function readIntakeFiles({ dir }) {
  return readFiles(dir, { keep: (name) => !/^errors-(?:(?:memoro|memoro-cli)-)?\d{4}-\d{2}-\d{2}\.md$/u.test(name) });
}

/** `git` as the area reader wants it: `{ ok, stdout, stderr }`. */
export function areaGit(cwd, args) {
  const result = run(cwd, args);
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || String(result.error?.message || '') };
}

/** The aims an area page states: the top-level bullets under `## Aim`. A page that says none yet has none. */
export function aimsOf(text) {
  const section = String(text).split(/^## Aim[ \t]*\r?\n/mu)[1]?.split(/^## /mu)[0] || '';
  return section.split(/\r?\n/u).filter((line) => /^[-*] /u.test(line)).length;
}

/**
 * Each area page of each repository that declares areas, read at `origin/main`: `{ pages, problems }`. A page is shared by
 * the areas that name it and is one page. What cannot be read is a problem, said on the row; the pages that could be read stay.
 */
export function readAreaPages({ repos, git = areaGit }) {
  const pages = []; const problems = [];
  for (const repo of repos) {
    const read = readAreas(repo.path, { git, repo: repo.name });
    if (!read.ok) { problems.push(read.reason); continue; }
    if (!read.declared) continue;
    for (const path of [...new Set(read.areas.map((area) => area.page).filter(Boolean))]) {
      const shown = git(repo.path, ['show', `origin/main:${path}`]);
      if (!shown.ok) { problems.push(`${repo.name}: could not read ${path} at origin/main — ${shown.stderr.trim() || 'git failed'}`); continue; }
      const log = git(repo.path, ['log', '-1', '--format=%cI', 'origin/main', '--', path]);
      const changed = log.ok ? log.stdout.trim() : '';
      if (!changed) problems.push(`${repo.name}: no commit of ${path} on origin/main`);
      pages.push({
        repo: repo.name, page: path, name: /^# (.+)$/mu.exec(shown.stdout)?.[1].trim() || path.replace(/^.*\//u, '').replace(/\.md$/u, ''),
        changed_at: changed || null, aims: aimsOf(shown.stdout),
      });
    }
  }
  return { pages, problems };
}
