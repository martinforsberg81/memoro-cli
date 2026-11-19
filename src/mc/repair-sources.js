/** Read repair evidence without giving the drafting session paths it can open. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { areaKeysOnDisk, areasHome, FALLBACK_AREAS, keyProposalsDir, listAllProposals } from './area-proposals.js';
import { digestDirs } from './helper-collect.js';
import { workRoot } from './paths.js';
import { AREA_RE } from './programme-record.js';
import { writeJsonAtomic } from './atomic-write.js';

export const sha256 = text => createHash('sha256').update(text).digest('hex');
const keyOf = (kind, ...identity) => sha256(JSON.stringify([kind, ...identity]));
const fileOrder = (a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const DATE_PROPOSAL = /^(\d{4}-\d\d-\d\d-(?:mc|memoro))-.+\.md$/u;
const DIGEST_NAME = /^errors-(?:(memoro|memoro-cli)-)?\d{4}-\d\d-\d\d\.md$/u;
const FINGERPRINT = /^[\w.:-]{1,128}$/u;
const INPUT_LIMIT = 128 * 1024;
const OUTCOME = /^Utfall: ([^\r\n]+)\r?\n(?:\r?\n)?/u;
const ARCHIVE_META = /^Repair archive: (\{[^\r\n]+\})\r?\n\r?\n/u;
const EVIDENCE = /^Repair evidence: ([a-f0-9]{64}) ([a-f0-9]{64})$/mu;

export function pendingProposals(env) {
  return listAllProposals(env).filter(row => DATE_PROPOSAL.test(row.file)).sort(fileOrder);
}

export function archivedProposals(env) {
  return areaKeysOnDisk(env).flatMap(area => {
    const dir = join(keyProposalsDir(area, env), 'archive');
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && DATE_PROPOSAL.test(entry.name))
      .map(entry => join(dir, entry.name));
  });
}

export const repairCasePath = (env, key) => join(workRoot(env), 'runner', 'repair-draft', `${key}.json`);
export function readRepairCase(env, key) {
  try { return JSON.parse(readFileSync(repairCasePath(env, key), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
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
export const versionedArchive = (live, digest) => join(dirname(archivedProposal(live)),
  `${DATE_PROPOSAL.exec(basename(live))[1]}-repair-resolved-${keyOf('proposal', live)}-${digest}.md`);

function archiveContent(body) {
  const outcome = OUTCOME.exec(body);
  if (!outcome) return { text: body };
  const contents = body.slice(outcome[0].length);
  const header = ARCHIVE_META.exec(contents);
  if (header && /^(?:resolved|declined)(?:\s|$)|^ordered in programme /u.test(outcome[1])) {
    try { return { outcome: outcome[1], text: contents.slice(header[0].length), meta: JSON.parse(header[1]) }; }
    catch { /* A legacy proposal may contain prose that looks like a header. */ }
  }
  return { outcome: outcome[1], text: contents };
}

/**
 * Record the outcome of the evidenced version, never remove a later waiting
 * proposal. Under the strict programme lock; archive and index precede unlink
 * so a retry can finish any of the three writes.
 */
export function settleRepairSources({ env, sources, programme, action, reason }) {
  const declining = action === 'decline';
  const outcome = declining ? `declined — ${programme}: ${reason.replace(/\s+/gu, ' ').trim()}` : `ordered in programme ${programme}`;
  for (const ref of sources) {
    const previous = readRepairCase(env, ref.key);
    let archive;
    if (ref.kind === 'proposal') {
      const live = ref.path;
      const location = proposalLocation(live, env);
      if (!location || location.isArchived || directory(dirname(live)) !== dirname(live)) continue;
      const source = readRepairSource({ kind: 'proposal', given: live, env });
      const waiting = lstatSync(live, { throwIfNoEntry: false });
      const current = source.ref?.key === ref.key && source.ref?.digest === ref.digest && (!waiting || waiting.isFile());
      const prior = current ? source : proposalArchives(live, env, ref.digest)
        .map(path => readRepairSource({ kind: 'proposal', given: path, env }))
        .find(found => found.ref?.key === ref.key && found.ref?.digest === ref.digest);
      if (prior?.outcome === outcome && prior.proposal.isArchived) archive = prior.proposal.path;
      else if (prior) {
        const target = archivedProposal(live);
        mkdirSync(dirname(target), { recursive: true });
        if (!lstatSync(dirname(target)).isDirectory()) throw new Error('proposal archive is not a directory owned by the area');
        if (!sameOutcome(target, outcome, prior.text)) {
          const save = (path, meta) => {
            try {
              writeFileSync(path, `Utfall: ${outcome}\n\n${meta ? `Repair archive: ${JSON.stringify(meta)}\n\n` : ''}${prior.text}`,
                { flag: 'wx', mode: 0o600 });
              return true;
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
              return sameOutcome(path, outcome, prior.text);
            }
          };
          if (save(target, null)) archive = target;
          else {
            // The ordered version is provenance; a later decline must not
            // rewrite that file, including when it was versioned itself.
            archive = declining ? declinedArchive(live, ref.digest, programme) : versionedArchive(live, ref.digest);
            if (!save(archive, { original: basename(live), programme })) throw new Error(`conflicting proposal outcome at ${archive}`);
          }
        } else archive = target;
      } else if (!declining && !waiting) {
        throw new Error(`cannot find the ordered proposal version: ${live}`);
      }
      writeJsonAtomic(repairCasePath(env, ref.key), { ...previous, ...(archive ? { archive } : {}),
        source: ref, status: declining ? 'declined' : 'ordered', programme, ...(declining ? { reason } : {}) });
      if (archive && current && waiting && readRepairSource({ kind: 'proposal', given: live, env }).ref?.digest === ref.digest) unlinkSync(live);
    } else {
      writeJsonAtomic(repairCasePath(env, ref.key), { ...previous, source: ref, programme,
        status: declining ? 'declined' : 'ordered', ...(declining ? { reason } : {}) });
    }
  }
}

function sameOutcome(path, outcome, text) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
  const found = archiveContent(readFileSync(path, 'utf8'));
  return found.outcome === outcome && found.text === text;
}

function declinedArchive(live, digest, programme) {
  return versionedArchive(live, digest).replace(/\.md$/u, `-declined-${sha256(programme)}.md`);
}

function proposalLocation(path, env) {
  if (!DATE_PROPOSAL.test(basename(path))) return null;
  const [repo, slug, folder, ...tail] = relative(directory(areasHome(env)), path).split(sep);
  const isArchived = tail.length === 2 && tail[0] === 'archive';
  const area = `${repo}/${slug}`;
  if (!AREA_RE.test(area) || folder !== 'proposals' || !(tail.length === 1 || isArchived)) return null;
  const live = isArchived ? join(dirname(dirname(path)), basename(path)) : path;
  return { path, live, repo, area, isArchived };
}

/** An exact archive path opens that version. A missing waiting path follows its latest resolution. */
function proposalAt(given, env) {
  if (!DATE_PROPOSAL.test(basename(given))) return null;
  const path = regular(given);
  if (path) return proposalLocation(path, env);
  const live = join(directory(dirname(given)), basename(given));
  const location = proposalLocation(live, env);
  if (!location || location.isArchived) return null;
  const paths = proposalArchives(live, env);
  return paths.length ? proposalLocation(paths[0], env) : null;
}

function proposalArchives(live, env, digest) {
  const canonical = archivedProposal(live);
  const latest = readRepairCase(env, keyOf('proposal', live)).archive;
  const version = digest && versionedArchive(live, digest);
  return [...new Set([latest, version, canonical].filter(path => typeof path === 'string' && dirname(path) === dirname(canonical))
    .map(regular).filter(path => path && dirname(path) === dirname(canonical)))];
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
      if (named.length === 1) {
        // A collector path can be overwritten. It corroborates identity, not a historical row.
        links.add(keyOf('error', repo, named[0]));
      } else for (const id of rows.keys()) possible.add(keyOf('error', repo, id));
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
    const archive = proposal?.isArchived ? archiveContent(body) : null;
    const text = archive?.text ?? body;
    const digest = sha256(text);
    if (archive?.meta?.original && typeof archive.meta.original === 'string' && DATE_PROPOSAL.test(archive.meta.original)
      && basename(archive.meta.original) === archive.meta.original) {
      const live = join(dirname(proposal.live), archive.meta.original);
      if (path === versionedArchive(live, digest) || (archive.meta.programme && path === declinedArchive(live, digest, archive.meta.programme))) proposal.live = live;
    }
    let outcome = archive?.outcome;
    if (proposal && !proposal.isArchived) {
      for (const path of proposalArchives(proposal.live, env, digest)) {
        const decided = archiveContent(read(path));
        if (decided.outcome && decided.text === text) { outcome = decided.outcome; break; }
      }
    }
    const locator = incidentOf(text);
    if (kind === 'feedback' && !locator) return { missingLocator: true };
    const { links, possible } = provenance(text, env);
    const evidence = new Map();
    for (const recorded of [EVIDENCE.exec(text)?.slice(1), archive?.meta?.evidence]) {
      if (Array.isArray(recorded) && recorded.length === 2 && recorded.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) {
        evidence.set(recorded[0], new Set([recorded[1]]));
      }
    }
    return {
      text, locator, proposal, evidence, outcome: outcome ?? null,
      repo: proposal?.repo ?? null, area: proposal?.area ?? null,
      ref: { kind, path, key: keyOf(kind, proposal?.live ?? path), digest,
        ...(locator ? { incident: sha256(JSON.stringify(locator)) } : {}), ...(links.length ? { links } : {}),
        ...(possible.length ? { possible } : {}) },
    };
  } catch { return { unreadable: true }; }
}
