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
export function deskBudget({ env = process.env, now = new Date(), read = readDeskText } = {}) {
  const text = read(deskSettingsPath(env));
  const ceiling = text == null ? null : JSON.parse(text).ceiling_usd_per_day;
  if (ceiling !== null && (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0)) throw new Error('desk.json ceiling_usd_per_day must be null or a non-negative number');
  const day = now.toISOString().slice(0, 10);
  const spent = readRunRows(read(deskRunsPath(env))).filter(row => ['desk-prepare', 'decision'].includes(row.kind) && String(row.ts).slice(0, 10) === day)
    .reduce((sum, row) => { const cost = Number(row.cost); return sum + (Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 10000) : 0); }, 0) / 10000;
  return { ceiling, spent, day, held: ceiling !== null && spent >= ceiling };
}
export function setDeskCeiling(ceiling, { env = process.env } = {}) {
  if (ceiling !== null && (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0)) throw new Error('ceiling must be a non-negative USD amount or off');
  writeJsonAtomic(deskSettingsPath(env), { ceiling_usd_per_day: ceiling });
}
export function deskBudgetReason(budget) { return `desk ceiling holds turns: $${budget.spent.toFixed(4)} today (UTC), ceiling $${budget.ceiling}`; }
