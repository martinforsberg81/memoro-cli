/**
 * Registered source exports: a disposable tree of committed files that mc
 * materializes from Git objects into one runner session's scratch directory,
 * reconstructs exactly, reuses within that session, and releases (see
 * docs/technical/mc-tidy.md, "Registered source exports").
 *
 *   <scratch>/<stem>/exports/<id>/              the removable tree, and nothing else
 *   <scratch>/<stem>/.mc-exports/<id>.json      the reconstruction receipt, outside the tree
 *   refs/mc/retained-export/<commit>            the source, kept in the repository
 *
 * The receipt is evidence, never proof on its own: every reuse and every
 * removal reconciles its inventory against the retained commit and the literal
 * selection (`ls-tree`), then walks the tree and hashes each file. A tree that
 * differs is kept with its reason. Git is reached only through `git.text`
 * (small answers, synchronous) and `git.blobs` (streamed batch reads).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { open as openHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { once } from 'node:events';

import { writeJsonAtomic } from './atomic-write.js';
import { rmTree } from './rm-tree.js';
import { runnerScratchDir } from './paths.js';

export const SCRATCH_MARKER = '.mc-scratch.json';
export const SCRATCH_SCHEMA = 'mc-scratch';
export const EXPORT_SCHEMA = 'mc-scratch-export';
export const EXPORT_VERSION = 1;
export const EXPORTS_DIR = 'exports';
export const RECEIPTS_DIR = '.mc-exports';
export const RETAINED_PREFIX = 'refs/mc/retained-export/';
/** The file an attached dependency tree carries once `ensure-worktree-deps` attached it (shared-deps.js ATTACHED_MARK). */
export const DEPS_MARK = '.memoro-deps.json';
const MODES = new Set(['100644', '100755']);
const ID = /^[0-9a-f]{12}-[0-9a-f]{16}$/u;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CHUNK = 1 << 20;

/* ------------------------------------------------------------ Git boundary */

function gitEnv() {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  return env;
}

/**
 * The real Git boundary. `text` answers a small command synchronously (null
 * when git fails). `blobs` streams `cat-file --batch` for the given object ids,
 * one event per object: `blob` (sha, size), then `data` chunks, then `end`.
 * Memory is bounded by the chunk size, not by the selection.
 */
export const realGit = {
  text(cwd, args) {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
    return r.error || r.status !== 0 ? null : r.stdout;
  },
  async *blobs(cwd, shas) {
    const child = spawn('git', ['-C', cwd, 'cat-file', '--batch'], { env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    const feed = (async () => {
      for (let at = 0; at < shas.length; at += 1024) {
        if (!child.stdin.write(`${shas.slice(at, at + 1024).join('\n')}\n`)) await once(child.stdin, 'drain');
      }
      child.stdin.end();
    })().catch(() => child.kill());
    let buffer = Buffer.alloc(0);
    let state = 'header';
    let remaining = 0;
    try {
      for await (const chunk of child.stdout) {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        for (;;) {
          if (state === 'header') {
            const at = buffer.indexOf(10);
            if (at < 0) break;
            const line = buffer.subarray(0, at).toString('utf8');
            buffer = buffer.subarray(at + 1);
            const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (\d+)$/u.exec(line);
            if (!match) throw new Error(`git could not read object: ${line.slice(0, 120)}`);
            remaining = Number(match[2]);
            yield { type: 'blob', sha: match[1], size: remaining };
            state = 'body';
          } else if (state === 'body') {
            if (remaining > 0 && buffer.length) {
              const take = Math.min(remaining, buffer.length);
              yield { type: 'data', buf: buffer.subarray(0, take) };
              buffer = buffer.subarray(take);
              remaining -= take;
            }
            if (remaining > 0) break;
            state = 'trailer';
          } else {
            if (!buffer.length) break;
            buffer = buffer.subarray(1);
            state = 'header';
            yield { type: 'end' };
          }
        }
      }
      await feed;
      const code = await exited;
      if (code !== 0) throw new Error(`git cat-file exited ${code}: ${stderr.trim().split('\n')[0] || 'no detail'}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  },
};

/* ----------------------------------------------------------- small helpers */

const lstatOrNull = (path) => { try { return lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const digestOf = (value) => sha256(JSON.stringify(value));

function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

/** git's object id for a blob of `size` bytes whose content is fed in pieces. */
function blobHasher(sha, size) {
  return createHash(sha.length === 64 ? 'sha256' : 'sha1').update(`blob ${size}\0`);
}

/** The blob id of a file on disk under the algorithm `like`'s id uses, read in bounded pieces. */
function streamHash(path, size, like) {
  const fd = openSync(path, 'r');
  try {
    const hash = blobHasher(like, size);
    const buffer = Buffer.alloc(CHUNK);
    let read = 0;
    let n;
    while ((n = readSync(fd, buffer, 0, CHUNK, read)) > 0) { hash.update(buffer.subarray(0, n)); read += n; }
    return { sha: hash.digest('hex'), bytes: read };
  } finally { closeSync(fd); }
}

/** The file's mode in git's terms, from its stat: executable when the owner may execute it. */
const modeOf = (stat) => ((stat.mode & 0o100) ? '100755' : '100644');

/* ------------------------------------------------------ paths and selection */

/**
 * The selection as the receipt keeps it: literal relative paths, normalized,
 * deduplicated and sorted. `.` is the whole repository and subsumes the rest.
 * Anything that is not a literal relative path is refused, not corrected.
 */
export function normalizePaths(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('no paths selected — name a file or directory, or `.` for the whole repository');
  const out = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string' || raw === '') throw new Error('an empty path selection is refused');
    if (raw.includes('\0') || raw.includes('\\')) throw new Error(`unsupported characters in path selection ${JSON.stringify(raw)}`);
    if (raw.startsWith('/')) throw new Error(`absolute path refused: ${raw}`);
    if (/[*?[\]{}]/u.test(raw)) throw new Error(`wildcard pathspec refused: ${raw} — name the literal path`);
    const parts = raw.split('/');
    if (parts.includes('..')) throw new Error(`path traversal refused: ${raw}`);
    if (parts.includes('.git')) throw new Error(`repository internals refused: ${raw}`);
    const kept = parts.filter((part) => part !== '' && part !== '.');
    out.add(kept.length ? kept.join('/') : '.');
  }
  if (out.has('.')) return ['.'];
  return [...out].sort();
}

/** The source key: repository + resolved commit + canonical path set. */
export function exportKey(repoName, commit, paths) {
  return sha256(JSON.stringify([EXPORT_SCHEMA, repoName, commit, paths]));
}

/** The export's name: the commit's head and the key's head, so two selections of one commit never share one. */
export function exportIdOf(commit, key) {
  return `${commit.slice(0, 12)}-${key.slice(0, 16)}`;
}

/* ------------------------------------------------------------ scratch owner */

/** The ownership record in a scratch directory, or null when there is none. Throws when it cannot be read. */
export function readMarker(stemDir) {
  const path = join(stemDir, SCRATCH_MARKER);
  const stat = lstatOrNull(path);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error('ownership record is not a regular file');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ownership record is not an object');
  return value;
}

/** A marker the runner wrote for this directory, and nothing else. */
function runnerOwned(marker, stem) {
  return Boolean(marker && marker.schema === SCRATCH_SCHEMA && marker.version === 1 && marker.owner === 'runner'
    && typeof marker.session === 'string' && marker.session && typeof marker.started === 'string' && marker.started && marker.stem === stem);
}

/**
 * The runner-owned scratch directory `MC_SCRATCH` names, exactly: a real
 * directory directly under the runner's scratch root whose marker names it.
 * A name guessed from the working directory is never accepted.
 */
export function ownerOf(scratch, env = process.env, { open = true } = {}) {
  if (!scratch) throw new Error('MC_SCRATCH is not set — exports belong to a runner session\'s scratch directory');
  const stem = basename(scratch);
  const expected = join(runnerScratchDir(env), stem);
  const stat = lstatOrNull(expected);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MC_SCRATCH is not a runner scratch directory');
  if (realpathSync(scratch) !== realpathSync(expected)) throw new Error('MC_SCRATCH does not name the runner scratch directory it was given');
  const marker = readMarker(expected);
  if (!runnerOwned(marker, stem)) throw new Error('the scratch directory has no runner ownership record for this session');
  if (open && marker.ended) throw new Error(`session ${marker.session} has ended — exports are made only by a running session`);
  return { dir: expected, stem, marker, root: identityOf(stat) };
}

/* ---------------------------------------------------------- session locking */

const chains = new Map();

/** One session's create/reuse/release at a time: in this process, and across processes by a lock file. */
export async function withSessionLock(stemDir, fn) {
  const previous = chains.get(stemDir) ?? Promise.resolve();
  let finish;
  const current = new Promise((resolve) => { finish = resolve; });
  const tail = previous.then(() => current);
  chains.set(stemDir, tail);
  await previous;
  const lock = join(stemDir, RECEIPTS_DIR, '.lock');
  try {
    mkdirSync(dirname(lock), { recursive: true });
    acquireFileLock(lock);
    try { return await fn(); } finally { try { unlinkSync(lock); } catch { /* gone already */ } }
  } finally {
    finish();
    if (chains.get(stemDir) === tail) chains.delete(stemDir);
  }
}

/**
 * The same session lock around a synchronous step (release, sweep and tidy's
 * removal). Process-local calls cannot interleave a synchronous step, so the
 * lock file is what another mc process has to wait for. A session with no
 * `.mc-exports` directory has nothing to lock.
 */
export function withSessionLockSync(stemDir, fn) {
  const dir = join(stemDir, RECEIPTS_DIR);
  if (!lstatOrNull(dir)) return fn();
  const lock = join(dir, '.lock');
  acquireFileLock(lock);
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* gone already */ } }
}

function acquireFileLock(lock) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' }); return; } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const holder = Number(readFileSync(lock, 'utf8').trim());
      let alive = false;
      try { process.kill(holder, 0); alive = true; } catch (killed) { alive = killed?.code === 'EPERM'; }
      if (alive || !Number.isInteger(holder)) throw new Error('another mc process is changing this session\'s exports');
      unlinkSync(lock);
    }
  }
  throw new Error('another mc process is changing this session\'s exports');
}

/* ----------------------------------------------------------------- receipts */

const receiptPath = (stemDir, id) => join(stemDir, RECEIPTS_DIR, `${id}.json`);

/** Each `<id>.json` under `.mc-exports/`, read but not verified. Names that are not a valid id are not receipts. */
export function listReceipts(stemDir) {
  const dir = join(stemDir, RECEIPTS_DIR);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const match = /^(.+)\.json$/u.exec(name);
    if (!match || !ID.test(match[1])) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new Error('receipt is not a regular file');
      const raw = readFileSync(path, 'utf8');
      out.push({ id: match[1], path, raw, receipt: JSON.parse(raw), error: null });
    } catch (error) {
      out.push({ id: match[1], path, raw: null, receipt: null, error: String(error?.message || error).split('\n')[0].slice(0, 200) });
    }
  }
  return out;
}

function validReceipt(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'receipt is not an object';
  if (value.schema !== EXPORT_SCHEMA || value.version !== EXPORT_VERSION) return 'receipt schema or version is not this one';
  if (value.id !== id) return 'receipt names another export';
  if (!['ready', 'removing', 'released'].includes(value.state)) return `receipt state ${value.state} is not one mc writes`;
  if (!SHA.test(value.commit || '')) return 'receipt has no full commit';
  if (!Array.isArray(value.paths) || !value.paths.length) return 'receipt has no paths';
  if (!Array.isArray(value.inventory)) return 'receipt has no inventory';
  if (!value.owner || typeof value.owner !== 'object' || !value.owner.session || !value.owner.started || !value.owner.stem) return 'receipt has no owner';
  if (!value.repo || typeof value.repo.name !== 'string' || typeof value.repo.path !== 'string') return 'receipt names no repository';
  if (value.export?.path !== `${EXPORTS_DIR}/${id}`) return 'receipt names another export directory';
  if (value.retained_ref !== RETAINED_PREFIX + value.commit) return 'receipt names another retained ref';
  if (!Number.isInteger(value.generation) || value.generation < 1) return 'receipt has no generation';
  return null;
}

/* -------------------------------------------------------- source and inventory */

/** The commit a ref names now, as a full id; null when it names none. The ref is read once, here. */
export function resolveCommit(git, repo, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error(`ref refused: ${ref}`);
  const text = git.text(repo.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = text?.trim() ?? '';
  if (!SHA.test(sha)) throw new Error(`ref ${ref} names no commit in ${repo.name}`);
  return sha;
}

/** `git ls-tree -r -l -z`, parsed; a Git entry the export cannot carry is refused by name. */
export function listSelection(git, repo, commit, paths) {
  const text = git.text(repo.path, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit, '--', ...paths]);
  if (text === null) throw new Error(`git could not list ${paths.join(', ')} at ${commit}`);
  const entries = [];
  for (const record of text.split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) (\S+) ([0-9a-f]{40,64}) +(\S+)\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error(`unreadable git listing: ${record.slice(0, 80)}`);
    const [, mode, type, sha, size, path] = match;
    if (mode === '120000') throw new Error(`symbolic link refused in the selection: ${path}`);
    if (mode === '160000' || type === 'commit') throw new Error(`submodule (gitlink) refused in the selection: ${path}`);
    if (type !== 'blob' || !MODES.has(mode)) throw new Error(`unsupported git entry refused: ${path} (${mode} ${type})`);
    entries.push({ path, mode, sha, size: Number(size) });
  }
  for (const selected of paths) {
    if (selected === '.') { if (!entries.length) throw new Error(`${commit} holds no files`); continue; }
    if (!entries.some((entry) => entry.path === selected || entry.path.startsWith(`${selected}/`))) {
      throw new Error(`${selected} is not in ${commit}`);
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Source retention: the commit under `refs/mc/retained-export/<sha>`, created once and never replaced. */
export function retainSource(git, repo, commit) {
  const ref = RETAINED_PREFIX + commit;
  const before = git.text(repo.path, ['rev-parse', '--verify', '--quiet', ref])?.trim() ?? null;
  if (before !== null) {
    if (before === commit) return ref;
    throw new Error(`retained ref ${ref} already names ${before}`);
  }
  git.text(repo.path, ['update-ref', ref, commit, '0'.repeat(commit.length)]);
  const after = git.text(repo.path, ['rev-parse', '--verify', '--quiet', ref])?.trim();
  if (after !== commit) throw new Error(`could not retain ${commit} as ${ref}`);
  return ref;
}

/* ------------------------------------------------------------- verification */

/** The export's tree as it stands: directories, regular files and symbolic links, each by its path, never following a link. */
function walkTree(root) {
  const dirs = new Set();
  const files = new Map();
  const links = new Map();
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) links.set(rel, path);
      else if (entry.isDirectory()) { dirs.add(rel); visit(path, rel); }
      else if (entry.isFile()) files.set(rel, path);
      else throw new Error(`unsupported entry in the export: ${rel}`);
    }
  };
  visit(root, '');
  return { dirs, files, links };
}

/** The attached dependency tree as its link records it: its target, identity and marker digest. */
function attachmentIdentity(target) {
  const real = realpathSync(target);
  const stat = statSync(real);
  if (!stat.isDirectory()) throw new Error('the dependency target is not a directory');
  const mark = lstatOrNull(join(real, DEPS_MARK));
  if (!mark || !mark.isFile()) throw new Error(`no ${DEPS_MARK} in the dependency target`);
  return { target: real, dev: stat.dev, ino: stat.ino, marker_sha256: sha256(readFileSync(join(real, DEPS_MARK))) };
}

/**
 * Whether the export on disk is exactly what its receipt and the retained
 * commit say. `allowMissing` is for a removal that already started: files may
 * be gone, but nothing may be added or changed. Returns `{ ok, why, bytes }`.
 */
export function verifyExport({ stemDir, receipt, git, repos, allowMissing = false }) {
  const bad = (why) => ({ ok: false, why, bytes: 0 });
  const id = receipt?.id;
  const shape = validReceipt(receipt, id);
  if (shape) return bad(shape);
  const expectKey = exportKey(receipt.repo.name, receipt.commit, receipt.paths);
  if (receipt.key !== expectKey || receipt.id !== exportIdOf(receipt.commit, expectKey)) return bad('receipt key does not match its source and selection');
  // The owner: the same session, the same start, and the same directory the runner made.
  let marker;
  try { marker = readMarker(stemDir); } catch (error) { return bad(`ownership record unreadable: ${error.message}`); }
  if (!runnerOwned(marker, basename(stemDir)) || marker.session !== receipt.owner.session || marker.started !== receipt.owner.started) {
    return bad('the owning session of this export changed or cannot be read');
  }
  const root = lstatOrNull(stemDir);
  if (!root || !root.isDirectory() || root.isSymbolicLink()) return bad('the scratch directory is not a plain directory');
  if (root.dev !== receipt.owner.root.dev || root.ino !== receipt.owner.root.ino) return bad('the scratch directory was replaced');
  const repo = (repos || []).find((candidate) => candidate.name === receipt.repo.name);
  if (!repo) return bad(`${receipt.repo.name} is no longer a configured repository`);
  let repoReal = null;
  try { repoReal = realpathSync(repo.path); } catch { /* fall through */ }
  if (repoReal !== receipt.repo.path) return bad('the configured repository moved or was replaced');
  const retained = git.text(repo.path, ['rev-parse', '--verify', '--quiet', receipt.retained_ref])?.trim();
  if (retained !== receipt.commit) return bad('the retained source ref is missing or names another commit');
  let current;
  try { current = listSelection(git, repo, receipt.commit, receipt.paths); } catch (error) { return bad(`source cannot be read: ${error.message}`); }
  const claimed = receipt.inventory;
  const same = current.length === claimed.length && current.every((entry, i) => entry.path === claimed[i].path
    && entry.mode === claimed[i].mode && entry.sha === claimed[i].sha && entry.size === claimed[i].size);
  if (!same) return bad('the receipt inventory does not reconcile with the retained commit and the selection');
  // The export directory itself, and the directories above it.
  const exportsDir = lstatOrNull(join(stemDir, EXPORTS_DIR));
  if (exportsDir && (!exportsDir.isDirectory() || exportsDir.isSymbolicLink())) return bad('the exports directory is a link or not a directory');
  const exportDir = join(stemDir, EXPORTS_DIR, id);
  const stat = lstatOrNull(exportDir);
  if (!stat) return allowMissing ? { ok: true, why: 'already removed in part', bytes: 0, partial: true } : bad('the export directory is missing');
  if (!stat.isDirectory() || stat.isSymbolicLink()) return bad('the export directory is a link or not a directory');
  if (stat.dev !== receipt.export.dev || stat.ino !== receipt.export.ino) return bad('the export directory was replaced');
  // The content, against the inventory: exact names and modes, every file's id.
  const attached = receipt.attachment ? 'node_modules' : null;
  const tree = walkTree(exportDir);
  const wanted = new Map(claimed.map((entry) => [entry.path, entry]));
  for (const rel of tree.links.keys()) {
    if (rel !== attached) return bad(`a symbolic link is not part of the export: ${rel}`);
  }
  for (const rel of tree.files.keys()) {
    if (!wanted.has(rel)) return bad(`a file was added to the export: ${rel}`);
  }
  for (const rel of tree.dirs) {
    if (![...wanted.keys()].some((path) => path.startsWith(`${rel}/`))) return bad(`a directory was added to the export: ${rel}`);
  }
  let bytes = 0;
  for (const entry of claimed) {
    const path = join(exportDir, entry.path);
    if (!tree.files.has(entry.path)) {
      if (allowMissing) continue;
      return bad(`a file is missing from the export: ${entry.path}`);
    }
    const file = lstatSync(tree.files.get(entry.path));
    if (file.size !== entry.size) return bad(`a file changed size: ${entry.path}`);
    if (modeOf(file) !== entry.mode) return bad(`a file changed mode: ${entry.path}`);
    const { sha } = streamHash(path, entry.size, entry.sha);
    if (sha !== entry.sha) return bad(`a file changed content: ${entry.path}`);
    bytes += entry.size;
  }
  if (receipt.attachment) {
    const link = join(exportDir, attached);
    const linkStat = lstatOrNull(link);
    if (!linkStat) {
      if (!allowMissing) return bad('the dependency link is missing');
    } else {
      if (!linkStat.isSymbolicLink()) return bad('node_modules is a real directory, not the recorded link');
      if (readlinkSync(link) !== receipt.attachment.target) return bad('the dependency link points elsewhere');
      let now;
      try { now = attachmentIdentity(receipt.attachment.target); } catch (error) { return bad(`dependency target: ${error.message}`); }
      if (now.dev !== receipt.attachment.dev || now.ino !== receipt.attachment.ino || now.marker_sha256 !== receipt.attachment.marker_sha256) {
        return bad('the dependency target changed since the export was made');
      }
    }
  }
  return { ok: true, why: null, bytes, partial: false };
}


/* ---------------------------------------------------------------- creation */

/** Write the blobs of `inventory` into `dir`, streamed from Git, each checked against its id and size. */
async function materialize({ git, repo, dir, inventory }) {
  if (!inventory.length) return;
  let index = -1;
  let current = null;
  let handle = null;
  let hash = null;
  let written = 0;
  try {
    for await (const event of git.blobs(repo.path, inventory.map((entry) => entry.sha))) {
      if (event.type === 'blob') {
        index += 1;
        current = inventory[index];
        if (!current || event.sha !== current.sha) throw new Error('git returned an object out of order');
        if (event.size !== current.size) throw new Error(`object size does not match its listing: ${current.path}`);
        const target = join(dir, current.path);
        mkdirSync(dirname(target), { recursive: true });
        handle = await openHandle(target, 'wx', 0o600);
        hash = blobHasher(current.sha, current.size);
        written = 0;
      } else if (event.type === 'data') {
        hash.update(event.buf);
        written += event.buf.length;
        await handle.write(event.buf);
      } else {
        if (written !== current.size) throw new Error(`short object for ${current.path}`);
        if (hash.digest('hex') !== current.sha) throw new Error(`object content does not match its id: ${current.path}`);
        await handle.chmod(current.mode === '100755' ? 0o755 : 0o644);
        await handle.close();
        handle = null;
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  if (index + 1 !== inventory.length) throw new Error('git returned fewer objects than were requested');
}

/**
 * Make the export for `ref` and the selected `paths` in the session's scratch
 * directory, or reuse the one already there after it proves itself. Returns
 * `{ id, path, reused, receipt }`. Writes no ready receipt until the tree is
 * complete and verified; an interrupted creation leaves an unregistered
 * directory that tidy keeps.
 */
export async function createExport({
  scratch, env = process.env, repos, repoName, ref, paths, attachDeps = null, git = realGit, now = Date.now(),
}) {
  const owner = ownerOf(scratch, env, { open: true });
  const repo = (repos || []).find((candidate) => candidate.name === repoName);
  if (!repo) throw new Error(`${repoName} is not a configured repository`);
  const canonical = normalizePaths(paths);
  const commit = resolveCommit(git, repo, ref);
  const key = exportKey(repo.name, commit, canonical);
  const id = exportIdOf(commit, key);
  return withSessionLock(owner.dir, async () => {
    const existing = listReceipts(owner.dir).find((item) => item.id === id);
    const dir = join(owner.dir, EXPORTS_DIR, id);
    let generation = 1;
    if (existing) {
      if (existing.error) throw new Error(`export ${id} has an unreadable receipt (${existing.error}) — it is kept`);
      const prior = existing.receipt;
      if (prior.state === 'ready' && prior.key === key && prior.owner.session === owner.marker.session && prior.owner.started === owner.marker.started) {
        const proof = verifyExport({ stemDir: owner.dir, receipt: prior, git, repos });
        if (!proof.ok) throw new Error(`export ${id} changed (${proof.why}) — it is kept with its receipt and not overwritten`);
        return { id, path: dir, reused: true, receipt: prior };
      }
      if (prior.state === 'released') generation = prior.generation + 1;
      else throw new Error(`export ${id} is ${prior.state} — an interrupted or unfinished export is kept, not reused`);
    }
    if (lstatOrNull(dir)) throw new Error(`${id} is already a directory in the exports of this session that no receipt names — it is kept`);
    const inventory = listSelection(git, repo, commit, canonical).map((entry) => ({ path: entry.path, mode: entry.mode, sha: entry.sha, size: entry.size }));
    if (attachDeps && inventory.some((entry) => entry.path === 'node_modules' || entry.path.startsWith('node_modules/'))) {
      throw new Error('a dependency link cannot sit beside tracked node_modules files');
    }
    const retained = retainSource(git, repo, commit);
    mkdirSync(join(owner.dir, EXPORTS_DIR), { recursive: true });
    mkdirSync(dir);
    const exportStat = lstatSync(dir);
    let attachment = null;
    try {
      await materialize({ git, repo, dir, inventory });
      if (attachDeps) {
        const identity = attachmentIdentity(attachDeps);
        if (identity.target.startsWith(`${dir}${sep}`)) throw new Error('a dependency target inside the export is refused');
        symlinkSync(identity.target, join(dir, 'node_modules'));
        attachment = { name: 'node_modules', ...identity };
      }
      const bytes = inventory.reduce((sum, entry) => sum + entry.size, 0);
      const receipt = {
        schema: EXPORT_SCHEMA, version: EXPORT_VERSION, id, generation, state: 'ready', key,
        created: new Date(now).toISOString(),
        owner: { session: owner.marker.session, started: owner.marker.started, stem: owner.stem, root: owner.root },
        repo: { name: repo.name, path: realpathSync(repo.path) },
        commit, paths: canonical, retained_ref: retained,
        export: { path: `${EXPORTS_DIR}/${id}`, dev: exportStat.dev, ino: exportStat.ino },
        inventory, bytes, inventory_digest: digestOf(inventory), attachment,
      };
      // The tree is checked against what was just written before it is published as ready.
      const proof = verifyExport({ stemDir: owner.dir, receipt, git, repos });
      if (!proof.ok) throw new Error(`new export did not verify: ${proof.why}`);
      writeJsonAtomic(receiptPath(owner.dir, id), receipt);
      return { id, path: dir, reused: false, receipt };
    } catch (error) {
      // A creation that failed says so and leaves nothing for a reader to take as ready.
      rmTree(dir);
      throw error;
    }
  });
}

/* ---------------------------------------------------------------- decisions */

/**
 * What tidy and the release command both decide from: whether the export may
 * be removed now, and why not when it may not. `facts` carries the evidence
 * read for it: `ended` (positive completion or a runner that has gone),
 * `live` and `open` (pids standing in or holding a file in the tree, or null
 * when unknown), `verify` (verifyExport's answer). The owner is `ownerEnded`
 * for the session-end and tidy paths, and `explicit` for the owning session's
 * own release, which may run while it is still going.
 */
export function exportDecision(item) {
  if (item.error) return { target: false, why: `error: ${item.error}` };
  if (!item.receipt) return { target: false, why: 'no reconstruction receipt — an unregistered export is kept' };
  const r = item.receipt;
  if (r.state === 'released') return { target: false, why: 'already released; its receipt is kept' };
  if (!item.marker) return { target: false, why: 'its scratch directory has no ownership record — kept' };
  if (!item.explicit && !item.ended) return { target: false, why: `${item.marker.session} has not recorded an end` };
  if (item.live === null || item.live === undefined) return { target: false, why: 'error: could not tell whether a process stands in it' };
  if (item.live.length) return { target: false, why: `process ${item.live.join(', ')} stands in it` };
  if (item.open === null || item.open === undefined) return { target: false, why: 'error: could not tell whether a file in it is open' };
  if (item.open.length) return { target: false, why: `process ${item.open.join(', ')} holds a file open in it` };
  if (!item.verify?.ok) return { target: false, why: item.verify ? item.verify.why : 'error: not verified' };
  const identity = {
    receipt_sha256: sha256(item.raw ?? ''), export: r.export, inventory_digest: r.inventory_digest,
    attachment: r.attachment ? { target: r.attachment.target, dev: r.attachment.dev, ino: r.attachment.ino, marker_sha256: r.attachment.marker_sha256 } : null,
  };
  const session = item.explicit ? `its owning session ${r.owner.session}` : item.ended ? `ended session ${r.owner.session}` : `session ${r.owner.session}, whose owning runner is gone`;
  return {
    target: true,
    why: `a registered source export of ${session}: ${r.paths.join(', ')} at ${r.commit.slice(0, 12)}; its source stays retained as ${r.retained_ref}`,
    identity, bytes: r.bytes || 0,
  };
}

/**
 * Remove a verified export: the dependency link alone (never its target), then
 * the tree. Callers hold the session lock (`withSessionLockSync`). The receipt says `removing` first and `released` after, so a
 * partial removal is kept visible and retried safely. Returns `{ ok, why }`.
 */
export function removeExport({ stemDir, receipt, identity, explicit = false, at = Date.now() }) {
  const p = receiptPath(stemDir, receipt.id);
  const exportDir = join(stemDir, EXPORTS_DIR, receipt.id);
  try {
    // The receipt as it is on disk now must be the one the decision read.
    const now = sha256(readFileSync(p, 'utf8'));
    if (identity && now !== identity.receipt_sha256) return { ok: false, why: 're-check: the receipt changed since the list' };
    writeJsonAtomic(p, { ...receipt, state: 'removing', removing: { at: new Date(at).toISOString(), explicit } });
    if (receipt.attachment) {
      const link = join(exportDir, 'node_modules');
      const stat = lstatOrNull(link);
      if (stat) {
        if (!stat.isSymbolicLink()) return { ok: false, why: 'node_modules is no longer a link; it is kept' };
        unlinkSync(link);
      }
    }
    if (!rmTree(exportDir)) return { ok: false, why: 'partial removal: the export directory could not be removed; it is kept and retried' };
    writeJsonAtomic(p, { ...receipt, state: 'released', released: { at: new Date(at).toISOString(), explicit, bytes: receipt.bytes || 0 } });
    return { ok: true, why: null };
  } catch (error) {
    return { ok: false, why: `partial removal: ${String(error?.message || error).split('\n')[0].slice(0, 160)}` };
  }
}

/** Facts for each export under one scratch directory, gathered without deciding: what tidy reads once for its plan. */
export function gatherExports({ stemDir, env = process.env, git = realGit, repos = [], standing, openIn, runnerGone = () => null, explicit = false, excludePid = null }) {
  const stem = basename(stemDir);
  let marker = null;
  let markerError = null;
  try { marker = readMarker(stemDir); } catch (error) { markerError = String(error?.message || error).split('\n')[0].slice(0, 200); }
  const items = [];
  for (const entry of listReceipts(stemDir)) {
    const item = {
      id: entry.id, path: join(stemDir, EXPORTS_DIR, entry.id), stem, stem_dir: stemDir, receipt_path: entry.path, raw: entry.raw,
      receipt: entry.receipt, error: entry.error, marker: null, explicit, ended: false, live: null, open: null, verify: null, bytes: 0,
    };
    items.push(item);
    if (markerError) { item.error = `its scratch directory's ownership record cannot be read (${markerError})`; continue; }
    if (!marker || !runnerOwned(marker, stem)) { item.error = item.error || 'its scratch directory has no runner ownership record — kept'; continue; }
    item.marker = marker;
    // Positive evidence only: a recorded end, or (for tidy's crash recovery) a runner that is positively gone.
    item.ended = Boolean(marker.ended) || (!explicit && runnerGone(marker) != null);
    if (entry.error) continue;
    if (!entry.receipt || entry.receipt.state === 'released') continue;
    try {
      item.live = standing(item.path, { excludePid });
      item.open = item.live === null ? null : openIn(item.path);
      item.verify = verifyExport({ stemDir, receipt: entry.receipt, git, repos, allowMissing: entry.receipt.state === 'removing' });
      item.bytes = entry.receipt.bytes || 0;
    } catch (error) {
      item.error = `error: ${String(error?.message || error).split('\n')[0].slice(0, 200)}`;
    }
  }
  return items;
}

/**
 * The list-first removal for one session's exports, the session's end
 * having been recorded: each eligible export's plan is written beside its
 * receipt, then the removal re-reads the receipt and its identity and removes
 * only what that plan still describes. Returns what went and what stayed.
 */
export function sweepSession({ stemDir, env = process.env, git = realGit, repos, standing, openIn, now = Date.now(), excludePid = null }) {
  return withSessionLockSync(stemDir, () => sweepLocked({ stemDir, env, git, repos, standing, openIn, now, excludePid }));
}

function sweepLocked({ stemDir, env, git, repos, standing, openIn, now, excludePid }) {
  const removed = [];
  const kept = [];
  const items = gatherExports({ stemDir, env, git, repos, standing, openIn, excludePid });
  for (const item of items) {
    if (item.error) { kept.push({ id: item.id, why: item.error }); continue; }
    if (!item.marker?.ended) { kept.push({ id: item.id, why: 'its session has not recorded an end' }); continue; }
    const verdict = exportDecision(item);
    if (!verdict.target) { kept.push({ id: item.id, why: verdict.why }); continue; }
    writeJsonAtomic(join(stemDir, RECEIPTS_DIR, `${item.id}.plan.json`), { schema: EXPORT_SCHEMA, id: item.id, at: new Date(now).toISOString(), identity: verdict.identity, why: verdict.why });
    const outcome = removeExport({ stemDir, receipt: item.receipt, identity: verdict.identity, at: now });
    if (outcome.ok) removed.push({ id: item.id, bytes: verdict.bytes, why: verdict.why });
    else kept.push({ id: item.id, why: outcome.why });
  }
  return { removed, kept };
}

/* ------------------------------------------------------------ explicit release */

/**
 * `mc scratch release <id>`: the preview writes the plan beside the receipt
 * and removes nothing. `apply` acts only on that saved plan: the receipt and
 * the identity it names must still be the ones the fresh decision finds.
 */
export function releaseExport({ scratch, env = process.env, id, apply = false, git = realGit, repos, standing, openIn, now = Date.now(), excludePid = null }) {
  if (!ID.test(id || '')) throw new Error(`not an export id: ${id}`);
  const owner = ownerOf(scratch, env, { open: false });
  return withSessionLockSync(owner.dir, () => releaseLocked({ owner, id, apply, git, repos, standing, openIn, now, excludePid, env }));
}

function releaseLocked({ owner, id, apply, git, repos, standing, openIn, now, excludePid, env }) {
  const items = gatherExports({ stemDir: owner.dir, env, git, repos, standing, openIn, explicit: true, excludePid });
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`no export ${id} in this session`);
  const verdict = item.error ? { target: false, why: item.error } : exportDecision(item);
  const planPath = join(owner.dir, RECEIPTS_DIR, `${id}.plan.json`);
  if (!apply) {
    if (verdict.target) writeJsonAtomic(planPath, { schema: EXPORT_SCHEMA, id, at: new Date(now).toISOString(), identity: verdict.identity, why: verdict.why });
    return { id, path: item.path, applied: false, target: verdict.target, why: verdict.why, bytes: item.bytes || 0, plan: verdict.target ? planPath : null };
  }
  const plan = lstatOrNull(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
  if (!plan) return { id, path: item.path, applied: false, target: false, why: 'no preview saved for this export — run it without --apply first' };
  if (!verdict.target) return { id, path: item.path, applied: false, target: false, why: verdict.why };
  if (JSON.stringify(plan.identity) !== JSON.stringify(verdict.identity)) {
    return { id, path: item.path, applied: false, target: false, why: 're-check: the export changed since its preview; it is kept' };
  }
  const outcome = removeExport({ stemDir: owner.dir, receipt: item.receipt, identity: verdict.identity, explicit: true, at: now });
  if (outcome.ok) { try { unlinkSync(planPath); } catch { /* the plan is evidence, not data */ } }
  return { id, path: item.path, applied: outcome.ok, target: true, why: outcome.ok ? verdict.why : outcome.why, bytes: item.bytes || 0 };
}

/** Whether the path is one a removal may name: `<scratch>/<stem>/exports/<id>`, reached without a link. */
export function exportShapeOk(path, base) {
  const rel = relative(base, path).split(sep);
  if (rel.length !== 3 || rel[1] !== EXPORTS_DIR || !ID.test(rel[2])) return false;
  let cursor = base;
  for (const part of rel) {
    cursor = join(cursor, part);
    const stat = lstatOrNull(cursor);
    if (!stat || stat.isSymbolicLink()) return false;
  }
  return true;
}
