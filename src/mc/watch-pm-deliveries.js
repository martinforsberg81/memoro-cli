/**
 * The delivery check (D-0170): did every order line reach its track?
 *
 * A track stood blocked one day, unable to build G5, because the order —
 * verbatim, complete, with its negative test — sat in an msr-design report
 * in PM's inbox, under the heading `Rad till spår 3:`, and never went the
 * last step. The track did the right thing: it stopped and said "I cannot
 * build on this" instead of guessing. The convention held; the channel
 * broke — and a check PM has to remember to run is the same kind of note
 * as the fault it would catch (D-0113), so this one runs in the round.
 *
 * Deterministic, no model, and deliberately not general: `msr-design →
 * msr-track-N` is the only channel with this form today, and the order
 * says to build for it — a second channel is a second order. For every
 * `RAD TILL SPÅR N:` line (any casing) in a file from msr-design under
 * PM's `inbox/archive/`, the order's text must appear in some file under
 * `msr-track-N`'s `inbox/` or its `archive/`. Matching is on a normalised
 * excerpt — whitespace collapsed, first stretch of the order — because a
 * relay may re-wrap a line but must not reword it. Quiet when everything
 * is delivered; one entry per undelivered order otherwise.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { workAreaPath } from './paths.js';

/** The convention's shape: the track number, then the order — usually quoted. */
const ORDER_LINE = /rad till spår (\d+)\s*:\s*(.+)/giu;

/** How much of the order has to be found. Long enough to be unique, short enough to survive a relay's trailing cut. */
const EXCERPT_CHARS = 60;

/**
 * Every order line in PM's archived msr-design reports that has not landed
 * in its track's inbox. `[{ track, source, at, excerpt }]`, oldest first —
 * or `[]`, which is the answer this check exists to keep true.
 */
export function undeliveredOrders({ env = process.env, read = readFileSync } = {}) {
  const pmArchive = join(workAreaPath('pm', env), 'inbox', 'archive');
  const reports = listFiles(pmArchive)
    .filter((name) => /msr-design/u.test(name))
    .sort();

  const missing = [];
  const inboxes = new Map();
  for (const name of reports) {
    const path = join(pmArchive, name);
    let body = '';
    try { body = String(read(path, 'utf8')); } catch { continue; }
    for (const order of ordersIn(body)) {
      const haystack = trackText({ track: order.track, env, read, inboxes });
      if (haystack === null) {
        missing.push({ track: order.track, source: name, at: modified(path), excerpt: order.excerpt, reason: `no msr-track-${order.track} inbox to look in` });
        continue;
      }
      if (!haystack.includes(order.needle)) {
        missing.push({ track: order.track, source: name, at: modified(path), excerpt: order.excerpt, reason: null });
      }
    }
  }
  return missing;
}

/** The order lines in one report: track number, display excerpt, match needle. */
export function ordersIn(body) {
  const found = [];
  for (const match of String(body).matchAll(ORDER_LINE)) {
    const track = Number(match[1]);
    // The quoted form is the convention (`RAD TILL SPÅR N: '<ordern>'`);
    // an unquoted line is taken as it stands. The closing quote may be on
    // a later line for a wrapped order — everything to the line's end is
    // the order's opening stretch, which is all the excerpt needs.
    const raw = match[2].replace(/^['"’]/u, '').replace(/['"’]\s*$/u, '');
    const needle = normalise(raw).slice(0, EXCERPT_CHARS);
    if (!needle) continue;
    found.push({ track, needle, excerpt: raw.slice(0, 80) });
  }
  return found;
}

/**
 * Everything in a track's inbox and archive, normalised, as one string —
 * read once per round however many orders point at the track. `null` when
 * the area does not exist: that is not "delivered", it is a different fact
 * and is said as one.
 */
function trackText({ track, env, read, inboxes }) {
  if (inboxes.has(track)) return inboxes.get(track);
  const inbox = join(workAreaPath(`msr-track-${track}`, env), 'inbox');
  const names = listFiles(inbox);
  const archived = listFiles(join(inbox, 'archive')).map((name) => join('archive', name));
  if (names.length === 0 && archived.length === 0 && !exists(inbox)) {
    inboxes.set(track, null);
    return null;
  }
  const pieces = [];
  for (const name of [...names, ...archived]) {
    try { pieces.push(String(read(join(inbox, name), 'utf8'))); } catch { /* a file that vanished mid-read is not a delivery */ }
  }
  const text = normalise(pieces.join('\n'));
  inboxes.set(track, text);
  return text;
}

/** One line per undelivered order, the way the knock says everything: place, time, text. */
export function deliveryLines(missing) {
  return missing.map((item) => `order to msr-track-${item.track} not delivered: "${item.excerpt}" `
    + `(${item.source}, ${minute(item.at)})${item.reason ? ` — ${item.reason}` : ''}`);
}

function normalise(value) {
  return String(value).replace(/\s+/gu, ' ');
}

function listFiles(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== 'README.md' && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch { return []; }
}

function exists(directory) {
  try { statSync(directory); return true; } catch { return false; }
}

function modified(path) {
  try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return null; }
}

function minute(at) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/u.exec(String(at || ''));
  return match ? `${match[1]}Z` : String(at || 'unknown time');
}
