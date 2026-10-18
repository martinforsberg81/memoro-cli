/**
 * `mc shot dev <target> --compare <ref>` — the same picture and the same
 * numbers on this worktree and on `<ref>`, and what moved between them.
 *
 * The other tree is a detached worktree of `<ref>` under
 * `~/.memoro/mc/compare/`, kept and reused while its commit is the asked one
 * and pruned once unused for a day with no server — here, and by `mc tidy`.
 * A directory's mtime does not move when it is reused, so a reuse touches it. Each tree runs its own server; both
 * captures run with this worktree's script and declaration, because the script
 * is only a browser client and the ref's own may not know a measurement or a
 * request field this tree declares.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { mcHome } from './paths.js';
import { runCapture } from './shot.js';
import { ensureAppServer, readDeclaration, serversFor } from './test-environment.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The fields compared besides `element` and the keys of `rect` and `scroll`. */
const FIELDS = ['position', 'padding', 'margin', 'overflow_y', 'z_index', 'visible'];

/**
 * The tree `<ref>` is checked out in, made or reused. Refuses a ref git does
 * not know, and a ref that is this tree's HEAD with nothing edited — the two
 * pictures would be the same picture.
 */
export function compareTree(worktree, ref, deps = {}) {
  const git = deps.git || ((args) => spawnSync('git', args, { encoding: 'utf8' }));
  const root = deps.root || join(mcHome(deps.env || process.env), 'compare');
  const sha = String(git(['-C', worktree, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).stdout || '').trim();
  if (!sha) return { ok: false, code: 2, error: `no commit ${ref} in ${worktree} (git fetch origin?)` };
  const head = String(git(['-C', worktree, 'rev-parse', 'HEAD']).stdout || '').trim();
  if (head === sha && !String(git(['-C', worktree, 'status', '--porcelain']).stdout || '').trim()) {
    return { ok: false, code: 2, error: `${ref} is this tree's HEAD and nothing is edited — nothing to compare` };
  }

  const dir = join(root, `${basename(worktree)}-${sha.slice(0, 10)}`);
  const reused = existsSync(dir) && String(git(['-C', dir, 'rev-parse', 'HEAD']).stdout || '').trim() === sha;
  if (reused) {
    // Last use is the directory's mtime, for the prune below and `mc tidy`'s (C).
    const at = deps.now ? deps.now() : new Date();
    try { (deps.touch || utimesSync)(dir, at, at); } catch { /* an untouched tree is pruned a day early, at worst */ }
  } else {
    mkdirSync(root, { recursive: true });
    prune(worktree, root, { git, keep: dir, deps });
    if (existsSync(dir)) git(['-C', worktree, 'worktree', 'remove', '--force', dir]);
    const added = git(['-C', worktree, 'worktree', 'add', '--detach', dir, sha]);
    if ((added.status ?? 1) !== 0) {
      return { ok: false, code: 1, error: `git worktree add ${dir} failed: ${String(added.stderr || '').trim() || `exit ${added.status}`}` };
    }
  }
  if (!existsSync(join(dir, 'node_modules'))) {
    // npm's own lines go to stderr: stdout's first line is the picture's path.
    const prepared = (deps.spawnSync || spawnSync)('npm', ['run', 'deps:prepare'], { cwd: dir, stdio: ['ignore', 2, 'inherit'] });
    if (prepared.error || (prepared.status ?? 1) !== 0) {
      return { ok: false, code: 1, error: `npm run deps:prepare in ${dir} failed: ${prepared.error?.message || `exit ${prepared.status}`}` };
    }
  }
  return { ok: true, dir, commit: sha, reused };
}

/**
 * Old compare trees go: a directory directly under `root`, untouched for a day,
 * with no live server. Nothing outside `root` is ever named to git.
 */
function prune(worktree, root, { git, keep, deps }) {
  const now = deps.now ? deps.now().getTime() : Date.now();
  const live = deps.serversFor || serversFor;
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (dirname(resolve(dir)) !== resolve(root) || resolve(dir) === resolve(keep)) continue;
    let mtime;
    try { mtime = statSync(dir).mtimeMs; } catch { continue; }
    if (now - mtime <= DAY_MS) continue;
    if (live(dir).length) continue;
    git(['-C', worktree, 'worktree', 'remove', '--force', dir]);
  }
}

/** Rounded as the capture script rounds, so 0.04 of drift is not a difference. */
function rounded(value) {
  if (typeof value === 'number') return Math.round(value * 10) / 10;
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, rounded(value[key])]));
  }
  return value ?? null;
}

const same = (a, b) => JSON.stringify(rounded(a)) === JSON.stringify(rounded(b));

/**
 * Every measured value that differs between the two trees, paired by index.
 * An index only one side has is one `missing` entry; no measure on either
 * side is no difference.
 */
export function diffMeasure(refList, hereList) {
  const refs = Array.isArray(refList) ? refList : [];
  const heres = Array.isArray(hereList) ? hereList : [];
  const diff = [];
  for (let index = 0; index < Math.max(refs.length, heres.length); index += 1) {
    const ref = refs[index];
    const here = heres[index];
    const element = here?.element ?? ref?.element ?? null;
    if (!ref || !here) {
      diff.push({ index, element, field: 'missing', ref: ref ? ref.element ?? null : null, here: here ? here.element ?? null : null });
      continue;
    }
    const push = (field, a, b) => { if (!same(a, b)) diff.push({ index, element, field, ref: rounded(a), here: rounded(b) }); };
    push('element', ref.element, here.element);
    for (const group of ['rect', 'scroll']) {
      const keys = new Set([...Object.keys(ref[group] || {}), ...Object.keys(here[group] || {})]);
      for (const key of keys) push(`${group}.${key}`, ref[group]?.[key], here[group]?.[key]);
    }
    for (const field of FIELDS) push(field, ref[field], here[field]);
  }
  return diff;
}

const shown = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));

/** `ref` file next to this tree's: `-<sha7>` before `.png`. */
export function refOutPath(out, commit) {
  return out.replace(/\.png$/u, `-${commit.slice(0, 7)}.png`);
}

/**
 * Both captures and the diff, printed. Called by `mc shot` once it has started
 * this tree's server and built this tree's request; returns the exit code.
 */
export async function runCompare({
  worktree, ref, declared, request, signInPath, served, servedTree, env, json, open, scrub = String,
  stdout, stderr, openFile, deps = {},
}) {
  const tree = (deps.compareTree || compareTree)(worktree, ref, deps);
  if (!tree.ok) { stderr.write(`mc: ${tree.error}\n`); return tree.code; }

  const read = (deps.readDeclaration || readDeclaration)(tree.dir);
  if (!read.ok) { stderr.write(`mc: ${ref}: ${read.error}\n`); return 1; }
  const app = await (deps.ensureAppServer || ensureAppServer)(tree.dir, read.declaration, { json, stdout: stderr, deps });
  if (!app.ok) { stderr.write(`mc: ${ref}: ${app.error}\n`); return 1; }
  const refServed = servedTree(tree.dir, app.server);
  if (!json) stderr.write(`mc: ${ref}: serving ${refServed.line}\n`);

  const capture = deps.runCapture || runCapture;
  const refRequest = {
    ...request,
    base_url: app.baseUrl,
    sign_in: { kind: 'url', url: `${app.baseUrl}${signInPath}` },
    out: refOutPath(request.out, tree.commit),
  };
  const results = {};
  for (const [side, label, req] of [['here', 'here', request], ['ref', ref, refRequest]]) {
    const ran = capture({ worktree, declaration: declared, request: req, env, deps });
    if (!ran.ok) { stderr.write(`mc: ${label}: ${scrub(ran.error)}\n`); return 1; }
    const { result } = ran;
    if (!result.ok) { stderr.write(`mc: ${label}: ${scrub(result.error || result.code || 'the capture failed')}\n`); return 1; }
    if (typeof result.file !== 'string' || !result.file) {
      stderr.write(`mc: ${label}: the capture script said ok and named no file\n`);
      return 1;
    }
    results[side] = result;
  }

  const diff = diffMeasure(results.ref.measure, results.here.measure);
  if (json) {
    stdout.write(`${scrub(JSON.stringify({
      here: { ...results.here, served },
      ref: { ref, commit: tree.commit, result: { ...results.ref, served: refServed } },
      diff,
    }, null, 2))}\n`);
  } else {
    stdout.write(`${results.here.file}\n${results.ref.file}\n`);
    for (const item of diff) {
      stdout.write(`diff  ${item.element}  ${item.field}  ${shown(item.ref)} → ${shown(item.here)}\n`);
    }
    if (!diff.length && request.measure) stdout.write('mc: the measured numbers are the same on both trees\n');
    for (const side of ['here', 'ref']) {
      for (const warning of results[side].warnings || []) stdout.write(`mc: warning — ${side}: ${scrub(warning)}\n`);
    }
  }
  if (open) { openFile(results.here.file); openFile(results.ref.file); }
  return 0;
}
