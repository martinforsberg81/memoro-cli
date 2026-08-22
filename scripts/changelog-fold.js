#!/usr/bin/env node
/**
 * Fold `changelog.d/` fragments into `CHANGELOG.md`.
 *
 * Every pull request used to write its own line at the top of `## [Unreleased]`,
 * and two open pull requests therefore always conflicted there — six rebases
 * and two red gate rounds in one evening (2026-08-22), whatever their code
 * did. A fragment is one file per change, named for its branch, so two pull
 * requests never touch the same file; the entries meet in `CHANGELOG.md` only
 * here, in one commit, at release or whenever somebody runs this.
 *
 * A fragment:
 *
 *     section: Added            (Added | Changed | Fixed | Removed | Deprecated | Security)
 *
 *     - **The suite right is a lease.** One full suite at a time …
 *       continued lines, indented two spaces as in CHANGELOG.md
 *
 * The body is pasted verbatim under that section of `## [Unreleased]`, newest
 * fragment first (by file mtime, then name), and the fragment is deleted in
 * the same run. A fragment without a valid `section:` line stops the fold
 * with its name — a fragment silently dropped would be the one change nobody
 * could later find in the log.
 *
 *     node scripts/changelog-fold.js            fold and delete
 *     node scripts/changelog-fold.js --check    list what would fold; exit 1 if any is malformed
 *
 * Importable too: `foldChangelog({ root })` returns what it did.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
export const FRAGMENTS_DIR = 'changelog.d';

/** Read one fragment: `{ name, section, body }`, or `{ name, error }`. */
export function readFragment(path) {
  const name = path.split('/').pop();
  const text = readFileSync(path, 'utf8');
  const match = /^section:\s*([A-Za-z]+)\s*\n/u.exec(text);
  if (!match) return { name, error: 'no "section: <Added|Changed|…>" first line' };
  const section = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  if (!SECTIONS.includes(section)) return { name, error: `unknown section "${match[1]}" — one of ${SECTIONS.join(', ')}` };
  const body = text.slice(match[0].length).replace(/^\s*\n/u, '').replace(/\s+$/u, '');
  if (!body.startsWith('- ')) return { name, error: 'the body must start with a "- " entry' };
  return { name, section, body };
}

/** Every fragment, newest first. */
export function listFragments(root) {
  const dir = join(root, FRAGMENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md') && !file.startsWith('.') && file !== 'README.md')
    .map((file) => ({ file, path: join(dir, file), mtime: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file))
    .map((item) => ({ ...readFragment(item.path), path: item.path }));
}

/**
 * Put each fragment's body under its section in `## [Unreleased]`, creating
 * the section (in canonical order) when it is missing, newest entries first.
 */
export function foldInto(changelog, fragments) {
  const lines = changelog.split('\n');
  const unreleased = lines.findIndex((line) => /^## \[Unreleased\]/u.test(line));
  if (unreleased === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  const nextRelease = lines.findIndex((line, index) => index > unreleased && /^## \[/u.test(line));
  const end = nextRelease === -1 ? lines.length : nextRelease;

  // The Unreleased block, as sections in the order they appear.
  const block = lines.slice(unreleased + 1, end);
  const sections = [];
  let current = null;
  for (const line of block) {
    const heading = /^### (\w+)\s*$/u.exec(line);
    if (heading) { current = { title: heading[1], lines: [] }; sections.push(current); continue; }
    if (current) current.lines.push(line);
  }

  for (const fragment of [...fragments].reverse()) {
    // Reversed so that, prepending one at a time, the newest ends up on top.
    let section = sections.find((item) => item.title === fragment.section);
    if (!section) {
      section = { title: fragment.section, lines: [''] };
      const rank = SECTIONS.indexOf(fragment.section);
      const at = sections.findIndex((item) => SECTIONS.indexOf(item.title) > rank);
      sections.splice(at === -1 ? sections.length : at, 0, section);
    }
    // After the heading's blank line, before the first existing entry.
    const first = section.lines.findIndex((line) => line.trim() !== '');
    const insertAt = first === -1 ? section.lines.length : first;
    section.lines.splice(insertAt, 0, ...fragment.body.split('\n'));
  }

  const rebuilt = [];
  for (const section of sections) {
    rebuilt.push(`### ${section.title}`);
    const body = section.lines.join('\n').replace(/^\n+/u, '').replace(/\n+$/u, '');
    rebuilt.push(...body.split('\n'), '');
  }
  return [...lines.slice(0, unreleased + 1), '', ...rebuilt, ...lines.slice(end)].join('\n').replace(/\n{3,}/gu, '\n\n');
}

/** Fold and delete. `check` only reports. */
export function foldChangelog({ root, check = false } = {}) {
  const fragments = listFragments(root);
  const malformed = fragments.filter((item) => item.error);
  const ready = fragments.filter((item) => !item.error);
  if (malformed.length || check || ready.length === 0) {
    return { folded: [], ready: ready.map((item) => item.name), malformed };
  }
  const changelogPath = join(root, 'CHANGELOG.md');
  const folded = foldInto(readFileSync(changelogPath, 'utf8'), ready);
  writeFileSync(changelogPath, folded);
  for (const item of ready) rmSync(item.path);
  const dir = join(root, FRAGMENTS_DIR);
  if (!existsSync(dir)) mkdirSync(dir);
  return { folded: ready.map((item) => item.name), ready: [], malformed: [] };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const check = process.argv.includes('--check');
  const result = foldChangelog({ root, check });
  for (const item of result.malformed) console.error(`changelog.d/${item.name}: ${item.error}`);
  if (check) {
    for (const name of result.ready) console.log(`would fold changelog.d/${name}`);
    if (result.ready.length === 0 && result.malformed.length === 0) console.log('nothing to fold');
  } else {
    for (const name of result.folded) console.log(`folded changelog.d/${name}`);
    if (result.folded.length === 0 && result.malformed.length === 0) console.log('nothing to fold');
  }
  process.exit(result.malformed.length ? 1 : 0);
}
