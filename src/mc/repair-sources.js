/** Read repair evidence without giving the drafting session paths it can open. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { areasHome, FALLBACK_AREAS, listAllProposals } from './area-proposals.js';
import { digestDirs } from './helper-collect.js';
import { AREA_RE } from './programme-record.js';

export const sha256 = text => createHash('sha256').update(text).digest('hex');
const keyOf = (kind, ...identity) => sha256(JSON.stringify([kind, ...identity]));
const fileOrder = (a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const DATE_PROPOSAL = /^\d{4}-\d\d-\d\d-(?:mc|memoro)-.+\.md$/u;
const DIGEST_NAME = /^errors-(?:(memoro|memoro-cli)-)?\d{4}-\d\d-\d\d\.md$/u;
const FINGERPRINT = /^[\w.:-]{1,128}$/u;
const INPUT_LIMIT = 128 * 1024;
const OUTCOME = /^Utfall: ([^\r\n]+)\r?\n(?:\r?\n)?/u;

export function pendingProposals(env) {
  return listAllProposals(env).filter(row => DATE_PROPOSAL.test(row.file)).sort(fileOrder);
}

function regular(path) {
  try {
    const physical = realpathSync(path);
    return !/[\r\n`]/u.test(physical) && statSync(physical).isFile() ? physical : null;
  } catch { return null; }
}

function directory(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function read(path) {
  if (statSync(path).size > INPUT_LIMIT) throw new Error('source exceeds the repair reading limit');
  return readFileSync(path, 'utf8');
}

export const archivedProposal = path => join(dirname(path), 'archive', basename(path));

/** Active and archived references have the same identity; an ordinary order may already have moved the source. */
function proposalAt(given, env) {
  if (!DATE_PROPOSAL.test(basename(given))) return null;
  const path = regular(given) ?? regular(archivedProposal(given));
  if (!path) return null;
  const [repo, slug, folder, ...tail] = relative(directory(areasHome(env)), path).split(sep);
  const isArchived = tail.length === 2 && tail[0] === 'archive';
  const area = `${repo}/${slug}`;
  if (!AREA_RE.test(area) || folder !== 'proposals' || !(tail.length === 1 || isArchived)) return null;
  if (!DATE_PROPOSAL.test(basename(path))) return null;
  const live = isArchived ? join(dirname(dirname(path)), basename(path)) : path;
  return { path, live, repo, area, isArchived };
}

function errorAt(given, env, { moved = false } = {}) {
  if (!DIGEST_NAME.test(basename(given))) return null;
  const dirs = digestDirs(env).map(directory);
  const physical = regular(given);
  if (physical) return dirs.includes(dirname(physical)) && DIGEST_NAME.test(basename(physical)) ? physical : null;
  if (!moved || !dirs.includes(directory(dirname(given)))) return null;
  const found = dirs.map(dir => regular(join(dir, basename(given)))).filter(path => path && dirs.includes(dirname(path)));
  return new Set(found).size === 1 ? found[0] : null;
}

/** Use the fingerprint table, not analysis summaries or the alarm delta. */
function errorRows(path) {
  const repo = DIGEST_NAME.exec(basename(path))?.[1] ?? 'memoro';
  const heading = repo === 'memoro-cli' ? '## mc itself — this machine' : '## Error fingerprints';
  const lines = read(path).split(/\r?\n/u);
  const start = lines.indexOf(heading);
  const rows = new Map();
  for (let i = start + 1; start >= 0 && i < lines.length && !lines[i].startsWith('#'); i++) {
    const row = /^\| `([^`]+)` \| (\d+) \| ([^|]*) \| ([^|]*) \| (.*) \|$/u.exec(lines[i]);
    if (!row || !FINGERPRINT.test(row[1])) continue;
    const [, fingerprint, hits, status, lastSeen, message] = row;
    if (!rows.has(fingerprint)) rows.set(fingerprint, { fingerprint, hits, status, lastSeen, message });
  }
  return { repo, rows };
}

function field(text, name) {
  return new RegExp(`(?:^|[\\s(])(?:${name})\\s*[:=]\\s*` + '`?([\\w.:+/-]+)', 'iu').exec(text)?.[1] ?? null;
}

/** A report of an incident needs an original task, or both original clock time and build. */
function incidentOf(text) {
  const task = field(text, 'task[ _-]?id');
  if (task) return { task };
  const timestamp = field(text, '(?:incident[ _-])?timestamp');
  const build = field(text, 'build');
  if (!timestamp || !/^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || !build) return null;
  return { timestamp: new Date(timestamp).toISOString(), build };
}

function provenance(text, env) {
  const links = new Set();
  const possible = new Set();
  // Explicit pointers written in proposal prose; do not follow a general file link.
  for (const match of text.matchAll(/`(\/[^\r\n`]+)`|\]\((\/[^\r\n)]+)\)/gu)) {
    const path = match[1] ?? match[2];
    const proposal = proposalAt(path, env);
    if (proposal) links.add(keyOf('proposal', proposal.live));
    const error = errorAt(path, env, { moved: true });
    if (error) {
      const { repo, rows } = errorRows(error);
      const named = [...rows.keys()].filter(id => text.includes(`\`${id}\``) || field(text, 'fingerprint') === id);
      if (named.length === 1) links.add(keyOf('error', repo, named[0]));
      else for (const id of rows.keys()) possible.add(keyOf('error', repo, id));
    } else if (!proposal) {
      possible.add(keyOf('feedback', resolve(path)));
    }
  }
  return { links: [...links].sort(), possible: [...possible].sort() };
}

export function readRepairSource({ kind, given, fingerprint = null, env }) {
  try {
    if (kind === 'error') {
      const path = errorAt(given, env, { moved: true });
      if (!path) return { unreadable: true };
      const { repo, rows } = errorRows(path);
      const ids = [...rows.keys()].sort();
      if ((!fingerprint && ids.length > 1) || (fingerprint && !rows.has(fingerprint))) return { ids };
      const selected = rows.get(fingerprint ?? ids[0]);
      if (!selected) return { empty: true };
      const text = JSON.stringify(selected);
      return { repo, area: FALLBACK_AREAS[repo === 'memoro-cli' ? 'mc' : 'memoro'], text,
        ref: { kind, path, key: keyOf(kind, repo, selected.fingerprint), digest: sha256(text) } };
    }
    const proposal = kind === 'proposal' ? proposalAt(given, env) : null;
    const path = kind === 'proposal' ? proposal?.path : regular(given);
    if (!path) return { unreadable: true };
    const body = read(path);
    let outcome = proposal?.isArchived ? OUTCOME.exec(body) : null;
    const text = outcome ? body.slice(outcome[0].length) : body;
    if (proposal && !proposal.isArchived) {
      const previous = proposalAt(archivedProposal(proposal.live), env);
      if (previous?.isArchived) {
        const archived = read(previous.path);
        const decided = OUTCOME.exec(archived);
        if (decided && archived.slice(decided[0].length) === text) outcome = decided;
      }
    }
    const locator = incidentOf(text);
    if (kind === 'feedback' && !locator) return { missingLocator: true };
    const { links, possible } = provenance(text, env);
    return {
      text, locator, proposal, outcome: outcome?.[1] ?? null,
      repo: proposal?.repo ?? null, area: proposal?.area ?? null,
      ref: { kind, path, key: keyOf(kind, proposal?.live ?? path), digest: sha256(text),
        ...(locator ? { incident: sha256(JSON.stringify(locator)) } : {}), ...(links.length ? { links } : {}),
        ...(possible.length ? { possible } : {}) },
    };
  } catch { return { unreadable: true }; }
}
