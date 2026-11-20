/**
 * Programme review: an advisory, independent reading of a programme's README.md
 * (docs/technical/mc-plan.md, "Programme state and advisory reading").
 *
 * One fresh headless session in the role `programme-review`, launched on exports of the
 * named repositories at origin/main, which writes PROGRAMME-REVIEW.md beside the programme.
 * The report is advice: it records no verdict, and no state, goal or turn reads it.
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
import { scrubProviderApiKeysFromEnv, scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';
import { withoutSessionIdentity } from './session-role.js';
import { pidAlive } from './status-collect.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const jsonOrNull = (text) => { try { return JSON.parse(text); } catch { return null; } };
const verdictWord = (verdict) => (verdict === 'ok' ? 'OK' : 'NOT OK');

export const PROGRAMME_REVIEW_ROLE = 'programme-review';
export const PROGRAMME_REVIEW_FILE = 'PROGRAMME-REVIEW.md';
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

export function readerWalk({ catalog, capacity, now, author, env = {}, choose = chooseCandidate, launch, billing, fallThrough = true, independent = false }) {
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
      if (independent && !live.some(one => one.tool === answer.candidate.tool && one.model === answer.candidate.model)) return { reason: 'the choice did not select an independent candidate' };
      if (gone.has(answer.candidate)) return { reason: `the choice answered ${answer.candidate.tool} ${answer.candidate.model}, which is already set aside` };
      const launched = launchOf(answer.candidate.tool);
      const route = launched?.ok ? billing(answer.candidate.tool, { env, now, route: { billing: answer.billing, why: answer.why } }) : { billing: 'unavailable', why: launchReason(answer.candidate) };
      if (route.billing !== 'unavailable') return { answer, billing: route, launched };
      sideline(answer.candidate, route.why);
      if (!fallThrough) return { reason: route.why, failed: true };
    }
  };
  const others = author ? catalog.review.filter((one) => !(one.model === author.model && one.tool === author.tool)) : catalog.review;
  const tiers = independent ? [others] : others.length && others.length < catalog.review.length ? [others, catalog.review] : [catalog.review];
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
      billing: deps.billingRoute ?? billingRouteNow, fallThrough: Boolean(policy.fallThrough), independent: policy.independent,
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
  // A report an earlier reading left is not this reading's: it counts only if the session wrote it after the launch.
  const earlierReport = policy.advisory ? read(join(target.dir, reviewFile)) : null;
  const modified = deps.mtime ?? ((file) => { try { return statSync(file).mtimeMs; } catch { return null; } });
  const discard = deps.discard ?? realDiscard;
  let made = false;
  let identity = null;
  const closeLaunch = () => { try { (deps.remove ?? ctx.remove)(join(target.dir, launchFile)); } catch { /* none left */ } };
  let result = null;
  let summary = null;
  let verdict = null;
  let note = null;
  let output = null;
  try {
    try { mkdirSync(checkout, { recursive: false }); made = true; identity = checkoutIdentity(checkout); } catch (error) { note = `the checkout could not be made: ${error.message}`; }
    if (made && !note) {
      policy.prepare?.(checkout);
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
      for (const key of ['MC_REPO', 'MC_WORKAREA', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR', 'MC_REVIEW_SEEN', 'MC_REVIEW_WRITE_BACK', 'MC_SESSION_STARTED', 'MC_SCRATCH', 'MC_PROGRAMME_REVIEW_TOKEN', 'MC_REPAIR_TOKEN']) delete childEnv[key];
      Object.assign(childEnv, { MC_ROLE: roleName, MC_HEADLESS: '1', ...policy.identity, MC_TOOL: candidate.tool, MC_MODEL: candidate.model, [policy.tokenEnv]: token });
      const safeEnv = (policy.isolatedOutput ? scrubRuntimeSecretsFromEnv : scrubProviderApiKeysFromEnv)(childEnv);
      try { result = await (deps.session ?? realSession)({ ...spawned, cwd: policy.sessionDirectory?.(checkout) ?? target.dir, env: safeEnv, timeoutMs: limitMs, group: true }); }
      catch (error) { result = { status: 1, stdout: '', stderr: error.message || String(error) }; }
      if (policy.isolatedOutput && result.status === 0 && !result.timedOut) output = policy.isolatedOutput(checkout);
      summary = readSessionOutput({ toolId: launched.id, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status, timedOut: result.timedOut, now: now(), model: candidate.model });
      refusePlanOnRead({ read: summary, launch: launched, model: candidate.model, billing: billing.billing, env, now: now(), say: (text) => stderr.write(`mc: ${kind} ${target.name}: ${text}\n`) });
    }
  } catch (error) {
    if (!policy.isolatedOutput) throw error;
    note = error.message || String(error);
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
  if (!policy.isolatedOutput) closeLaunch();
  let code;
  if (note) { stderr.write(`mc: ${kind} ${target.name}: no reading — ${note}\n`); code = invalidExit; }
  else if (changed.length) { note = `${changed.join(', ')} changed during the reading`; stderr.write(`mc: ${kind} ${target.name}: no reading stored — ${note}\n`); code = invalidExit; }
  else if (policy.isolatedOutput) {
    try {
      note = invalidLaunch ? 'the reader launch is no longer current'
        : result?.timedOut ? `the reading exceeded ${limitWords}`
          : result?.status !== 0 ? `the reading failed (exit ${result?.status ?? 1})`
            : policy.store({ output, candidate, at: now() });
    } catch (error) { note = error.message || String(error); }
    if (note) stderr.write(`mc: ${kind} ${target.name}: no reading stored — ${note}\n`);
    else stdout.write(`mc: ${kind} ${target.name}: review written — ${join(target.dir, reviewFile)}\n`);
    code = note ? invalidExit : 0;
  } else if (policy.advisory) {
    const report = read(join(target.dir, reviewFile));
    const written = report !== null && (report !== earlierReport || (modified(join(target.dir, reviewFile)) ?? -Infinity) >= started.getTime());
    if (result?.timedOut) {
      note = `the reading exceeded ${limitWords}`;
      stderr.write(`mc: ${kind} ${target.name}: no reading — ${note}\n`);
      code = invalidExit;
    } else if (!written) {
      note = `the session ended without writing ${reviewFile}${report === null ? '' : ' — the one on disk is an earlier reading\'s'}`;
      stderr.write(`mc: ${kind} ${target.name}: no reading stored — ${note}\n`);
      code = 1;
    } else {
      const path = join(target.dir, reviewFile);
      stdout.write(`mc: ${kind} ${target.name}: review written — ${path}\n`);
      code = 0;
    }
  } else if (result?.timedOut || !verdict || invalidLaunch) { note = result?.timedOut ? `the reading exceeded ${limitWords}` : `the session ended without a verdict (exit ${result?.status ?? 1})`; stderr.write(`mc: ${kind} ${target.name}: no reading stored — ${note}\n`); code = invalidExit; }
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
  if (policy.isolatedOutput) lock(lockRoot, () => {
    if (readLaunch(target.dir, read, launchFile).launch?.token_sha256 === sha256(token)) closeLaunch();
  }, { strict: true, name: `${kind}-unclaim` });
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
  const { read, env, stderr } = ctx;
  if (text === null) { stderr.write(`mc: programme-review ${target.name}: README.md is missing\n`); return 2; }
  const hash = sha256(text);
  const check = () => read(join(target.dir, 'README.md')) !== text ? 'README.md changed during the reading — read its current text again' : null;
  return readerCall({ target, ctx, deps, policy: {
    kind: PROGRAMME_REVIEW_ROLE, role: PROGRAMME_REVIEW_ROLE, launchFile: PROGRAMME_REVIEW_LAUNCH,
    reviewFile: PROGRAMME_REVIEW_FILE, limitMs: PROGRAMME_REVIEW_LIMIT_MS, limitWords: 'thirty minutes', invalidExit: 2,
    hash, round: 1, author: authorOf(env, null), bound: true, advisory: true,
    checkoutName: `mc-programme-review-${target.name}`, identity: { MC_PROGRAMME: target.name },
    tokenEnv: 'MC_PROGRAMME_REVIEW_TOKEN', runName: `programme:${target.name}`, repos,
    names: ['README.md', 'PROGRAMME.json'], check,
    prompt: (checkout) => [
      `Read the programme ${target.name}. Its directory is ${target.dir}.`,
      `Judge README.md (sha256 ${hash}), not a goal. Read the horizon's playback and basis, the cited standards/code, the places it did not read, and the pictures.`,
      'The repositories are read-only exports at origin/main (no repository metadata):',
      ...repos.map(({ repo }) => `${repo}: ${join(checkout, repo)}`),
      `Write only ${join(target.dir, PROGRAMME_REVIEW_FILE)}: line one findings: <n>; then each finding with its part, entry and narrowest fix.`,
      'README.md follows:', text,
    ].join('\n\n'),
    store: () => null,
  } });
}
