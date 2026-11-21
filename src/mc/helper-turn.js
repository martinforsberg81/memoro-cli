/**
 * `mc helper --intake` — the model half: one headless turn that reads **one
 * file** from the inbox and writes a proposal or nothing, and nothing else.
 *
 * `~/mc/intake/` is an inbox. The collect step (`helper-collect.js`) puts one
 * digest a day per repository in it without a model, and Martin puts whatever
 * he has in it by hand. This is the turn that empties it one file at a time: a
 * fresh, headless session with the `intake` role from `canon/roles/intake.md`,
 * standing in `~/mc/intake/`, given one filename and asked for one outcome —
 * one `<date>-<system>-<slug>.md` in the `proposals/` of the area it concerns
 * (`~/mc/areas/<repo>/<area>/proposals/`, area-proposals.js) — or none.
 *
 * `drainIntake` at the bottom is what makes that an inbox rather than a pile:
 * the oldest files, one turn each, every one archived under
 * `~/mc/runner/log/intake/<date>/` the moment its turn ends, repeated round
 * after round until nothing is left. `mc run` and `mc helper --intake` both go
 * through it, so there is one drain and one archive rather than two.
 *
 * The verb has no other half: `~/mc/helper/` holds the retired desk's old
 * conversations, and the desk is `mc martin` (`commands/helper.js`).
 * The turn writes into an area's `proposals/`, where the proposal waits until someone takes a stand on it.
 *
 * The file is **named**, not inlined. Everything else the turn judges against
 * is in the prompt — the project log, every plan on main with the step it is
 * on, and the proposals already waiting — because the repositories are
 * elsewhere on the disk and a turn that cannot reach them cannot accidentally
 * write in them either. The file itself is the exception, and it has to be:
 * a screenshot has no text to inline, and the inbox is defined by Martin being
 * able to drop anything in it. It is in the directory the turn stands in, so
 * naming it is enough. What it may write is one directory, and the role says
 * so in the same words as this comment.
 *
 * A proposal is not a plan and not a queue entry. It waits in its area's
 * `proposals/` until a stand is taken on it; one with no clear area goes to
 * `memoro-cli/system` or `memoro/delivery`; mc reads only its name. The turn
 * reads no archive: judging a proposal against the ones already declined is
 * whoever decides it.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { registerForeground } from './foreground.js';
import { withoutSessionIdentity } from './session-role.js';
import { readModels } from './model-config.js';
import { readCapacity } from './model-capacity.js';
import { chooseCandidate } from './model-choice.js';
import { runnerDir, workRoot } from './paths.js';
import { realLock } from './runner-lock.js';
import { declared, requireCapability, resolveLaunch, toolShortName } from '../adapters/index.js';
import { billingRouteNow, gatewayLaunch } from './billing-route.js';
import { scrubProviderApiKeysFromEnv } from './runtime-secrets.js';
import { defaultRepos, proposalSystem } from './brief-collect.js';
import { FINISHED, programsGoals } from './goals.js';
import { runAsync as runGitAsync } from './git.js';
import { intakeArchiveDir, intakeDir, programmeNames } from './helper-collect.js';
import { areaKeysOnDisk, declaredAreaKeys, listAllProposals, placementWords } from './area-proposals.js';
import { AREAS_PATH, checkAreas } from './areas.js';
import { programsHome } from './paths.js';
import { profileArgs } from './portrait.js';
import { catalogSuggestion } from './intake-catalog.js';
import { gitDirOf } from './repos.js';
import { instructionsFor, readCanonRole } from './roles.js';
import { headlessArgs, intakeQueue, INTAKE_PER_ROUND, readSessionOutput, sessionFinished, TIMEOUT_EXIT } from './run-plan.js';
import { quotaFields, refusePlanOnRead } from './plan-refusal.js';

/** One turn over one file. Ten minutes is four times the longest measured. */
export const DEFAULT_TURN_MINUTES = 10;

/**
 * The role this turn wears. It is `intake`; the turn's live record keeps the
 * verb `helper`, which the page's intake panel reads.
 */
export const INTAKE_ROLE = 'intake';

/** The project log the turn is given, if the repository that keeps one is here. */
export const PROJECT_LOG = join('docs', 'project', 'project_log.md');

/* ------------------------------------------------------------------ prompt */

const clip = (text, max = 110) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * Which system a file in the inbox belongs to, when its name says so. The
 * collector's own digests do — `errors-<repo>-<date>.md`, and the unprefixed
 * `errors-<date>.md` from before memoro-cli had a digest of its own. Anything
 * a person dropped in does not, and gets `null`: the turn decides that one
 * from what it reads, which is the only reader that can.
 */
export function repoOfFile(file) {
  const name = basename(String(file || ''));
  const match = /^errors-(memoro-cli|memoro)-\d{4}-\d{2}-\d{2}\.md$/u.exec(name);
  if (match) return match[1];
  return /^errors-\d{4}-\d{2}-\d{2}\.md$/u.test(name) ? 'memoro' : null;
}

/**
 * What the turn is told: the name of the one file that is its business, and
 * the ground to judge it against — what is already planned, what was already
 * closed, and what is already proposed.
 *
 * The file is named rather than inlined. It sits in the directory the turn
 * stands in, so a name is enough to open it, and it is the only form that
 * works for a file that is not text.
 */
export function helperPrompt({
  file, areas = [], env = process.env, programmes = [], projectLog = null, goals = [], proposals = [], repo = null, now = new Date(),
}) {
  const tagOf = (repo) => (repo === 'memoro-cli' ? 'mc' : 'memoro');
  const date = now.toISOString().slice(0, 10);
  const name = basename(String(file || ''));
  // The filename's system is what the page counts by and what a person filters
  // on. A turn left to infer it from a digest would get it right most days, and
  // the days it did not would file a proposal against the wrong system — so a
  // file whose name says which repository it is keeps saying so.
  const known = repo || repoOfFile(name);
  const out = [
    `Today is ${date}. One file in the directory you are standing in is yours this turn:`,
    '',
    `    ${name}`,
    '',
    'Read it — yourself, and whole — and decide what, if anything, is worth doing about it.',
    'The ground to judge it against is below: what is already planned, what was already closed,',
    'and what is already proposed.',
    '',
  ];
  if (known) {
    out.push(`It is **${known}**'s, so a proposal you write about it is named \`${date}-${tagOf(known)}-<slug>.md\`.`);
    out.push(known === 'memoro-cli'
      ? 'memoro-cli has no server: its production is this machine — mc itself, its runner, its verbs and the logs it keeps about its own rounds.'
      : 'memoro\'s production is the deployed service.');
  } else {
    out.push('Nothing in that name says which system the file belongs to, so decide it from what you read and put it in the name:',
      '`mc` for memoro-cli (mc itself on this machine), `memoro` for the deployed service.');
  }
  out.push(
    '',
    `One file, one outcome: either **one** proposal, named \`${date}-<mc|memoro>-<slug>.md\`,`,
    'or none at all. Not two from one file — one report is one proposal — and no proposal is the right',
    'answer whenever the file does not warrant one.',
    '',
    placementWords(areas, env),
    'A programme is an order, not a place for a proposal; the programmes are under PROGRAMMES below as ground.',
    'Say in one line which you did, where it went and why, then stop.',
    '',
    'If you cannot read the file whole — it is past your tool\'s read limit, or in a form you cannot open —',
    'say so rather than judging it from its head: either a proposal that names the limit, or no proposal',
    'with that as the reason in your line.',
    '',
    '----- PROGRAMMES -----',
  );
  if (!programmes.length) out.push('_none_');
  else for (const p of programmes) out.push(`- ${p.name} — ${clip(p.line || NO_DESCRIPTION, 160)}`);
  out.push('', '----- GOALS NOT FINISHED -----');
  if (!goals.length) out.push('_none read_');
  else {
    out.push('| programme / goal | stage · status | title | next |', '|---|---|---|---|');
    for (const g of goals) out.push(`| ${g.programme} / ${g.goal} | ${g.stage ? `${g.stage} · ${g.status}` : '?'} | ${clip(g.title || '—')} | ${clip(g.next || '—')} |`);
  }
  out.push('', '----- PROJECT LOG (closed projects) -----', projectLog ? projectLogTail(projectLog) : '_none read_');
  out.push('', '----- PROPOSALS ALREADY WAITING -----');
  if (!proposals.length) out.push('_none_');
  else {
    const groups = new Map();
    for (const p of proposals) {
      if (!groups.has(p.area)) groups.set(p.area, []);
      groups.get(p.area).push(p.file);
    }
    for (const key of [...groups.keys()].sort()) {
      out.push(`area ${key}:`);
      for (const name of groups.get(key)) out.push(`- ${name}`);
    }
  }
  return out.join('\n');
}

/**
 * The newest rows of the project log, within `maxBytes`. The log is
 * append-only and grows without end; inlined whole it passed the kernel's
 * 128 KiB limit on one argument, and every intake turn died at spawn with
 * E2BIG (2026-11-18 to 2026-11-20). The newest closures are the ones a fresh
 * report can repeat, so the tail is kept, cut at a line, and the turn is told
 * where the rest is.
 */
export const PROJECT_LOG_TAIL_BYTES = 48 * 1024;
export function projectLogTail(text, maxBytes = PROJECT_LOG_TAIL_BYTES) {
  const full = String(text || '');
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;
  const kept = [];
  let bytes = 0;
  const lines = full.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(lines[i], 'utf8') + 1;
    if (bytes + size > maxBytes) break;
    kept.unshift(lines[i]);
    bytes += size;
  }
  return [`_older rows omitted; the whole log is \`${PROJECT_LOG}\` on origin/main_`, '', ...kept].join('\n');
}

/**
 * The largest prompt a turn is started with. A positional argument longer
 * than the kernel's per-argument limit (128 KiB) fails the spawn with E2BIG;
 * this leaves room for the other arguments beside it.
 */
export const PROMPT_LIMIT_BYTES = 120 * 1024;

/** What the routing table says for a programme whose README gives no line. */
export const NO_DESCRIPTION = '(no description)';

/** A README's first line that is not a heading, or null: the programme's line in the routing table. */
export function readmeLine(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return null;
}

/**
 * The routing table the intake turn picks a programme from: one row per
 * programme under `~/mc/programs/`, its line read from its README.
 */
export function programmeRoutes(env = process.env, { read = (path) => readFileSync(path, 'utf8') } = {}) {
  return programmeNames(env).map((name) => {
    let line = null;
    try { line = readmeLine(read(join(programsHome(env), name, 'README.md'))); } catch { /* no README */ }
    return { name, line: line || NO_DESCRIPTION };
  });
}

/* -------------------------------------------------------------------- turn */

// The names come from the before/after listing in `runHelperTurn`, and a name without a system is said and left alone, because guessing it is the parse that was removed.
/** What the turn produced, in the one line a runner log and a person share. */
export function describeTurn({ catalogued = null, wrote = [], waiting = [], providerPriority = 'auto', tool = null, routeWhy = null }) {
  const route = providerPriority === 'auto' || !tool ? '' : ` · ${tool} (${providerPriority} priority${tool !== providerPriority ? `, fallback: ${routeWhy || 'other provider selected'}` : ''})`;
  if (catalogued) return `kept as it is in ${catalogued.area}, catalogued by jev`;
  if (!wrote.length) return `no proposal — nothing in the file warranted one (${waiting.length} still waiting)${route}`;
  // Where it went, when the listing said: the area by its key.
  const placed = wrote.filter((p) => p && typeof p === 'object' && typeof p.area === 'string');
  const where = placed.length ? ` to ${[...new Set(placed.map((p) => `area ${p.area}`))].join(' and ')}` : '';
  const line = `${wrote.length} proposal${wrote.length === 1 ? '' : 's'}${where}, ${waiting.length} waiting`;
  const untagged = wrote.filter((p) => typeof p?.file === 'string' && !proposalSystem(p.file)).map((p) => `proposal ${p.file} names no system (mc|memoro)`);
  const described = untagged.length ? `${line} — ${untagged.join('; ')}` : line;
  return `${described}${route}`;
}

function realSession({ bin, args, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
      const timedOut = error?.killed === true || error?.signal === 'SIGTERM';
      resolve({
        status: timedOut ? TIMEOUT_EXIT : (error?.code ?? 0),
        stdout: stdout || '',
        stderr: stderr || (error && !timedOut ? String(error.message) : ''),
        timedOut,
      });
    });
  });
}

function realGit(cwd, args) {
  return runGitAsync(undefined, ['-C', cwd, ...args], { timeoutMs: 20_000 })
    .then((r) => (r.error || r.status !== 0 ? null : String(r.stdout || '').trimEnd()));
}

/**
 * The ground the turn judges the digest against: the goals under
 * `~/mc/programs/` that are not finished (`programsGoals`), each with its last
 * entry's next action, and the project log read from each checkout on
 * origin/main. A repository that is not here is
 * simply absent — the turn is told what it was given, never that a list is
 * complete.
 */
export async function helperGround({ env = process.env, repos = defaultRepos(env), git = realGit, goals: readGoals = () => programsGoals({ home: programsHome(env) }) } = {}) {
  const present = repos.filter((repo) => existsSync(gitDirOf(repo)));
  await Promise.all(present.map((repo) => git(repo.path, ['fetch', '-q', 'origin'])));
  const goals = readGoals().filter((g) => !FINISHED.includes(g.stage)).map((g) => ({
    programme: g.programme, goal: g.goal, stage: g.stage ?? null, status: g.status ?? null, title: g.title ?? null,
    next: [...(g.log || [])].reverse().find((entry) => entry.next)?.next ?? null,
  }));
  const notes = [];
  let projectLog = null;
  const declaring = [];
  for (const repo of present) {
    const text = await git(repo.path, ['show', `origin/main:${PROJECT_LOG}`]);
    if (text) projectLog = projectLog ? `${projectLog}\n\n${text}` : text;
    // The area pages it declares, for where a proposal goes; one it does not declare, or cannot be read, names none.
    const declared = await git(repo.path, ['show', `origin/main:${AREAS_PATH}`]);
    const read = declared ? checkAreas(declared, `${repo.name}'s ${AREAS_PATH}`) : null;
    if (read?.ok) declaring.push({ name: repo.name, areas: read.areas });
  }
  if (!projectLog) notes.push(`no ${PROJECT_LOG} on origin/main in ${present.map((r) => r.name).join(', ') || 'any checkout'}`);
  const keys = declaredAreaKeys(declaring);
  return { goals, projectLog, notes, areas: keys.length ? keys : areaKeysOnDisk(env) };
}

/**
 * Run the turn over one file in the inbox. `file` is that file — a path or a
 * bare name; only the name reaches the prompt, because the turn stands in the
 * directory it is in. Returns what happened, never throws: a missing role, a
 * missing tool and a session that failed are all outcomes the caller prints,
 * because the runner logs this the same way it logs a step.
 *
 * `wrote` is measured, not claimed — every area's `proposals/` before and
 * after. A turn that said it wrote a file and did not is reported as having
 * written none.
 */
export async function runHelperTurn({
  env = process.env,
  now = new Date(),
  file,
  model = null,
  tool = null,
  // Null means the name decides, and if the name does not say, the turn does.
  repo = null,
  minutes = DEFAULT_TURN_MINUTES,
  deps = {},
} = {}) {
  const role = (deps.role || readCanonRole)(INTAKE_ROLE);
  if (!role?.overlay) {
    return { ok: false, reason: 'no-role', note: `canon/roles/${INTAKE_ROLE}.md is missing from this install` };
  }
  let routeCandidate = null;
  let routeWhy = null;
  let routeBilling = null;
  let savedPriority = 'auto';
  // A tool whose intake model comes only from the catalog's build list (`INTAKE_FROM_CATALOG`) is routed by it.
  const fromCatalog = (name) => declared(name, 'INTAKE_FROM_CATALOG') != null;
  if (!model && (!tool || fromCatalog(tool))) {
    const catalog = (deps.catalog || (() => readModels(env)))();
    savedPriority = catalog.providerPriority ?? 'auto';
    if (tool) {
      routeCandidate = (catalog.build || []).find((candidate) => candidate.tool === toolShortName(tool)) || null;
    } else if (!tool && savedPriority !== 'auto') {
      const roleCandidates = [
        { tool: 'claude', model: role.model || 'opus', effort: 'medium' },
        ...(catalog.build || []).filter((candidate) => fromCatalog(candidate.tool)),
      ];
      const chosen = chooseCandidate({ cls: 'build', catalog: { build: roleCandidates }, capacity: (deps.capacity || (() => readCapacity({ root: runnerDir(env) })))(), now, priority: savedPriority });
      routeCandidate = chosen.candidate;
      routeWhy = chosen.why;
      routeBilling = chosen.billing;
    }
  }
  const selectedTool = tool || routeCandidate?.tool || role.tools?.[0] || 'claude';
  const launch = (deps.launch || resolveLaunch)(selectedTool);
  if (!launch?.ok) {
    return { ok: false, reason: 'no-tool', note: launch?.hint || launch?.reason || 'no tool to run the turn' };
  }
  if (fromCatalog(launch.id) && !model && !routeCandidate) return { ok: false, reason: `no ${declared(launch.id, 'INTAKE_FROM_CATALOG')} intake candidate is listed in mc model` };

  const dir = intakeDir(env);
  // Every directory a proposal may be written in, before and after: each
  // area's `proposals/` under `~/mc/areas/`, never an archive.
  const listAll = deps.list || listAllProposals;
  const waitingBefore = listAll(env);
  const before = new Set(waitingBefore.map((p) => p.path));

  const ground = await (deps.ground || helperGround)({ env });
  const prompt = helperPrompt({
    file, areas: ground.areas ?? areaKeysOnDisk(env), env, programmes: (deps.routes || programmeRoutes)(env),
    projectLog: ground.projectLog, goals: ground.goals,
    proposals: waitingBefore.map((p) => ({ area: p.area, file: p.file })), repo, now,
  });
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > PROMPT_LIMIT_BYTES) {
    return { ok: false, reason: 'prompt-too-large', note: `the intake prompt is ${Math.round(promptBytes / 1024)} KiB; a turn starts with at most ${PROMPT_LIMIT_BYTES / 1024} KiB` };
  }
  const instructions = instructionsFor(launch.id, role.overlay);
  const args = headlessArgs({
    // `stream: false`: a helper turn is one short answer on its own
    // wall-clock cap, with no check-ins, so its prompt stays the positional
    // and its output the one JSON object (step-cost step 3 left it so).
    toolId: launch.id, adapter: launch.adapter, model: model || routeCandidate?.model || role.model, effort: routeCandidate?.effort, instructions, prompt, profileArgs, autocompact: null, stream: false, cache: role.cache,
  });
  const provider = requireCapability(launch.id, 'BILLING_PROVIDER');
  const billing = (deps.billingRoute || billingRouteNow)(provider, { now, env, route: { billing: routeBilling, why: routeWhy } });
  if (billing.billing === 'unavailable') return { ok: false, reason: billing.why, providerPriority: savedPriority, routeWhy };
  const selectedModel = model || routeCandidate?.model || role.model;
  const processLaunch = gatewayLaunch({ provider, model: selectedModel, bin: launch.spec.bin, args, billing: billing.billing });

  const release = (deps.register || registerForeground)({
    verb: 'helper', area: dir, tool: launch.shortName || launch.id, model: selectedModel, env,
    // The runner repeats turns in one process; finally and dead-pid filtering
    // handle cleanup without accumulating one exit listener per turn.
    onExit: () => {},
  });
  let result;
  try {
    result = await (deps.session || realSession)({
      bin: processLaunch.bin, args: processLaunch.args, cwd: dir, timeoutMs: minutes * 60_000, env: scrubProviderApiKeysFromEnv({ ...withoutSessionIdentity(env), MC_ROLE: 'intake', MC_HEADLESS: '1' }),
    });
  } finally {
    release();
  }
  const read = readSessionOutput({
    toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut, now, model: selectedModel,
  });
  refusePlanOnRead({ read, launch, model: selectedModel, billing: billing.billing, env, now, say: deps.say });
  const after = listAll(env);
  const wrote = after.filter((p) => !before.has(p.path));
  return {
    ok: sessionFinished(result, read),
    status: result.status,
    note: read.note,
    quota: read.quota,
    quotaReset: read.quotaReset,
    ...quotaFields(read, launch),
    turns: read.turns,
    session: read.session,
    // What it cost, in the same columns runs.tsv keeps for a step: the daily
    // turn is a model call the page's day line should be able to price.
    input: read.input,
    output: read.output,
    cacheRead: read.cacheRead,
    cacheWrite: read.cacheWrite,
    cost: read.cost,
    stdout: result.stdout,
    stderr: result.stderr,
    model: selectedModel,
    tool: launch.shortName || launch.id,
    providerPriority: savedPriority,
    billing: billing.billing,
    routeWhy,
    wrote,
    waiting: after,
    groundNotes: ground.notes || [],
  };
}

/* ------------------------------------------------------------------- drain */

/** The inbox's files, never its directories: `decisions-archive/` is not an item. */
const listFiles = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch { return []; }
};

/** `~/mc` and `~/mc/runner/log/` are one filesystem, so a rename is the whole move. */
const moveFile = (from, to) => {
  try { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); return true; } catch { return false; }
};

/**
 * Drain the inbox: one turn per file, oldest first, up to `limit` of them, and
 * every file archived the moment its turn ends.
 *
 * The archive is unconditional and it is the reason this terminates. A turn
 * that failed, timed out, hit the quota or threw has still had its turn, and a
 * file put back for the next round is a file every round after this one takes
 * again — an inbox that keeps what it could not judge never drains. That is
 * Martin's word (2026-09-04) and it is also the only version with an end.
 *
 * The file's repository is not passed. `repoOfFile` reads it out of the
 * collector's own names and answers `null` for anything else, which is what the
 * prompt wants: a file a person dropped in belongs to whichever system its
 * contents say, and the turn is the only reader that can tell.
 *
 * `deps` is the whole of what this touches outside itself — `files`, `move`,
 * `turn` — so a caller with its own filesystem (the runner, its tests) hands
 * over its own and the drain is exercised rather than stubbed. `onTurn` is
 * called after each file's turn *and* its archive, which is where the runner
 * writes its runs.tsv row; `stop` ends the drain between files, never inside
 * one.
 */
export async function drainIntake({
  env = process.env,
  now = () => new Date(),
  limit = INTAKE_PER_ROUND,
  model = null,
  tool = null,
  deps = {},
} = {}) {
  const dir = intakeDir(env);
  const waiting = intakeQueue((deps.files || listFiles)(dir));
  const done = [];
  for (const file of waiting.slice(0, Math.max(0, limit))) {
    const started = now().getTime();
    let turn;
    try {
      // An app suggestion is catalogued by jev and kept as it is (intake-catalog.js); every other file has a model turn.
      turn = file.startsWith('suggestion-')
        ? await (deps.catalog || catalogSuggestion)({ env, now: now(), file })
        : await (deps.turn || runHelperTurn)({ env, now: now(), file, model, tool });
    } catch (error) {
      // The one path that would otherwise skip the archive below. A turn that
      // threw did not judge the file, but the file has had its turn.
      turn = { ok: false, reason: 'turn-threw', note: clip(error?.message || String(error), 120), wrote: [], waiting: [] };
    }
    const move = () => (deps.move || moveFile)(join(dir, file), join(intakeArchiveDir(env, now()), file));
    let archived = false;
    try {
      // A collector retry must not recreate the inbox file as the drain moves it.
      archived = file.startsWith('suggestion-')
        ? realLock(workRoot(env), move, { strict: true, name: 'suggestions-archive' }) : move();
    } catch { /* keep the file for the next drain when its archive lock is unavailable */ }
    const result = { file, turn, archived, seconds: Math.round((now().getTime() - started) / 1000) };
    done.push(result);
    if (deps.onTurn) await deps.onTurn(result);
    if (deps.stop?.()) break;
  }
  return { done, left: Math.max(0, waiting.length - done.length) };
}
