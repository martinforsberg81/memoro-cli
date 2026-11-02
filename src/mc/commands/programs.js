/**
 * `mc programs` — the programmes mc knows, every one of them.
 *
 *   mc programs list [--json]    one line per programme, sorted by name
 *
 * The page draws only the programmes with work on them and folds the dormant
 * ones — no project, no goal — into one line that points here. This is the
 * whole list, read from the same sources and through the same collector
 * (`readProgrammes`, page-collect.js), so a programme is active or dormant
 * here exactly when it is on the page. `mc programs` alone prints the usage.
 */
import { readProgrammes } from '../page-collect.js';
import { planProviders, statusRollup } from '../page-render.js';
import { scanArgs } from './flags.js';

export function usage() {
  return [
    'usage — mc programs list [--json]   every programme, one line each: active or dormant, its repositories,\n',
    '                                    projects with their states, goals and open plan sessions\n',
    '\n',
    'A programme is active with at least one project or goal, of any status; every other is dormant.\n',
    'The page draws the active ones and one line for the dormant; --json prints this list as data.\n',
  ].join('');
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, { booleans: ['--json'] });
  const [verb, ...rest] = scanned.positional;
  if (!scanned.error && verb === undefined && !scanned.flags.json) { stdout.write(usage()); return 0; }
  let error = scanned.error;
  if (!error && verb !== 'list') error = verb === undefined ? 'mc programs --json needs list' : `mc programs has no ${verb}`;
  if (!error && rest.length) error = `mc programs list takes no ${rest[0]}`;
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }

  const read = deps.read || (() => readProgrammes({ env: deps.env || process.env }));
  const listing = programmesListing(read());
  if (scanned.flags.json) { stdout.write(`${JSON.stringify(listing, null, 2)}\n`); return 0; }
  stdout.write(listingText(listing));
  return 0;
}

/**
 * Every programme as one record: the page's group, reduced to the facts this
 * list says. The repositories are the tree's (`homes`, where the programme is
 * a directory) and every project's and goal's, so a dormant programme still
 * says where it lives.
 */
export function programmesListing({ section, homes = {} }) {
  const programmes = (section.programmes || []).map((group) => ({
    name: group.programme,
    state: group.dormant ? 'dormant' : 'active',
    dormant: Boolean(group.dormant),
    repos: [...new Set([
      ...(homes[group.programme] || []),
      ...group.projects.map((project) => project.repo),
      ...(group.goals || []).flatMap((goal) => goal.repos || []),
    ].filter(Boolean))].sort(),
    projects: group.projects.length,
    statuses: Object.fromEntries(statusRollup(group.statuses)),
    goals: (group.goals || []).length,
    plan_sessions: planProviders(group),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const dormant = programmes.filter((item) => item.dormant).length;
  return { active: programmes.length - dormant, dormant, programmes };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The cells of one programme's line, in the page's words. */
function cells(item) {
  const rollup = statusRollup(item.statuses).map(([status, n]) => `${status} ${n}`).join(' · ');
  // planSessionWords' words, from the counts it was made of.
  const meta = Object.entries(item.plan_sessions).map(([provider, n]) => `${provider} ${n}`).join(' · ');
  return [
    item.name,
    item.state,
    item.repos.join(',') || '—',
    item.projects ? `${plural(item.projects, 'project')}${rollup ? ` · ${rollup}` : ''}` : 'no project yet',
    item.goals ? plural(item.goals, 'goal') : 'no goal',
    meta ? `plan ${meta}` : 'no plan session',
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
