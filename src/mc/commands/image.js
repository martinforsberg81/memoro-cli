/**
 * `mc image` — one image from Codex's built-in image generation, on the Codex plan (docs/technical/mc-image.md).
 *
 * The verb launches one headless `codex exec` the way the other headless mc calls launch Codex (`headlessArgs`,
 * provider API keys scrubbed from the child), in an empty scratch directory under the runner area, and asks it to call
 * the built-in `image_gen` tool once. Codex writes the image under `$CODEX_HOME/generated_images/<session id>/`; mc
 * finds it there and copies it to `--out`. The model is never trusted to copy the file itself.
 *
 * Plan only: the call is refused unless the Codex billing route is the plan and Codex is logged in with ChatGPT. There
 * is no API or credits fallback for an image, and the session is told never to use the `$imagegen` skill's CLI
 * fallback, which needs an API key.
 *
 * Every boundary — the catalog, the billing route, the login, the session, the clock, the run log — is on `deps`, so
 * a test runs the whole verb with no Codex.
 */
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { requireCapability, resolveLaunch } from '../../adapters/index.js';
import { billingRouteNow } from '../billing-route.js';
import { commandUsage } from '../command-help.js';
import { runnerDir } from '../paths.js';
import { profileArgs } from '../portrait.js';
import { appendRun, realSession } from '../programme-review.js';
import { headlessArgs, readSessionOutput } from '../run-plan.js';
import { scrubProviderApiKeysFromEnv } from '../runtime-secrets.js';
import { withoutSessionIdentity } from '../session-role.js';
import { scanArgs } from './flags.js';

export const TOOL = 'codex';
/** How long one image may take. */
export const LIMIT_MS = 5 * 60_000;
/** The Codex model families `--model` takes as a word; each resolves to the newest catalog slug of its family. */
export const FAMILIES = Object.freeze(['luna', 'sol', 'terra']);
/** The cheapest family that suffices: the text model only has to call one tool. */
export const DEFAULT_MODEL = 'luna';
export const EFFORT = 'low';

const SCAN = {
  strictValues: ['--prompt', '--out', '--model', '--image-model'],
  repeatable: ['--input'],
  booleans: ['--transparent', '--force'],
};

/** What a scanned command line may not be, or null. */
function refuseScanned({ flags, positional }) {
  if (positional.length) return `mc image takes no ${positional[0]}`;
  if (!flags.prompt || !flags.prompt.trim()) return '--prompt "<text>" is required';
  if (!flags.out) return '--out <file> is required';
  return null;
}

/** The bare verb and its scan; help-routes.test.js walks the help with it. */
export const ROUTES = { '': { ...SCAN, check: refuseScanned } };

export function usage() {
  return commandUsage('image');
}

/** `{ prompt, out, inputs, transparent, force, model, imageModel }`, or `{ error }`. */
export function parseImageArgs(argv) {
  const scanned = scanArgs(argv, SCAN);
  const error = scanned.error ?? refuseScanned(scanned);
  if (error) return { error };
  const { flags } = scanned;
  return {
    prompt: flags.prompt, out: flags.out, inputs: flags.input, transparent: flags.transparent, force: flags.force,
    model: flags.model ?? DEFAULT_MODEL, imageModel: flags['image-model'],
  };
}

// ---------------------------------------------------------------------- the model

export const codexHome = (env) => env.CODEX_HOME || join(homedir(), '.codex');

/** The version of a `gpt-<version>-<family>` slug as numbers, or null. */
function familyVersion(slug, family) {
  const match = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-${family}$`, 'u').exec(slug);
  return match ? match[1].split('.').map(Number) : null;
}

function newer(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff) return diff > 0;
  }
  return false;
}

/**
 * The Codex model `--model` names: a family word is the newest slug of that family in `slugs`, a slug in `slugs` is
 * itself. With no catalog (`slugs` null) a slug passes as given — Codex is the authority — and a family word cannot be
 * resolved. `{ model }` or `{ error }`.
 */
export function resolveCodexModel(word, slugs) {
  if (FAMILIES.includes(word)) {
    if (!slugs) return { error: `the Codex model catalog cannot be read, so --model ${word} cannot be resolved; name a model, e.g. gpt-6-luna` };
    let best = null;
    for (const slug of slugs) {
      const version = familyVersion(slug, word);
      if (version && (!best || newer(version, best.version))) best = { slug, version };
    }
    return best ? { model: best.slug } : { error: `the Codex catalog has no ${word} model (it lists ${slugs.join(', ')})` };
  }
  if (!slugs || slugs.includes(word)) return { model: word };
  return { error: `${word} is not in the Codex catalog: ${FAMILIES.join(', ')} or one of ${slugs.join(', ')}` };
}

const slugsOf = (value) => (Array.isArray(value?.models)
  ? value.models.filter((one) => typeof one?.slug === 'string' && one.visibility !== 'hide').map((one) => one.slug)
  : null);

/** The listed model slugs of Codex's catalog: its own cache file, else `codex debug models`; null when neither reads. */
export function readCodexCatalog(env, { read = (path) => readFileSync(path, 'utf8'), run = spawnSync } = {}) {
  try {
    const slugs = slugsOf(JSON.parse(read(join(codexHome(env), 'models_cache.json'))));
    if (slugs?.length) return slugs;
  } catch { /* fall through to the tool */ }
  try {
    const done = run('codex', ['debug', 'models'], { encoding: 'utf8', env, timeout: 30_000, maxBuffer: 16 << 20 });
    const slugs = done.status === 0 ? slugsOf(JSON.parse(done.stdout)) : null;
    return slugs?.length ? slugs : null;
  } catch { return null; }
}

/** How Codex is logged in: `auth_mode` from its auth.json, or null when it cannot be read. Never a token. */
export function readCodexLogin(env, read = (path) => readFileSync(path, 'utf8')) {
  try { return JSON.parse(read(join(codexHome(env), 'auth.json')))?.auth_mode ?? null; } catch { return null; }
}

// ---------------------------------------------------------------------- the session

/** The session's whole prompt: the fixed instruction, then the user's prompt verbatim. */
export function imagePrompt({ prompt, inputs = [], transparent = false, imageModel = null }) {
  const lines = [
    'Make exactly one image with your built-in image generation tool (image_gen), calling it once.',
    'Use only that tool. Run no shell command and no script, use no skill and no CLI fallback (never scripts/image_gen.py),',
    'make no API call and use no API key, and create, edit or copy no file. mc collects the image itself.',
  ];
  if (imageModel) lines.push(`Generate it with the image model ${imageModel}.`);
  if (inputs.length) lines.push(`Pass these reference images as referenced_image_paths: ${inputs.map((path) => JSON.stringify(path)).join(', ')}.`);
  if (transparent) lines.push('Ask for a transparent background (transparent_background: true).');
  lines.push('Pass the prompt below to the tool as it is. When the tool has returned, reply with the single word done and nothing else.',
    '', 'THE PROMPT', '', prompt);
  return lines.join('\n');
}

const files = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((one) => one.isFile()).map((one) => join(dir, one.name));
  } catch { return []; }
};

const mtime = (path) => { try { return statSync(path).mtimeMs; } catch { return 0; } };

/**
 * The image the session made: the newest file under `generated_images/<session>/`, else the newest file under any
 * `generated_images/*` written since `since` (ms). Null when there is none.
 */
export function findGeneratedImage({ home, session = null, since }) {
  const root = join(home, 'generated_images');
  const newest = (list) => list.sort((a, b) => mtime(b) - mtime(a))[0] ?? null;
  if (session && session !== '-') {
    const own = newest(files(join(root, session)));
    if (own) return own;
  }
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((one) => one.isDirectory()).map((one) => join(root, one.name)); } catch { return null; }
  return newest(dirs.flatMap(files).filter((path) => mtime(path) >= since));
}

// ---------------------------------------------------------------------- the verb

/**
 * `mc image …`. Prints the absolute path of the copied image on stdout. Exit 0 with an image, 1 refused (not on the
 * plan, `--out` exists) or no image, 2 a bad argument.
 */
export async function run(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const say = (text) => stderr.write(`mc: image: ${text}\n`);

  const parsed = parseImageArgs(argv);
  if (parsed.error) { stderr.write(`mc: ${parsed.error}\n${usage()}`); return 2; }
  const out = resolve(cwd, parsed.out);
  const inputs = parsed.inputs.map((path) => resolve(cwd, path));
  for (const path of inputs) {
    let file = false;
    try { file = statSync(path).isFile(); } catch { /* missing */ }
    if (!file) { say(`--input ${path} is not a file`); return 2; }
  }
  if (existsSync(out) && !parsed.force) { say(`${out} exists; --force replaces it`); return 1; }

  const resolved = resolveCodexModel(parsed.model, deps.catalog !== undefined ? deps.catalog : readCodexCatalog(env));
  if (resolved.error) { say(resolved.error); return 2; }
  const model = resolved.model;

  const provider = requireCapability(TOOL, 'BILLING_PROVIDER');
  let route;
  try { route = (deps.billingRoute ?? billingRouteNow)(provider, { env, now: now() }); }
  catch (error) { route = { billing: 'unknown', why: error.message || String(error) }; }
  if (route?.billing !== 'plan') {
    say(`refused — the ${provider} route is ${route?.billing ?? 'unknown'} (${route?.why ?? 'no reason'}), and an image runs only on the Codex plan, never on API credits`);
    return 1;
  }
  const login = deps.login !== undefined ? deps.login : readCodexLogin(env);
  if (login !== 'chatgpt') {
    say(`refused — Codex is ${login ? `logged in with ${login}` : 'not logged in'}, not with ChatGPT, so the call would not run on the plan`);
    return 1;
  }

  const launched = (deps.launch ?? resolveLaunch)(TOOL);
  if (!launched?.ok) { say(`codex cannot be launched: ${launched?.hint ?? 'unknown'}`); return 1; }
  if (parsed.imageModel) say(`the built-in image tool has no model field: --image-model ${parsed.imageModel} is passed to the session as an instruction and cannot be confirmed`);

  const id = (deps.id ?? randomUUID)();
  const scratch = join(runnerDir(env), 'images', id);
  const home = codexHome(env);
  const started = now();
  // generated_images keeps the file's own mtime; a second's slack covers a coarse file-system clock.
  const since = started.getTime() - 1000;
  say(`${model} (${EFFORT}) on the Codex plan; up to ${LIMIT_MS / 60_000} minutes`);

  let result;
  let summary = null;
  let found = null;
  let reason = null;
  try {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const prompt = imagePrompt({ prompt: parsed.prompt, inputs, transparent: parsed.transparent, imageModel: parsed.imageModel });
    const args = headlessArgs({ toolId: launched.id, adapter: launched.adapter, model, effort: EFFORT, instructions: null, prompt, profileArgs, stream: false });
    const childEnv = withoutSessionIdentity(env);
    Object.assign(childEnv, { MC_HEADLESS: '1', MC_TOOL: TOOL, MC_MODEL: model });
    try { result = await (deps.session ?? realSession)({ bin: launched.spec.bin, args, cwd: scratch, env: scrubProviderApiKeysFromEnv(childEnv), timeoutMs: LIMIT_MS, group: true }); }
    catch (error) { result = { status: 1, stdout: '', stderr: error.message || String(error) }; }
    summary = readSessionOutput({ toolId: launched.id, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status, timedOut: result.timedOut, now: now(), model });
    found = findGeneratedImage({ home, session: summary.session, since });
    if (!found) {
      const said = String(result.stderr || '').trim().split('\n').filter(Boolean).at(-1);
      reason = result.timedOut ? `no image within ${LIMIT_MS / 60_000} minutes`
        : result.status !== 0 ? `codex exited ${result.status} without an image${said ? `: ${said.slice(0, 300)}` : ''}`
          : `codex finished but no image is under ${join(home, 'generated_images')}`;
    } else {
      try {
        mkdirSync(dirname(out), { recursive: true });
        copyFileSync(found, out, parsed.force ? 0 : constants.COPYFILE_EXCL);
      } catch (error) { reason = `the image ${found} could not be copied to ${out}: ${error.message}`; }
    }
  } catch (error) {
    reason = reason ?? (error.message || String(error));
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* left for mc tidy */ }
  }

  if (summary) {
    const row = { ...summary, ts: now().toISOString(), name: 'image', kind: 'image', exit: reason ? 1 : 0,
      seconds: Math.round((now().getTime() - started.getTime()) / 1000), pr: '-', note: reason ?? 'image', model, cls: '-',
      tool: TOOL, effort: EFFORT, billing: 'plan' };
    try { (deps.logRun ?? ((one) => appendRun(one, env)))(row); } catch (error) { say(`warning: the run is not recorded (${error.message})`); }
  }
  if (reason) { say(reason); return 1; }
  stdout.write(`${isAbsolute(out) ? out : resolve(out)}\n`);
  return 0;
}
