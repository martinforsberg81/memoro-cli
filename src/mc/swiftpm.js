/**
 * What mc does to SwiftPM before an `xcodebuild` of memoro's iOS app, so the
 * build does not wait on the network.
 *
 * On 2026-10-25 `xcodebuild` sat at "Resolve Package Graph" for more than 20
 * minutes, three times, while SwiftPM downloaded Capacitor's binary
 * xcframework zips; `curl` fetched the same URL in seconds (proposal
 * 2026-10-25-mc-swiftpm-artifact-download-stall). So before any build, device
 * or simulator, every `binaryTarget` the app's package graph names is fetched
 * with curl into SwiftPM's artifact cache, where SwiftPM looks before it
 * downloads, and verified against the checksum its `Package.swift` declares
 * (`prefetchArtifacts`). A file that does not verify is deleted and the build
 * fails with the URL named: an unverified zip is never left where SwiftPM
 * would take it.
 *
 * The simulator build also seeds its cloned packages from the shared
 * `<mcHome>/build/ios-spm` with an APFS clone, once (`seedPackages`); it keeps
 * that copy after, and passes `-disableAutomaticPackageResolution
 * -skipPackageUpdates` only when the worktree's `Package.resolved` pins exactly
 * what the copy xcodebuild reads holds (`resolvedMatchesClone`).
 *
 * Every process boundary is a parameter: the download is a `step` (the
 * builder's one way to run a command), the file system is node's.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** SwiftPM's shared cache when no `-packageCachePath` is passed: what a device build uses. */
export function defaultPackageCache(env = process.env) {
  return join(env.HOME || homedir(), 'Library', 'Caches', 'org.swift.swiftpm');
}

/**
 * The name SwiftPM gives a downloaded artifact in its cache: the URL as a C99
 * identifier, every other character `_`
 * (`https___github_com_ionic_team_capacitor_swift_pm_releases_download_8_5_3_Capacitor_xcframework_zip`).
 */
export function artifactCacheName(url) {
  const name = String(url).replace(/[^A-Za-z0-9_]/gu, '_');
  return /^[0-9]/u.test(name) ? `_${name}` : name;
}

/** Where SwiftPM looks for `url` in the cache at `cachePath`. */
export function artifactCachePath(cachePath, url) {
  return join(cachePath, 'artifacts', artifactCacheName(url));
}

/** Every remote `.binaryTarget(name:, url:, checksum:)` in a `Package.swift`. */
export function binaryTargets(text) {
  const found = [];
  for (const match of String(text || '').matchAll(/\.binaryTarget\s*\(([^)]*)\)/gu)) {
    const fields = Object.fromEntries([...match[1].matchAll(/(\w+)\s*:\s*"([^"]*)"/gu)].map((m) => [m[1], m[2]]));
    if (fields.url && fields.checksum) found.push({ name: fields.name || '', url: fields.url, checksum: fields.checksum.toLowerCase() });
  }
  return found;
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** The local packages a `Package.swift` names by `path:`, resolved against its directory. */
function localPackages(text, dir) {
  return [...String(text || '').matchAll(/\.package\s*\([^)]*\bpath\s*:\s*"([^"]+)"/gu)].map((m) => resolve(dir, m[1]));
}

/**
 * The `Package.swift` files the app's package graph resolves through: the
 * generated `CapApp-SPM` beside the project, the local packages it names
 * (Capacitor's plugins in `node_modules`), and every package checked out in
 * the cloned-packages directory `spm` (where `capacitor-swift-pm`, which
 * declares the xcframework zips, lives). The texts, in that order.
 */
export function packageManifests({ worktree, project, spm }) {
  const capApp = join(worktree, dirname(project), 'CapApp-SPM');
  const texts = [];
  const root = readText(join(capApp, 'Package.swift'));
  if (root !== null) {
    texts.push(root);
    for (const dir of localPackages(root, capApp)) {
      const text = readText(join(dir, 'Package.swift'));
      if (text !== null) texts.push(text);
    }
  }
  let checkouts = [];
  try { checkouts = readdirSync(join(spm, 'checkouts')).sort(); } catch { checkouts = []; }
  for (const name of checkouts) {
    const text = readText(join(spm, 'checkouts', name, 'Package.swift'));
    if (text !== null) texts.push(text);
  }
  return texts;
}

/** The sha256 of a file, hex — what SwiftPM's `checksum:` is. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Every binary target in `manifests`, in SwiftPM's cache at `cachePath`
 * before `xcodebuild` asks for it: one that is there and verifies is reused,
 * any other is downloaded with curl (through `step`, so it is in the build's
 * log) to a temporary name beside it, verified, and only then renamed into
 * place. `{ ok: true, artifacts: [{ name, url, path, how }] }` with `how`
 * `downloaded` or `reused`, or `{ ok: false, line }` naming the URL — after a
 * checksum mismatch no file of it is left.
 */
export async function prefetchArtifacts({
  manifests, cachePath, step, cwd, env = process.env, stdout = process.stdout, hash = sha256File,
}) {
  const seen = new Set();
  const targets = manifests.flatMap(binaryTargets).filter((target) => !seen.has(target.url) && seen.add(target.url));
  const artifacts = [];
  for (const target of targets) {
    const path = artifactCachePath(cachePath, target.url);
    if (existsSync(path)) {
      if (hash(path) === target.checksum) {
        artifacts.push({ ...target, path, how: 'reused' });
        stdout.write(`mc: prefetch ${target.name || target.url}: reused ${path}\n`);
        continue;
      }
      rmSync(path, { force: true });
    }
    const partial = `${path}.mc-partial`;
    rmSync(partial, { force: true });
    mkdirSync(dirname(path), { recursive: true });
    const got = await step(`curl ${target.name || 'artifact'}`, [
      'curl', '--fail', '--location', '--silent', '--show-error', '--retry', '3', '--connect-timeout', '30',
      '--max-time', '900', '--output', partial, target.url,
    ], { cwd, env, timeoutMs: 16 * 60 * 1000 });
    if (!got.ok || !existsSync(partial)) {
      rmSync(partial, { force: true });
      const why = String(got.error || got.output || '').trim().split('\n').at(-1) || `exit ${got.code}`;
      return { ok: false, line: `could not download ${target.url} (${why})` };
    }
    const actual = hash(partial);
    if (actual !== target.checksum) {
      rmSync(partial, { force: true });
      return { ok: false, line: `checksum mismatch for ${target.url}: the download is ${actual}, Package.swift says ${target.checksum} — the file was deleted` };
    }
    renameSync(partial, path);
    artifacts.push({ ...target, path, how: 'downloaded' });
    stdout.write(`mc: prefetch ${target.name || target.url}: downloaded ${target.url}\n`);
  }
  return { ok: true, artifacts };
}

/** `{ <identity>: <revision> }` for the remote pins of a `Package.resolved` (version 1, 2 or 3), or null. */
export function resolvedPins(text) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  const pins = Array.isArray(json?.pins) ? json.pins : json?.object?.pins;
  if (!Array.isArray(pins)) return null;
  const out = {};
  for (const pin of pins) {
    const identity = pin.identity || String(pin.package || '').toLowerCase();
    if (identity && pin.state?.revision) out[identity] = pin.state.revision;
  }
  return out;
}

/** `{ <identity>: <revision> }` for the source-control checkouts a cloned-packages directory holds, or null. */
export function clonedPins(spm) {
  const text = readText(join(spm, 'workspace-state.json'));
  if (text === null) return null;
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  const out = {};
  for (const dep of json?.object?.dependencies || []) {
    const revision = dep?.state?.checkoutState?.revision;
    if (dep?.packageRef?.identity && revision) out[dep.packageRef.identity] = revision;
  }
  return out;
}

/** Where Xcode keeps the project's `Package.resolved`. */
export function resolvedPath(worktree, project) {
  return join(worktree, project, 'project.xcworkspace', 'xcshareddata', 'swiftpm', 'Package.resolved');
}

/**
 * Whether the worktree's `Package.resolved` pins exactly the packages, at
 * exactly the revisions, the build's cloned packages in `spm` hold: the copy
 * xcodebuild reads (`-clonedSourcePackagesDirPath`). That is the seed's copy
 * made once and kept, so a seed refreshed since does not reach it. False when
 * either is missing: with no `Package.resolved` there is nothing for SwiftPM
 * to build from without resolving.
 */
export function resolvedMatchesClone({ worktree, project, spm }) {
  const text = readText(resolvedPath(worktree, project));
  const pins = text === null ? null : resolvedPins(text);
  const held = clonedPins(spm);
  if (!pins || !held || !Object.keys(pins).length) return false;
  const names = Object.keys(pins).sort();
  return names.length === Object.keys(held).length && names.every((name) => held[name] === pins[name]);
}

/**
 * The build's own cloned-packages directory, made once from the shared seed
 * with an APFS clone (`cp -c -R`: copy-on-write, near-instant) through
 * `step`. The seed's `workspace-state.json` names its own absolute paths;
 * they are rewritten to the copy's so SwiftPM finds what it extracted.
 * `{ ok, how, line }` with `how` `kept` (already there), `seeded` or `none`
 * (no seed on this Mac — SwiftPM clones from the network).
 */
export async function seedPackages({ seed, spm, step, cwd, env = process.env }) {
  if (existsSync(spm)) return { ok: true, how: 'kept', line: `${spm} kept from the last build` };
  if (!existsSync(seed) || !statSync(seed).isDirectory()) return { ok: true, how: 'none', line: `no package seed at ${seed} — SwiftPM clones from the network` };
  mkdirSync(dirname(spm), { recursive: true });
  const r = await step('seed packages', ['cp', '-c', '-R', seed, spm], { cwd, env, timeoutMs: 10 * 60 * 1000 });
  if (!r.ok) {
    rmSync(spm, { recursive: true, force: true });
    return { ok: false, line: `cp -c -R ${seed} ${spm} failed — ${String(r.error || r.output || '').trim().split('\n').at(-1) || `exit ${r.code}`}` };
  }
  const state = join(spm, 'workspace-state.json');
  const text = readText(state);
  if (text !== null && text.includes(seed)) writeFileSync(state, text.split(seed).join(spm));
  return { ok: true, how: 'seeded', line: `${spm} cloned from ${seed}` };
}
