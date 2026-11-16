/**
 * `mc programs` — the programmes mc knows, every one of them.
 *
 *   mc programs list [--json]    one line per programme, sorted by name
 *   mc programs priority <programme>... --set <n>    prefer work within a stage
 *   mc programs create <programme> --end "…" [--horizon <slug> | --area <repo>/<id>] [--purpose "…"] [--from-proposal <path>]    a new programme with its record
 *   mc programs record <programme> --end "…" [--horizon <slug>]    the record of an existing one
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
import { basename, join, sep } from 'node:path';
import { archivedProgramsHome, programsHome, workRoot } from '../paths.js';
import { wakeRunner } from '../run-control.js';
import { shelveProgramme } from '../archive-programme.js';
import { readAreas } from '../areas.js';
import { readHorizons } from '../desk-horizons.js';
import { run as runGit } from '../git.js';
import { repoNameOf } from '../repos.js';
import { knownRepositories } from '../work-area.js';
import { setProgrammePriorities, validPriority } from '../programme-priority.js';
import {
  AREA_RE, RECORD_FILE, changePhases, documentProblems, dropRecord, returnRecord, signRecord, cycleOf, newRecord, readRecord, recordPage, recordPageTemplate, recordView, recordedProgrammes, writeRecord,
} from '../programme-record.js';
import { PLAN_ROLE, listDirsOf, programsGoals, readTextOrNull } from '../goals.js';
import { NAME_RE } from '../plan-schema.js';
import { reservedRoleHint, reservedRoleName } from '../roles.js';
import { normalizeSessionRole } from '../session-role.js';
import { readProgrammes } from '../page-collect.js';
import { planProviders, statusRollup } from '../page-render.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';
import { writeFileAtomic } from '../atomic-write.js';
import { realLock } from '../runner-lock.js';
import { currentProgrammeReading, programmeRepositories, programmeReviewCall, programmeVerdictVerb } from '../plan-review.js';

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
  sign: { strictValues: ['--reason'], check: ({ positional, flags }) => programmeNameCheck('sign', positional) || (flags.reason !== null && !flags.reason.trim() ? '--reason needs nonempty text' : null) },
  return: { strictValues: ['--reason'], check: (scanned) => reasonCheck('return', scanned) },
  drop: { strictValues: ['--reason'], check: (scanned) => reasonCheck('drop', scanned) },
  model: { check: ({ positional }) => positional.length ? 'mc programs model takes no arguments' : null },
  review: { check: ({ positional }) => {
    const [name, action, word] = positional;
    return programmeNameCheck('review', [name]) || (positional.length === 1 || (positional.length === 3 && action === 'verdict' && ['ok', 'not-ok'].includes(word)) ? null : 'mc programs review needs <programme> or <programme> verdict ok|not-ok');
  } },
  after: { booleans: ['--none'], check: (scanned) => afterCheck(scanned) },
  show: { booleans: ['--json'], check: ({ positional }) => (
    positional.length !== 1 ? 'mc programs show needs one programme'
      : NAME_RE.test(positional[0]) ? null : `"${positional[0]}" is not a programme name: lower-case letters, digits and hyphens, at most 64, starting with a letter or digit`
  ) },
  '*': { booleans: ['--json'], check: ({ positional }) => `mc programs has no ${positional[0]}` },
};

const VERBS = ['list', 'priority', 'create', 'record', 'after', 'show', 'sign', 'review', 'return', 'drop', 'model'];

function reasonCheck(verb, { positional, flags }) {
  return programmeNameCheck(verb, positional) || (!flags.reason?.trim() ? `mc programs ${verb} needs --reason "<text>"` : null);
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
 * a person, the interactive Martin role and the manager. Every other role is
 * refused, so a role added later is refused until it is named here.
 */
export function recordWriter(env) {
  const role = env.MC_ROLE ? normalizeSessionRole(env.MC_ROLE) : null;
  if (!role && !env.MC_GOAL) return { by: 'person' };
  if (role === 'manager') return { by: 'manager' };
  if (role === 'martin') {
    return env.MC_HEADLESS === '1'
      ? { refusal: 'the Martin role is interactive-only; unattended sessions cannot create a programme or write a record' }
      : { by: 'martin' };
  }
  const named = role || 'build-session:goal';
  return { refusal: `the ${named} role cannot create a programme or write a record — the manager (mc manager) and the desk (mc martin) create programmes, and a person may` };
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
  if (verb === 'create' || verb === 'record') return writeVerb(verb, scanned, { ...deps, env, stdout, stderr });
  if (verb === 'sign') return signVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'return' || verb === 'drop') return transitionVerb(verb, scanned, { ...deps, env, stdout, stderr });
  if (verb === 'model') return modelVerb({ env, stdout, stderr });
  if (verb === 'review') return reviewVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'after') return afterVerb(scanned, { ...deps, env, stdout, stderr });
  if (verb === 'show') return showVerb(scanned, { env, stdout, stderr });

  const read = deps.read || (() => readProgrammes({ env }));
  const home = programsHome(env);
  const listing = programmesListing(read(), { record: (name) => recordView(readRecord(join(home, name)), { dir: join(home, name) }) });
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
    proposals: group.proposals || 0,
    statuses: Object.fromEntries(statusRollup(group.statuses)),
    plan_sessions: planProviders(group),
    record: record(group.programme),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const dormant = programmes.filter((item) => item.dormant).length;
  return { active: programmes.length - dormant, dormant, programmes };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The last cell of a line whose programme has a record. */
function recordCell(record) {
  if (record.problems) return 'record invalid';
  return `record ${record.state} · ${record.horizon ? `horizon ${record.horizon}` : 'no horizon'}${record.legacy ? ' · legacy: not signed' : ''}${record.signed_at ? ` · signed ${record.signed_at} by ${record.signed_by}` : ''}${record.designs_changed ? ' · designs changed since sign-off' : ''}`;
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
    plural(item.proposals, 'proposal'),
    meta ? `plan ${meta}` : 'no plan session',
    ...(item.record ? [recordCell(item.record)] : []),
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

/** The valid open records under `home`: `[{ name, record }]`. An invalid one is not here and holds nothing back at create. */
export function openRecords(home) {
  return recordedProgrammes(home)
    .map((name) => ({ name, found: readRecord(join(home, name)) }))
    .filter(({ found }) => found.status === 'valid' && found.record.state === 'open')
    .map(({ name, found }) => ({ name, record: found.record }));
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

/** The proposal `--from-proposal` names, as a real path to a file in ~/mc/proposals/ or a programme's proposals/, or why not. */
function proposalIn(given, { env, home }) {
  let path;
  try { path = realpathSync(given); } catch { return { error: `--from-proposal ${given} is not a file` }; }
  if (!statSync(path).isFile()) return { error: `--from-proposal ${given} is not a file` };
  const root = join(workRoot(env), 'proposals') + sep;
  // A proposal is a file directly in a proposals folder; one under its archive/ has been decided already.
  const under = (dir) => (path.startsWith(dir + sep) ? path.slice(dir.length + 1).split(sep) : null);
  const inRoot = under(realOr(root.slice(0, -1)))?.length === 1;
  const parts = under(realOr(home));
  const inProgramme = parts?.length === 3 && parts[1] === 'proposals';
  if (!inRoot && !inProgramme) return { error: `--from-proposal ${given} is not a proposal: it must be a file in ${root} or in a programme's proposals/ folder` };
  return { path };
}

function realOr(path) {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * `create` and `record`: the caller is checked first; the whole request is validated before the first write.
 * The manager (D9) names `--purpose` and exactly one of `--horizon` and `--area`, and cannot call `record`; a
 * `--horizon` it names is an open horizon of the store that no valid open record names. `--area` is refused when
 * the area is not declared or a valid open record already names it. The page is written before the record, so a
 * programme is offered to planning only once its page is whole; a proposal named by `--from-proposal` is moved
 * into the programme only after both exist.
 */
function writeVerb(verb, { positional, flags }, { env, stdout, stderr, read, canon, now = new Date(), git, known, horizons }) {
  const writer = recordWriter(env);
  if (writer.refusal) { stderr.write(`mc: ${writer.refusal}\n`); return 2; }
  const [name] = positional;
  const home = programsHome(env);
  const dir = join(home, name);
  const problem = (text) => { stderr.write(`mc: ${text}\n`); return 1; };
  const manager = writer.by === 'manager';
  if (manager && verb === 'record') { stderr.write('mc: the manager role cannot write a record onto an existing directory — mc programs create makes a whole programme, its page and its record\n'); return 2; }
  if (manager && verb === 'create') {
    if (flags.purpose === null) { stderr.write('mc: the manager names --purpose "<What it is for: what this programme delivers of its horizon or repairs of its area>" on create\n'); return 2; }
    if ((flags.horizon === null) === (flags.area === null)) { stderr.write('mc: the manager names exactly one of --horizon <slug> and --area <repo>/<id> on create\n'); return 2; }
  }
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
    const open = openRecords(home);
    if (manager && flags.horizon !== null) {
      const held = (horizons ? horizons() : readHorizons({ env })).horizons.find((one) => one.slug === flags.horizon);
      if (!held || held.state !== 'open') return problem(`--horizon ${flags.horizon} is not an open horizon — mc martin horizon list says which are`);
      const named = open.find((one) => one.record.horizon === flags.horizon);
      if (named) return problem(`the horizon ${flags.horizon} already has the open programme ${named.name} — one open programme per horizon`);
    }
    if (flags.area !== null) {
      const refused = areaRefusal(flags.area, { env, git, known });
      if (refused) return problem(refused);
      const named = open.find((one) => one.record.area === flags.area);
      if (named) return problem(`the area ${flags.area} already has the open repair programme ${named.name} — one repair at a time per area, the rest wait`);
    }
    let proposal = null;
    if (flags['from-proposal'] !== null) {
      proposal = proposalIn(flags['from-proposal'], { env, home });
      if (proposal.error) return problem(proposal.error);
    }
    const template = recordPageTemplate({ ...(canon ? { canon } : {}), area: flags.area });
    if (template === null) return problem(`could not read the programme page template (canon/tasks/references/${flags.area ? 'repair-page.md' : 'programme-document.md'}) — nothing was made`);
    const page = recordPage(template, { name, end: flags.end, horizon: flags.horizon, area: flags.area, purpose: flags.purpose });
    const record = newRecord({ horizon: flags.horizon, area: flags.area, end: flags.end.trim(), createdBy: writer.by, now, stated: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(dir);
    for (const sub of ['goals', join('proposals', 'archive'), 'evidence']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'README.md'), page, { flag: 'wx' });
    writeRecord(dir, record);
    stdout.write(`${name}: programme made at ${dir} — record state ${record.state}, phases stated, page README.md to fill in; mc goal new ${name}/<goal> makes its first goal\n`);
    if (proposal) {
      const moved = join(dir, 'proposals', basename(proposal.path));
      try {
        writeFileSync(moved, `Moved here from ${proposal.path} when ${name} was made (mc programs create --from-proposal).\n\n${readFileSync(proposal.path, 'utf8')}`, { flag: 'wx' });
        unlinkSync(proposal.path);
      } catch (error) { return problem(`${name} is made, but the proposal ${proposal.path} was not moved into ${join(dir, 'proposals')}: ${error.message}`); }
      stdout.write(`${name}: the proposal moved into ${moved}\n`);
    }
    return 0;
  } catch (error) {
    if (error.code === 'EEXIST' && verb === 'record') return problem(`${name} already has a record (${join(dir, RECORD_FILE)}) — mc programs show ${name} prints it; it is not replaced`);
    if (error.code === 'EEXIST') return problem(`programme ${name} exists — mc programs record ${name} --end "…" gives a directory without a record its record, and mc programs show ${name} prints what it has`);
    return problem(`could not write ${name}: ${error.message}`);
  }
}

/** `show`: one programme's record, or that it has none. Any caller may read. */
function showVerb({ positional, flags }, { env, stdout, stderr }) {
  const [name] = positional;
  const dir = join(programsHome(env), name);
  if (!existsSync(dir)) { stderr.write(`mc: no programme ${name} — ${dir} does not exist\n`); return 1; }
  const found = readRecord(dir);
  const view = recordView(found, { dir });
  if (flags.json) { stdout.write(`${JSON.stringify({ name, record: view }, null, 2)}\n`); return found.status === 'invalid' ? 1 : 0; }
  if (found.status === 'none') { stdout.write(`${name} has no record — mc programs record ${name} --end "…" gives it one\n`); return 0; }
  if (found.status === 'invalid') {
    stderr.write(`mc: ${name} has an invalid record (${join(dir, RECORD_FILE)}):\n${found.problems.map((text) => `  ${text}\n`).join('')}`);
    return 1;
  }
  const { horizon, end, state, created, created_by: by, phases, area } = found.record;
  stdout.write(`${name}\n  horizon  ${horizon ?? 'none'}\n${area ? `  area     ${area}\n` : ''}  end      ${end}\n  state    ${state}\n  created  ${created} by ${by}\n`);
  if (view.legacy) stdout.write('  legacy: not signed\n');
  if (view.signed_at) stdout.write(`  signed   ${view.signed_at} by ${view.signed_by}\n  signed_text  ${view.signed_text}\n`);
  if (view.designs_changed) stdout.write('  designs changed since sign-off\n');
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


/** The desk and document authors may commission a reading, never goal delivery or other readers. */
function reviewAuthor(env) {
  const role = normalizeSessionRole(env.MC_ROLE);
  if (role === 'manager') return true;
  if (role === 'martin') return env.MC_HEADLESS !== '1';
  if (role === PLAN_ROLE) return env.MC_HEADLESS !== '1' && !env.MC_GOAL;
  return !role && !env.MC_GOAL && env.MC_HEADLESS !== '1';
}

async function reviewVerb({ positional: [name, action, word] }, deps) {
  const { env, stdout, stderr } = deps;
  const target = { name, dir: join(programsHome(env), name) };
  const ctx = { env, stdout, stderr, read: readTextOrNull, write: writeFileAtomic, remove: unlinkSync,
    lock: deps.lock ?? realLock, now: deps.now ?? (() => new Date()), alive: deps.alive };
  if (action === 'verdict') return programmeVerdictVerb({ target, word, ctx, deps: deps.review ?? {} });
  if (!reviewAuthor(env)) { stderr.write('mc: only the manager, the interactive desk or programme plan, or a person calls a programme reading\n'); return 2; }
  const text = ctx.read(join(target.dir, 'README.md'));
  if (text === null) { stderr.write(`mc: ${name} has no README.md to read\n`); return 2; }
  const known = (deps.known ?? (() => knownRepositories(env)))().map((path) => ({ repo: repoNameOf(path), path }));
  const found = programmeRepositories(text, known);
  if (found.error) { stderr.write(`mc: ${found.error}\n`); return 2; }
  try { return await programmeReviewCall({ target, ctx, text, repos: found.repos, deps: deps.review ?? {} }); }
  catch (error) { stderr.write(`mc: programme-review ${name}: ${error.message}\n`); return 2; }
}

/** Sign checks the document and current independent reading inside the record writer's strict lock. */
function signVerb({ positional: [name], flags }, { env, stdout, stderr, now = new Date(), lock }) {
  if (env.MC_ROLE !== 'martin' || env.MC_HEADLESS === '1') {
    stderr.write('mc: only Martin at the desk signs a programme\n'); return 2;
  }
  const dir = join(programsHome(env), name);
  const reason = flags.reason?.trim() || null;
  let earlier = false;
  try {
    const result = signRecord(dir, { at: typeof now === 'function' ? now() : now, root: workRoot(env), ...(lock ? { lock } : {}),
      check: ({ text }) => {
        const problems = documentProblems(text);
        if (problems.length) return problems;
        // Martin signs at the desk: a reading of an earlier text counts, since edits made with him need no new reading.
        const reading = currentProgrammeReading(dir, text, undefined, { anyText: true });
        if (!reading) return [`${name} has no reading — mc programs review ${name}`];
        earlier = reading.earlier;
        if (reading.verdict === 'not-ok' && !reason) return [`${name}'s reading is NOT OK — repair PROGRAMME-REVIEW.md or sign with --reason "…"`];
        return [];
      },
    });
    if (!result.ok) {
      const problems = result.problems.length ? result.problems : [`${name} has no valid record — mc programs show ${name}`];
      for (const problem of problems) stderr.write(`mc: ${problem}\n`);
      return 1;
    }
    // The command owns the human record of the act, not another PROGRAMME.json key.
    const log = join(dir, 'LOG.md');
    const before = readTextOrNull(log) ?? '';
    writeFileAtomic(log, `${before}${before.endsWith('\n') || !before ? '' : '\n'}\n${result.record.signed_at} · martin · signed${reason ? ` — ${reason}` : ''}${earlier ? ' (the reading read an earlier text; the edits since were made at the desk)' : ''}\n`);
    stdout.write(`${name}: signed — goals may be cut\n`);
    wakeRunner(workRoot(env));
    return 0;
  } catch (error) { stderr.write(`mc: could not sign ${name}: ${error.message}\n`); return 1; }
}

/** Return is also the programme planner's safe ending; a goal planner has no such authority. */
function transitionVerb(verb, { positional: [name], flags }, { env, stdout, stderr, now = new Date(), lock, shelve = shelveProgramme }) {
  const martin = env.MC_ROLE === 'martin' && env.MC_HEADLESS !== '1';
  const planner = env.MC_ROLE === PLAN_ROLE && env.MC_PROGRAMME === name && !env.MC_GOAL;
  if (!(martin || (verb === 'return' && planner))) {
    stderr.write(`mc: only Martin at the desk${verb === 'return' ? ' or its programme planning turn returns' : ' drops'} a programme\n`);
    return 2;
  }
  const dir = join(programsHome(env), name);
  const reason = flags.reason.trim();
  try {
    const result = (verb === 'return' ? returnRecord : dropRecord)(dir, { root: workRoot(env), ...(lock ? { lock } : {}) });
    if (!result.ok) {
      for (const problem of result.problems.length ? result.problems : [`${name} has no valid record — mc programs show ${name}`]) stderr.write(`mc: ${problem}\n`);
      return 1;
    }
    const path = join(dir, 'RETURNED.md');
    const before = readTextOrNull(path) ?? '';
    const at = (typeof now === 'function' ? now() : now).toISOString();
    writeFileAtomic(path, `${before}${before.endsWith('\n') || !before ? '' : '\n'}\n${at} · ${env.MC_ROLE} · ${verb === 'return' ? 'returned to draft' : 'dropped'} — ${reason}\n`);
    if (verb === 'return') stdout.write(`${name}: returned to draft — ${reason}\n`);
    else {
      // No release, worktree cleanup, proposal move or restricted-data deletion: retain the whole draft.
      const destination = shelve(dir, name, env);
      stdout.write(`${name}: dropped — ${reason}\n  retained at ${destination}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`mc: could not ${verb} ${name}: ${error.message} — material retained; inspect ${dir}\n`);
    return 1;
  }
}

/** The most recent signature, not directory order, supplies the form of the next document. */
function modelVerb({ env, stdout, stderr }) {
  const signed = [];
  for (const home of [programsHome(env), archivedProgramsHome(env)]) {
    for (const name of listDirsOf(home)) {
      const dir = join(home, name);
      const found = readRecord(dir);
      if (found.status === 'valid' && found.record.signed_at && existsSync(join(dir, 'SIGNED.md'))) signed.push({ dir, at: found.record.signed_at });
    }
  }
  signed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.dir.localeCompare(b.dir));
  if (!signed.length) { stderr.write('mc: no programme document is signed yet\n'); return 1; }
  stdout.write(`${join(signed[0].dir, 'SIGNED.md')}\n`);
  return 0;
}
