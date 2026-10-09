/**
 * `mc deps` — which of a repository's dependencies need updating, and how
 * urgently, read off the lockfile on `origin/main` (ruling 29).
 *
 * What is read is never a working tree: `package.json` and
 * `package-lock.json` come out of `git show origin/main:<file>` into a fresh
 * directory under the runner's scratch, and npm reads them there. The primary
 * checkout is only where the refs live. A declared note runs in that same
 * directory, its script taken from `origin/main` too.
 *
 * `npm outdated` is not used: against memoro's manifest and lockfile with no
 * `node_modules` it listed 32 of 63 direct dependencies, no devDependencies
 * and no `current` (measured 2026-10-09). So the installed version is the
 * lockfile's, and the two newer ones are each one `npm view`.
 *
 * Runtime or tool is the section of `package.json` the name stands in and
 * nothing else; a transitive package the audit flags takes the kind of the
 * direct dependencies that pull it in.
 *
 * Every outside call — `git`, `npm`, `now`, `runNote` — is injectable, so the
 * tests never reach the registry.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { ageWords } from './page-cache.js';
import { mcHome, runnerScratchDir } from './paths.js';
import { declarationFor } from './repo-gate-table.js';

/** A saved reading younger than this, for the same sha, is printed as it is. */
export const FRESH_MS = 6 * 60 * 60 * 1000;
/** `npm view` calls in flight at once: memoro has 63 direct dependencies, one call ~1.2 s. */
export const VIEW_CONCURRENCY = 8;
/** A declared note that has not answered in this long has failed. */
export const NOTE_TIMEOUT_MS = 20_000;

const RUNTIME_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

/** Where the last reading of `<repo>` is kept. */
export function savedPath(repo, root = mcHome()) {
  return join(root, 'deps', `${repo}.json`);
}

export function loadSaved(repo, root = mcHome()) {
  try { return JSON.parse(readFileSync(savedPath(repo, root), 'utf8')); } catch { return null; }
}

/* ----------------------------------------------------------------- versions */

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/u.exec(String(version || '').trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || null };
}

/**
 * Numeric `major.minor.patch`; a pre-release sorts below its release, and two
 * pre-releases of one release compare as text. Unparseable sorts lowest.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The line `^` stays on: the major, or `0.<minor>` for a 0.x version. */
export function majorLine(version) {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const [major, minor] = parsed.parts;
  return major > 0 ? String(major) : `0.${minor}`;
}

function newer(a, b) {
  return a != null && b != null && compareVersions(a, b) > 0;
}

/* -------------------------------------------------------------- the reading */

/** The direct dependencies of a manifest, with the kind their section gives them. */
export function directDependencies(manifest) {
  const direct = new Map();
  for (const section of RUNTIME_SECTIONS) {
    for (const [name, spec] of Object.entries(manifest?.[section] || {})) {
      if (!direct.has(name)) direct.set(name, { name, kind: 'runtime', spec: String(spec) });
    }
  }
  for (const [name, spec] of Object.entries(manifest?.devDependencies || {})) {
    if (!direct.has(name)) direct.set(name, { name, kind: 'tool', spec: String(spec) });
  }
  return direct;
}

/**
 * Every audit entry, with the direct dependencies behind it: itself when it
 * is direct, else its `effects` walked up to the direct ones.
 */
export function auditEntries(audit, direct) {
  const vulnerabilities = audit?.vulnerabilities || {};
  const isDirect = (name) => vulnerabilities[name]?.isDirect === true || direct.has(name);
  const behind = (name) => {
    if (isDirect(name)) return [name];
    const found = new Set();
    const seen = new Set([name]);
    const queue = [...(vulnerabilities[name]?.effects || [])];
    while (queue.length) {
      const next = queue.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      if (isDirect(next)) { found.add(next); continue; }
      queue.push(...(vulnerabilities[next]?.effects || []));
    }
    return [...found].sort();
  };
  return Object.entries(vulnerabilities).map(([name, entry]) => ({
    name,
    severity: entry.severity || null,
    direct: isDirect(name),
    behind: behind(name),
    fix: entry.fixAvailable ?? false,
  }));
}

/** A fix that stays inside the major: `true`, or an object that does not cross it. */
function fixWithinMajor(fix) {
  return fix === true || (fix && typeof fix === 'object' && fix.isSemVerMajor === false);
}

function highest(severities) {
  let best = null;
  for (const severity of severities) {
    if (severity && (best === null || SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(best))) best = severity;
  }
  return best;
}

/**
 * One row per direct dependency, into the first group that applies:
 * security within the major, then major, then patch/minor. Rows whose
 * `npm view` failed and that no audit fix places go to `unread`.
 */
export function groupRows(packages, entries) {
  const groups = { security: [], minor: [], major: [] };
  const unread = [];
  for (const pkg of packages) {
    const mine = entries.filter((entry) => entry.behind.includes(pkg.name));
    const fixable = mine.filter((entry) => fixWithinMajor(entry.fix));
    const via = [...new Set(mine.filter((entry) => entry.name !== pkg.name).map((entry) => entry.name))].sort();
    const row = {
      name: pkg.name,
      kind: pkg.kind,
      spec: pkg.spec,
      installed: pkg.installed,
      target: newer(pkg.in_major, pkg.installed) ? pkg.in_major : pkg.installed,
      in_major: pkg.in_major,
      latest: pkg.latest,
      severity: null,
      via,
      error: pkg.error,
    };
    if (fixable.length) {
      // The audit's own fix version is the target when it names one; `true`
      // alone says only "within ranges", so the newest in the major stands.
      const named = fixable
        .filter((entry) => typeof entry.fix === 'object' && entry.fix.name === pkg.name)
        .map((entry) => entry.fix.version)
        .sort(compareVersions);
      if (named.length) row.target = named[named.length - 1];
      row.severity = highest(fixable.map((entry) => entry.severity));
      row.via = [...new Set(fixable.filter((entry) => entry.name !== pkg.name).map((entry) => entry.name))].sort();
      groups.security.push(row);
      continue;
    }
    if (pkg.error) {
      row.severity = highest(mine.map((entry) => entry.severity));
      unread.push(row);
      continue;
    }
    if (pkg.latest && newer(pkg.latest, pkg.installed) && majorLine(pkg.latest) !== majorLine(pkg.installed)) {
      if (mine.length) {
        row.severity = highest(mine.map((entry) => entry.severity));
        row.fix_crosses_major = true;
      }
      groups.major.push(row);
      continue;
    }
    if (newer(pkg.in_major, pkg.installed)) {
      row.severity = highest(mine.map((entry) => entry.severity));
      groups.minor.push(row);
    }
  }
  return { groups, unread };
}

/** Transitive entries `npm audit fix --package-lock-only` changes within ranges. */
export function transitiveFixable(entries) {
  return entries.filter((entry) => !entry.direct && entry.fix === true).length;
}

/** Run `fn` over `items`, `limit` at a time, keeping their order. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function lastVersion(stdout) {
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const last = list[list.length - 1];
  return last == null ? null : String(last);
}

async function viewPackage(pkg, lock, npm, cwd) {
  const installed = lock?.packages?.[`node_modules/${pkg.name}`]?.version ?? null;
  const row = { ...pkg, installed, in_major: null, latest: null, error: null };
  if (!installed) return { ...row, error: 'not in package-lock.json' };
  try {
    const within = await npm(['view', `${pkg.name}@^${installed}`, 'version', '--json'], { cwd });
    if (within.status !== 0) throw new Error(firstLine(within.stderr) || `npm view exited ${within.status}`);
    row.in_major = lastVersion(within.stdout);
    const latest = await npm(['view', pkg.name, 'dist-tags.latest'], { cwd });
    if (latest.status !== 0) throw new Error(firstLine(latest.stderr) || `npm view exited ${latest.status}`);
    row.latest = firstLine(latest.stdout);
  } catch (error) {
    row.error = `npm view: ${error.message}`;
  }
  return row;
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || null;
}

/**
 * The files of `argv` that are paths on `origin/main`, written under `dir`
 * at the same paths — so a note run in `dir` is the script of the tree that
 * was read, beside that tree's lockfile. The manifest and lockfile are
 * already there; an argument that is no file on `origin/main` is left alone.
 */
async function materializeArgv(argv, { git, repoPath, dir }) {
  for (const arg of argv) {
    if (!/^[\w.][\w./-]*$/u.test(arg) || arg.split('/').includes('..')) continue;
    if (arg === 'package.json' || arg === 'package-lock.json') continue;
    const shown = await git(['show', `origin/main:${arg}`], { cwd: repoPath });
    if (shown.status !== 0) continue;
    mkdirSync(dirname(join(dir, arg)), { recursive: true });
    writeFileSync(join(dir, arg), shown.stdout);
  }
}

/**
 * The repository's declared one-line notes, each run in `cwd`. `readDeps`
 * runs them in its scratch copy of `origin/main`: in the primary checkout
 * they read whatever lockfile that checkout has, which is not the tree the
 * numbers beside them are of (a wrangler bump read as unbumped, 2026-10-09).
 */
export async function readNotes(repoPath, {
  runNote = defaultRunNote, declaration = declarationFor, cwd = repoPath, materialize = null,
} = {}) {
  let declared = null;
  try { declared = declaration(repoPath); } catch { return []; }
  if (!declared?.ok) return [];
  const notes = declared.declaration?.deps_notes || [];
  return Promise.all(notes.map(async ({ name, argv }) => {
    try {
      if (materialize) await materialize(argv);
      const result = await runNote(argv, { cwd, timeout: NOTE_TIMEOUT_MS });
      const text = firstLine(result.stdout);
      if (result.status !== 0 || !text) {
        return { name, text: null, error: firstLine(result.stderr) || result.error || `exited ${result.status} with nothing on stdout` };
      }
      return { name, text };
    } catch (error) {
      return { name, text: null, error: error.message };
    }
  }));
}

/**
 * Read `repoPath`'s dependencies off `origin/main`, or hand back the saved
 * reading when it is for the same sha and younger than six hours.
 *
 * Returns `{ reading, reused }`; throws with a sentence when there is
 * nothing to read.
 */
export async function readDeps({
  repoPath,
  repo = basename(repoPath),
  refresh = false,
  env = process.env,
  root = mcHome(),
  git = defaultGit,
  npm = defaultNpm,
  now = () => new Date(),
  runNote = defaultRunNote,
  declaration = declarationFor,
} = {}) {
  const fetched = (await git(['fetch', 'origin', 'main', '--quiet'], { cwd: repoPath })).status === 0;
  const head = await git(['rev-parse', 'origin/main'], { cwd: repoPath });
  if (head.status !== 0) throw new Error(`${repo} has no origin/main to read (${firstLine(head.stderr) || 'git rev-parse failed'})`);
  const sha = firstLine(head.stdout);

  if (!refresh) {
    const saved = loadSaved(repo, root);
    const age = saved ? now().getTime() - Date.parse(saved.read_at) : Infinity;
    // A reading from before its notes ran on `origin/main` is read anew.
    const current = saved?.notes_from === 'origin/main';
    if (current && saved.sha === sha && age >= 0 && age < FRESH_MS) return { reading: saved, reused: true };
  }

  const manifestText = await git(['show', 'origin/main:package.json'], { cwd: repoPath });
  if (manifestText.status !== 0) throw new Error(`${repo} has no package.json on origin/main`);
  const lockText = await git(['show', 'origin/main:package-lock.json'], { cwd: repoPath });
  if (lockText.status !== 0) throw new Error(`${repo} has no package-lock.json on origin/main`);

  const scratchRoot = runnerScratchDir(env);
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, `deps-${repo}-`));
  try {
    writeFileSync(join(scratch, 'package.json'), manifestText.stdout);
    writeFileSync(join(scratch, 'package-lock.json'), lockText.stdout);
    const manifest = JSON.parse(manifestText.stdout);
    const lock = JSON.parse(lockText.stdout);
    const direct = directDependencies(manifest);

    const [packages, auditRun, notes] = await Promise.all([
      pool([...direct.values()], VIEW_CONCURRENCY, (pkg) => viewPackage(pkg, lock, npm, scratch)),
      npm(['audit', '--json', '--package-lock-only'], { cwd: scratch }),
      readNotes(repoPath, {
        runNote, declaration, cwd: scratch,
        materialize: (argv) => materializeArgv(argv, { git, repoPath, dir: scratch }),
      }),
    ]);

    // npm audit exits non-zero whenever it finds anything; only output that
    // is not JSON is a failure.
    let audit = null;
    try { audit = JSON.parse(auditRun.stdout); } catch {
      throw new Error(`npm audit --json --package-lock-only printed no JSON for ${repo} (exit ${auditRun.status}): ${firstLine(auditRun.stderr) || firstLine(auditRun.stdout) || 'nothing'}`);
    }
    const entries = auditEntries(audit, direct);
    const { groups, unread } = groupRows(packages, entries);
    const reading = {
      repo,
      sha,
      read_at: now().toISOString(),
      fetched,
      audit: { counts: audit?.metadata?.vulnerabilities || {}, transitive_fixable: transitiveFixable(entries) },
      groups,
      unread,
      notes,
      notes_from: 'origin/main',
      failed: packages.filter((pkg) => pkg.error).length,
    };
    writeJsonAtomic(savedPath(repo, root), reading);
    return { reading, reused: false };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ printed */

function viaText(via) {
  if (!via?.length) return '';
  const shown = via.slice(0, 3).join(', ');
  return `(via ${shown}${via.length > 3 ? ` +${via.length - 3}` : ''})`;
}

function table(rows) {
  if (!rows.length) return [];
  // A column no row fills (no severity among the major rows) is left out.
  const filled = rows[0].map((_, column) => rows.some((row) => row[column]));
  rows = rows.map((row) => row.filter((_, column) => filled[column]));
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column])).join('  ')}`.trimEnd());
}

/** The reading as a person reads it: a head line, three groups, the notes, the next step. */
export function formatReading(reading, { now = new Date() } = {}) {
  const counts = reading.audit?.counts || {};
  const age = Math.max(0, Math.round((now.getTime() - Date.parse(reading.read_at)) / 1000));
  const lines = [
    `mc deps ${reading.repo} — origin/main ${String(reading.sha).slice(0, 7)}, read ${ageWords(age)} ago: `
      + `${counts.critical || 0} critical · ${counts.high || 0} high · ${counts.moderate || 0} moderate`,
  ];
  if (reading.fetched === false) lines.push('  (git fetch failed — read from the origin/main this checkout already had)');
  const { security = [], minor = [], major = [] } = reading.groups || {};

  lines.push('', `SECURITY, within the major (${security.length})`);
  lines.push(...table(security.map((row) => [
    row.severity || '', row.name, `${row.installed} → ${row.target}`, row.kind, viaText(row.via),
  ])));
  lines.push('', `PATCH/MINOR (${minor.length})`);
  lines.push(...table(minor.map((row) => [row.name, `${row.installed} → ${row.target}`, row.kind])));
  lines.push('', `MAJOR (${major.length})`);
  lines.push(...table(major.map((row) => [
    row.severity || '', row.name, `${row.installed} → ${row.latest}`, row.kind, viaText(row.via),
  ])));
  const unread = reading.unread || [];
  if (unread.length) {
    lines.push('', `NOT READ (${unread.length})`);
    lines.push(...table(unread.map((row) => [row.name, row.installed || '?', row.kind, row.error || ''])));
  }

  lines.push('', `transitive: ${reading.audit?.transitive_fixable || 0} more fixed by npm audit fix within ranges`);
  for (const note of reading.notes || []) {
    lines.push(note.text ?? `${note.name}: not read — ${note.error}`);
  }
  if (security.length) lines.push(`next: mc deps bump ${reading.repo} security`);
  else if (minor.length) lines.push(`next: mc deps bump ${reading.repo} minor`);
  return `${lines.join('\n')}\n`;
}

/* --------------------------------------------------------- outside callers */

/** Run a command, collect its output, never reject on a non-zero exit. */
function capture(command, args, { cwd, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timer = null;
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (timeout) timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, stdout, stderr, error: error.message }); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error: signal ? `stopped by ${signal}${timeout ? ` after ${timeout / 1000} s` : ''}` : null });
    });
  });
}

export function defaultGit(args, { cwd } = {}) {
  return capture('git', args, { cwd });
}

export function defaultNpm(args, { cwd } = {}) {
  return capture('npm', args, { cwd });
}

function defaultRunNote(argv, { cwd, timeout } = {}) {
  return capture(argv[0], argv.slice(1), { cwd, timeout });
}

/** Does `repoPath`'s `origin/main` carry a lockfile? */
export async function hasLockfile(repoPath, { git = defaultGit } = {}) {
  const result = await git(['cat-file', '-e', 'origin/main:package-lock.json'], { cwd: repoPath });
  return result.status === 0;
}
