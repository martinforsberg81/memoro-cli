/**
 * Where proposals live: in the permanent areas, one folder per area page (Martin, 2026-11-17). A programme is an
 * order — temporary, archived when done — so a finding outside a session's task waits in the area it concerns, not
 * in a programme and not in an ownerless root.
 *
 * An area is an area page a repository declares: a distinct `page` of its `.mc/areas.json` on origin/main
 * (`readAreas`, areas.js). Its key is `<repo>/<slug>`, the slug being the page file's name without `.md`
 * (`docs/technical/areas/system.md` is `memoro-cli/system`). Its proposals wait in
 * `~/mc/areas/<repo>/<slug>/proposals/*.md`; the decided ones are in `proposals/archive/`, each with
 * `Utfall: <what happened>` as its first line. A finding with no clear area goes to `memoro-cli/system` when mc would
 * change and to `memoro/delivery` when memoro would change: there is no ownerless place.
 *
 * Listing reads the directories on disk, never git: an area folder whose page is no longer declared is still listed.
 */
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { workRoot } from './paths.js';

/** The directory under the work root that holds the areas. */
export const AREAS_HOME = 'areas';

/** The area a finding with no clear area goes to, by the system its filename names. */
export const FALLBACK_AREAS = Object.freeze({ mc: 'memoro-cli/system', memoro: 'memoro/delivery' });

/** `~/mc/areas/`. */
export function areasHome(env = process.env) {
  return join(workRoot(env), AREAS_HOME);
}

/** `~/mc/areas/<repo>/<slug>/proposals/`: where an area's proposals wait. */
export function areaProposalsDir(repo, slug, env = process.env) {
  return join(areasHome(env), repo, slug, 'proposals');
}

/** `~/mc/areas/<repo>/<slug>/proposals/archive/`: the area's decided proposals, each with its `Utfall:` line first. */
export function areaProposalsArchiveDir(repo, slug, env = process.env) {
  return join(areaProposalsDir(repo, slug, env), 'archive');
}

/** The proposals folder of an area key `<repo>/<slug>`. */
export function keyProposalsDir(key, env = process.env) {
  const [repo, slug] = String(key).split('/');
  return areaProposalsDir(repo, slug, env);
}

/** An area page's slug: the page file's name without `.md`. */
export const pageSlug = (page) => basename(String(page)).replace(/\.md$/u, '');

/** The area keys the repositories declare, `[{ name, areas }]` as `areaRepositories` (manager-pulse.js) returns them: sorted, distinct. */
export function declaredAreaKeys(repos = []) {
  const keys = new Set();
  for (const repo of repos) for (const area of repo.areas ?? []) if (typeof area.page === 'string' && area.page.trim()) keys.add(`${repo.name}/${pageSlug(area.page)}`);
  return [...keys].sort();
}

const directories = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch { return []; }
};

/** The area keys present on disk: every `~/mc/areas/<repo>/<slug>/`, sorted as keys (`memoro-cli/…` before `memoro/…`). */
export function areaKeysOnDisk(env = process.env) {
  const home = areasHome(env);
  return directories(home).flatMap((repo) => directories(join(home, repo)).map((slug) => `${repo}/${slug}`)).sort();
}

/** The keys a prompt lists: the given ones and the two fallbacks, sorted and distinct. */
export function areaKeysToName(keys = []) {
  return [...new Set([...keys, ...Object.values(FALLBACK_AREAS)])].sort();
}

/**
 * The sentence a prompt gives a session that may write a proposal: where it goes, the area keys, and the fallbacks.
 * `keys` are the declared pages where the caller has the repositories at hand, else the directories present.
 */
export function placementWords(keys = [], env = process.env) {
  const named = areaKeysToName(keys).map((key) => `\`${key}\``).join(', ');
  return `A proposal goes in the \`proposals/\` of the area it concerns: \`${areasHome(env)}/<repo>/<area>/proposals/\`, `
    + `where \`<repo>/<area>\` is one of ${named}. With no clear area it goes to \`${FALLBACK_AREAS.mc}\` when mc would change `
    + `and to \`${FALLBACK_AREAS.memoro}\` when memoro would change.`;
}

/**
 * Every waiting proposal: each direct `.md` under every `~/mc/areas/<repo>/<slug>/proposals/`, never an archive.
 * `{ area: '<repo>/<slug>', file, path }`, sorted by area, then by name.
 */
export function listAllProposals(env = process.env) {
  const rows = [];
  for (const area of areaKeysOnDisk(env)) {
    const dir = keyProposalsDir(area, env);
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
      rows.push({ area, file: entry.name, path: join(dir, entry.name) });
    }
  }
  return rows.sort((a, b) => (a.area === b.area ? (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) : a.area < b.area ? -1 : 1));
}

/**
 * The page-area a programme record's `area` (`<repo>/<id>`) names, as `<repo>/<slug>`, or null when it names no area
 * with a page. `repos` are `[{ name, areas }]` as `areaRepositories` returns them.
 */
export function pageAreaOf(ref, repos = []) {
  const match = /^([^/]+)\/([^/]+)$/u.exec(String(ref ?? ''));
  if (!match) return null;
  const area = repos.find((repo) => repo.name === match[1])?.areas?.find((one) => one.id === match[2]);
  return typeof area?.page === 'string' && area.page.trim() ? `${match[1]}/${pageSlug(area.page)}` : null;
}
