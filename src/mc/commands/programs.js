/**
 * `mc programs` — the programmes mc knows, every one of them.
 *
 *   mc programs list [--json]    one line per programme, sorted by name
 *   mc programs priority <programme>... --set <n>    prefer work within a stage
 *
 * The page draws only the programmes with work on them and folds the dormant
 * ones — no goal — into one line that points here. This is the
 * whole list, read from the same sources and through the same collector
 * (`readProgrammes`, page-collect.js), so a programme is active or dormant
 * here exactly when it is on the page. `mc programs` alone prints the usage.
 */
import { programsHome } from '../paths.js';
import { setProgrammePriorities, validPriority } from '../programme-priority.js';
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
  '*': { booleans: ['--json'], check: ({ positional }) => `mc programs has no ${positional[0]}` },
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const [verb] = argv.filter((word) => !word.startsWith('-'));
  const route = verb === undefined ? ROUTES[''] : (ROUTES[verb] || ROUTES['*']);
  const scanned = scanArgs(['list', 'priority'].includes(verb) ? argv.filter((word, at) => at !== argv.indexOf(verb)) : argv, route);
  if (!scanned.error && verb === undefined && !scanned.flags.json) { stdout.write(usage()); return 0; }
  const error = scanned.error || route.check(scanned);
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }

  const read = deps.read || (() => readProgrammes({ env: deps.env || process.env }));
  const listing = programmesListing(read());
  if (verb === 'priority') {
    try {
      const result = setProgrammePriorities(scanned.positional, Number(scanned.flags.set), {
        home: programsHome(deps.env || process.env), known: listing.programmes.map((item) => item.name),
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
export function programmesListing({ section, homes = {} }) {
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
    `priority ${item.priority}`,
    item.repos.join(',') || '—',
    item.goals ? `${plural(item.goals, 'goal')}${rollup ? ` · ${rollup}` : ''}` : 'no goal',
    plural(item.proposals, 'proposal'),
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
