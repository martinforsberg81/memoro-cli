/**
 * The one module that knows where intake comes from (design note §2–§3).
 *
 * Martin puts files in `pm-helper/intake/` — a screenshot, a line of text,
 * an error message. It is a mailbox, not a door: the helper never answers
 * him there (K1.2 unbroken). The convention is deliberately almost empty,
 * because everything Martin has to remember is a rule he will break:
 *
 *   - anything that is not `.md` is an attachment;
 *   - an `.md` with the same filename stem is its description, if he
 *     bothered — its absence is not an error;
 *   - whatever lands within the same quarter hour is assumed to belong
 *     together until something says otherwise.
 *
 * The PM's one design condition, honoured here: no provider layer for one
 * provider, but the intake READING concentrated in one place. This module
 * knows the path and the file forms; the rest of the helper consumes
 * finished items and knows nothing about where they came from — which makes
 * a future Memoro path a swap, not a demolition.
 *
 * Processing MOVES to `intake/processed/<date>/`, never deletes: Martin
 * must be able to go back to his own screenshot.
 */
import {
  mkdirSync, readFileSync, readdirSync, renameSync, statSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';

export const INTAKE_DIR = 'intake';
export const PROCESSED_DIR = 'processed';

/** The quarter hour: the whole grouping rule, as a number. */
const GROUP_MS = 15 * 60 * 1000;

/**
 * Every unprocessed intake item, oldest first.
 *
 * An item is a stem: its attachments (non-`.md` files sharing the stem),
 * its description (`<stem>.md`, when Martin wrote one), or a bare `.md`
 * standing alone as its own item. `group` ties together whatever landed in
 * the same quarter hour.
 */
export function listIntake(areaPath) {
  const directory = join(areaPath, INTAKE_DIR);
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== 'README.md' && !entry.name.startsWith('.'));
  } catch { return []; }

  const byStem = new Map();
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const stem = entry.name.slice(0, entry.name.length - extname(entry.name).length) || entry.name;
    let at = 0;
    try { at = statSync(path).mtimeMs; } catch { at = 0; }
    const item = byStem.get(stem) || { stem, files: [], description: null, at };
    item.at = Math.min(item.at, at) || at;
    if (extname(entry.name).toLowerCase() === '.md') {
      let text = null;
      try { text = readFileSync(path, 'utf8').trim() || null; } catch { text = null; }
      item.description = text;
      item.files.push(entry.name);
    } else {
      item.files.push(entry.name);
    }
    byStem.set(stem, item);
  }

  return [...byStem.values()]
    .sort((a, b) => a.at - b.at || a.stem.localeCompare(b.stem))
    .map((item) => ({
      stem: item.stem,
      files: item.files.sort(),
      description: item.description,
      at: new Date(item.at).toISOString(),
      group: Math.floor(item.at / GROUP_MS),
    }));
}

/**
 * Mark stems processed: their files move to `intake/processed/<date>/`.
 * Never a delete. A stem that names nothing is said, not skipped silently —
 * silence is the one forbidden outcome in this corner of the system.
 */
export function processIntake(areaPath, stems, { now = new Date() } = {}) {
  const directory = join(areaPath, INTAKE_DIR);
  const dated = join(directory, PROCESSED_DIR, now.toISOString().slice(0, 10));
  const items = listIntake(areaPath);
  const moved = [];
  const missing = [];
  for (const stem of stems) {
    const item = items.find((candidate) => candidate.stem === stem);
    if (!item) { missing.push(stem); continue; }
    mkdirSync(dated, { recursive: true, mode: 0o700 });
    for (const file of item.files) {
      renameSync(join(directory, file), join(dated, basename(file)));
      moved.push(file);
    }
  }
  return { moved, missing, to: dated };
}
