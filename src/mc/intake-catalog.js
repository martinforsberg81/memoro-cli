/**
 * An app suggestion is catalogued by jev, not by a model turn (Martin,
 * 2026-11-20: "Katalogiseringen ska göras av jev. Billigt anrop."), and kept as
 * it is: mc writes no proposal from it (Martin, the same day: "vi sparar
 * suggestion såsom den är tills vi bestämt om det ska göras något med den").
 *
 * A suggestion file (`suggestion-<hash>.md`, written by helper-suggestions.js)
 * holds one person's words about the memoro app. Cataloguing it is one choice:
 * which of memoro's area pages it concerns. jev answers that choice with
 * probabilities in one call and writes no text. The file is copied unchanged
 * to that area's `suggestions/` (`~/mc/areas/memoro/<slug>/suggestions/`), and
 * one line in the area's `suggestions/catalog.jsonl` says when, where and why.
 * The inbox's own copy is archived by the drain as before, where
 * helper-suggestions.js keeps finding it as its id ledger.
 *
 * A clear answer (`CATALOG_THRESHOLD` or more) places it in that area. An
 * unclear answer, or no answer from jev, places it in memoro's fallback area
 * (`FALLBACK_AREAS.memoro`) with the reason in the catalog line: a suggestion is
 * never left unplaced, and the inbox still drains.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { askJev, JEV_KEY, JEV_MODEL } from './jev.js';
import { readKeysDotenv } from './keys-dotenv.js';
import { defaultRepos } from './repos.js';
import { runAsync as runGitAsync } from './git.js';
import { AREAS_PATH, checkAreas } from './areas.js';
import { areasHome, FALLBACK_AREAS, pageSlug } from './area-proposals.js';
import { writeFileAtomic } from './atomic-write.js';
import { intakeDir } from './helper-collect.js';

/** The probability at which jev's area is taken; below it the fallback area is. */
export const CATALOG_THRESHOLD = 0.6;

/** The one question: which page's areas the suggestion concerns. */
export const CATALOG_INSTRUCTION = 'Which area of the Memoro app does this suggestion from a user of the app concern, given what each area covers';

const MARKER = '<!-- mc-suggestions-state\n';

/** The suggestion's rows from its record, or null when the file is not a readable suggestion. */
export function suggestionRows(text) {
  const start = String(text).lastIndexOf(MARKER);
  if (start < 0) return null;
  try {
    const rows = JSON.parse(text.slice(start + MARKER.length, text.lastIndexOf('\n-->')));
    return Array.isArray(rows) && rows.length && typeof rows[0]?.text === 'string' ? rows : null;
  } catch { return null; }
}

/**
 * jev's options: one per area page memoro declares, keyed by the page's slug
 * with `_` for `-`, described by the names and coverage of the areas on it.
 * `{ criteria: { key: description }, slugOf: { key: slug } }`.
 */
export function pageCriteria(areas = []) {
  const pages = new Map();
  for (const area of areas) {
    if (typeof area.page !== 'string' || !area.page.trim()) continue;
    const slug = pageSlug(area.page);
    if (!pages.has(slug)) pages.set(slug, []);
    pages.get(slug).push(`${area.name}: ${area.covers}`);
  }
  const criteria = {};
  const slugOf = {};
  for (const [slug, parts] of [...pages].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const key = slug.replace(/-/gu, '_');
    criteria[key] = parts.join(' ');
    slugOf[key] = slug;
  }
  return { criteria, slugOf };
}

/** jev's choice from a response, or null when the response does not hold one of the keys with a probability. */
export function readChoice(response, criteria) {
  const area = response?.answers?.area;
  const choice = area?.choice;
  const p = area?.probabilities?.[choice];
  if (typeof choice !== 'string' || !Object.hasOwn(criteria, choice)) return null;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return { choice, p, probabilities: area.probabilities, model: typeof response.model === 'string' ? response.model : JEV_MODEL };
}

/** `~/mc/areas/<repo>/<slug>/suggestions/`: where an area's catalogued suggestions are kept as they came. */
export function areaSuggestionsDir(key, env = process.env) {
  const [repo, slug] = String(key).split('/');
  return join(areasHome(env), repo, slug, 'suggestions');
}

async function memoroAreas(env, git) {
  const repo = defaultRepos(env).find((one) => one.name === 'memoro');
  if (!repo || !existsSync(repo.git)) return { problem: 'no memoro repository on this machine' };
  const shown = await git(repo.path, ['show', `origin/main:${AREAS_PATH}`]);
  if (!shown) return { problem: `memoro's ${AREAS_PATH} cannot be read on origin/main` };
  const read = checkAreas(shown, `memoro's ${AREAS_PATH}`);
  return read.ok ? { areas: read.areas } : { problem: read.reason };
}

const realGit = (cwd, args) => runGitAsync(undefined, ['-C', cwd, ...args], { timeoutMs: 20_000 })
  .then((r) => (r.error || r.status !== 0 ? null : String(r.stdout || '')));

/**
 * Catalogue one suggestion file in the inbox. Returns a turn-shaped outcome
 * the drain and the runner already log: `{ ok, reason?, note, wrote: [],
 * catalogued, waiting, model, tool }`; `wrote` is empty because no proposal is written. Never throws for jev, the keys or the areas; a file that is
 * not a readable suggestion is `{ ok: false, reason: 'not-a-suggestion' }`.
 */
export async function catalogSuggestion({ env = process.env, now = new Date(), file, deps = {} } = {}) {
  const name = basename(String(file || ''));
  const path = join(intakeDir(env), name);
  let record;
  try { record = (deps.read || ((p) => readFileSync(p, 'utf8')))(path); }
  catch { return { ok: false, reason: 'unreadable', note: `${name} cannot be read`, wrote: [], waiting: [] }; }
  const rows = suggestionRows(record);
  if (!rows) return { ok: false, reason: 'not-a-suggestion', note: `${name} holds no suggestion record`, wrote: [], waiting: [] };

  const fallback = FALLBACK_AREAS.memoro;
  let placed = fallback;
  let why;
  const listed = await (deps.areas || ((e) => memoroAreas(e, deps.git || realGit)))(env);
  if (listed.problem) {
    why = `jev was not asked (${listed.problem}), so it waits in the fallback area`;
  } else {
    const { criteria, slugOf } = pageCriteria(listed.areas);
    let key = null;
    try {
      const values = (deps.readKeys || (() => readKeysDotenv({ env, home: env.HOME || process.env.HOME }).values))();
      key = values && typeof values[JEV_KEY] === 'string' && values[JEV_KEY] ? values[JEV_KEY] : null;
    } catch { key = null; }
    const first = rows[0];
    const body = {
      model: JEV_MODEL,
      state: { suggestion: { kind: first.kind, text: first.text }, areas: criteria },
      questions: { area: { type: 'choice', instructions: CATALOG_INSTRUCTION, criteria } },
    };
    const asked = Object.keys(criteria).length
      ? await (deps.ask || askJev)({ body, key, ...(deps.jev || {}) })
      : { unavailable: 'memoro declares no area page' };
    const read = asked.response ? readChoice(asked.response, criteria) : null;
    if (!read) {
      why = `jev gave no answer (${asked.unavailable || asked.limit || 'malformed response'}), so it waits in the fallback area`;
    } else if (read.p >= CATALOG_THRESHOLD) {
      placed = `memoro/${slugOf[read.choice]}`;
      why = `${slugOf[read.choice]} at p ${read.p.toFixed(2)} (${read.model})`;
    } else {
      why = `no clear area: ${slugOf[read.choice]} at p ${read.p.toFixed(2)} (${read.model}), under ${CATALOG_THRESHOLD.toFixed(2)}, so it waits in the fallback area`;
    }
  }

  const dir = areaSuggestionsDir(placed, env);
  const target = join(dir, name);
  const line = JSON.stringify({ at: now.toISOString(), file: name, area: placed, why, ids: rows.map((row) => row.id) });
  try {
    (deps.mkdir || ((d) => mkdirSync(d, { recursive: true })))(dir);
    (deps.write || writeFileAtomic)(target, record);
    (deps.append || appendFileSync)(join(dir, 'catalog.jsonl'), `${line}\n`);
  } catch (error) {
    return { ok: false, reason: 'write-failed', note: `${target} could not be written (${error?.code || 'error'})`, wrote: [], waiting: [] };
  }
  return {
    ok: true, status: 0, note: `kept in ${placed}: ${why}`,
    wrote: [], catalogued: { area: placed, file: name, path: target }, waiting: [], model: JEV_MODEL, tool: 'jev',
  };
}
