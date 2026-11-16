/**
 * Programme review: independent reading of a programme's README before sign-off
 * (docs/technical/mc-plan.md, "Sign-off and independent programme reading").
 *
 * One fresh headless session in the role `programme-review`, launched on exports of the
 * named repositories at origin/main, which writes PROGRAMME-REVIEW.md and records its verdict
 * with `mc programs review <programme> verdict ok|not-ok`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { requireCapability, resolveLaunch } from '../adapters/index.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { runTool } from './child-async.js';
import { deskRunsPath } from './desk-budget.js';
import { readTextOrNull } from './goals.js';
import { chooseCandidate } from './model-choice.js';
import { readCapacity } from './model-capacity.js';
import { readModels } from './model-config.js';
import { runnerDir, workRoot } from './paths.js';
import { profileArgs } from './portrait.js';
import { instructionsFor, readCanonRole } from './roles.js';
import { headlessArgs, readSessionOutput, TIMEOUT_EXIT, tsvHeader, tsvRow } from './run-plan.js';
import { refusePlanOnRead } from './plan-refusal.js';
import { scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { withoutSessionIdentity } from './session-role.js';
import { pidAlive } from './status-collect.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const jsonOrNull = (text) => { try { return JSON.parse(text); } catch { return null; } };
const verdictWord = (verdict) => (verdict === 'ok' ? 'OK' : 'NOT OK');

export const PROGRAMME_REVIEW_ROLE = 'programme-review';
export const PROGRAMME_REVIEW_FILE = 'PROGRAMME-REVIEW.md';
export const PROGRAMME_REVIEW_RECORD = '.programme-review.json';
export const PROGRAMME_REVIEW_LAUNCH = '.programme-review-launch.json';
export const PROGRAMME_REVIEW_LIMIT_MS = 30 * 60_000;

export function authorOf(env, avoid) {
  if (avoid) {
    const colon = avoid.indexOf(':');
    if (colon > 0 && colon < avoid.length - 1) return { tool: avoid.slice(0, colon), model: avoid.slice(colon + 1) };
    return null;
  }
  if (env.MC_TOOL && env.MC_MODEL) return { tool: env.MC_TOOL, model: env.MC_MODEL };
  return null;
}

export function readerWalk({ catalog, capacity, now, author, env = {}, choose = chooseCandidate, launch, billing, fallThrough = true }) {
  const priority = catalog.providerPriority ?? 'auto';
  const top = catalog.review[0] ?? null;
  const setAside = [];
  const gone = new Set();
  const launches = new Map();
  const launchOf = (tool) => { if (!launches.has(tool)) launches.set(tool, launch(tool)); return launches.get(tool); };
  const sideline = (candidate, reason) => { gone.add(candidate); setAside.push({ tool: candidate.tool, model: candidate.model, reason }); };
  const launchReason = (candidate) => launchOf(candidate.tool)?.hint || launchOf(candidate.tool)?.reason || `${candidate.tool} cannot be launched here`;
  const stage = (pool) => {
    for (;;) {
      for (const one of pool) if (!gone.has(one) && !launchOf(one.tool)?.ok) sideline(one, launchReason(one));
      const live = pool.filter((one) => !gone.has(one));
      if (!live.length) return { reason: 'no candidate is left' };
      const answer = choose({ cls: 'review', catalog: { ...catalog, review: live }, capacity, now, priority, first: live.includes(top) ? top : null, setAside: setAside.map(({ tool, model }) => ({ tool, model })) });
      if (!answer?.ok || !answer.candidate) return { reason: answer?.reason || 'no answer' };
      if (gone.has(answer.candidate)) return { reason: `the choice answered ${answer.candidate.tool} ${answer.candidate.model}, which is already set aside` };
      const launched = launchOf(answer.candidate.tool);
      const route = launched?.ok ? billing(answer.candidate.tool, { env, now, route: { billing: answer.billing, why: answer.why } }) : { billing: 'unavailable', why: launchReason(answer.candidate) };
      if (route.billing !== 'unavailable') return { answer, billing: route, launched };
      sideline(answer.candidate, route.why);
      if (!fallThrough) return { reason: route.why, failed: true };
    }
  };
  const others = author ? catalog.review.filter((one) => !(one.model === author.model && one.tool === author.tool)) : catalog.review;
  const tiers = others.length && others.length < catalog.review.length ? [others, catalog.review] : [catalog.review];
  let result = { reason: 'no candidate is left' };
  for (const pool of tiers) {
    result = stage(pool);
    if (result.answer || result.failed) break;
  }
  if (!result.answer) return { ok: false, reason: result.reason, failed: Boolean(result.failed), setAside };
  return { ok: true, candidate: result.answer.candidate, answer: result.answer, billing: result.billing, launched: result.launched, setAside };
}

export function chooseReader({ catalog, capacity, now, author, choose = chooseCandidate, launchable }) {
  const walked = readerWalk({ catalog, capacity, now, author, choose, launch: (tool) => ({ ok: launchable ? launchable(tool) : true }), billing: () => ({ billing: 'plan', why: '' }) });
  return walked.ok ? walked.answer : { ok: false, reason: walked.reason };
}

function realCheckout({ repos, dir }) {
  for (const { repo, path } of repos) {
    const into = join(dir, repo);
    mkdirSync(into);
    const archive = spawnSync('git', ['-C', path, 'archive', '--format=tar', 'origin/main'], { maxBuffer: 1 << 30 });
    if (archive.status !== 0) return { ok: false, reason: `git archive of ${repo} failed: ${String(archive.stderr || archive.error?.message || '').trim()}` };
    const unpacked = spawnSync('tar', ['-x', '-C', into], { input: archive.stdout });
    if (unpacked.status !== 0) return { ok: false, reason: `unpacking ${repo} failed: ${String(unpacked.stderr || '').trim()}` };
  }
  spawnSync('chmod', ['-R', 'a-w', dir]);
  return { ok: true };
}

export function realDiscard(dir, identity) {
  const recheck = () => {
    const current = checkoutIdentity(dir);
    if (!identity || current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeMs !== identity.birthtimeMs) {
      throw new Error('the checkout identity changed or cannot be proved');
    }
  };
  recheck();
  chmodSync(dir, 0o700);
  spawnSync('chmod', ['-R', 'u+w', dir]);
  recheck();
  rmSync(dir, { recursive: true, force: true });
}

export function checkoutIdentity(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('the checkout identity is not a directory');
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

export function appendRun(row, env) {
  const path = deskRunsPath(env);
  mkdirSync(join(runnerDir(env), 'log'), { recursive: true });
  appendFileSync(path, `${existsSync(path) ? '' : `${tsvHeader()}\n`}${tsvRow(row)}\n`);
}

export async function realSession({ bin, args, ...options }) {
  const result = await runTool(bin, args, options);
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return { ...result, status: timedOut ? TIMEOUT_EXIT : result.status ?? 1, timedOut, stderr: result.stderr || result.error?.message || '' };
}

function readLaunch(dir, read, file = PROGRAMME_REVIEW_LAUNCH) {
  const text = read(join(dir, file));
  if (text === null) return { none: true };
  const launch = jsonOrNull(text);
  return launch && typeof launch === 'object' ? { launch } : { problem: `${join(dir, file)} is not a launch record` };
}

function liveLaunch(launch, now, alive, limit = PROGRAMME_REVIEW_LIMIT_MS) {
  const start = Date.parse(launch.start);
  return Number.isInteger(launch.pid) && alive(launch.pid) && Number.isFinite(start) && now.getTime() >= start && now.getTime() - start < limit;
}

export async function readerCall({ target, ctx, deps = {}, policy }) {
  const { stdout, stderr, env, read, write } = ctx;
  const { kind, role: roleName, launchFile, reviewFile, limitMs, limitWords, invalidExit, hash, round, author, names } = policy;
  const refuse = (text) => { stderr.write(`mc: ${kind} ${target.name}: ${text}\n`); return 2; };
  const now = deps.now ?? (() => new Date());
  const alive = deps.alive ?? ctx.alive ?? pidAlive;
  const lockRoot = workRoot(env);
  const lock = deps.lock ?? ctx.lock;
  const pid = deps.pid ?? process.pid;
  const checkoutId = (deps.checkoutId ?? randomUUID)();
  const checkout = join(deps.tmp ?? tmpdir(), `${policy.checkoutName}-${checkoutId}`);
  const exists = deps.exists ?? existsSync;
  if (exists(checkout)) return refuse(`${checkout} exists and this call did not make it — nothing is launched and nothing removed`);

  const role = (deps.role ?? readCanonRole)(roleName);
  if (!role?.overlay) { stderr.write(`mc: ${kind} ${target.name}: the ${roleName} role is missing\n`); return invalidExit; }

  const runningRefusal = (existing) => {
    if (existing.problem) return existing.problem;
    if (existing.launch && liveLaunch(existing.launch, now(), alive, limitMs)) return `a reading of round ${existing.launch.round ?? '?'} is running (pid ${existing.launch.pid}, since ${existing.launch.start})`;
    return null;
  };
  let walked;
  try {
    walked = readerWalk({
      catalog: deps.catalog ?? readModels(env), capacity: deps.capacity ?? readCapacity({ root: runnerDir(env) }), now: now(), author, env,
      choose: deps.route ? ({ setAside }) => deps.route('review', { setAside }) : deps.choose, launch: deps.launch ?? resolveLaunch,
      billing: deps.billingRoute ?? billingRouteNow, fallThrough: Boolean(policy.fallThrough),
    });
  } catch (error) { walked = { ok: false, reason: error.message || String(error), setAside: [] }; }
  for (const one of walked.setAside ?? []) stderr.write(`mc: ${kind} ${target.name}: ${one.tool}:${one.model} cannot read — ${one.reason}; trying the next reader\n`);
  if (!walked.ok) {
    if (!policy.unreadFile) { stderr.write(`mc: ${kind} ${target.name}: ${walked.failed ? walked.reason : `no review candidate can run — ${walked.reason}`}\n`); return invalidExit; }
    const unread = { hash, author, set_aside: walked.setAside, reason: walked.reason ?? null, at: now().toISOString() };
    const parked = lock(lockRoot, () => {
      const refused = runningRefusal(readLaunch(target.dir, read, launchFile));
      if (refused) return { refused };
      write(join(target.dir, policy.unreadFile), `${JSON.stringify(unread, null, 2)}\n`);
      return {};
    }, { strict: true, name: `${kind}-claim` });
    if (parked.refused) return refuse(parked.refused);
    const reasons = [...walked.setAside.map((one) => `${one.tool} ${one.model}: ${one.reason}`), walked.reason].filter(Boolean);
    stderr.write(`mc: ${kind} ${target.name}: no reader can run — nothing was read; the draft waits for a reader (${reasons.join('; ')})\n`);
    return 3;
  }
  const candidate = walked.candidate;
  const launched = walked.launched;
  const billing = walked.billing;

  const token = (deps.token ?? (() => randomBytes(24).toString('hex')))();
  const started = now();
  const claimed = lock(lockRoot, () => {
    const problem = runningRefusal(readLaunch(target.dir, read, launchFile)) ?? policy.check?.();
    if (problem) return { refused: problem };
    write(join(target.dir, launchFile), `${JSON.stringify({ binding: target.name, role: roleName, round, hash, token_sha256: sha256(token), pid, start: started.toISOString(), tool: candidate.tool, model: candidate.model, author }, null, 2)}\n`);
    if (policy.unreadFile) { try { (deps.remove ?? ctx.remove)(join(target.dir, policy.unreadFile)); } catch { /* none left */ } }
    return {};
  }, { strict: true, name: `${kind}-claim` });
  if (claimed.refused) return refuse(claimed.refused);

  const before = Object.fromEntries(names.map((file) => [file, read(join(target.dir, file))]));
  const discard = deps.discard ?? realDiscard;
  let made = false;
  let identity = null;
  const closeLaunch = () => { try { (deps.remove ?? ctx.remove)(join(target.dir, launchFile)); } catch { /* none left */ } };
  let result = null;
  let summary = null;
  let verdict = null;
  let note = null;
  try {
    try { mkdirSync(checkout, { recursive: false }); made = true; identity = checkoutIdentity(checkout); } catch (error) { note = `the checkout could not be made: ${error.message}`; }
    if (made && !note) {
      const done = (deps.checkout ?? realCheckout)({ repos: policy.repos.map((one) => ({ repo: one.repo, path: one.path })), dir: checkout });
      if (!done?.ok) note = done?.reason || 'the checkout failed';
    }
    if (!note) {
      policy.beforeSession?.(round);
      stdout.write(`mc: ${kind} ${target.name}: round ${round} on ${candidate.tool} ${candidate.model}${author ? ` — the author is ${author.tool} ${author.model}${candidate.model === author.model && candidate.tool === author.tool ? ' (no other model could run)' : ''}` : ' — the author\'s model is unknown, none excluded'}\n`);
      const prompt = policy.prompt(checkout);
      const args = headlessArgs({ toolId: launched.id, adapter: launched.adapter, model: candidate.model, effort: candidate.effort,
        instructions: instructionsFor(launched.id, role.overlay), prompt, profileArgs, stream: false, cache: role.cache });
      const allowed = requireCapability(launched.id, 'ALLOWED_DIR');
      const at = allowed ? args.indexOf(allowed.before) : -1;
      if (at > 0) args.splice(at, 0, allowed.flag, checkout);
      const spawned = gatewayLaunch({ provider: requireCapability(launched.id, 'BILLING_PROVIDER'), model: candidate.model, bin: launched.spec.bin, args, billing: billing.billing });
      const childEnv = withoutSessionIdentity(env);
      for (const key of ['MC_REPO', 'MC_WORKAREA', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR', 'MC_REVIEW_SEEN', 'MC_REVIEW_WRITE_BACK', 'MC_SESSION_STARTED', 'MC_SCRATCH', 'MC_PROGRAMME_REVIEW_TOKEN']) delete childEnv[key];
      Object.assign(childEnv, { MC_ROLE: roleName, MC_HEADLESS: '1', ...policy.identity, MC_TOOL: candidate.tool, MC_MODEL: candidate.model, [policy.tokenEnv]: token });
      try { result = await (deps.session ?? realSession)({ ...spawned, cwd: target.dir, env: scrubProviderApiKeysFromEnv(childEnv), timeoutMs: limitMs, group: true }); }
      catch (error) { result = { status: 1, stdout: '', stderr: error.message || String(error) }; }
      summary = readSessionOutput({ toolId: launched.id, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status, timedOut: result.timedOut, now: now(), model: candidate.model });
      refusePlanOnRead({ read: summary, launch: launched, billing: billing.billing, env, now: now(), say: (text) => stderr.write(`mc: ${kind} ${target.name}: ${text}\n`) });
    }
  } finally {
    if (made) {
      try { discard(checkout, identity); }
      catch (error) {
        note = `the checkout ${checkout} is left in place — ${error.message}`;
        stderr.write(`mc: ${kind} ${target.name}: ${note}\n`);
      }
    }
  }

  const launch = readLaunch(target.dir, read, launchFile).launch ?? null;
  verdict = launch && (launch.verdict === 'ok' || launch.verdict === 'not-ok') ? launch.verdict : null;
  const invalidLaunch = policy.bound && (!launch || launch.binding !== target.name || launch.role !== roleName || launch.hash !== hash || launch.token_sha256 !== sha256(token) || launch.pid !== pid || launch.start !== started.toISOString());
  const changed = names.filter((file) => read(join(target.dir, file)) !== before[file]);
  closeLaunch();
  let code;
  if (note) { stderr.write(`mc: ${kind} ${target.name}: no reading — ${note}\n`); code = invalidExit; }
  else if (changed.length) { note = `${changed.join(', ')} changed during the reading`; stderr.write(`mc: ${kind} ${target.name}: no reading stored — ${note}\n`); code = invalidExit; }
  else if (result?.timedOut || !verdict || invalidLaunch) { note = result?.timedOut ? `the reading exceeded ${limitWords}` : `the session ended without a verdict (exit ${result?.status ?? 1})`; stderr.write(`mc: ${kind} ${target.name}: no reading stored — ${note}\n`); code = invalidExit; }
  else {
    const at = now();
    const problem = policy.store({ verdict, hash, round, candidate, author, at, launch });
    if (problem) {
      stderr.write(`mc: ${kind} ${target.name}: no reading stored — ${problem}\n`);
      note = problem;
      code = invalidExit;
    } else {
      const path = join(target.dir, reviewFile);
      stdout.write(`mc: ${kind} ${target.name}: ${verdictWord(verdict)} (round ${round}) — ${path}\n`);
      code = verdict === 'ok' ? 0 : 1;
    }
  }
  if (summary) {
    const row = { ...summary, ts: now().toISOString(), name: policy.runName, kind, exit: result?.status ?? 1,
      seconds: Math.round((now().getTime() - started.getTime()) / 1000), pr: '-', note: note ?? (verdict ? verdictWord(verdict) : null),
      model: candidate.model, cls: 'review', tool: candidate.tool, effort: candidate.effort, billing: billing.billing };
    (deps.logRun ?? ((one) => appendRun(one, env)))(row);
  }
  return code;
}

export function readerVerdict({ target, word, ctx, deps = {}, policy }) {
  const { stdout, stderr, env, read, write } = ctx;
  const { kind, role, launchFile, reviewFile, tokenEnv, identityKey, identityLabel, limitMs, limitWords } = policy;
  const refuse = (text) => { stderr.write(`mc: ${kind} verdict: ${text}\n`); return 2; };
  if (word !== 'ok' && word !== 'not-ok') return refuse('the verdict is ok or not-ok');
  if (env.MC_ROLE !== role) return refuse(`only the ${role} session a call launched records a verdict`);
  if (env[identityKey] !== target.name) return refuse(`this session reads ${env[identityKey] || `no ${identityLabel}`}, not ${target.name}`);
  const token = env[tokenEnv];
  if (!token) return refuse('no launch token in this session');
  const found = readLaunch(target.dir, read, launchFile);
  if (found.none) return refuse(`${target.name} has no reading in progress`);
  if (found.problem) return refuse(found.problem);
  const launch = found.launch;
  if (launch.token_sha256 !== sha256(token)) return refuse('the token is not the one this reading was launched with');
  const now = (deps.now ?? ctx.now);
  const current = typeof now === 'function' ? now() : now;
  if (!liveLaunch(launch, current, deps.alive ?? ctx.alive ?? pidAlive, limitMs)) return refuse(`the reading is not live: its call has ended or its ${limitWords} have passed`);
  if (launch.verdict) return refuse(`a verdict is already recorded (${launch.verdict})`);
  const path = join(target.dir, reviewFile);
  const text = read(path);
  if (text === null) return refuse(`${path} is not written`);
  const modified = (deps.mtime ?? ((file) => { try { return statSync(file).mtimeMs; } catch { return null; } }))(path);
  if (modified === null || modified < Date.parse(launch.start)) return refuse(`${path} was not written in this round — write it, then record the verdict`);
  const first = text.split('\n', 1)[0].trim();
  if (first !== verdictWord(word)) return refuse(`${path} starts with "${first}", and the verdict is ${verdictWord(word)} — the first line is OK or NOT OK, the same word`);
  const problem = policy.check?.({ launch, text });
  if (problem) return refuse(problem);
  write(join(target.dir, launchFile), `${JSON.stringify({ ...launch, verdict: word, ...policy.record?.(text) }, null, 2)}\n`);
  stdout.write(`mc: ${kind} verdict ${verdictWord(word)} recorded for ${target.name}\n`);
  return 0;
}

export function programmeReport(text) {
  if (typeof text !== 'string') return null;
  const [verdict, count] = text.split(/\r?\n/u);
  const findings = /^findings: (\d+)$/u.exec(count ?? '');
  if (!['OK', 'NOT OK'].includes(verdict) || !findings || !Number.isSafeInteger(Number(findings[1]))) return null;
  return { verdict: verdict === 'OK' ? 'ok' : 'not-ok', findings: Number(findings[1]) };
}

export function currentProgrammeReading(dir, text, read = readTextOrNull, { anyText = false } = {}) {
  const meta = jsonOrNull(read(join(dir, PROGRAMME_REVIEW_RECORD)));
  const report = read(join(dir, PROGRAMME_REVIEW_FILE));
  const parsed = programmeReport(report);
  if (anyText && meta) meta.earlier = meta.hash !== sha256(text);
  if (!meta || !parsed || (!anyText && meta.hash !== sha256(text)) || meta.report_sha256 !== sha256(report)
    || meta.verdict !== parsed.verdict || meta.findings !== parsed.findings || !Number.isFinite(Date.parse(meta.at))) return null;
  return meta;
}

export function programmeRepositories(text, known) {
  const line = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gmu, '').split(/\r?\n/u).find((one) => /^Repositories:/u.test(one));
  const words = line?.slice('Repositories:'.length).trim().replace(/\.$/u, '').split(/[\s,]+/u).filter(Boolean) ?? [];
  if (!words.length) return { error: 'README.md needs a nonempty Repositories: line' };
  const repos = [];
  for (const name of new Set(words)) {
    const found = known.find((one) => one.repo === name);
    if (!found) return { error: `Repositories: ${name} is not a repository mc knows` };
    repos.push(found);
  }
  return { repos };
}

export async function programmeReviewCall({ target, ctx, text, repos, deps = {} }) {
  const { read, write, env, stderr } = ctx;
  if (text === null) { stderr.write(`mc: programme-review ${target.name}: README.md is missing\n`); return 2; }
  const hash = sha256(text);
  const check = () => read(join(target.dir, 'README.md')) !== text ? 'README.md changed during the reading — read its current text again' : null;
  return readerCall({ target, ctx, deps, policy: {
    kind: PROGRAMME_REVIEW_ROLE, role: PROGRAMME_REVIEW_ROLE, launchFile: PROGRAMME_REVIEW_LAUNCH,
    reviewFile: PROGRAMME_REVIEW_FILE, limitMs: PROGRAMME_REVIEW_LIMIT_MS, limitWords: 'thirty minutes', invalidExit: 2,
    hash, round: 1, author: authorOf(env, null), bound: true,
    checkoutName: `mc-programme-review-${target.name}`, identity: { MC_PROGRAMME: target.name },
    tokenEnv: 'MC_PROGRAMME_REVIEW_TOKEN', runName: `programme:${target.name}`, repos,
    names: ['README.md', 'PROGRAMME.json', 'SIGNED.md', 'RETURNED.md'], check,
    prompt: (checkout) => [
      `Read the programme ${target.name}. Its directory is ${target.dir}.`,
      `Judge README.md (sha256 ${hash}), not a goal. Read the horizon's playback and basis, the cited standards/code, the places it did not read, and the pictures.`,
      'The repositories are read-only exports at origin/main (no repository metadata):',
      ...repos.map(({ repo }) => `${repo}: ${join(checkout, repo)}`),
      `Write only ${join(target.dir, PROGRAMME_REVIEW_FILE)}: line one OK or NOT OK; line two findings: <n>; then each finding with its part, entry and narrowest fix.`,
      `Your last act is mc programs review ${target.name} verdict ok|not-ok, matching line one.`,
      'README.md follows:', text,
    ].join('\n\n'),
    store: ({ verdict, at, candidate, author, launch }) => ctx.lock(workRoot(env), () => {
      const changed = check();
      if (changed) return changed;
      const report = read(join(target.dir, PROGRAMME_REVIEW_FILE));
      const parsed = programmeReport(report);
      if (!parsed || parsed.verdict !== verdict || launch.report_sha256 !== sha256(report)) return 'PROGRAMME-REVIEW.md needs matching verdict and findings: <n> on its first two lines';
      write(join(target.dir, PROGRAMME_REVIEW_RECORD), `${JSON.stringify({ verdict, hash, at: at.toISOString(), findings: parsed.findings,
        report_sha256: sha256(report), tool: candidate.tool, model: candidate.model, author }, null, 2)}\n`);
      return null;
    }, { strict: true, name: 'programme-review-store' }),
  } });
}

export function programmeVerdictVerb({ target, word, ctx, deps = {} }) {
  return readerVerdict({ target, word, ctx, deps, policy: {
    kind: PROGRAMME_REVIEW_ROLE, role: PROGRAMME_REVIEW_ROLE, launchFile: PROGRAMME_REVIEW_LAUNCH,
    reviewFile: PROGRAMME_REVIEW_FILE, tokenEnv: 'MC_PROGRAMME_REVIEW_TOKEN', identityKey: 'MC_PROGRAMME', identityLabel: 'programme',
    limitMs: PROGRAMME_REVIEW_LIMIT_MS, limitWords: 'thirty minutes',
    record: (text) => ({ report_sha256: sha256(text) }),
    check: ({ launch, text }) => {
      if (launch.binding !== target.name || launch.role !== PROGRAMME_REVIEW_ROLE) return 'the launch is not for this programme reading';
      const current = ctx.read(join(target.dir, 'README.md'));
      if (current === null || launch.hash !== sha256(current)) return 'README.md changed during the reading — read its current text again';
      if (!programmeReport(text)) return 'PROGRAMME-REVIEW.md needs findings: <n> on line two';
      return null;
    },
  } });
}
