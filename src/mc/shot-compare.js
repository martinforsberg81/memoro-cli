/**
 * `mc shot dev <target> --compare` compares this worktree with MAIN or an
 * existing memoro worktree. Both captures use this worktree's browser script.
 */
import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { run as runGit } from './git.js';
import { actionGap, errorLines, reportLines, runCapture } from './shot.js';
import { ensureAppServer, NO_SHARED_WORKTREE, readDeclaration, sharedWorktree } from './test-environment.js';
import { defaultRepos } from './repos.js';
import { workRoot } from './paths.js';

/** How long the other side waits for a worktree server slot. */
export const COMPARE_ADMIT_WAIT_SECONDS = 60;

/** The fields compared besides element and the keys of rect and scroll. */
const FIELDS = ['position', 'padding', 'margin', 'overflow_y', 'z_index', 'visible'];
const OPTIONAL_FIELDS = ['background_color', 'color'];

/** Resolve only MAIN or one registered memoro worktree beneath the mc work root. */
export function compareSide(value, { env = process.env, cwd = process.cwd(), git = null, exists = existsSync, realpath = realpathSync } = {}) {
  const asked = String(value || 'main');
  if (asked === 'main' || asked === 'origin/main') {
    const worktree = sharedWorktree(env);
    return worktree ? { ok: true, kind: 'main', worktree } : { ok: false, code: 1, error: NO_SHARED_WORKTREE };
  }
  const root = resolve(workRoot(env));
  const candidate = resolve(cwd, asked);
  const callGit = git || ((args) => runGit(undefined, args));
  const repos = defaultRepos(env);
  const memoro = repos.find((repo) => repo.name === 'memoro');
  const list = memoro ? callGit(['-C', memoro.path, 'worktree', 'list', '--porcelain']) : { stdout: '' };
  const registered = String(list?.stdout || '').split(/\n(?=worktree )/u).map((block) => {
    const line = block.split('\n').find((entry) => entry.startsWith('worktree '));
    return line ? line.slice('worktree '.length).trim() : null;
  }).filter(Boolean);
  let matches = [];
  if (exists(candidate)) {
    let real;
    try { real = realpath(candidate); } catch { real = candidate; }
    matches = registered.filter((path) => {
      try { return realpath(path) === real; } catch { return resolve(path) === resolve(candidate); }
    });
  } else {
    const rel = asked.replaceAll('\\', '/').replace(/^\.\//u, '');
    matches = registered.filter((path) => {
      const pathRel = relative(root, path).split(sep).join('/');
      const parts = pathRel.split('/');
      return pathRel === rel || (parts.length >= 5 && parts[0] === 'programs' && parts[2] === 'goals' && parts.at(-1) === 'memoro' && parts.at(-2) === rel);
    });
  }
  const unique = [...new Set(matches)];
  if (unique.length > 1) return { ok: false, code: 2, error: `${asked} matches more than one memoro worktree: ${unique.join(', ')}` };
  if (unique.length !== 1) return { ok: false, code: 2, error: `mc: --compare takes main (the MAIN slot, the shared checkout's server) or a memoro worktree under ~/mc by path or name, not ${asked}` };
  let real;
  try { real = realpath(unique[0]); } catch { real = resolve(unique[0]); }
  let realRoot;
  try { realRoot = realpath(root); } catch { realRoot = root; }
  if (!(real === realRoot || real.startsWith(`${realRoot}${sep}`)) || !exists(`${unique[0]}/.mc/shot.json`)) {
    return { ok: false, code: 2, error: `mc: --compare takes main (the MAIN slot, the shared checkout's server) or a memoro worktree under ~/mc by path or name, not ${asked}` };
  }
  const here = resolve(cwd);
  let realHere;
  try { realHere = realpath(here); } catch { realHere = here; }
  if (real === realHere) return { ok: false, code: 2, error: `${asked} is this tree — nothing to compare` };
  return { ok: true, kind: 'worktree', worktree: unique[0] };
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
    for (const field of OPTIONAL_FIELDS) if (ref[field] !== undefined && here[field] !== undefined) push(field, ref[field], here[field]);
  }
  return diff;
}

const shown = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));

/** `ref` file next to this tree's: `-<sha7>` before `.png`. */
export function refOutPath(out, commit) {
  return out.replace(/\.png$/u, `-${commit.slice(0, 7)}.png`);
}

/** Compare two already-running sides and print their captures and differences. */
export async function runCompare({
  worktree, ref, side: selectedSide = null, declared, request, signInPath, served, servedTree, env, json, open, scrub = String,
  stdout, stderr, openFile, deps = {},
}) {
  const side = selectedSide || (deps.compareSide || compareSide)(ref, { env: deps.env || process.env, cwd: deps.cwd || process.cwd(), git: deps.git });
  if (!side.ok) { stderr.write(`${side.error.startsWith('mc:') ? '' : 'mc: '}${side.error}\n`); return side.code; }
  const read = (deps.readDeclaration || readDeclaration)(side.worktree);
  if (!read.ok) { stderr.write(`mc: ${ref}: ${read.error}\n`); return 1; }
  const app = await (deps.ensureAppServer || ensureAppServer)(side.worktree, read.declaration, {
    json, stdout: stderr, deps: { holderVerb: 'shot', ...deps, admitWaitSeconds: deps.admitWaitSeconds ?? COMPARE_ADMIT_WAIT_SECONDS },
  });
  if (!app.ok) { stderr.write(`mc: ${side.kind === 'main' ? 'main' : side.worktree}: ${app.error}\n`); return 1; }
  const refServed = servedTree(side.worktree, app.server, deps);
  let behind = null;
  if (side.kind === 'main') {
    const result = (deps.git || ((args) => runGit(side.worktree, args)))(['rev-list', '--count', 'HEAD..origin/main']);
    const parsed = Number.parseInt(String(result?.stdout || '').trim(), 10);
    if ((result?.status ?? 0) === 0 && Number.isInteger(parsed) && parsed >= 0) behind = parsed;
    if (!json) stderr.write(`mc: main: serving ${refServed.line}; ${behind === null ? 'behind origin/main: unknown' : behind === 0 ? 'at origin/main' : `${behind} commits behind origin/main`}\n`);
  } else if (!json) stderr.write(`mc: ${side.worktree}: serving ${refServed.line}\n`);
  const capture = deps.runCapture || runCapture;
  const refRequest = { ...request, base_url: app.baseUrl, sign_in: { kind: 'url', url: `${app.baseUrl}${signInPath}` }, out: refOutPath(request.out, refServed.commit) };
  const results = {};
  const label = side.kind === 'main' ? 'main' : side.worktree;
  for (const [key, sideLabel, req] of [['here', 'here', request], ['ref', label, refRequest]]) {
    const ran = capture({ worktree, declaration: declared, request: req, env, deps });
    if (!ran.ok) { stderr.write(`mc: ${sideLabel}: ${scrub(ran.error)}\n`); return 1; }
    const { result } = ran;
    if (!result.ok) { stderr.write(`mc: ${sideLabel}: ${scrub(result.error || result.code || 'the capture failed')}\n`); for (const line of errorLines(result)) stderr.write(`${sideLabel}: ${scrub(line)}\n`); return 1; }
    if (typeof result.file !== 'string' || !result.file) { stderr.write(`mc: ${sideLabel}: the capture script said ok and named no file\n`); return 1; }
    const gap = actionGap(req, result, { worktree, script: declared.argv.join(' ') });
    if (gap) { stderr.write(`mc: ${sideLabel}: ${scrub(gap)}\n`); return 1; }
    results[key] = result;
  }
  const diff = diffMeasure(results.ref.measure, results.here.measure);
  const reports = { here: reportLines(results.here), ref: reportLines(results.ref) };
  const labels = { here: 'here', ref: label };
  if (json) stdout.write(`${scrub(JSON.stringify({
    here: { ...results.here, served },
    ref: { ref, kind: side.kind, worktree: side.worktree, commit: refServed.commit, behind_origin_main: behind, result: { ...results.ref, served: refServed } },
    diff,
  }, null, 2))}\n`);
  else {
    stdout.write(`${results.here.file}\n${results.ref.file}\n`);
    for (const item of diff) stdout.write(`diff  ${item.element}  ${item.field}  ${shown(item.ref)} → ${shown(item.here)}\n`);
    if (!diff.length && request.measure) stdout.write('mc: the measured numbers are the same on both trees\n');
    for (const key of ['here', 'ref']) for (const line of reports[key].lines) stdout.write(`${labels[key]}: ${scrub(line)}\n`);
    for (const key of ['here', 'ref']) for (const warning of results[key].warnings || []) stdout.write(`mc: warning — ${labels[key]}: ${scrub(warning)}\n`);
  }
  if (open) { openFile(results.here.file); openFile(results.ref.file); }
  return reports.here.failed || reports.ref.failed ? 1 : 0;
}
