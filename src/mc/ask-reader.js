/**
 * The ask reader: the one model that answers `mc ask` when jev did not settle it (docs/technical/mc-jev.md,
 * "The reader"; canon/roles/ask-reader.md).
 *
 * `askReaderCall` launches one fresh headless read-only session in the role `ask-reader`, as `mc goal plan-review`
 * launches its reader, and waits for it inside the asking call. The reader works in a copy of the asking session's
 * worktree (`snapshotTree`), the key source's values redacted from every file, and ends with one verdict through
 * `mc ask answer` (`answerVerb`), accepted only from the session the call launched: the role, the call's id and a
 * token whose sha256 is in the launch file, while the call is live, once.
 *
 * Everything the call does outside this process — the model choice, the tool, the session, the copy, the removal,
 * the clock — is an injectable dependency, so a test runs the whole call with no model and no provider.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { requireCapability, resolveLaunch } from '../adapters/index.js';
import { writeFileAtomic } from './atomic-write.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { checkoutIdentity, appendRun, realDiscard, realSession } from './plan-review.js';
import { redactText, redactValue } from './jev.js';
import { chooseCandidate } from './model-choice.js';
import { readCapacity } from './model-capacity.js';
import { readModels } from './model-config.js';
import { runnerDir } from './paths.js';
import { profileArgs } from './portrait.js';
import { instructionsFor, readCanonRole } from './roles.js';
import { headlessArgs, readSessionOutput } from './run-plan.js';
import { scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { withoutSessionIdentity } from './session-role.js';
import { pidAlive } from './status-collect.js';
import { renderGoalText } from './goals.js';
import { textForm, textName } from './desk-texts.js';
import { scanArgs } from './commands/flags.js';

export const ASK_READER_ROLE = 'ask-reader';
/** How long a reading may take, and so how long its call is live. */
export const LIMIT_MS = 10 * 60_000;
export const LAUNCH_FILE = 'launch.json';
export const TOKEN_ENV = 'MC_ASK_TOKEN';
export const CALL_ENV = 'MC_ASK_CALL';
/** A file larger than this is not copied into the reader's tree. */
export const MAX_FILE_BYTES = 1 << 20;
const CALL_ID = /^[a-z0-9-]{8,64}$/u;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const askDir = (env) => join(runnerDir(env), 'ask');
export const callDirOf = (env, id) => join(askDir(env), id);

// -------------------------------------------------------------------------- the model

/**
 * The reader's candidate: the `decision` list with the asker's tool and model taken out of it, asked of
 * `chooseCandidate`; only when that list is empty or answers that nothing can run is the whole list asked.
 */
export function chooseAskReader({ catalog, capacity, now, asker, choose = chooseCandidate }) {
  const priority = catalog.providerPriority ?? 'auto';
  const ask = (decision) => choose({ cls: 'decision', catalog: { ...catalog, decision }, capacity, now, priority });
  const others = asker ? catalog.decision.filter((one) => !(one.model === asker.model && one.tool === asker.tool)) : catalog.decision;
  if (others.length && others.length < catalog.decision.length) {
    const answer = ask(others);
    if (answer?.ok && answer.candidate) return answer;
  }
  return ask(catalog.decision);
}

// ------------------------------------------------------------------------ the copy

function realGit(args) {
  const done = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: done.status ?? 1, stdout: done.stdout || '', stderr: done.stderr || done.error?.message || '' };
}

/**
 * A read-only copy of the worktree `source` at `into`: the files Git tracks and the untracked files it does not
 * ignore, with the worktree's uncommitted changes as they are on disk. A file that is not UTF-8 text, is larger than
 * `MAX_FILE_BYTES`, is not a regular file or is gone from disk is left out; every other file goes through key
 * redaction. The source is only read — its HEAD, index and files are as they were. `{ ok, files, left }` or
 * `{ ok: false, reason }`.
 */
export function snapshotTree({ source, into, secrets = [], git = realGit, maxBytes = MAX_FILE_BYTES, chmod = true }) {
  const listed = git(['-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listed.status !== 0) return { ok: false, reason: `git ls-files in ${source} failed: ${String(listed.stderr).trim()}` };
  const names = [...new Set(String(listed.stdout).split('\0').filter(Boolean))];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const left = { not_text: [], too_large: [], not_a_file: [] };
  const base = resolve(into);
  mkdirSync(into, { recursive: true });
  let files = 0;
  for (const name of names) {
    const to = resolve(into, name);
    if (to !== base && !to.startsWith(`${base}${sep}`)) { left.not_a_file.push(name); continue; }
    let stat;
    try { stat = lstatSync(join(source, name)); } catch { continue; }
    if (!stat.isFile()) { left.not_a_file.push(name); continue; }
    if (stat.size > maxBytes) { left.too_large.push(name); continue; }
    let text;
    try { text = decoder.decode(readFileSync(join(source, name))); } catch { left.not_text.push(name); continue; }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, redactText(text, secrets), { mode: 0o444 });
    files += 1;
  }
  if (chmod) spawnSync('chmod', ['-R', 'a-w', into]);
  return { ok: true, files, left };
}

// ----------------------------------------------------------------------- the prompt

const oneLine = (value) => String(value ?? '').replace(/\s*\n\s*/gu, ' ').trim();

/** What the reader is given: the question and its options, what the asker and jev said, the goal and the pages. */
export function askReaderPrompt({ id, question, options, recommend, evidence, jevText, goalName, goal, readme, documents = [], trees = [], treeRoot }) {
  const lines = [
    `Answer one question a working session asked with mc ask${goalName ? ` for goal ${goalName}` : ''}. You are the ask-reader role: follow your role page and end with exactly one verb, mc ask answer ${id} …`,
    trees.length
      ? `The asker's worktree${trees.length === 1 ? '' : 's'}, copied read-only with its uncommitted changes, ${trees.length === 1 ? 'is' : 'are'} under ${treeRoot} (${trees.map((one) => `${treeRoot}/${one.repo}`).join(', ')}).`
      : 'The asker has no worktree: there is nothing copied.',
    '', 'THE QUESTION', '', oneLine(question), '', 'THE OPTIONS',
    ...Object.entries(options).map(([key, text]) => `  ${key}: ${oneLine(text)}${key === recommend ? '   (the asker recommends this)' : ''}`),
    '', `Recommended by the asker: ${recommend}`, '', 'THE ASKER\'S EVIDENCE', '', evidence ? String(evidence).trim() : 'none supplied', '',
    'WHAT JEV READ', '', jevText || 'jev was not read', '',
  ];
  if (goal) lines.push('THE GOAL, as mc goal show renders it', '', renderGoalText(goal).trimEnd(), '');
  if (readme) lines.push('THE PROGRAMME PAGE', '', String(readme).trimEnd(), '');
  for (const item of documents) lines.push(`DOCUMENT ${item.path}${item.label ? ` (${item.label})` : ''}`, '', String(item.text).trimEnd(), '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------- the launch

const jsonOrNull = (text) => { try { return JSON.parse(text); } catch { return null; } };

function readLaunch(dir) {
  try { return jsonOrNull(readFileSync(join(dir, LAUNCH_FILE), 'utf8')); } catch { return null; }
}

/** Whether a call is live: its pid runs and its start is within the limit. */
function liveCall(launch, now, alive) {
  const start = Date.parse(launch.start);
  return Number.isInteger(launch.pid) && alive(launch.pid) && Number.isFinite(start) && now.getTime() - start < LIMIT_MS;
}

/**
 * One reading. `trees` is `[{ repo, path }]`, the asker's worktrees to copy; `secrets` the key source's values.
 * Returns `{ read: true, verdict, tool, model }` with the verdict the reader's verb recorded — `{ kind: 'continue',
 * key, why }`, `{ kind: 'defect', part, found }` or `{ kind: 'text', inside, text, brief }` — or `{ read: false,
 * reason, tool?, model? }`: the reader could not be started, did not answer in ten minutes or ended without a verdict.
 */
export async function askReaderCall({ call, evidence = '', jevText = '', goalName = null, goal = null, programme = null, readme = null, documents = [], trees = [], asker = null, env, secrets = [], stderr = { write() {} }, deps = {} }) {
  const now = deps.now ?? (() => new Date());
  const alive = deps.alive ?? pidAlive;
  const clean = (value) => redactText(value, secrets);
  const unread = (reason, extra = {}) => ({ read: false, reason: clean(reason), ...extra });

  const route = (() => {
    try {
      if (deps.route) return deps.route('decision');
      const catalog = deps.catalog ?? readModels(env);
      const capacity = deps.capacity ?? readCapacity({ root: runnerDir(env) });
      return chooseAskReader({ catalog, capacity, now: now(), asker, choose: deps.choose });
    } catch (error) { return { ok: false, reason: error.message || String(error) }; }
  })();
  if (!route?.ok || !route.candidate) return unread(`no reader can run: ${route?.reason || 'no answer'}`);
  const candidate = route.candidate;
  const who = { tool: candidate.tool, model: candidate.model };
  const launched = (deps.launch ?? resolveLaunch)(candidate.tool);
  if (!launched?.ok) return unread(`${candidate.tool} is unavailable: ${launched?.hint || launched?.reason || 'no launch'}`, who);
  const role = (deps.role ?? readCanonRole)(ASK_READER_ROLE);
  if (!role?.overlay) return unread('the ask-reader role is missing', who);
  const billing = (deps.billingRoute ?? billingRouteNow)(candidate.tool, { env, now: now(), route: { billing: route.billing, why: route.why } });
  if (billing.billing === 'unavailable') return unread(billing.why, who);

  const id = (deps.id ?? randomUUID)();
  const token = (deps.token ?? (() => randomBytes(24).toString('hex')))();
  const dir = callDirOf(env, id);
  const treeRoot = join(dir, 'tree');
  const started = now();
  const discard = deps.discard ?? realDiscard;
  let made = false;
  let identity = null;
  let result = null;
  let summary = null;
  let note = null;
  let verdict = null;
  try {
    try { mkdirSync(dir, { recursive: false, mode: 0o700 }); made = true; identity = checkoutIdentity(dir); }
    catch (error) {
      if (!made) mkdirSync(askDir(env), { recursive: true });
      try { mkdirSync(dir, { recursive: false, mode: 0o700 }); made = true; identity = checkoutIdentity(dir); }
      catch (again) { note = `the call directory could not be made: ${again.message}`; }
    }
    if (made && !note) {
      const launch = redactValue({ id, token_sha256: sha256(token), pid: deps.pid ?? process.pid, start: started.toISOString(), tool: candidate.tool, model: candidate.model,
        options: call.options, recommend: call.recommend, goal: goalName, programme }, secrets);
      writeFileAtomic(join(dir, LAUNCH_FILE), `${JSON.stringify(launch, null, 2)}\n`);
      mkdirSync(treeRoot, { recursive: true });
      for (const one of trees) {
        const done = (deps.snapshot ?? snapshotTree)({ source: one.path, into: join(treeRoot, one.repo), secrets, ...(deps.git ? { git: deps.git } : {}) });
        if (!done?.ok) { note = done?.reason || `the copy of ${one.repo} failed`; break; }
      }
      spawnSync('chmod', ['-R', 'a-w', treeRoot]);
    }
    if (!note) {
      const cwd = trees.length ? join(treeRoot, trees[0].repo) : treeRoot;
      const prompt = clean(askReaderPrompt({ id, question: call.question, options: call.options, recommend: call.recommend, evidence, jevText, goalName, goal, readme, documents, trees, treeRoot }));
      const args = headlessArgs({ toolId: launched.id, adapter: launched.adapter, model: candidate.model, effort: candidate.effort,
        instructions: instructionsFor(launched.id, role.overlay), prompt, profileArgs, stream: false, cache: role.cache });
      const allowed = requireCapability(launched.id, 'ALLOWED_DIR');
      const at = allowed ? args.indexOf(allowed.before) : -1;
      if (at > 0) args.splice(at, 0, allowed.flag, treeRoot);
      const spawned = gatewayLaunch({ provider: requireCapability(launched.id, 'BILLING_PROVIDER'), model: candidate.model, bin: launched.spec.bin, args, billing: billing.billing });
      const childEnv = withoutSessionIdentity(env);
      for (const key of ['MC_GOAL', 'MC_PROGRAMME', 'MC_REPO', 'MC_WORKAREA', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR', 'MC_REVIEW_SEEN', 'MC_SESSION_STARTED', 'MC_SCRATCH', 'MC_PLAN_REVIEW_TOKEN']) delete childEnv[key];
      Object.assign(childEnv, { MC_ROLE: ASK_READER_ROLE, MC_HEADLESS: '1', MC_TOOL: candidate.tool, MC_MODEL: candidate.model, [TOKEN_ENV]: token, [CALL_ENV]: id });
      try { result = await (deps.session ?? realSession)({ ...spawned, cwd, env: scrubProviderApiKeysFromEnv(childEnv), timeoutMs: LIMIT_MS, group: true }); }
      catch (error) { result = { status: 1, stdout: '', stderr: error.message || String(error) }; }
      summary = readSessionOutput({ toolId: launched.id, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status, timedOut: result.timedOut, now: now(), model: candidate.model });
      const recorded = readLaunch(dir)?.verdict;
      verdict = recorded && typeof recorded === 'object' ? recorded : null;
    }
  } finally {
    if (made) {
      try { discard(dir, identity); }
      catch (error) {
        note ??= null;
        stderr.write(clean(`mc: the ask reader's call directory ${dir} is left in place — ${error.message}\n`));
      }
    }
  }
  const reason = note ? note
    : result?.timedOut ? 'the reader did not answer within ten minutes'
      : !verdict ? `the reader ended without a verdict (exit ${result?.status ?? 1})` : null;
  if (summary) {
    const row = { ...summary, ts: now().toISOString(), name: `ask:${goalName ?? programme ?? '-'}`, kind: 'ask-reader', exit: result?.status ?? 1,
      seconds: Math.round((now().getTime() - started.getTime()) / 1000), pr: '-', note: clean(reason ?? `${verdict.kind}`),
      model: candidate.model, cls: 'decision', tool: candidate.tool, effort: candidate.effort, billing: billing.billing };
    try { (deps.logRun ?? ((one) => appendRun(one, env)))(row); } catch (error) { stderr.write(clean(`mc: warning: the reader's run is not recorded (${error.message})\n`)); }
  }
  if (reason) return unread(reason, who);
  return { read: true, verdict, ...who };
}

// ---------------------------------------------------------------------- the verdict

export const ANSWER_USAGE = [
  'mc ask answer <id> continue <key> [--why "<one line>"]      (--why when the key is not the asker\'s recommendation)',
  'mc ask answer <id> defect --part "<part>" --found "<what is wrong, with file and line>"',
  'mc ask answer <id> text --inside <key> | --none --text "<the text, one line>" --file <path|->',
].join('\n  ');

const ANSWER_SCAN = { strictValues: ['--why', '--part', '--found', '--inside', '--text', '--file'], booleans: ['--none'] };

/**
 * `mc ask answer <id> …` — the reader's one verb. Accepted only from the session a call launched: `MC_ROLE`
 * ask-reader, the call's id, a token whose sha256 is the launch file's, while the call is live, once. A failed
 * check exits 2, writes nothing and says the fix. `ctx` is `{ stdout, stderr, env, readFile, now }`.
 */
export function answerVerb({ argv, ctx, deps = {} }) {
  const { stdout, stderr, env } = ctx;
  const refuse = (text) => { stderr.write(`mc: ask answer is not recorded — ${text}\nThe forms:\n  ${ANSWER_USAGE}\n`); return 2; };
  if (env.MC_ROLE !== ASK_READER_ROLE) { stderr.write('mc: ask answer is not recorded — only the ask-reader session an mc ask call launched records an answer\n'); return 2; }
  const scanned = scanArgs(argv, ANSWER_SCAN);
  if (scanned.error) return refuse(scanned.error);
  const [id, form, key, ...extra] = scanned.positional;
  const flags = scanned.flags;
  if (!id || !CALL_ID.test(id)) return refuse('the first word is the call id the prompt names');
  if (env[CALL_ENV] !== id) return refuse(`this session answers call ${env[CALL_ENV] || 'none'}, not ${id}`);
  const token = env[TOKEN_ENV];
  if (!token) return refuse('no launch token in this session');
  const dir = callDirOf(env, id);
  const launch = readLaunch(dir);
  if (!launch) return refuse(`call ${id} has no reading in progress`);
  if (launch.token_sha256 !== sha256(token)) return refuse('the token is not the one this call was launched with');
  const now = deps.now ?? ctx.now;
  const current = typeof now === 'function' ? now() : (now ?? new Date());
  if (!liveCall(launch, current, deps.alive ?? pidAlive)) return refuse('the call is not live: it has ended or its ten minutes have passed');
  if (launch.verdict) return refuse(`an answer is already recorded (${launch.verdict.kind})`);
  if (extra.length) return refuse(`unexpected words: ${extra.join(' ')}`);
  const keys = Object.keys(launch.options ?? {});
  let verdict;
  if (form === 'continue') {
    if (!key) return refuse(`continue names an option key (${keys.join(', ')})`);
    if (!keys.includes(key)) return refuse(`${key} is not one of the options (${keys.join(', ')})`);
    const why = oneLine(flags.why);
    if (key !== launch.recommend && !why) return refuse(`${key} is not the asker's recommendation (${launch.recommend}): say why in one line with --why "…"`);
    verdict = { kind: 'continue', key, why: why || null };
  } else if (form === 'defect') {
    if (key) return refuse('defect takes --part and --found and no key');
    if (!launch.goal) return refuse('the call has no goal, so there is no goal defect to report: answer with continue or text');
    const part = oneLine(flags.part);
    const found = oneLine(flags.found);
    if (!part || !found) return refuse('defect needs --part "<the part or criterion that is wrong>" and --found "<what is wrong, with file and line or command and output>"');
    verdict = { kind: 'defect', part, found };
  } else if (form === 'text') {
    if (key) return refuse('text takes --inside <key> or --none and no key word');
    if (flags.none === (flags.inside !== null)) return refuse(`text takes --inside <key> (the option that stays inside the wording that stands: ${keys.join(', ')}) or --none, one of them`);
    if (flags.inside !== null && !keys.includes(flags.inside)) return refuse(`--inside ${flags.inside} is not one of the options (${keys.join(', ')})`);
    const named = textName(flags.text);
    if (named.error) return refuse(named.error);
    if (!flags.file) return refuse('text needs --file <path|-> with the brief: "## Vad den säger", "## Vad som föreslås", "## Vad som hittades"');
    let brief;
    try { brief = (ctx.readFile ?? ((path) => readFileSync(path === '-' ? 0 : path, 'utf8')))(flags.file); }
    catch (error) { return refuse(`--file ${flags.file} cannot be read (${error.message})`); }
    const form_ = textForm(brief);
    if (form_.error) return refuse(form_.error);
    verdict = { kind: 'text', inside: flags.inside, text: named.text, brief: String(brief).trim() };
  } else return refuse('the second word is continue, defect or text');
  writeFileAtomic(join(dir, LAUNCH_FILE), `${JSON.stringify({ ...launch, verdict }, null, 2)}\n`);
  stdout.write(`mc: answer ${verdict.kind} recorded for call ${id}\n`);
  return 0;
}
