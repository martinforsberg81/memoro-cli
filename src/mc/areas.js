/**
 * A repository's rule areas: `.mc/areas.json`, read from the repository's `origin/main` as `.mc/ios.json` is
 * (`ios-build.js`), because a goal is written before its worktree exists and the areas that bind a goal are main's.
 *
 * Each area has an id, a name, what it covers, its standards, the paths where it lives and a short list of
 * questions, each with the condition under which it is asked. Only `mc goal areas` and `mc goal obligation set`
 * read it (`commands/goal.js`); nothing renders it into a goal and no goal file's validation knows of it.
 */

export const AREAS_PATH = '.mc/areas.json';
const ID_RE = /^[a-z][a-z0-9-]*$/u;
const FILE_KEYS = ['schema_version', 'areas'];
const AREA_KEYS = ['id', 'name', 'covers', 'standards', 'paths', 'questions'];
const QUESTION_KEYS = ['when', 'ask'];

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const words = (value) => typeof value === 'string' && value.trim() !== '';
const unknownKeys = (object, keys) => Object.keys(object).filter((key) => !keys.includes(key));

/**
 * `{ ok: true, declared: true, areas }` for a valid declaration's text, or `{ ok: false, reason }` naming the
 * first problem's field and `where` the file was read.
 */
export function checkAreas(text, where) {
  const fail = (field, problem) => ({ ok: false, reason: `${where}: ${field} ${problem}` });
  let file;
  try { file = JSON.parse(text); } catch (error) { return { ok: false, reason: `${where} is not JSON (${error.message})` }; }
  if (!plain(file)) return fail('the file', 'must be a JSON object');
  if (file.schema_version !== 1) return fail('schema_version', `is ${file.schema_version ?? 'missing'}; mc reads 1`);
  const stray = unknownKeys(file, FILE_KEYS)[0];
  if (stray) return fail(stray, 'is an unknown key');
  if (!Array.isArray(file.areas) || file.areas.length === 0) return fail('areas', 'must be a non-empty array');
  const seen = new Set();
  for (const [index, area] of file.areas.entries()) {
    const at = `areas[${index}]`;
    if (!plain(area)) return fail(at, 'must be an object');
    const extra = unknownKeys(area, AREA_KEYS)[0];
    if (extra) return fail(`${at}.${extra}`, 'is an unknown key');
    if (typeof area.id !== 'string' || !ID_RE.test(area.id)) return fail(`${at}.id`, 'must be lower-case letters, digits and hyphens, starting with a letter');
    if (seen.has(area.id)) return fail(`${at}.id`, `${area.id} is given twice`);
    seen.add(area.id);
    for (const key of ['name', 'covers']) if (!words(area[key])) return fail(`${at}.${key}`, 'must be a non-blank text');
    if (!Array.isArray(area.standards) || area.standards.length === 0 || !area.standards.every(words)) return fail(`${at}.standards`, 'must be a non-empty array of non-blank paths');
    if (!Array.isArray(area.paths) || !area.paths.every(words)) return fail(`${at}.paths`, 'must be an array of non-blank strings, possibly empty');
    if (!Array.isArray(area.questions) || area.questions.length === 0) return fail(`${at}.questions`, 'must be a non-empty array');
    for (const [q, question] of area.questions.entries()) {
      const where2 = `${at}.questions[${q}]`;
      if (!plain(question)) return fail(where2, 'must be an object');
      const bad = unknownKeys(question, QUESTION_KEYS)[0];
      if (bad) return fail(`${where2}.${bad}`, 'is an unknown key');
      for (const key of QUESTION_KEYS) if (!words(question[key])) return fail(`${where2}.${key}`, 'must be a non-blank text');
    }
  }
  return { ok: true, declared: true, areas: file.areas };
}

/** Git's words for a path that is not in the revision, as `onOriginMain` (commands/goal.js) reads them. */
const NOT_IN_REVISION = /does not exist in|exists on disk, but not in/u;

/**
 * A repository's declaration at `at` (`origin/main` unless given), read with `git show` in `repoPath` through the
 * goal verbs' git (`{ ok, stdout, stderr }`): `{ ok: true, declared: false, areas: [] }` when the file is empty or is
 * not in that revision, `{ ok: true, declared: true, areas }` when it is valid, else `{ ok: false, reason }`. A git
 * failure of any other kind — a revision that does not exist, a repository git cannot read — is never no declaration.
 */
export function readAreas(repoPath, { git, at = 'origin/main', repo = null }) {
  const named = repo ? `${repo}'s ${AREAS_PATH}` : AREAS_PATH;
  const shown = git(repoPath, ['show', `${at}:${AREAS_PATH}`]);
  if (!shown.ok) {
    if (NOT_IN_REVISION.test(shown.stderr || '')) return { ok: true, declared: false, areas: [] };
    return { ok: false, reason: `could not read ${named} at ${at} in ${repoPath} — ${(shown.stderr || '').trim() || 'git failed'}` };
  }
  if (!shown.stdout.trim()) return { ok: true, declared: false, areas: [] };
  return checkAreas(shown.stdout, `${named} at ${at}`);
}
