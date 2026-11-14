/** Read-only report of choices recorded in jev's append-only ledger. */
import { readFileSync } from 'node:fs';
import { commandUsage } from '../command-help.js';
import { ledgerPath, fixed } from '../jev.js';
import { mcHome } from '../paths.js';
import { scanArgs } from './flags.js';

export const ROUTES = { '': { strictValues: ['--since', '--programme'], booleans: ['--json'], check: ({ positional }) => positional.length ? `mc decisions takes no positional (${positional.join(' ')})` : null } };
const PRODUCT_READING_FLAG = 0.70;

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const scanned = scanArgs(argv, ROUTES['']);
  const error = scanned.error || ROUTES[''].check(scanned);
  const { since, programme, json } = scanned.flags;
  const validSince = !since || (/^\d{4}-\d{2}-\d{2}$/u.test(since) && !Number.isNaN(Date.parse(`${since}T00:00:00Z`)) && new Date(`${since}T00:00:00Z`).toISOString().slice(0, 10) === since);
  if (error || !validSince || (programme && !/^[a-z][a-z0-9-]*$/u.test(programme))) {
    stderr.write(`mc: ${error || (!validSince ? '--since must be a real YYYY-MM-DD date' : '--programme must be a programme name')}\n${usage()}`);
    return 2;
  }
  const path = ledgerPath(mcHome(env));
  let text;
  try { text = (deps.readFile || readFileSync)(path, 'utf8'); }
  catch { stdout.write('mc decisions: nothing to report\n'); return 0; }
  const now = deps.now ? deps.now() : new Date();
  const from = since || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = [];
  for (const [index, line] of text.split(/\n/u).entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { stderr.write(`mc decisions: ${path}:${index + 1}: unparseable ledger line\n`); continue; }
    if (!['decided', 'answered'].includes(row.outcome) || typeof row.at !== 'string' || row.at.slice(0, 10) < from || (programme && row.programme !== programme)) continue;
    const chosen = row.outcome === 'decided' ? row.recommend : row.answers?.answer?.choice;
    const option = row.options?.[chosen] ?? '';
    const reading = readingOf(row);
    const product_flag = row.outcome === 'decided' && row.answers?.product >= PRODUCT_READING_FLAG;
    rows.push({ at: row.at, programme: row.programme ?? null, goal: row.goal ?? null, kind: row.kind ?? '-', question: String(row.question || '').replace(/\s*\n\s*/gu, ' '), chosen, option, reading, ...(row.answers?.answer?.choice && row.answers.answer.choice !== chosen ? { jev_preferred: row.answers.answer.choice } : {}), ...(product_flag ? { product_flag: true } : {}) });
  }
  rows.sort((a, b) => (b.product_flag ? 1 : 0) - (a.product_flag ? 1 : 0) || b.at.localeCompare(a.at));
  if (json) stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else if (!rows.length) stdout.write('mc decisions: nothing to report\n');
  else stdout.write(`${rows.map((row) => `${row.at}  ${row.programme ?? '-'}${row.goal ? `/${row.goal.split('/').at(-1)}` : ''}  ${row.kind}  ${row.question}\n  chose ${row.chosen}: ${row.option}  jev: ${row.reading}${row.jev_preferred ? `  jev preferred ${row.jev_preferred}` : ''}${row.product_flag ? '  jev read this as a product choice' : ''}`).join('\n')}\n`);
  return 0;
}

function readingOf(row) {
  const answers = row.answers;
  if (!answers?.answer) return row.reason || 'jev unavailable';
  const choice = answers.answer.choice;
  return `${choice} (p ${fixed(answers.answer.probabilities?.[choice])}, fits ${fixed(answers.fits)}, settled ${fixed(answers.settled)}${typeof answers.product === 'number' ? `, product ${fixed(answers.product)}` : ''}, ${row.model || '-'})`;
}

export function usage() { return commandUsage('decisions'); }
