/**
 * The plan review: the check on a goal's way out of draft and the reading that check asks for
 * (docs/technical/mc-goals.md, "Plan review"; canon/roles/plan-review.md).
 *
 * Two parts. The gate (`moveGate`) runs inside `mc goal stage` and `mc goal log --stage` on a forward move
 * out of draft: a version 2 goal is checked for the parts it must have (`partsLacks`) and every goal needs an
 * OK reading of the text it has now. The reading (`planReviewCall`) is `mc goal plan-review`: one fresh
 * headless session in the role `plan-review`, launched as `prepareDeskItem` launches a preparation, which writes
 * PLAN-REVIEW.md and records its verdict with `mc goal plan-review <p>/<g> verdict ok|not-ok` (`verdictVerb`).
 *
 * Two files in the goal's directory, beside GOAL.json and LOG.md and not part of the goal's text:
 * `.plan-review.json` holds the readings and the markers of a move back into draft, appended and never
 * rewritten; `.plan-review-launch.json` holds the one launch in flight, with the sha256 of the token that only
 * the child's environment holds. Every function here takes what it reads and writes from the caller, so a test
 * runs it with no model, no git and no clock.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { requireCapability, resolveLaunch } from '../adapters/index.js';
import { AREAS_PATH, isSourceArea } from './areas.js';
import { writeFileAtomic } from './atomic-write.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { runTool } from './child-async.js';
import { deskRunsPath } from './desk-budget.js';
import { GOAL_FILE, HOLD_FILE, LOG_FILE, appendEntry, logStamp, readTextOrNull, renderGoalText } from './goals.js';
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

export const PLAN_REVIEW_ROLE = 'plan-review';
export const RECORDS_FILE = '.plan-review.json';
export const LAUNCH_FILE = '.plan-review-launch.json';
/** The record of a call that found no reader able to run: the text's hash, the author, each candidate set aside. */
export const UNREAD_FILE = '.plan-review-unread.json';
export const REVIEW_TEXT_FILE = 'PLAN-REVIEW.md';
/** How long a reading may take, and so how long its launch is live. */
export const LIMIT_MS = 20 * 60_000;
/** Readings since the goal last entered draft after which the author decides with `--reason`. */
export const MAX_READINGS = 2;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The hash of the text a reading judges: the brief as `renderGoalText` gives it for the parsed goal file, with
 * every criterion's `met` set false, so a met mark and the count in the criteria heading change nothing. Stage,
 * status, phase, repos, class, created, prs, the log and the hold are not in it.
 */
export function goalHash(goal) {
  const plain = { ...goal, success_criteria: (goal.success_criteria ?? []).map((item) => ({ ...item, met: false })) };
  return sha256(renderGoalText(plain));
}

// ---------------------------------------------------------------- the records

/** `{ records }` read from the goal's directory, or `{ problem }` when the file is there and is not the records. */
export function readRecords(dir, read = readTextOrNull) {
  const text = read(join(dir, RECORDS_FILE));
  if (text === null) return { records: [] };
  try {
    const file = JSON.parse(text);
    if (file && Array.isArray(file.records)) return { records: file.records };
  } catch { /* the problem below */ }
  return { problem: `${join(dir, RECORDS_FILE)} is not the plan review's records` };
}

/** One record appended to `.plan-review.json`; what was there is kept as it was. */
export function appendRecord(dir, record, { read = readTextOrNull, write = writeFileAtomic } = {}) {
  const { records, problem } = readRecords(dir, read);
  if (problem) return { problem };
  write(join(dir, RECORDS_FILE), `${JSON.stringify({ records: [...records, record] }, null, 2)}\n`);
  return {};
}

/** The marker a move back into draft appends (D6): readings and rounds count after the latest one. */
export function markerRecord(now, from) {
  return { kind: 'marker', at: now.toISOString(), from };
}

/**
 * Where the plan review of a goal stands for the text with `hash`: the readings since the latest marker (the
 * order of the records, never their minute stamps), and `status` — `none`, `ok` (the latest reading answered OK
 * for this text), `ok-earlier` (OK for a text the goal no longer has) or `not-ok` — with the latest's round.
 */
export function readingState(records, hash) {
  const cut = records.map((record) => record.kind).lastIndexOf('marker');
  const readings = records.slice(cut + 1).filter((record) => record.kind === 'reading' && (record.verdict === 'ok' || record.verdict === 'not-ok'));
  const latest = readings.at(-1) ?? null;
  const status = !latest ? 'none' : latest.verdict === 'not-ok' ? 'not-ok' : latest.hash === hash ? 'ok' : 'ok-earlier';
  return { readings, latest, status, round: latest ? readings.length : 0 };
}

const verdictWord = (verdict) => (verdict === 'ok' ? 'OK' : 'NOT OK');

/** The line `mc goal show` prints for the plan review (C4), or null when there is nothing to say. */
export function showLine({ name, goal, stage, records }) {
  const state = readingState(records, goalHash(goal));
  if (state.status === 'none') return stage === 'draft' ? `plan review: none yet — mc goal plan-review ${name}` : null;
  const by = `${state.latest.tool ?? '—'} ${state.latest.model ?? '—'}`;
  if (state.status === 'ok') return `plan review: OK for this text (round ${state.round}, ${by}, ${state.latest.at})`;
  if (state.status === 'ok-earlier') return `plan review: OK for an earlier text (round ${state.round}, ${by}) — the goal changed since; mc goal plan-review ${name} reads it again`;
  return `plan review: not OK (round ${state.round}, ${by}) — see ${REVIEW_TEXT_FILE}`;
}

// ------------------------------------------------------------ the parts check

/** `[repo, path]` of a standard written `<repo>/<path>#<section>`. */
function standardPath(standard) {
  const text = String(standard).split('#')[0];
  const slash = text.indexOf('/');
  return slash > 0 ? [text.slice(0, slash), text.slice(slash + 1)] : [text, ''];
}

/**
 * What a version 2 goal lacks to be built, each lack one line (D3): an empty outcome, no change item, no
 * criterion, a declared rule area without a stand, a stand whose standard is not on origin/main of the
 * repository it names. A question that cannot be answered is a line too, with the reason.
 * `probe.declarations()` is `{ declared: [{ repo, areas }] }` or `{ error }`; `probe.onMain(repo, path)` is
 * `{ state: 'present'|'absent'|'unknown', why }`.
 */
export function partsLacks(goal, name, probe) {
  if (goal.version !== 2) return [];
  const lacks = [];
  if (!(goal.outcome ?? []).some((paragraph) => String(paragraph).trim())) lacks.push(`the outcome is empty — mc goal set ${name} outcome --text "…"`);
  if (!(goal.change ?? []).length) lacks.push(`there is no change item — mc goal item add ${name} change --where "…" --what "…"`);
  if (!(goal.success_criteria ?? []).length) lacks.push(`there is no criterion — mc goal criterion add ${name} --criterion "…" --check "…"`);
  const obligations = goal.obligations ?? [];
  const read = probe.declarations();
  if (read.error) lacks.push(`the declared rule areas cannot be read, so the stands cannot be checked: ${read.error}`);
  else {
    const taken = new Set(obligations.map((one) => one.area));
    const bare = read.declared.flatMap((one) => one.areas.filter((area) => !isSourceArea(area)).map((area) => `${one.repo}/${area.id}`)).filter((id) => !taken.has(id));
    if (bare.length) lacks.push(`no stand on ${bare.join(', ')} — mc goal obligation set ${name} <area> --stand touched|untouched --text "…" (mc goal areas ${name} lists them)`);
  }
  for (const one of obligations) {
    if (!one.standard) continue;
    const [repo, path] = standardPath(one.standard);
    const found = probe.onMain(repo, path);
    if (found.state === 'absent') lacks.push(`the stand on ${one.area} names ${one.standard}, and ${path} is not on origin/main of ${repo}`);
    else if (found.state !== 'present') lacks.push(`cannot tell whether ${path} is on origin/main of ${repo} (the standard of ${one.area}): ${found.why ?? 'no answer'}`);
  }
  if (!read.error) {
    for (const { repo, areas } of read.declared) {
      for (const area of areas) {
        if (!area.page) continue;
        const found = probe.onMain(repo, area.page);
        if (found.state === 'absent') lacks.push(`the page of ${repo}/${area.id}, ${area.page}, is not on origin/main of ${repo} — repair ${repo}'s main: its ${AREAS_PATH} or the page`);
        else if (found.state !== 'present') lacks.push(`cannot tell whether the page of ${repo}/${area.id}, ${area.page}, is on origin/main of ${repo}: ${found.why ?? 'no answer'}`);
      }
    }
  }
  return lacks;
}

// ------------------------------------------------------------------ the gate

/**
 * The check on a forward move out of draft. `null` when the move is not one it is held to (the goal is not in
 * draft, the move is to draft or `dropped`); else `{ comment: null }` when the goal is complete, or `{ refusal }`
 * — the text for stderr, every lack in it. No reading is asked for: plan review is removed (Martin, 2026-11-16).
 */
export function moveGate({ goal, name, to, via, reason, dir, read, probe, signedPart = false }) {
  if (goal.stage !== 'draft' || !to || to === 'draft' || to === 'dropped') return null;
  // A goal moves out of draft when it is complete; no plan review is asked for (Martin, 2026-11-16: plan review is
  // removed). A reading that exists is advice and is not looked at here.
  const lacks = partsLacks(goal, name, probe);
  if (!lacks.length) return { comment: null };
  return { refusal: `${name} is not moved to ${to} — ${lacks.length === 1 ? lacks[0] : `${lacks.length} things to repair:\n${lacks.map((line) => `  - ${line}`).join('\n')}`}` };
}

// ------------------------------------------------- what the reader is given

const UNSUPPORTED = /\b(every|only|no other)\b/iu;
const PREMISE_ID = /\bP\d+\b/u;

/**
 * The statements of the goal that say `every`, `only` or `no other` (whole words, any case) and name no premise
 * id (D3): `[{ id, text }]`, for the reader to judge whether the inventory is established. A premise is not one.
 */
export function unsupportedClaims(goal) {
  const found = [];
  const look = (id, texts) => {
    const text = texts.filter((one) => typeof one === 'string').join(' — ');
    if (UNSUPPORTED.test(text) && !PREMISE_ID.test(text)) found.push({ id, text });
  };
  const prose = (label, paragraphs) => (paragraphs ?? []).forEach((paragraph, i) => look(`${label} ${i + 1}`, [paragraph]));
  if (goal.version === 2) {
    prose('aim', goal.aim); prose('outcome', goal.outcome); prose('latitude', goal.latitude); prose('protection', goal.protection);
    for (const item of [...(goal.problem ?? []), ...(goal.decisions ?? []), ...(goal.change ?? []), ...(goal.preserve ?? []), ...(goal.risks ?? []), ...(goal.out_of_scope ?? [])]) look(item.id, Object.entries(item).filter(([key]) => key !== 'id').map(([, value]) => value));
    for (const one of goal.obligations ?? []) look(`obligation ${one.area}`, [one.text]);
  } else {
    prose('goal', goal.goal); prose('contract', goal.contract); prose('out of scope', goal.out_of_scope);
  }
  (goal.success_criteria ?? []).forEach((item, i) => look(`criterion ${i + 1}`, [item.criterion, item.check, item.evidence]));
  return found;
}

/** The prompt of the reading: the goal as `mc goal show` renders it, the areas' questions, the claims to judge. */
export function readerPrompt({ name, goal, declared, dir, checkout }) {
  const lines = [
    `Read the plan of goal ${name} before it is built. You are the plan-review role: follow your role page, answer its questions in order, and change nothing but ${REVIEW_TEXT_FILE}.`,
    `The goal's repositories at origin/main are checked out, read-only, under ${checkout}${declared.length ? ` (${declared.map((one) => `${checkout}/${one.repo}`).join(', ')})` : ''}.`,
    `Write ${join(dir, REVIEW_TEXT_FILE)} (first line OK or NOT OK), then end with mc goal plan-review ${name} verdict ok|not-ok, saying the same word.`,
    '', 'THE GOAL, as mc goal show renders it', '', renderGoalText(goal).trimEnd(), '',
    'THE DECLARED RULE AREAS OF ITS REPOSITORIES, with their questions',
  ];
  const areas = declared.flatMap((one) => one.areas.map((area) => ({ repo: one.repo, area })));
  if (!areas.length) lines.push('  none declared');
  const rules = areas.filter(({ area }) => !isSourceArea(area));
  for (const { repo, area } of rules) {
    lines.push(`  ${repo}/${area.id} — ${area.name}${area.seen === true ? ' · judged as the user sees it' : ''}`);
    if (area.page) lines.push(`    page ${checkout}/${repo}/${area.page}`);
    for (const question of area.questions) lines.push(`    when ${question.when}`, `      ask ${question.ask}`);
  }
  const stands = new Map((goal.obligations ?? []).map((one) => [one.area, one.stand]));
  const seen = rules.filter(({ repo, area }) => area.seen === true && stands.get(`${repo}/${area.id}`) === 'touched').map(({ repo, area }) => `${repo}/${area.id}`);
  if (seen.length) lines.push('', `QUESTION 8 IS ASKED: the goal stands touched on ${seen.join(', ')}, judged as the user sees it — answer it for ${seen.length === 1 ? 'that area' : 'those areas'}`);
  const sources = areas.filter(({ area }) => isSourceArea(area));
  if (sources.length) {
    lines.push('', 'THE SOURCE AREAS OF ITS REPOSITORIES, which ask no stand — read the page of each the goal touches');
    for (const { repo, area } of sources) lines.push(`  ${repo}/${area.id} — ${area.name}`, `    covers ${area.covers}`, `    page ${checkout}/${repo}/${area.page}`);
  }
  lines.push('', 'STATEMENTS THAT SAY every, only OR no other WITHOUT NAMING A PREMISE — judge whether each inventory is established');
  const claims = unsupportedClaims(goal);
  if (!claims.length) lines.push('  none');
  for (const claim of claims) lines.push(`  ${claim.id}: ${claim.text.replace(/\s*\n\s*/gu, ' ')}`);
  return lines.join('\n');
}

// ----------------------------------------------- the advisory stand (D10)

const pathTokens = (where) => String(where).split(/[\s,;()]+/u).map((token) => token.replace(/:\d[\d,-]*$/u, '').replace(/[.:]+$/u, '')).filter((token) => token.includes('/'));
const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`);

/**
 * The stand `mc goal areas` proposes for an area with none: `touched`, naming the change items, when a token of
 * a change item's `where` that holds a slash is a path under one of the area's paths or a directory above one;
 * otherwise `untouched`; nothing for a source area, which asks no stand. Advisory: nothing reads it back.
 */
export function proposedStand(goal, repo, area) {
  if (isSourceArea(area)) return null;
  const items = [];
  for (const item of goal.change ?? []) {
    const hit = pathTokens(item.where ?? '').some((raw) => {
      const token = raw.startsWith(`${repo}/`) ? raw.slice(repo.length + 1) : raw;
      return area.paths.some((path) => within(token, path) || within(path, token));
    });
    if (hit) items.push(item.id);
  }
  return items.length ? { stand: 'touched', items } : { stand: 'untouched', items: [] };
}

/** The proposal as the line under an area. */
export function proposedWords(proposal) {
  return proposal.stand === 'touched'
    ? `  proposed stand: touched — ${proposal.items.join(', ')} change${proposal.items.length === 1 ? 's' : ''} a path of the area (advisory)`
    : '  proposed stand: untouched — no change item names a path of the area (advisory)';
}

// ----------------------------------------------------------- the model

/**
 * The author's model: `--avoid <tool>:<model>` when given (split at the first colon) names the draft's author
 * whoever calls; else the caller's `MC_TOOL` and `MC_MODEL` (an interactive session has neither, and a person's
 * tool is `person`); else unknown (`null`).
 */
export function authorOf(env, avoid) {
  if (avoid) {
    const colon = avoid.indexOf(':');
    if (colon > 0 && colon < avoid.length - 1) return { tool: avoid.slice(0, colon), model: avoid.slice(colon + 1) };
  }
  if (env.MC_TOOL && env.MC_TOOL !== 'person' && env.MC_MODEL) return { tool: env.MC_TOOL, model: env.MC_MODEL };
  return null;
}

/**
 * The reader walk: the candidate a reading runs on. The review list with the author's model taken out is asked
 * of `chooseCandidate` first; only when that list answers that nothing can run is the whole list asked, so the
 * author's model is last. 'Can run' is what `chooseCandidate` answers, its API reserve included, and a candidate
 * whose tool cannot launch or whose billing route answers `unavailable` is set aside with its reason and the
 * choice is asked again without it (`fallThrough`; with it false the first such candidate ends the walk).
 *
 * The review list's first candidate is its first choice while it is in the list asked; once it is set aside the
 * list is asked with `first` null, so no other candidate is promoted to first choice.
 *
 * Returns `{ ok: true, candidate, answer, billing, launched, setAside }`, or `{ ok: false, reason, failed, setAside }`
 * where `failed` marks a walk ended by a candidate's billing or launch refusal and `reason` is the choice's answer
 * when none can run. Pure: it writes nothing, so the runner asks it too (the unread record's wait).
 */
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

/** The choice `readerWalk` makes, as `chooseCandidate` answers it: `{ ok: true, candidate, … }` or `{ ok: false, reason }`. */
export function chooseReader({ catalog, capacity, now, author, choose = chooseCandidate, launchable }) {
  const walked = readerWalk({ catalog, capacity, now, author, choose, launch: (tool) => ({ ok: launchable ? launchable(tool) : true }), billing: () => ({ billing: 'plan', why: '' }) });
  return walked.ok ? walked.answer : { ok: false, reason: walked.reason };
}

/** The unread record for the goal's current text (`hash`), or null: another text's record, or one that does not parse, is absent. */
/** The reasons an unread record names, as the call wrote them: each candidate set aside, then the walk's own reason. */
export function unreadReasons(record) {
  const aside = Array.isArray(record?.set_aside) ? record.set_aside.map((one) => `${one.tool} ${one.model}: ${one.reason ?? one.why ?? '—'}`) : [];
  return [...aside, record?.reason].filter(Boolean).join('; ') || '—';
}

export function unreadFor(dir, read, hash) {
  const record = jsonOrNull(read(join(dir, UNREAD_FILE)) ?? '');
  return record && typeof record === 'object' && record.hash === hash ? record : null;
}

// -------------------------------------------------- the throwaway checkout

/** The repositories at `origin/main` into `dir/<repo>`, each as `git archive` writes it (no repository metadata). */
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

/** The checkout the call made, writable again and removed. */
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

/** Do not follow a replacement symlink when proving the directory belongs to this call. */
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

const jsonOrNull = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** The launch in the goal's directory: `{ launch }`, `{ none: true }` or `{ problem }` for a file that is not one. */
function readLaunch(dir, read, file = LAUNCH_FILE) {
  const text = read(join(dir, file));
  if (text === null) return { none: true };
  const launch = jsonOrNull(text);
  return launch && typeof launch === 'object' ? { launch } : { problem: `${join(dir, file)} is not a launch record` };
}

/** Whether a launch is live: its pid runs and its start is within the limit. */
function liveLaunch(launch, now, alive, limit = LIMIT_MS) {
  const start = Date.parse(launch.start);
  return Number.isInteger(launch.pid) && alive(launch.pid) && Number.isFinite(start) && now.getTime() >= start && now.getTime() - start < limit;
}

// ------------------------------------------------------------ the call

/**
 * `mc goal plan-review <p>/<g> [--avoid <tool>:<model>]` — one reading (D8, D9). `refusal` is what `refusedMove`
 * says of the caller moving this goal from draft to build (null: the caller may); `declarations` is the goal's
 * repositories' declared areas (`{ declared }` or `{ error }`). Exit 0 for OK, 1 for not OK, no verdict or changed
 * files, 2 for a call refused, which launches nothing, and 3 when no reader could run: nothing was read, and the call
 * writes `.plan-review-unread.json` (the text's hash, the author, each candidate set aside with its reason) instead of a
 * reading; the two readings per stay in draft are not consumed.
 */
export async function planReviewCall({ target, goal, avoid, refusal, declarations, ctx, deps = {} }) {
  const { stdout, stderr, env, read, write } = ctx;
  const refuse = (text) => { stderr.write(`mc: plan-review ${target.name}: ${text}\n`); return 2; };
  if (refusal) return refuse(refusal);
  if (goal.stage !== 'draft') return refuse(`it is in ${goal.stage}; a plan review is for a goal in draft`);
  const { records, problem } = readRecords(target.dir, read);
  if (problem) return refuse(problem);
  const state = readingState(records, goalHash(goal));
  if (state.readings.length >= MAX_READINGS) return refuse(`${state.readings.length} readings are stored since it entered draft — a third round is the author's decision: mc goal stage ${target.name} build --reason "…"`);
  if (env.MC_ROLE === 'learning' && state.readings.length >= 1) return refuse('the learning role runs one reading per goal it wrote; it stays in draft with its PLAN-REVIEW.md for the plan');
  if (avoid !== null && !authorOf({}, avoid)) return refuse('--avoid is <tool>:<model>');
  if (declarations.error) return refuse(`the declared rule areas cannot be read: ${declarations.error}`);

  return readerCall({ target, ctx, deps, policy: {
    kind: 'plan-review', role: PLAN_REVIEW_ROLE, launchFile: LAUNCH_FILE, reviewFile: REVIEW_TEXT_FILE,
    limitMs: LIMIT_MS, limitWords: 'twenty minutes', invalidExit: 1, fallThrough: true, unreadFile: UNREAD_FILE,
    hash: goalHash(goal), round: state.readings.length + 1, author: authorOf(env, avoid),
    checkoutName: `mc-plan-review-${target.programme}-${target.goal}-r${state.readings.length + 1}`,
    identity: { MC_GOAL: target.name }, tokenEnv: 'MC_PLAN_REVIEW_TOKEN', runName: `goal:${target.name}`,
    repos: declarations.declared, names: [GOAL_FILE, LOG_FILE, HOLD_FILE],
    prompt: (checkout) => readerPrompt({ name: target.name, goal, declared: declarations.declared, dir: target.dir, checkout }),
    beforeSession: (round) => {
      if (round > 1) {
        const earlier = read(join(target.dir, REVIEW_TEXT_FILE));
        if (earlier !== null) write(join(target.dir, `PLAN-REVIEW-${round - 1}.md`), earlier);
      }
    },
    store: ({ verdict, hash, round, candidate, author, at }) => {
      appendRecord(target.dir, { kind: 'reading', verdict, hash, round, tool: candidate.tool, model: candidate.model, author, at: at.toISOString() }, { read, write });
      const path = join(target.dir, REVIEW_TEXT_FILE);
      appendEntry({ dir: target.dir, entry: { at: logStamp(at), tool: candidate.tool, model: candidate.model, role: PLAN_REVIEW_ROLE, stage: goal.stage, status: goal.status, done: `plan review round ${round}: ${verdictWord(verdict)}`, comment: `${candidate.tool} ${candidate.model}, judged text ${hash.slice(0, 12)}; ${path}`, next: null }, read, write });
    },
  } });
}

/** Shared adapter-based reader launch. Bindings own their state, prompt and persistence, not routing or cleanup. */
export async function readerCall({ target, ctx, deps = {}, policy }) {
  const { stdout, stderr, env, read, write } = ctx;
  const { kind, role: roleName, launchFile, reviewFile, limitMs, limitWords, invalidExit, hash, round, author, names } = policy;
  const refuse = (text) => { stderr.write(`mc: ${kind} ${target.name}: ${text}\n`); return 2; };
  const now = deps.now ?? (() => new Date());
  const alive = deps.alive ?? ctx.alive ?? pidAlive;
  const lockRoot = workRoot(env);
  const lock = deps.lock ?? ctx.lock;
  const pid = deps.pid ?? process.pid;
  // A dead call may leave its tree behind without recording a reading. Never reuse or remove that tree.
  const checkoutId = (deps.checkoutId ?? randomUUID)();
  const checkout = join(deps.tmp ?? tmpdir(), `${policy.checkoutName}-${checkoutId}`);
  const exists = deps.exists ?? existsSync;
  if (exists(checkout)) return refuse(`${checkout} exists and this call did not make it — nothing is launched and nothing removed`);

  // The role, then the candidate: the walk (readerWalk) sets aside a candidate that cannot launch or bill and asks the
  // next, the author's model last. Nothing is written before a candidate is chosen.
  const role = (deps.role ?? readCanonRole)(roleName);
  if (!role?.overlay) { stderr.write(`mc: ${kind} ${target.name}: the ${roleName} role is missing\n`); return invalidExit; }
  // A live launch refuses any claim; the reason is the claim's own words.
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
    // No reader: nothing was read. The unread record is written under the claim, never beside a live launch.
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

  // The claim: one launch at a time, a dead or expired one closed as no reading.
  const token = (deps.token ?? (() => randomBytes(24).toString('hex')))();
  const started = now();
  const claimed = lock(lockRoot, () => {
    const problem = runningRefusal(readLaunch(target.dir, read, launchFile)) ?? policy.check?.();
    if (problem) return { refused: problem };
    write(join(target.dir, launchFile), `${JSON.stringify({ binding: target.name, role: roleName, round, hash, token_sha256: sha256(token), pid, start: started.toISOString(), tool: candidate.tool, model: candidate.model, author }, null, 2)}\n`);
    // A launch supersedes an earlier unread record: the draft is read, so it is no longer waiting for a reader.
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
      // A tool that takes the checkout as an allowed directory declares where its argument goes.
      const allowed = requireCapability(launched.id, 'ALLOWED_DIR');
      const at = allowed ? args.indexOf(allowed.before) : -1;
      if (at > 0) args.splice(at, 0, allowed.flag, checkout);
      const spawned = gatewayLaunch({ provider: requireCapability(launched.id, 'BILLING_PROVIDER'), model: candidate.model, bin: launched.spec.bin, args, billing: billing.billing });
      const childEnv = withoutSessionIdentity(env);
      for (const key of ['MC_REPO', 'MC_WORKAREA', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR', 'MC_REVIEW_SEEN', 'MC_REVIEW_WRITE_BACK', 'MC_SESSION_STARTED', 'MC_SCRATCH', 'MC_PLAN_REVIEW_TOKEN', 'MC_PROGRAMME_REVIEW_TOKEN']) delete childEnv[key];
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

  // What the turn left: the launch record's verdict, and whether the goal's own files stayed as they were.
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

// ----------------------------------------------------------- the verdict

/**
 * `mc goal plan-review <p>/<g> verdict ok|not-ok` — accepted only from the session the call launched: MC_ROLE
 * `plan-review`, MC_GOAL the launch's goal, a token whose sha256 is the launch record's while the launch is live,
 * and a PLAN-REVIEW.md written since the launch whose first line says the same verdict. It writes the verdict onto
 * the launch record and nothing else. Exit 0, or 2 with the reason.
 */
export function verdictVerb({ target, word, ctx, deps = {} }) {
  return readerVerdict({ target, word, ctx, deps, policy: {
    kind: 'plan-review', role: PLAN_REVIEW_ROLE, launchFile: LAUNCH_FILE, reviewFile: REVIEW_TEXT_FILE,
    tokenEnv: 'MC_PLAN_REVIEW_TOKEN', identityKey: 'MC_GOAL', identityLabel: 'goal',
    limitMs: LIMIT_MS, limitWords: 'twenty minutes',
  } });
}

/** Token, live-call and report checks shared by goal and programme readings. */
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


// ---------------------------------------------------- programme binding

export const PROGRAMME_REVIEW_ROLE = 'programme-review';
export const PROGRAMME_REVIEW_FILE = 'PROGRAMME-REVIEW.md';
export const PROGRAMME_REVIEW_RECORD = '.programme-review.json';
export const PROGRAMME_REVIEW_LAUNCH = '.programme-review-launch.json';
export const PROGRAMME_REVIEW_LIMIT_MS = 30 * 60_000;

/** The signed report format, not a judgement of its findings. */
export function programmeReport(text) {
  if (typeof text !== 'string') return null;
  const [verdict, count] = text.split(/\r?\n/u);
  const findings = /^findings: (\d+)$/u.exec(count ?? '');
  if (!['OK', 'NOT OK'].includes(verdict) || !findings || !Number.isSafeInteger(Number(findings[1]))) return null;
  return { verdict: verdict === 'OK' ? 'ok' : 'not-ok', findings: Number(findings[1]) };
}

/** A current reading includes the report it recorded, so an unsuccessful newer call cannot substitute its report. */
export function currentProgrammeReading(dir, text, read = readTextOrNull, { anyText = false } = {}) {
  const meta = jsonOrNull(read(join(dir, PROGRAMME_REVIEW_RECORD)));
  const report = read(join(dir, PROGRAMME_REVIEW_FILE));
  const parsed = programmeReport(report);
  // anyText: the desk's sign — a reading of an earlier text still counts; edits made with Martin at the desk need no new reading.
  if (anyText && meta) meta.earlier = meta.hash !== sha256(text);
  if (!meta || !parsed || (!anyText && meta.hash !== sha256(text)) || meta.report_sha256 !== sha256(report)
    || meta.verdict !== parsed.verdict || meta.findings !== parsed.findings || !Number.isFinite(Date.parse(meta.at))) return null;
  return meta;
}

/** Only named, known repositories are exported. Never interpret a README entry as an arbitrary disk path. */
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

/** One programme reading, uncapped, bound to README bytes rather than goal records or draft rounds. */
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
