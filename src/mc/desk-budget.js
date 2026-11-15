/** Shared admission reading for unattended preparation and decision turns. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { readRunRows } from './landed.js';
import { runnerDir } from './paths.js';

export const deskSettingsPath = (env = process.env) => join(runnerDir(env), 'desk.json');
export const deskRunsPath = (env = process.env) => join(runnerDir(env), 'log', 'runs.tsv');
export function readDeskText(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** The cost of desk rows in USD: a row without a readable, non-negative cost adds nothing; summed in 1/10000 dollars. */
export function costSum(rows) {
  return rows.reduce((sum, row) => { const cost = Number(row.cost); return sum + (Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 10000) : 0); }, 0) / 10000;
}
/** The daily ceiling in USD, or null when it is off; a setting that is not one is an error. Reads desk.json and nothing else. */
export function deskCeiling({ env = process.env, read = readDeskText } = {}) {
  const text = read(deskSettingsPath(env));
  const ceiling = text == null ? null : JSON.parse(text).ceiling_usd_per_day;
  if (ceiling !== null && (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0)) throw new Error('desk.json ceiling_usd_per_day must be null or a non-negative number');
  return ceiling;
}
export function deskBudget({ env = process.env, now = new Date(), read = readDeskText } = {}) {
  const ceiling = deskCeiling({ env, read });
  const day = now.toISOString().slice(0, 10);
  const spent = costSum(readRunRows(read(deskRunsPath(env))).filter(row => ['desk-prepare', 'decision', 'learning', 'ask-reader'].includes(row.kind) && String(row.ts).slice(0, 10) === day));
  return { ceiling, spent, day, held: ceiling !== null && spent >= ceiling };
}
export function setDeskCeiling(ceiling, { env = process.env } = {}) {
  if (ceiling !== null && (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0)) throw new Error('ceiling must be a non-negative USD amount or off');
  writeJsonAtomic(deskSettingsPath(env), { ceiling_usd_per_day: ceiling });
}
export function deskBudgetReason(budget) { return `desk ceiling holds turns: $${budget.spent.toFixed(4)} today (UTC), ceiling $${budget.ceiling}`; }
