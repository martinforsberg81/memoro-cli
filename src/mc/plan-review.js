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

import { resolveLaunch } from '../adapters/index.js';
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
import { scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { withoutSessionIdentity } from './session-role.js';
import { pidAlive } from './status-collect.js';

export const PLAN_REVIEW_ROLE = 'plan-review';
export const RECORDS_FILE = '.plan-review.json';
export const LAUNCH_FILE = '.plan-review-launch.json';
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
    const bare = read.declared.flatMap((one) => one.areas.map((area) => `${one.repo}/${area.id}`)).filter((id) => !taken.has(id));
    if (bare.length) lacks.push(`no stand on ${bare.join(', ')} — mc goal obligation set ${name} <area> --stand touched|untouched --text "…" (mc goal areas ${name} lists them)`);
  }
  for (const one of obligations) {
    if (!one.standard) continue;
    const [repo, path] = standardPath(one.standard);
    const found = probe.onMain(repo, path);
    if (found.state === 'absent') lacks.push(`the stand on ${one.area} names ${one.standard}, and ${path} is not on origin/main of ${repo}`);
    else if (found.state !== 'present') lacks.push(`cannot tell whether ${path} is on origin/main of ${repo} (the standard of ${one.area}): ${found.why ?? 'no answer'}`);
  }
  return lacks;
}

// ------------------------------------------------------------------ the gate

/**
 * The check on a forward move out of draft. `null` when the move is not one it is held to (the goal is not in
 * draft, the move is to draft or `dropped`); else `{ lacks }` empty and `{ comment }` when the move is allowed
 * by `--reason` after two readings, or `{ refusal }` — the text for stderr, every lack in it.
 * `via` is `stage` or `log`: only the stage verb takes a reason.
 */
export function moveGate({ goal, name, to, via, reason, dir, read, probe }) {
  if (goal.stage !== 'draft' || !to || to === 'draft' || to === 'dropped') return null;
  const hash = goalHash(goal);
  const { records, problem } = readRecords(dir, read);
  if (problem) return { refusal: `${name} is not moved to ${to} — ${problem}` };
  const state = readingState(records, hash);
  const lacks = partsLacks(goal, name, probe);
  const why = reason && String(reason).trim() ? String(reason).trim() : null;
  let comment = null;
  if (state.status !== 'ok') {
    const second = state.readings.length >= MAX_READINGS;
    if (second && via === 'stage' && why) {
      comment = `${why} — moved without an OK reading after ${state.readings.length} readings: ${state.readings.map((one, i) => `round ${i + 1} ${verdictWord(one.verdict)}${one.hash === hash ? '' : ' (an earlier text)'}`).join(', ')}`;
    } else {
      const route = second
        ? (via === 'stage' ? ` — two readings are stored: the author decides with mc goal stage ${name} ${to} --reason "…"` : ` — two readings are stored, and mc goal log --stage takes no reason: the author decides with mc goal stage ${name} ${to} --reason "…"`)
        : '';
      const again = `mc goal plan-review ${name}`;
      if (state.status === 'none') lacks.push(`no plan review has read it — ${again}${route}`);
      else if (state.status === 'not-ok') lacks.push(`the plan review of round ${state.round} answered NOT OK — repair what ${REVIEW_TEXT_FILE} names and read it again with ${again}${route}`);
      else lacks.push(`the text changed after an OK (round ${state.round}) — read it again with ${again}${route}`);
    }
  }
  if (!lacks.length) return { comment };
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
    `Read the plan of goal ${name} before it is built. You are the plan-review role: follow your role page, answer its seven questions in order, and change nothing but ${REVIEW_TEXT_FILE}.`,
    `The goal's repositories at origin/main are checked out, read-only, under ${checkout}${declared.length ? ` (${declared.map((one) => `${checkout}/${one.repo}`).join(', ')})` : ''}.`,
    `Write ${join(dir, REVIEW_TEXT_FILE)} (first line OK or NOT OK), then end with mc goal plan-review ${name} verdict ok|not-ok, saying the same word.`,
    '', 'THE GOAL, as mc goal show renders it', '', renderGoalText(goal).trimEnd(), '',
    'THE DECLARED RULE AREAS OF ITS REPOSITORIES, with their questions',
  ];
  const areas = declared.flatMap((one) => one.areas.map((area) => ({ repo: one.repo, area })));
  if (!areas.length) lines.push('  none declared');
  for (const { repo, area } of areas) {
    lines.push(`  ${repo}/${area.id} — ${area.name}`);
    for (const question of area.questions) lines.push(`    when ${question.when}`, `      ask ${question.ask}`);
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
 * otherwise `untouched`. Advisory: nothing reads it back.
 */
export function proposedStand(goal, repo, area) {
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
 * The author's model: the caller's `MC_TOOL` and `MC_MODEL` (an interactive session has neither, and a person's
 * tool is `person`), else `--avoid <tool>:<model>` (split at the first colon), else unknown (`null`).
 */
export function authorOf(env, avoid) {
  if (env.MC_TOOL && env.MC_TOOL !== 'person' && env.MC_MODEL) return { tool: env.MC_TOOL, model: env.MC_MODEL };
  if (avoid) {
    const colon = avoid.indexOf(':');
    if (colon > 0 && colon < avoid.length - 1) return { tool: avoid.slice(0, colon), model: avoid.slice(colon + 1) };
  }
  return null;
}

/**
 * The reader's candidate (D13): the review list with the author's model taken out of it, asked of
 * `chooseCandidate`; only when that list is empty or answers that nothing can run is the whole list asked.
 * 'Can run' is what `chooseCandidate` answers, its API reserve included.
 */
export function chooseReader({ catalog, capacity, now, author, choose = chooseCandidate }) {
  const priority = catalog.providerPriority ?? 'auto';
  const ask = (review) => choose({ cls: 'review', catalog: { ...catalog, review }, capacity, now, priority });
  const others = author ? catalog.review.filter((one) => !(one.model === author.model && one.tool === author.tool)) : catalog.review;
  if (others.length && others.length < catalog.review.length) {
    const answer = ask(others);
    if (answer?.ok && answer.candidate) return answer;
  }
  return ask(catalog.review);
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
function realDiscard(dir, identity) {
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
function checkoutIdentity(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('the checkout identity is not a directory');
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function appendRun(row, env) {
  const path = deskRunsPath(env);
  mkdirSync(join(runnerDir(env), 'log'), { recursive: true });
  appendFileSync(path, `${existsSync(path) ? '' : `${tsvHeader()}\n`}${tsvRow(row)}\n`);
}

async function realSession({ bin, args, ...options }) {
  const result = await runTool(bin, args, options);
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return { ...result, status: timedOut ? TIMEOUT_EXIT : result.status ?? 1, timedOut, stderr: result.stderr || result.error?.message || '' };
}

const jsonOrNull = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** The launch in the goal's directory: `{ launch }`, `{ none: true }` or `{ problem }` for a file that is not one. */
function readLaunch(dir, read) {
  const text = read(join(dir, LAUNCH_FILE));
  if (text === null) return { none: true };
  const launch = jsonOrNull(text);
  return launch && typeof launch === 'object' ? { launch } : { problem: `${join(dir, LAUNCH_FILE)} is not a launch record` };
}

/** Whether a launch is live: its pid runs and its start is within the limit. */
function liveLaunch(launch, now, alive) {
  const start = Date.parse(launch.start);
  return Number.isInteger(launch.pid) && alive(launch.pid) && Number.isFinite(start) && now.getTime() - start < LIMIT_MS;
}

// ------------------------------------------------------------ the call

/**
 * `mc goal plan-review <p>/<g> [--avoid <tool>:<model>]` — one reading (D8, D9). `refusal` is what `refusedMove`
 * says of the caller moving this goal from draft to build (null: the caller may); `declarations` is the goal's
 * repositories' declared areas (`{ declared }` or `{ error }`). Exit 0 for OK, 1 for not OK, no verdict or changed
 * files, 2 for a call refused, which writes and launches nothing.
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

  const now = deps.now ?? (() => new Date());
  const alive = deps.alive ?? ctx.alive ?? pidAlive;
  const lockRoot = workRoot(env);
  const lock = deps.lock ?? ctx.lock;
  const pid = deps.pid ?? process.pid;
  const hash = goalHash(goal);
  const round = state.readings.length + 1;
  const author = authorOf(env, avoid);
  // A dead call may leave its tree behind without recording a reading. Never reuse or remove that tree.
  const checkoutId = (deps.checkoutId ?? randomUUID)();
  const checkout = join(deps.tmp ?? tmpdir(), `mc-plan-review-${target.programme}-${target.goal}-r${round}-${checkoutId}`);
  const exists = deps.exists ?? existsSync;
  if (exists(checkout)) return refuse(`${checkout} exists and this call did not make it — nothing is launched and nothing removed`);

  // The model, the tool, the role and the billing route: what can fail without a launch, before one is written.
  const candidateOf = () => {
    if (deps.route) return deps.route('review');
    const catalog = deps.catalog ?? readModels(env);
    const capacity = deps.capacity ?? readCapacity({ root: runnerDir(env) });
    return chooseReader({ catalog, capacity, now: now(), author, choose: deps.choose });
  };
  let route;
  try { route = candidateOf(); } catch (error) { route = { ok: false, reason: error.message || String(error) }; }
  if (!route?.ok || !route.candidate) { stderr.write(`mc: plan-review ${target.name}: no review candidate can run — ${route?.reason || 'no answer'}\n`); return 1; }
  const candidate = route.candidate;
  const launched = (deps.launch ?? resolveLaunch)(candidate.tool);
  if (!launched?.ok) { stderr.write(`mc: plan-review ${target.name}: ${launched?.hint || launched?.reason || `${candidate.tool} is unavailable`}\n`); return 1; }
  const role = (deps.role ?? readCanonRole)(PLAN_REVIEW_ROLE);
  if (!role?.overlay) { stderr.write(`mc: plan-review ${target.name}: the plan-review role is missing\n`); return 1; }
  const billing = (deps.billingRoute ?? billingRouteNow)(candidate.tool, { env, now: now(), route: { billing: route.billing, why: route.why } });
  if (billing.billing === 'unavailable') { stderr.write(`mc: plan-review ${target.name}: ${billing.why}\n`); return 1; }

  // The claim: one launch at a time, a dead or expired one closed as no reading.
  const token = (deps.token ?? (() => randomBytes(24).toString('hex')))();
  const started = now();
  const claimed = lock(lockRoot, () => {
    const existing = readLaunch(target.dir, read);
    if (existing.problem) return { refused: existing.problem };
    if (existing.launch && liveLaunch(existing.launch, now(), alive)) return { refused: `a reading of round ${existing.launch.round ?? '?'} is running (pid ${existing.launch.pid}, since ${existing.launch.start})` };
    write(join(target.dir, LAUNCH_FILE), `${JSON.stringify({ round, hash, token_sha256: sha256(token), pid, start: started.toISOString(), tool: candidate.tool, model: candidate.model, author }, null, 2)}\n`);
    return {};
  }, { strict: true, name: 'plan-review-claim' });
  if (claimed.refused) return refuse(claimed.refused);

  const names = [GOAL_FILE, LOG_FILE, HOLD_FILE];
  const before = Object.fromEntries(names.map((file) => [file, read(join(target.dir, file))]));
  const discard = deps.discard ?? realDiscard;
  let made = false;
  let identity = null;
  const closeLaunch = () => { try { (deps.remove ?? ctx.remove)(join(target.dir, LAUNCH_FILE)); } catch { /* none left */ } };
  let result = null;
  let summary = null;
  let verdict = null;
  let note = null;
  try {
    try { mkdirSync(checkout, { recursive: false }); made = true; identity = checkoutIdentity(checkout); } catch (error) { note = `the checkout could not be made: ${error.message}`; }
    if (made && !note) {
      const done = (deps.checkout ?? realCheckout)({ repos: declarations.declared.map((one) => ({ repo: one.repo, path: one.path })), dir: checkout });
      if (!done?.ok) note = done?.reason || 'the checkout failed';
    }
    if (!note) {
      if (round > 1) {
        const earlier = read(join(target.dir, REVIEW_TEXT_FILE));
        if (earlier !== null) write(join(target.dir, `PLAN-REVIEW-${round - 1}.md`), earlier);
      }
      stdout.write(`mc: plan-review ${target.name}: round ${round} on ${candidate.tool} ${candidate.model}${author ? ` — the author is ${author.tool} ${author.model}${candidate.model === author.model && candidate.tool === author.tool ? ' (no other model could run)' : ''}` : ' — the author\'s model is unknown, none excluded'}\n`);
      const prompt = readerPrompt({ name: target.name, goal, declared: declarations.declared, dir: target.dir, checkout });
      const args = headlessArgs({ toolId: launched.id, adapter: launched.adapter, model: candidate.model, effort: candidate.effort,
        instructions: instructionsFor(launched.id, role.overlay), prompt, profileArgs, stream: false, cache: role.cache });
      const at = args.indexOf('--permission-mode');
      if (launched.id === 'claude' && at > 0) args.splice(at, 0, '--add-dir', checkout);
      const spawned = gatewayLaunch({ provider: candidate.tool, model: candidate.model, bin: launched.spec.bin, args, billing: billing.billing });
      const childEnv = withoutSessionIdentity(env);
      for (const key of ['MC_REPO', 'MC_WORKAREA', 'MC_REVIEW_HEAD', 'MC_REVIEW_PR', 'MC_SESSION_STARTED', 'MC_SCRATCH']) delete childEnv[key];
      Object.assign(childEnv, { MC_ROLE: PLAN_REVIEW_ROLE, MC_HEADLESS: '1', MC_GOAL: target.name, MC_TOOL: candidate.tool, MC_MODEL: candidate.model, MC_PLAN_REVIEW_TOKEN: token });
      try { result = await (deps.session ?? realSession)({ ...spawned, cwd: target.dir, env: scrubProviderApiKeysFromEnv(childEnv), timeoutMs: LIMIT_MS, group: true }); }
      catch (error) { result = { status: 1, stdout: '', stderr: error.message || String(error) }; }
      summary = readSessionOutput({ toolId: launched.id, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status, timedOut: result.timedOut, now: now(), model: candidate.model });
    }
  } finally {
    if (made) {
      try { discard(checkout, identity); }
      catch (error) {
        note = `the checkout ${checkout} is left in place — ${error.message}`;
        stderr.write(`mc: plan-review ${target.name}: ${note}\n`);
      }
    }
  }

  // What the turn left: the launch record's verdict, and whether the goal's own files stayed as they were.
  const launch = readLaunch(target.dir, read).launch ?? null;
  verdict = launch && (launch.verdict === 'ok' || launch.verdict === 'not-ok') ? launch.verdict : null;
  const changed = names.filter((file) => read(join(target.dir, file)) !== before[file]);
  closeLaunch();
  let code;
  if (note) { stderr.write(`mc: plan-review ${target.name}: no reading — ${note}\n`); code = 1; }
  else if (changed.length) { note = `${changed.join(', ')} changed during the reading`; stderr.write(`mc: plan-review ${target.name}: no reading stored — ${note}\n`); code = 1; }
  else if (result?.timedOut || !verdict) { note = result?.timedOut ? 'the reading exceeded twenty minutes' : `the session ended without a verdict (exit ${result?.status ?? 1})`; stderr.write(`mc: plan-review ${target.name}: no reading stored — ${note}\n`); code = 1; }
  else {
    const at = now();
    appendRecord(target.dir, { kind: 'reading', verdict, hash, round, tool: candidate.tool, model: candidate.model, author, at: at.toISOString() }, { read, write });
    const path = join(target.dir, REVIEW_TEXT_FILE);
    appendEntry({ dir: target.dir, entry: { at: logStamp(at), tool: candidate.tool, model: candidate.model, role: PLAN_REVIEW_ROLE, stage: goal.stage, status: goal.status, done: `plan review round ${round}: ${verdictWord(verdict)}`, comment: `${candidate.tool} ${candidate.model}, judged text ${hash.slice(0, 12)}; ${path}`, next: null }, read, write });
    stdout.write(`mc: plan-review ${target.name}: ${verdictWord(verdict)} (round ${round}) — ${path}\n`);
    code = verdict === 'ok' ? 0 : 1;
  }
  if (summary) {
    const row = { ...summary, ts: now().toISOString(), name: `goal:${target.name}`, kind: 'plan-review', exit: result?.status ?? 1,
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
  const { stdout, stderr, env, read, write } = ctx;
  const refuse = (text) => { stderr.write(`mc: plan-review verdict: ${text}\n`); return 2; };
  if (word !== 'ok' && word !== 'not-ok') return refuse('the verdict is ok or not-ok');
  if (env.MC_ROLE !== PLAN_REVIEW_ROLE) return refuse('only the plan-review session a call launched records a verdict');
  if (env.MC_GOAL !== target.name) return refuse(`this session reads ${env.MC_GOAL || 'no goal'}, not ${target.name}`);
  const token = env.MC_PLAN_REVIEW_TOKEN;
  if (!token) return refuse('no launch token in this session');
  const found = readLaunch(target.dir, read);
  if (found.none) return refuse(`${target.name} has no reading in progress`);
  if (found.problem) return refuse(found.problem);
  const launch = found.launch;
  if (launch.token_sha256 !== sha256(token)) return refuse('the token is not the one this reading was launched with');
  const now = (deps.now ?? ctx.now);
  const current = typeof now === 'function' ? now() : now;
  if (!liveLaunch(launch, current, deps.alive ?? ctx.alive ?? pidAlive)) return refuse('the reading is not live: its call has ended or its twenty minutes have passed');
  if (launch.verdict) return refuse(`a verdict is already recorded (${launch.verdict})`);
  const path = join(target.dir, REVIEW_TEXT_FILE);
  const text = read(path);
  if (text === null) return refuse(`${path} is not written`);
  const modified = (deps.mtime ?? ((file) => { try { return statSync(file).mtimeMs; } catch { return null; } }))(path);
  if (modified === null || modified < Date.parse(launch.start)) return refuse(`${path} was not written in this round — write it, then record the verdict`);
  const first = text.split('\n', 1)[0].trim();
  if (first !== verdictWord(word)) return refuse(`${path} starts with "${first}", and the verdict is ${verdictWord(word)} — the first line is OK or NOT OK, the same word`);
  write(join(target.dir, LAUNCH_FILE), `${JSON.stringify({ ...launch, verdict: word }, null, 2)}\n`);
  stdout.write(`mc: plan-review verdict ${verdictWord(word)} recorded for ${target.name}\n`);
  return 0;
}
