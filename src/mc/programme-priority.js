/** Programme preferences, read anew for each scheduling choice and page. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { programsHome } from './paths.js';

export const PRIORITY_FILE = 'PRIORITY.json';
export const validPriority = (value) => Number.isSafeInteger(value) && value >= 0;
const validName = (name) => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(name);
const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

/** Absent or malformed preferences preserve the default scheduling order. */
export function readProgrammePriority(programme, { home = programsHome(), read = readText } = {}) {
  if (!validName(programme)) return 0;
  try {
    const value = JSON.parse(read(join(home, programme, PRIORITY_FILE)))?.priority;
    return validPriority(value) ? value : 0;
  } catch { return 0; }
}

/** Validate the entire request before any write; each programme has its own atomic file. */
export function setProgrammePriorities(names, priority, { home = programsHome(), known = [] } = {}) {
  if (!validPriority(priority)) return { ok: false, reason: 'priority must be a non-negative safe whole number' };
  const unknown = names.find((name) => !validName(name) || !known.includes(name));
  if (unknown !== undefined) return { ok: false, reason: `unknown programme: ${unknown}` };
  const programmes = [...new Set(names)];
  for (const name of programmes) writeJsonAtomic(join(home, name, PRIORITY_FILE), { priority });
  return { ok: true, programmes, priority };
}
