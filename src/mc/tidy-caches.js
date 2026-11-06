/** Exact rebuildable caches approved for unattended tidy, never a general disk scanner. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const CACHE_KEEP_MS = 72 * 60 * 60 * 1000;
export const CACHE_KIND_ROOT = Object.freeze({
  'native-cache': 'scratch',
  'dev-bundle': 'root',
  'swift-cache': 'user_library',
  'ios-derived-cache': 'mc_home',
  'device-delta-cache': 'user_library',
  'media-model-cache': 'user_library',
});
const NATIVE_CACHE_PATHS = Object.freeze([
  'native-phone/derived',
  'native-phone/packages/repositories',
  'native-phone/packages/artifacts',
  'native-phone/authorization-home/Library/Caches/org.swift.swiftpm',
  'native-phone/host/ios/App/App/public',
]);
const SHARED_PATHS = Object.freeze({
  'swift-cache': 'Caches/org.swift.swiftpm',
  'ios-derived-cache': 'build/ios-derived',
  'device-delta-cache': 'Containers/com.apple.CoreDevice.CoreDeviceService/Data/Library/Caches/AppInstallationBinaryDeltas',
  'media-model-cache': 'Containers/com.apple.mediaanalysisd/Data/Library/Caches/com.apple.mediaanalysisd/com.apple.e5rt.e5bundlecache',
});
const BUNDLE_PATH = '.wrangler/dev-server/measure/bundle';

/** Both discovery and apply use this allowlist; a list cannot nominate a broader parent. */
export function cachePathAllowed({ kind, path }, roots) {
  const base = roots[CACHE_KIND_ROOT[kind]];
  if (!base || typeof path !== 'string') return false;
  const rel = relative(base, path);
  const parts = rel.split('/');
  if (!rel || parts.some((part) => part === '..' || !part) || rel.startsWith('/')) return false;
  if (kind === 'native-cache') return !parts[0].startsWith('.') && NATIVE_CACHE_PATHS.includes(parts.slice(1).join('/'));
  if (kind === 'dev-bundle') return parts.length > 4 && rel.endsWith('/' + BUNDLE_PATH);
  return rel === SHARED_PATHS[kind];
}

/** Do not follow even an in-root symlink while locating a cache. Inner links are unlinked only. */
function cacheSnapshot(path, base) {
  const rel = relative(base, path);
  if (!rel || rel.startsWith('../') || rel.startsWith('/')) throw new Error('cache escapes its approved root');
  if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) throw new Error('cache root is not a regular directory');
  let cursor = base;
  for (const part of rel.split('/')) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('symbolic link in cache path');
  }
  if (!lstatSync(path).isDirectory()) throw new Error('cache is not a directory');
  const hash = createHash('sha256');
  let newest = 0;
  let bytes = 0;
  const walk = (file) => {
    const s = lstatSync(file);
    if (!s.isDirectory() && !s.isFile() && !s.isSymbolicLink()) throw new Error('unexpected file type in cache');
    newest = Math.max(newest, s.mtimeMs);
    hash.update(JSON.stringify([relative(path, file), s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs]));
    if (s.isDirectory()) {
      for (const name of readdirSync(file).sort()) walk(join(file, name));
    } else if (s.isFile()) bytes += s.size;
  };
  walk(path);
  return { identity: hash.digest('hex'), newest_ms: newest, bytes };
}

/** Read metadata and process evidence, with no cache payloads or authentication files read. */
export function gatherCacheFacts({ roots, repos, git, running, openIn, servers, now, only = null }) {
  const items = [];
  const opens = new Map();
  const inspect = (path, kind, guard) => {
    const item = { path, kind, guard, active: null, open: null, bytes: 0 };
    try {
      // Missing exact candidates are ordinary; permission and shape failures are not absence.
      try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
      items.push(item);
      if (!cachePathAllowed(item, roots)) throw new Error('not an approved cache path');
      Object.assign(item, cacheSnapshot(path, roots[CACHE_KIND_ROOT[kind]]));
      if (kind === 'native-cache') {
        if (!lstatSync(join(guard, '.mc-scratch.json')).isFile() || lstatSync(join(guard, '.mc-scratch.json')).isSymbolicLink()) {
          throw new Error('scratch ownership record is not a regular file');
        }
        const marker = JSON.parse(readFileSync(join(guard, '.mc-scratch.json'), 'utf8'));
        if (marker?.schema !== 'mc-scratch' || marker.owner !== 'runner' || !marker.session
          || marker.stem !== basename(guard)
          || !Number.isFinite(Date.parse(marker.started)) || !Number.isFinite(Date.parse(marker.ended))
          || Date.parse(marker.ended) < Date.parse(marker.started) || Date.parse(marker.ended) > now) {
          throw new Error('scratch cache needs a valid ended runner ownership record');
        }
        item.owner_id = JSON.stringify([marker.session, marker.started, marker.ended, marker.stem]);
      }
      if (running === null) throw new Error('could not establish process cwd evidence');
      item.active = running.some((p) => typeof p.cwd === 'string' && (p.cwd === guard || p.cwd.startsWith(guard + '/')));
      if (item.active || (kind !== 'native-cache' && item.newest_ms >= now - CACHE_KEEP_MS)) return;
      if (kind === 'dev-bundle') {
        const live = servers(guard);
        if (!Array.isArray(live)) throw new Error('could not establish dev-server state');
        if (live.length) { item.active = true; return; }
      }
      const openRoot = kind === 'native-cache' ? guard : path;
      if (!opens.has(openRoot)) opens.set(openRoot, openIn(openRoot));
      item.open = opens.get(openRoot);
    } catch (error) {
      if (!items.includes(item)) items.push(item);
      item.error = String(error.message || error);
    }
  };

  if (only) {
    inspect(only.path, only.kind, only.guard);
    return items;
  }
  let sessions = [];
  try { sessions = readdirSync(roots.scratch, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') items.push({ path: roots.scratch, kind: 'native-cache', error: String(error.message || error) }); }
  for (const session of sessions) {
    if (!session.isDirectory() || session.name.startsWith('.')) continue;
    const dir = join(roots.scratch, session.name);
    for (const rel of NATIVE_CACHE_PATHS) inspect(join(dir, rel), 'native-cache', dir);
  }
  const worktrees = new Set();
  for (const repo of repos) {
    let listing;
    try { listing = git(repo.path, ['worktree', 'list', '--porcelain']); } catch { continue; }
    if (typeof listing !== 'string') continue;
    for (const line of listing.split('\n')) {
      if (line.startsWith('worktree ')) worktrees.add(line.slice(9));
    }
  }
  for (const wt of worktrees) {
    if (!wt.startsWith(roots.root + '/')) continue;
    inspect(join(wt, BUNDLE_PATH), 'dev-bundle', wt);
  }
  for (const [kind, rel] of Object.entries(SHARED_PATHS)) {
    const path = join(roots[CACHE_KIND_ROOT[kind]], rel);
    inspect(path, kind, kind === 'ios-derived-cache' ? join(roots.mc_home, 'build') : path);
  }
  return items;
}

export function rebuildableCache(item, now) {
  if (item.error) return { target: false, why: 'error: ' + item.error };
  if (item.active === null) return { target: false, why: 'error: process evidence is unavailable' };
  if (item.active) return { target: false, why: 'a process or dev server is using its owner directory' };
  if (item.kind !== 'native-cache' && item.newest_ms >= now - CACHE_KEEP_MS) return { target: false, why: 'cache touched in the last 72 hours' };
  if (!Array.isArray(item.open)) return { target: false, why: 'error: open-file evidence is unavailable' };
  if (item.open.length) return { target: false, why: 'a file is open in its owner directory' };
  return { target: true, why: item.kind === 'native-cache' ? 'rebuildable output of an ended runner session' : 'unused rebuildable cache untouched for 72 hours' };
}
