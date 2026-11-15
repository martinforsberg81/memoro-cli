/**
 * `mc programs` — the programmes mc knows, every one of them.
 *
 *   mc programs list [--json]    one line per programme, sorted by name
 *   mc programs priority <programme>... --set <n>    prefer work within a stage
 *   mc programs create <programme> --end "…" [--horizon <slug>]    a new programme with its record
 *   mc programs record <programme> --end "…" [--horizon <slug>]    the record of an existing one
 *   mc programs show <programme> [--json]    one programme's record
 *
 * The page draws only the programmes with work on them and folds the dormant
 * ones — no goal — into one line that points here. This is the
 * whole list, read from the same sources and through the same collector
 * (`readProgrammes`, page-collect.js), so a programme is active or dormant
 * here exactly when it is on the page. `mc programs` alone prints the usage.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { programsHome } from '../paths.js';
import { setProgrammePriorities, validPriority } from '../programme-priority.js';
import {
  RECORD_FILE, newRecord, readRecord, recordPage, recordPageTemplate, recordView, writeRecord,
} from '../programme-record.js';
import { NAME_RE } from '../plan-schema.js';
import { reservedRoleHint, reservedRoleName } from '../roles.js';
import { normalizeSessionRole } from '../session-role.js';
import { readProgrammes } from '../page-collect.js';
import { planProviders, statusRollup } from '../page-render.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

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
  create: { strictValues: ['--end', '--horizon'], check: (scanned) => writeCheck('create', scanned) },
  record: { strictValues: ['--end', '--horizon'], check: (scanned) => writeCheck('record', scanned) },
  show: { booleans: ['--json'], check: ({ positional }) => (positional.length === 1 ? null : 'mc programs show needs one programme') },
  '*': { booleans: ['--json'], check: ({ positional }) => `mc programs has no ${positional[0]}` },
};

const VERBS = ['list', 'priority', 'create', 'record', 'show'];

/** What `create` and `record` refuse after the scan, before they read or write anything. */
function writeCheck(verb, { positional, flags }) {
  if (positional.length !== 1) return `mc programs ${verb} needs one programme name`;
  const [name] = positional;
  if (!NAME_RE.test(name)) return `"${name}" is not a programme name: lower-case letters, digits and hyphens, at most 64, starting with a letter or digit`;
  if (reservedRoleName(name)) return reservedRoleHint(name);
  if (flags.end === null || !flags.end.trim()) return `mc programs ${verb} needs --end "<a sentence saying when the programme is done>"`;
  if (flags.horizon !== null && !NAME_RE.test(flags.horizon)) return `--horizon "${flags.horizon}" is not a slug: lower-case letters, digits and hyphens, at most 64, starting with a letter or digit`;
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
  if (verb === 'show') return showVerb(scanned, { env, stdout, stderr });

  const read = deps.read || (() => readProgrammes({ env }));
  const home = programsHome(env);
  const listing = programmesListing(read(), { record: (name) => recordView(readRecord(join(home, name))) });
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

/** `create` and `record`: the caller is checked first; the whole request is validated before the first write. */
function writeVerb(verb, { positional, flags }, { env, stdout, stderr, read, canon, now = new Date() }) {
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
      stdout.write(`${name}: record written to ${join(dir, RECORD_FILE)} — state open\n`);
      return 0;
    }
    const exists = existsSync(dir) || (read ? read() : readProgrammes({ env })).section.programmes.some((group) => group.programme === name);
    if (exists) return problem(`programme ${name} exists — mc programs record ${name} --end "…" gives a directory without a record its record, and mc programs show ${name} prints what it has`);
    const template = recordPageTemplate(canon ? { canon } : {});
    if (template === null) return problem('could not read the programme record page template (canon/tasks/references/programme-record-readme.md) — nothing was made');
    const page = recordPage(template, { name, end: flags.end, horizon: flags.horizon });
    mkdirSync(home, { recursive: true });
    mkdirSync(dir);
    writeRecord(dir, newRecord({ horizon: flags.horizon, end: flags.end.trim(), createdBy: writer.by, now }));
    writeFileSync(join(dir, 'README.md'), page, { flag: 'wx' });
    for (const sub of ['goals', join('proposals', 'archive'), 'evidence']) mkdirSync(join(dir, sub), { recursive: true });
    stdout.write(`${name}: programme made at ${dir} — record state open, page README.md to fill in; mc goal new ${name}/<goal> makes its first goal\n`);
    return 0;
  } catch (error) {
    if (error.code === 'EEXIST') return problem(`programme ${name} exists — mc programs record ${name} --end "…" gives a directory without a record its record, and mc programs show ${name} prints what it has`);
    return problem(`could not write ${name}: ${error.message}`);
  }
}

/** `show`: one programme's record, or that it has none. Any caller may read. */
function showVerb({ positional, flags }, { env, stdout, stderr }) {
  const [name] = positional;
  const dir = join(programsHome(env), name);
  if (!NAME_RE.test(name) || !existsSync(dir)) { stderr.write(`mc: no programme ${name} — ${dir} does not exist\n`); return 1; }
  const found = readRecord(dir);
  const view = recordView(found);
  if (flags.json) { stdout.write(`${JSON.stringify({ name, record: view }, null, 2)}\n`); return found.status === 'invalid' ? 1 : 0; }
  if (found.status === 'none') { stdout.write(`${name} has no record — mc programs record ${name} --end "…" gives it one\n`); return 0; }
  if (found.status === 'invalid') {
    stderr.write(`mc: ${name} has an invalid record (${join(dir, RECORD_FILE)}):\n${found.problems.map((text) => `  ${text}\n`).join('')}`);
    return 1;
  }
  const { horizon, end, state, created, created_by: by } = found.record;
  stdout.write(`${name}\n  horizon  ${horizon ?? 'none'}\n  end      ${end}\n  state    ${state}\n  created  ${created} by ${by}\n`);
  return 0;
}
