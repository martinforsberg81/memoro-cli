/**
 * `mc programs` — the programmes mc knows, every one of them.
 *
 *   mc programs list [--json]    one line per programme, sorted by name
 *   mc programs priority <programme>... --set <n>    prefer work within a stage
 *   mc programs create <programme> --end "…" [--horizon <slug> | --area <repo>/<id>] [--purpose "…"] [--from-proposal <path>]    a new programme with its record
 *   mc programs record <programme> --end "…" [--horizon <slug>]    the record of an existing one
 *   mc programs state <programme> draft|ready    set draft or ready (interactive Martin only); ready releases the desk's holds on its unfinished goals
 *   mc programs review <programme>    one independent advisory reading of the current document
 *   mc programs after <programme> <phase> <phase>… | --none    what a phase of a stated programme waits for
 *   mc programs show <programme> [--json]    one programme's record
 *
 * The page draws only the programmes with work on them and folds the dormant
 * ones — no goal — into one line that points here. This is the
 * whole list, read from the same sources and through the same collector
 * (`readProgrammes`, page-collect.js), so a programme is active or dormant
 * here exactly when it is on the page. `mc programs` alone prints the usage.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { areasHome } from '../area-proposals.js';
import { programsHome, workRoot } from '../paths.js';
import { wakeRunner } from '../run-control.js';
import { readAreas } from '../areas.js';
import { run as runGit } from '../git.js';
import { repoNameOf } from '../repos.js';
import { knownRepositories } from '../work-area.js';
import { setProgrammePriorities, validPriority } from '../programme-priority.js';
import {
  AREA_RE, RECORD_FILE, changePhases, createProgramme, cycleOf, newRecord, readRecord, recordPage, recordPageTemplate, recordView, setRecordState, writeRecord,
} from '../programme-record.js';
import { GOAL_FILE, HOLD_FILE, PLAN_ROLE, appendEntry, listDirsOf, logStamp, parseGoal, programsGoals, readHold, readTextOrNull } from '../goals.js';
import { NAME_RE } from '../plan-schema.js';
import { reservedRoleHint, reservedRoleName } from '../roles.js';
import { normalizeSessionRole } from '../session-role.js';
import { readProgrammes } from '../page-collect.js';
import { planProviders, statusRollup } from '../page-render.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';
import { writeFileAtomic } from '../atomic-write.js';
import { realLock } from '../runner-lock.js';
import { programmeRepositories, programmeReviewCall } from '../programme-review.js';
import { beginRepairReview, repairReviewCall } from '../repair-review.js';
import { isDesk, releaseRepair, repairReleaseState } from '../repair-release.js';
import { reconcileRepair, setDeskRepairState } from '../repair-reconcile.js';
import { disposeRepair, REPAIR_DISPOSITIONS, stopRepair } from '../repair-stop.js';

export function usage() {
  return commandUsage('programs');
}

/** The forms the handler reads, and what it refuses after the scan (help-routes walks them). */
export const ROUTES = {
  '': { booleans: ['--json'], check: ({ flags }) => (flags.json ? 'mc programs --json needs list' : null) },
  list: { booleans: ['--json'], check: ({ positional }) => (positional.length ? `mc programs list takes no ${positional[0]}` : null) },
  priority: { strictValues: ['--set'], check: ({ positional, flags }) => (
    !positional.length ? 'mc programs priority needs at least one programme'
      : flags.set === null || !/^\d+$/u.test(flags.set) || !validPriority(Number(flags.set))
        ? 'mc programs priority needs --set <n>, a non-negative safe whole number' : null
  ) },
  create: { strictValues: ['--end', '--horizon', '--area', '--purpose', '--from-proposal'], check: (scanned) => writeCheck('create', scanned) },
  record: { strictValues: ['--end', '--horizon'], check: (scanned) => writeCheck('record', scanned) },
  state: { check: ({ positional }) => stateCheck(positional) },
  review: { check: ({ positional }) => programmeNameCheck('review', positional) },
  release: { check: ({ positional }) => programmeNameCheck('release', positional) },
  'repair-stop': { strictValues: ['--title', '--summary', '--item'], check: ({ positional, flags }) => programmeNameCheck('repair-stop', positional)
    ?? (!flags.title?.trim() || !flags.summary?.trim() ? 'mc programs repair-stop needs --title and --summary' : null) },
  disposition: { strictValues: ['--reason'], check: ({ positional, flags }) => positional.length === 2 && NAME_RE.test(positional[0])
    && REPAIR_DISPOSITIONS.includes(positional[1]) && flags.reason?.trim() ? null
    : 'use mc programs disposition <programme> decline|return|takeover --reason "<text>"' },
  reconcile: { strictValues: ['--reason'], check: ({ positional, flags }) => programmeNameCheck('reconcile', positional)
    ?? (!flags.reason?.trim() ? 'mc programs reconcile needs --reason "…"' : null) },
  after: { booleans: ['--none'], check: (scanned) => afterCheck(scanned) },
  show: { booleans: ['--json'], check: ({ positional }) => (
    positional.length !== 1 ? 'mc programs show needs one programme'
      : NAME_RE.test(positional[0]) ? null : `"${positional[0]}" is not a programme name: lower-case letters, digits and hyphens, at most 64, starting with a letter or digit`
  ) },
  '*': { booleans: ['--json'], check: ({ positional }) => `mc programs has no ${positional[0]}` },
};

const VERBS = ['list', 'priority', 'create', 'record', 'state', 'after', 'show', 'review', 'release', 'reconcile', 'repair-stop', 'disposition'];

function stateCheck(positional) {
  if (positional.length !== 2) return 'mc programs state needs <programme> draft|ready';
  const [name, target] = positional;
  if (!NAME_RE.test(name)) return `"${name}" is not a programme name: lower-case letters, digits and hyphens, at most 64, starting with a letter or digit`;
  if (target !== 'draft' && target !== 'ready') return 'mc programs state needs draft or ready';
  return null;
}

function programmeNameCheck(verb, positional) {
  return positional.length !== 1 || !NAME_RE.test(positional[0] ?? '') ? `mc programs ${verb} needs one programme name` : null;
}

const PHASE_RE = /^[1-9]\d{0,8}$/u;

/** What `after` refuses after the scan, before it reads or writes anything: a malformed call. */
function afterCheck({ positional, flags }) {
  const [name, ...phases] = positional;
  if (name === undefined) return 'mc programs after needs a programme, the phase that waits and the phases it waits for, or --none';
  if (!NAME_RE.test(name)) return `"${name}" is not a programme name: lower-case letters, digits and hyphens, at most 64, starting with a letter or digit`;
  const [waiting, ...named] = phases;
  if (waiting === undefined) return 'mc programs after needs the phase that waits';
  for (const word of phases) if (!PHASE_RE.test(word)) return `"${word}" is not a phase — a whole number from 1`;
  if (flags.none && named.length) return 'mc programs after takes the phases it waits for or --none, not both';
  if (!flags.none && !named.length) return 'mc programs after needs the phases the phase waits for, or --none';
  if (named.includes(waiting)) return `phase ${waiting} cannot wait for itself`;
  return null;
}

/** What `create` and `record` refuse after the scan, before they read or write anything. */
function writeCheck(verb, { positional, flags }) {
  if (positional.length !== 1) return `mc programs ${verb} needs one programme name`;
  const [name] = positional;
  if (!NAME_RE.test(name)) return `"${name}" is not a programme name: lower-case letters, digits and hyphens, at most 64, starting with a letter or digit`;
  if (reservedRoleName(name)) return reservedRoleHint(name);
  if (flags.end === null || !flags.end.trim()) return `mc programs ${verb} needs --end "<a sentence saying when the programme is done>"`;
  if (flags.horizon !== null && !NAME_RE.test(flags.horizon)) return `--horizon "${flags.horizon}" is not a slug: lower-case letters, digits and hyphens, at most 64, starting with a letter or digit`;
  if (verb === 'record') {
    for (const flag of ['area', 'purpose', 'from-proposal']) if (flags[flag] !== undefined && flags[flag] !== null) return `mc programs record takes no --${flag}; mc programs create does`;
    return null;
  }
  if (flags.area !== null && !AREA_RE.test(flags.area)) return `--area "${flags.area}" is not <repo>/<id>: a repository and an area it declares, lower-case letters, digits and hyphens`;
  if (flags.area !== null && flags.horizon !== null) return 'mc programs create takes --horizon or --area, not both: a programme serves a horizon or repairs an area';
  if (flags.purpose !== null && !flags.purpose.trim()) return 'mc programs create --purpose needs the text of What it is for';
  if (flags['from-proposal'] !== null && flags.area === null) return 'mc programs create --from-proposal needs --area <repo>/<id>: a proposal becomes an area repair';
  return null;
}

/**
 * Who writes a record, from the environment alone — `MC_ROLE` through
 * `normalizeSessionRole`, else `MC_GOAL` for a build session, else a person:
 * a person and the interactive Martin role. Every other role, including the
 * manager and any unattended role, is refused.
 */
export function recordWriter(env) {
  if (env.MC_HEADLESS === '1') {
    return { refusal: 'unattended sessions cannot create a programme or write a record' };
  }
  const role = env.MC_ROLE ? normalizeSessionRole(env.MC_ROLE) : null;
  if (!role && !env.MC_GOAL) return { by: 'person' };
  if (role === 'martin') return { by: 'martin' };
  const named = role || 'build-session:goal';
  return { refusal: `the ${named} role cannot create a programme or write a record — only Martin at the desk and a person may` };
}

/**
 * Who states what a phase waits for, from the environment alone, as the
 * record's own verbs read it: a person, the interactive Martin role, the
 * manager and the plan role (the order of work is the plan's), the last two
 * also headless. Every other role is refused, and so is a caller with
 * `MC_GOAL` and no `MC_ROLE`.
 */
export function afterWriter(env) {
  const role = env.MC_ROLE ? normalizeSessionRole(env.MC_ROLE) : null;
  if (role === 'manager' || role === PLAN_ROLE) return { by: role };
  const writer = recordWriter(env);
  if (!writer.refusal) return writer;
  if (role === 'martin') return { refusal: 'the Martin role is interactive-only; unattended sessions cannot state what a phase waits for' };
  const named = role || 'build-session:goal';
  return { refusal: `the ${named} role cannot state what a phase waits for — the plan states it (mc plan), and the manager, interactive Martin and a person may` };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const [verb] = argv.filter((word) => !word.startsWith('-'));
  const route = verb === undefined ? ROUTES[''] : (ROUTES[verb] || ROUTES['*']);
  const scanned = scanArgs(VERBS.includes(verb) ? argv.filter((word, at) => at !== argv.indexOf(verb)) : argv, route);
  if (!scanned.error && verb === undefined && !scanned.flags.json) { stdout.write(usage()); return 0; }
  const error = scanned.error || route.check(scanned);
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }
  const env = deps.env || process.env;
  if (env.MC_ROLE === 'learning' && ![undefined, 'list', 'show'].includes(verb)) {
    stderr.write('mc: the learning role does not write programmes — record a repair proposal with mc learning record\n'); return 2;
  }
  if (verb === 'create' || verb === 'record') return writeVerb(verb, scanned, { ...deps, env, stdout, stderr });
  if (verb === 'state') return stateVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'review') return reviewVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'release') return releaseVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'reconcile') return reconcileVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'repair-stop') return stopVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'disposition') return dispositionVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'after') return afterVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'show') return showVerb(scanned, { env, stdout, stderr });

  const read = deps.read || (() => readProgrammes({ env }));
  const home = programsHome(env);
  const listing = programmesListing(read(), { record: (name) => {
    const dir = join(home, name);
    const result = readRecord(dir);
    const view = recordView(result);
    if (view?.repair && view.state === 'ready' && view.repair.disposition?.action !== 'decline'
        && !repairReleaseState(dir, result.record)?.release) return { ...view, needs_review: true };
    return view;
  } });
  if (verb === 'priority') {
    try {
      const result = setProgrammePriorities(scanned.positional, Number(scanned.flags.set), {
        home, known: listing.programmes.map((item) => item.name),
      });
      if (!result.ok) { stderr.write(`mc: ${result.reason}\n`); return 2; }
      for (const name of result.programmes) stdout.write(`${name}: priority ${result.priority}\n`);
      return 0;
    } catch (error) { stderr.write(`mc: could not set programme priority: ${error.message}\n`); return 1; }
  }
  if (scanned.flags.json) { stdout.write(`${JSON.stringify(listing, null, 2)}\n`); return 0; }
  stdout.write(listingText(listing));
  return 0;
}

/**
 * Every programme as one record: the page's group, reduced to the facts this
 * list says. The repositories are the tree's (`homes`, where the programme is
 * a directory) and every goal's, so a dormant programme still
 * says where it lives.
 */
export function programmesListing({ section, homes = {} }, { record = () => null } = {}) {
  const programmes = (section.programmes || []).map((group) => ({
    name: group.programme,
    priority: group.priority || 0,
    state: group.dormant ? 'dormant' : 'active',
    dormant: Boolean(group.dormant),
    repos: [...new Set([
      ...(homes[group.programme] || []),
      ...(group.goals || []).flatMap((goal) => goal.repos || []),
    ].filter(Boolean))].sort(),
    goals: (group.goals || []).length,
    statuses: Object.fromEntries(statusRollup(group.statuses)),
    plan_sessions: planProviders(group),
    record: record(group.programme),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const dormant = programmes.filter((item) => item.dormant).length;
  return { active: programmes.length - dormant, dormant, programmes };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The last cell of a line whose programme has a record. */
function recordCell(record, name) {
  if (record.problems) return 'record invalid';
  if (record.repair && record.state === 'Martin') return `${name} · Martin`;
  if (record.needs_review) return `${name} · ready (needs review)`;
  return `record ${record.state} · ${record.horizon ? `horizon ${record.horizon}` : 'no horizon'}`;
}

/** The cells of one programme's line, in the page's words. */
function cells(item) {
  const rollup = statusRollup(item.statuses).map(([status, n]) => `${status} ${n}`).join(' · ');
  // planSessionWords' words, from the counts it was made of.
  const meta = Object.entries(item.plan_sessions).map(([provider, n]) => `${provider} ${n}`).join(' · ');
  return [
    item.name,
    item.state,
    `priority ${item.priority}`,
    item.repos.join(',') || '—',
    item.goals ? `${plural(item.goals, 'goal')}${rollup ? ` · ${rollup}` : ''}` : 'no goal',
    meta ? `plan ${meta}` : 'no plan session',
    ...(item.record ? [recordCell(item.record, item.name)] : []),
  ];
}

/**
 * One list sorted by name with a state column, rather than active first: the
 * name is what somebody arriving from the page's dormant line looks for, and
 * the column still says the verdict at a glance.
 */
export function listingText(listing) {
  const rows = listing.programmes.map(cells);
  const widths = rows.reduce((out, row) => row.map((cell, i) => Math.max(out[i] || 0, cell.length)), []);
  const lines = rows.map((row) => `  ${row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')}`.trimEnd());
  return `programmes — ${listing.active} active · ${listing.dormant} dormant\n${lines.map((line) => `${line}\n`).join('')}`;
}

/** `git -C <cwd> <args>` as `{ ok, stdout, stderr }`, the shape `readAreas` reads. */
function gitIn(cwd, args) {
  const r = runGit(undefined, ['-C', cwd, ...args]);
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * The proposal `--from-proposal` names, as a real path to a file directly in an area's
 * `~/mc/areas/<repo>/<area>/proposals/`, with where it is archived once ordered, or why not.
 */
function proposalIn(given, { env }) {
  let path;
  try { path = realpathSync(given); } catch { return { error: `--from-proposal ${given} is not a file` }; }
  if (!statSync(path).isFile()) return { error: `--from-proposal ${given} is not a file` };
  // A proposal is a file directly in an area's proposals folder; one under its archive/ has been decided already.
  const home = realOr(areasHome(env));
  const parts = path.startsWith(home + sep) ? path.slice(home.length + 1).split(sep) : null;
  if (parts?.length !== 4 || parts[2] !== 'proposals') return { error: `--from-proposal ${given} is not a proposal: it must be a file directly in an area's ${areasHome(env)}/<repo>/<area>/proposals/` };
  const archived = join(dirname(path), 'archive', basename(path));
  if (existsSync(archived)) return { error: `--from-proposal ${given}: ${archived} exists already — the proposal was decided once; nothing was made` };
  return { path, area: `${parts[0]}/${parts[1]}`, archived };
}

function realOr(path) {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Why `area` (`<repo>/<id>`) is not an area a known repository declares at its origin/main, or null. A repository
 * mc does not know, one whose declaration cannot be read and one that does not declare the id are all refused.
 */
function areaRefusal(area, { env, git = gitIn, known = () => knownRepositories(env) }) {
  const [repo, id] = area.split('/');
  const path = known().find((one) => repoNameOf(one) === repo);
  if (!path) return `${repo} is not a repository mc knows — ${known().map(repoNameOf).join(', ')}`;
  const read = readAreas(path, { git, repo });
  if (!read.ok) return read.reason;
  if (!read.areas.some((one) => one.id === id)) return `${repo} declares no area ${id}${read.areas.length ? ` — ${read.areas.map((one) => `${repo}/${one.id}`).join(', ')}` : ' (it declares none)'}`;
  return null;
}

/**
 * `create` and `record`: the caller is checked first; the whole request is validated before the first write.
 * Created only by a person or interactive Martin; create makes a draft.
 */
function writeVerb(verb, { positional, flags }, { env, stdout, stderr, read, canon, now = new Date(), git, known }) {
  const writer = recordWriter(env);
  if (writer.refusal) { stderr.write(`mc: ${writer.refusal}\n`); return 2; }
  const [name] = positional;
  const home = programsHome(env);
  const dir = join(home, name);
  const problem = (text) => { stderr.write(`mc: ${text}\n`); return 1; };
  try {
    if (verb === 'record') {
      if (!existsSync(dir)) return problem(`no programme ${name} — ${dir} does not exist; mc programs create ${name} --end "…" makes a new one`);
      if (existsSync(join(dir, RECORD_FILE))) return problem(`${name} already has a record (${join(dir, RECORD_FILE)}) — mc programs show ${name} prints it; it is not replaced`);
      writeRecord(dir, newRecord({ horizon: flags.horizon, end: flags.end.trim(), createdBy: writer.by, now }));
      stdout.write(`${name}: record written to ${join(dir, RECORD_FILE)} — state draft\n`);
      return 0;
    }
    const exists = existsSync(dir) || (read ? read() : readProgrammes({ env })).section.programmes.some((group) => group.programme === name);
    if (exists) return problem(`programme ${name} exists — mc programs record ${name} --end "…" gives a directory without a record its record, and mc programs show ${name} prints what it has`);
    if (flags.area !== null) {
      const refused = areaRefusal(flags.area, { env, git, known });
      if (refused) return problem(refused);
    }
    let proposal = null;
    if (flags['from-proposal'] !== null) {
      proposal = proposalIn(flags['from-proposal'], { env });
      if (proposal.error) return problem(proposal.error);
    }
    const template = recordPageTemplate({ ...(canon ? { canon } : {}), area: flags.area });
    if (template === null) return problem(`could not read the programme page template (canon/tasks/references/${flags.area ? 'repair-page.md' : 'programme-document.md'}) — nothing was made`);
    const page = recordPage(template, { name, end: flags.end, horizon: flags.horizon, area: flags.area, purpose: flags.purpose, proposal: proposal?.archived ?? null });
    const record = newRecord({ horizon: flags.horizon, area: flags.area, end: flags.end.trim(), createdBy: writer.by, now, stated: true });
    mkdirSync(home, { recursive: true });
    createProgramme(dir, page, record);
    stdout.write(`${name}: programme made at ${dir} — record state ${record.state}, phases stated, page README.md to fill in; mc goal new ${name}/<goal> makes its first goal\n`);
    if (proposal) {
      // Ordered is decided: the proposal goes to its area's archive under the line that says so.
      try {
        mkdirSync(dirname(proposal.archived), { recursive: true });
        writeFileSync(proposal.archived, `Utfall: ordered in programme ${name}\n\n${readFileSync(proposal.path, 'utf8')}`, { flag: 'wx' });
        unlinkSync(proposal.path);
      } catch (error) { return problem(`${name} is made, but the proposal ${proposal.path} was not archived at ${proposal.archived}: ${error.message}`); }
      stdout.write(`${name}: the proposal is archived at ${proposal.archived} (area ${proposal.area})\n`);
    }
    return 0;
  } catch (error) {
    if (error.code === 'EEXIST' && verb === 'record') return problem(`${name} already has a record (${join(dir, RECORD_FILE)}) — mc programs show ${name} prints it; it is not replaced`);
    if (error.code === 'EEXIST') return problem(`programme ${name} exists — mc programs record ${name} --end "…" gives a directory without a record its record, and mc programs show ${name} prints what it has`);
    return problem(`could not write ${name}: ${error.message}`);
  }
}

/** `state`: sets a programme's state to draft or ready. Interactive Martin only. */
function stateVerb({ positional }, { env, stdout, stderr, lock, now = new Date() }) {
  if (env.MC_ROLE !== 'martin' || env.MC_HEADLESS === '1') {
    stderr.write('mc: only Martin at the desk sets a programme state — mc martin opens the desk\n');
    return 2;
  }
  const [name, targetState] = positional;
  const home = programsHome(env);
  const dir = join(home, name);
  if (!existsSync(dir)) {
    stderr.write(`mc: no programme ${name} — ${dir} does not exist\n`);
    return 1;
  }
  try {
    const outcome = readRecord(dir).record?.repair?.desk
      ? setDeskRepairState(dir, targetState, env, { lock })
      : setRecordState(dir, targetState, { root: workRoot(env), lock });
    if (!outcome.ok) {
      for (const problem of outcome.problems.length ? outcome.problems : [`${name} has no valid record — mc programs show ${name}`]) stderr.write(`mc: ${problem}\n`);
      return 1;
    }
    stdout.write(`mc: ${name} · state ${targetState}\n`);
    if (targetState === 'ready') {
      const { released, kept } = releaseDeskHolds(dir, { env, now: now instanceof Date ? now : new Date() });
      for (const goal of released) stdout.write(`  ${name}/${goal.name} released (held since ${goal.hold.at ?? '—'}: ${goal.hold.reason ?? '—'})\n`);
      for (const goal of kept) stdout.write(`  ${name}/${goal.name} still held by ${goal.hold.by ?? '—'} — mc goal release ${name}/${goal.name} frees it\n`);
      wakeRunner(workRoot(env));
    }
    return 0;
  } catch (error) {
    stderr.write(`mc: could not set ${name} state: ${error.message}\n`);
    return 1;
  }
}

/**
 * The holds on a programme's unfinished goals when Martin sets it ready: a hold the desk (`by: martin`) placed is
 * released, with the log entry `mc goal release` writes, since setting the order ready is his word that its work
 * goes on; a creation hold and a hold by anyone else are kept and named. A finished or unreadable goal is left alone.
 */
export function releaseDeskHolds(dir, { env = {}, now = new Date(), read = readTextOrNull, write = writeFileAtomic, remove = unlinkSync } = {}) {
  const released = [];
  const kept = [];
  const goalsDir = join(dir, 'goals');
  for (const name of listDirsOf(goalsDir)) {
    const goalDir = join(goalsDir, name);
    const hold = readHold(goalDir, read);
    if (!hold) continue;
    const text = read(join(goalDir, GOAL_FILE));
    const goal = text === null ? null : parseGoal(text);
    if (!goal || goal.problems || ['done', 'dropped'].includes(goal.stage)) continue;
    if (hold.by !== 'martin' || hold.created) { kept.push({ name, hold }); continue; }
    const comment = `released: held by ${hold.by} since ${hold.at ?? '—'} (${hold.reason ?? '—'}) — the programme was set ready`;
    appendEntry({ dir: goalDir, entry: { at: logStamp(now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: 'martin', stage: goal.stage, status: goal.status, done: null, comment, next: null }, read, write });
    remove(join(goalDir, HOLD_FILE));
    released.push({ name, hold });
  }
  return { released, kept };
}

/** `show`: one programme's record, or that it has none. Any caller may read. */
function showVerb({ positional, flags }, { env, stdout, stderr }) {
  const [name] = positional;
  const dir = join(programsHome(env), name);
  if (!existsSync(dir)) { stderr.write(`mc: no programme ${name} — ${dir} does not exist\n`); return 1; }
  const found = readRecord(dir);
  const view = recordView(found);
  if (flags.json) { stdout.write(`${JSON.stringify({ name, record: view }, null, 2)}\n`); return found.status === 'invalid' ? 1 : 0; }
  if (found.status === 'none') { stdout.write(`${name} has no record — mc programs record ${name} --end "…" gives it one\n`); return 0; }
  if (found.status === 'invalid') {
    stderr.write(`mc: ${name} has an invalid record (${join(dir, RECORD_FILE)}):\n${found.problems.map((text) => `  ${text}\n`).join('')}`);
    return 1;
  }
  const { horizon, end, state, created, created_by: by, phases, area } = found.record;
  stdout.write(`${name}\n  horizon  ${horizon ?? 'none'}\n${area ? `  area     ${area}\n` : ''}  end      ${end}\n  state    ${state}\n  created  ${created} by ${by}\n`);
  if (phases) {
    stdout.write('  phases: stated\n');
    for (const [phase, waits] of Object.entries(phases.after ?? {})) stdout.write(`  phase ${phase} after ${phaseWords(waits)}\n`);
  }
  return 0;
}

const phaseWords = (phases) => `phase ${phases.join(', ')}`;

/**
 * `after`: the first phase waits for the phases after it, replacing what it
 * waited for, or for none (`--none`). The caller is checked before anything is
 * read; the whole statement is checked against the record and the programme's
 * goals before the one write, a change of `phases` in the record
 * (`changePhases`) that touches nothing else.
 */
function afterVerb({ positional, flags }, { env, stdout, stderr, read, lock }) {
  const writer = afterWriter(env);
  if (writer.refusal) { stderr.write(`mc: ${writer.refusal}\n`); return 2; }
  const [name, waitingWord, ...words] = positional;
  const waiting = Number(waitingWord);
  const named = [...new Set(words.map(Number))].sort((a, b) => a - b);
  const home = programsHome(env);
  const dir = join(home, name);
  const refuse = (text) => { stderr.write(`mc: ${text}\n`); return 1; };
  if (!existsSync(dir)) return refuse(`no programme ${name} — ${dir} does not exist`);
  const found = readRecord(dir);
  if (found.status === 'none') return refuse(`${name} has no record, so its phases run in sequence — mc goal phase orders its goals`);
  if (found.status === 'invalid') return refuse(`${name} has an invalid record — mc programs show ${name} says what is wrong; nothing is changed`);
  if (found.record.phases === undefined) return refuse(`${name}'s record does not state its phases, so they run in sequence — mc goal phase orders its goals`);
  const goals = programsGoals({ home, list: (path) => (path === home ? [name] : listDirsOf(path)), ...(read ? { read } : {}) })
    .filter((goal) => goal.programme === name && goal.problems.length === 0);
  for (const phase of [waiting, ...named]) {
    if (!goals.some((goal) => goal.phase === phase)) return refuse(`${name} has no goal in phase ${phase} — a phase waits and is waited for only where it has a goal`);
  }
  const stated = (phases) => {
    const after = { ...(phases.after ?? {}) };
    delete after[waiting];
    if (named.length) after[waiting] = named;
    const keys = Object.keys(after).sort((a, b) => Number(a) - Number(b));
    return { ...phases, ...(keys.length || phases.after !== undefined ? { after: Object.fromEntries(keys.map((key) => [key, after[key]])) } : {}) };
  };
  const cycle = cycleOf(stated(found.record.phases).after);
  if (cycle) return refuse(`phases ${cycle.join(', ')} would wait for one another in a cycle — nothing is changed`);
  let outcome;
  try { outcome = changePhases(dir, stated, { root: workRoot(env), lock }); } catch (error) {
    return refuse(`could not change ${name}'s record: ${error.message}`);
  }
  if (!outcome.ok) return refuse(`could not change ${name}'s record: ${outcome.problems.join('; ')}`);
  stdout.write(`mc: ${name} · phase ${waiting} · ${named.length ? `after ${phaseWords(named)}` : 'waits for no phase'}\n`);
  return 0;
}

/** Only Martin at the desk commissions a programme reading: no headless role, the manager included, and no other session. */
function reviewAuthor(env) {
  return Boolean(env.MC_ROLE) && normalizeSessionRole(env.MC_ROLE) === 'martin' && env.MC_HEADLESS !== '1';
}

function releaseVerb({ positional: [name] }, { env, stdout, stderr, lock, authorAlive }) {
  try {
    const result = releaseRepair(join(programsHome(env), name), env, { lock, alive: authorAlive });
    if (!result.ok) {
      stderr.write(`mc: ${result.problems[0] ?? `${name} is not a repair-owned programme`}\n`);
      return 1;
    }
    stdout.write(`mc: repair programme ${name} is ready for planning\n`);
    wakeRunner(workRoot(env));
    return 0;
  } catch (error) { stderr.write(`mc: repair release ${name}: ${error.message}\n`); return 1; }
}

function stopVerb({ positional: [name], flags }, { env, stdout, stderr, lock, authorAlive, now }) {
  try {
    const result = stopRepair(join(programsHome(env), name), env,
      { title: flags.title, summary: flags.summary, item: flags.item }, { lock, alive: authorAlive, now: now?.() });
    if (!result.ok) { stderr.write(`mc: ${result.problems[0] ?? `no valid record for ${name}`}\n`); return 1; }
    stdout.write(`mc: repair programme ${name} is at Martin (item ${result.record.repair.stop_item})\n`);
    return 0;
  } catch (error) { stderr.write(`mc: could not stop ${name}: ${error.message}\n`); return 1; }
}

function dispositionVerb({ positional: [name, action], flags }, { env, stdout, stderr, lock, now, readPr, wake = () => wakeRunner(workRoot(env)) }) {
  if (!isDesk(env)) { stderr.write('mc: only interactive Martin may dispose of a repair stop — mc martin opens the desk\n'); return 2; }
  try {
    const result = disposeRepair(join(programsHome(env), name), env,
      { action, reason: flags.reason.trim() }, { lock, now: now?.(), readPr });
    if (!result.ok) { stderr.write(`mc: ${result.problems[0] ?? `no valid record for ${name}`}\n`); return 1; }
    const words = { decline: 'declined', return: 'returned to repair', takeover: 'taken over by Martin' };
    stdout.write(`mc: ${name} — ${words[action]}\n`);
    wake();
    return 0;
  } catch (error) { stderr.write(`mc: could not dispose of ${name}: ${error.message}\n`); return 1; }
}

function reconcileVerb({ positional: [programme], flags }, { env, stdout, stderr, lock }) {
  try {
    const result = reconcileRepair({ home: programsHome(env), programme, env, lock, reason: flags.reason });
    if (!result.ok) {
      stderr.write(`mc: ${result.problems[0] ?? `${programme} has no valid record`}\n`);
      return 1;
    }
    stdout.write(`mc: ${programme} · release ${result.record.repair.reconciled.revision} reconciled\n`);
    return 0;
  } catch (error) { stderr.write(`mc: could not reconcile ${programme}: ${error.message}\n`); return 1; }
}

async function reviewVerb({ positional: [name] }, deps) {
  const { env, stdout, stderr } = deps;
  const target = { name, dir: join(programsHome(env), name) };
  const ctx = { env, stdout, stderr, read: readTextOrNull, write: writeFileAtomic, remove: unlinkSync,
    lock: deps.lock ?? realLock, now: deps.now ?? (() => new Date()), alive: deps.alive };
  const record = readRecord(target.dir, { read: ctx.read });
  const repair = record.status === 'valid' && Boolean(record.record.repair && !record.record.repair.desk);
  if (!repair && !reviewAuthor(env)) { stderr.write('mc: only Martin at the desk calls a programme reading — mc martin opens the desk\n'); return 2; }
  try {
    const reviewDeps = deps.review ?? {};
    const attempt = repair ? beginRepairReview({ target, ctx, deps: reviewDeps }) : null;
    const text = attempt ? attempt.snapshot.text : ctx.read(join(target.dir, 'README.md'));
    if (text === null) { stderr.write(`mc: ${name} has no README.md to read\n`); return 2; }
    const known = (deps.known ?? (() => knownRepositories(env)))().map((path) => ({ repo: repoNameOf(path), path }));
    const found = programmeRepositories(text, known);
    if (found.error) { stderr.write(`mc: ${found.error}\n`); return 2; }
    return await (attempt ? repairReviewCall({ target, ctx, repos: found.repos, ...attempt, deps: reviewDeps })
      : programmeReviewCall({ target, ctx, text, repos: found.repos, deps: reviewDeps }));
  }
  catch (error) { stderr.write(`mc: programme-review ${name}: ${error.message}\n`); return 2; }
}
