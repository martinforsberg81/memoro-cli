/** Waiting proposals by area (`~/mc/areas/<repo>/<area>/proposals/`), plus the total. */
import { statSync } from 'node:fs';
import { keyProposalsDir, listAllProposals } from '../area-proposals.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

export const ROUTES = {
  '': {
    booleans: ['--json'],
    check: ({ positional }) => (positional.length ? `mc proposals takes no positional (${positional.join(' ')})` : null),
  },
};

export function usage() {
  return commandUsage('proposals');
}

export function collectProposalCounts(env = process.env) {
  const counts = new Map();
  let total = 0;
  // The shared reader visits every area directory on disk, declared or not.
  // It reads names, never proposal contents or archives.
  for (const proposal of listAllProposals(env)) {
    if (!statSync(proposal.path, { throwIfNoEntry: false })?.isFile()) continue;
    total += 1;
    counts.set(proposal.area, (counts.get(proposal.area) || 0) + 1);
  }
  return {
    total,
    areas: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([area, count]) => ({ area, count, path: keyProposalsDir(area, env) })),
  };
}

export function listingText(summary) {
  const rows = [...summary.areas.map(({ area, count }) => [area, count]), ['Total', summary.total]];
  const width = Math.max(...rows.map(([name]) => name.length));
  return `proposals — ${summary.total} waiting\n${rows.map(([name, count]) => `  ${name.padEnd(width)}  ${count}`).join('\n')}\n`;
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, ROUTES['']);
  const error = scanned.error || ROUTES[''].check(scanned);
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }
  const summary = collectProposalCounts(deps.env || process.env);
  stdout.write(scanned.flags.json ? `${JSON.stringify(summary, null, 2)}\n` : listingText(summary));
  return 0;
}
