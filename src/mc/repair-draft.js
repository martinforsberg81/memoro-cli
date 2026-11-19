/** Internal Part 2 entry. The CLI must not dispatch to it before release ships. */
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { FALLBACK_AREAS, keyProposalsDir } from './area-proposals.js';
import { writeJsonAtomic } from './atomic-write.js';
import { scanArgs } from './commands/flags.js';
import { archivedProgramsHome, programsHome, workRoot } from './paths.js';
import { AREA_RE, createProgramme, linkRepairSource, newRecord, readRecord, recordedProgrammes } from './programme-record.js';
import { NAME_RE } from './plan-schema.js';
import { judgeRepair } from './repair-session.js';
import { archivedProposal, archivedProposals, pendingProposals, readRepairCase, readRepairSource, repairCasePath, versionedArchive } from './repair-sources.js';
import { realLock } from './runner-lock.js';

const ROUTE = { strictValues: ['--proposal', '--feedback', '--error', '--fingerprint'] };
const REPOS = ['memoro', 'memoro-cli'];
const oneLine = (value, max = 400) => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= max && !/[\r\n\p{Cc}]/u.test(value);
const paragraph = value => value.replace(/^([#>])/u, '\\$1');
const label = name => String(name).replace(/[\p{Cc}]/gu, '?');
const read = path => { try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const foundIn = (outcome, pattern) => outcome?.match(pattern)?.[1];
const fallbackArea = repo => FALLBACK_AREAS[repo === 'memoro-cli' ? 'mc' : 'memoro'];

function orders(env) {
  return [programsHome(env), archivedProgramsHome(env)].flatMap(home => recordedProgrammes(home).flatMap(name => {
    const dir = join(home, name);
    const found = readRecord(dir);
    return found.status === 'valid' ? [{ name, dir, record: found.record, archived: home !== programsHome(env) }] : [];
  }));
}

function linkStrength(a, b) {
  if (a.key === b.key && a.incident && b.incident && a.incident !== b.incident) return 'possible';
  if (a.key === b.key || a.links?.includes(b.key) || b.links?.includes(a.key)
    || a.links?.some(key => b.links?.includes(key))) return 'certain';
  if (a.incident && a.incident === b.incident
    && ((b.kind === 'feedback' && a.possible?.includes(b.key)) || (a.kind === 'feedback' && b.possible?.includes(a.key)))) return 'certain';
  if ((a.incident && a.incident === b.incident) || a.possible?.includes(b.key) || b.possible?.includes(a.key)
    || a.possible?.some(key => b.links?.includes(key)) || b.possible?.some(key => a.links?.includes(key))) return 'possible';
  return null;
}

function owningOrder(source, all, env) {
  const ordered = foundIn(source.outcome, /^ordered in(?: programme)? ([a-z0-9-]+)$/u);
  if (ordered) return { ordered };
  const matches = [];
  let possible = false;
  for (const order of all) {
    const { record, dir } = order;
    if (record.repair) {
      const strengths = record.repair.sources.map(known => linkStrength(source.ref, known));
      if (strengths.includes('certain')) matches.push(order);
      else if (!order.archived && record.state !== 'done' && strengths.includes('possible')) possible = true;
    } else if (record.area) {
      // The ordinary writer places this exact pointer before trying to archive.
      const page = read(join(dir, 'README.md'));
      const archived = page?.match(/^Ordered from the proposal `(\/[^\r\n`]+)`\.$/mu)?.[1];
      if (!archived) continue;
      if (source.proposal && archived === archivedProposal(source.proposal.live)) matches.push(order);
      else {
        // For a desk archive that failed, its README already points one level below the waiting source.
        const desk = readRepairSource({ kind: 'proposal', given: archived, env });
        const live = desk.ref ? desk : readRepairSource({ kind: 'proposal', given: resolve(dirname(archived), '..', basename(archived)), env });
        if (!live.ref) continue;
        const strength = linkStrength(source.ref, live.ref);
        if (strength === 'certain') matches.push(order);
        else if (!order.archived && record.state !== 'done' && strength === 'possible') possible = true;
      }
    }
  }
  if (matches.length > 1 || (!matches.length && possible)) return { possible: true };
  const [order] = matches;
  if (!order) return {};
  if (order.record.repair?.stop_item && !order.archived) return { stopped: order };
  if (order.record.repair && order.record.state === 'draft' && !order.archived) return { draft: order };
  return { ordered: order.name };
}

function writeCase(env, ref, state) {
  const previous = ref.kind === 'proposal' ? readRepairCase(env, ref.key).archive : null;
  writeJsonAtomic(repairCasePath(env, ref.key), { ...(previous ? { archive: previous } : {}), ...state, source: ref });
}

function archiveStatus(outcome) {
  if (/^(?:ej aktuellt|declined)(?:\s|$)/iu.test(outcome ?? '')) return 'declined';
  if (/^resolved(?:\s|$)/iu.test(outcome ?? '')) return 'resolved';
  return null;
}

/** An archive can close an evidenced version, not every occurrence of a defect. */
function archivedDisposition(source, env) {
  const statuses = new Set();
  let possible = false;
  for (const given of archivedProposals(env)) {
    const candidate = readRepairSource({ kind: 'proposal', given, env });
    const status = archiveStatus(candidate.outcome);
    if (!status || !candidate.proposal?.isArchived) continue;
    // The selected proposal's own path was already checked against its archived content.
    if (source.ref.key === candidate.ref.key) continue;
    const versions = candidate.evidence.get(source.ref.key);
    if (versions) {
      if (versions.has(source.ref.digest)) statuses.add(status);
      continue;
    }
    const strength = linkStrength(source.ref, candidate.ref);
    if (source.ref.kind === 'proposal') {
      const shared = [...source.evidence].filter(([key]) => candidate.evidence.has(key));
      const unchanged = shared.filter(([key, digests]) => [...digests].some(digest => candidate.evidence.get(key).has(digest)));
      if (shared.length && !unchanged.length) continue;
      if (strength === 'certain' && (source.ref.digest === candidate.ref.digest
        || (shared.length > 0 && unchanged.length === shared.length))) statuses.add(status);
      else if (strength) possible = true;
      continue;
    }
    // Legacy prose has no feedback digest. A source link and matching incident corroborate it.
    if (strength === 'certain' && source.ref.kind === 'feedback'
      && source.ref.incident === candidate.ref.incident) statuses.add(status);
    else if (strength) possible = true;
  }
  if (statuses.size === 1) return [...statuses][0];
  return possible || statuses.size > 1 ? 'ambiguous' : null;
}

function waitingMatch(source, env) {
  if (source.ref.kind === 'proposal') return {};
  const matches = [];
  let possible = false;
  for (const { path } of pendingProposals(env)) {
    const candidate = readRepairSource({ kind: 'proposal', given: path, env });
    if (!candidate.ref || candidate.outcome || candidate.proposal.isArchived) continue;
    const strength = linkStrength(source.ref, candidate.ref);
    if (strength === 'certain') matches.push(candidate);
    if (strength === 'possible') possible = true;
  }
  if (matches.length === 1) return { proposal: matches[0] };
  return { possible: matches.length > 1 || possible };
}

function decisionFor(source, all, ctx) {
  const previous = readRepairCase(ctx.env, source.ref.key);
  const generated = previous.proposal && readRepairSource({ kind: 'proposal', given: previous.proposal, env: ctx.env });
  const status = archiveStatus(source.outcome);
  if (status) return { status };
  let owner = owningOrder(source, all, ctx.env);
  if (!Object.keys(owner).length && generated?.ref) owner = owningOrder(generated, all, ctx.env);
  if (owner.ordered) return { status: 'ordered', name: owner.ordered };
  if (owner.stopped) return { status: 'stopped', name: owner.stopped.name, item: owner.stopped.record.repair.stop_item };
  if (owner.draft) {
    // Keep new references on the order, not inferred from mutable Markdown.
    linkRepairSource(owner.draft.dir, owner.draft.record, source.ref);
    return { status: 'resume', name: owner.draft.name };
  }
  if (owner.possible) return { status: 'ambiguous' };
  if (source.proposal?.isArchived) return { status: 'ambiguous' }; // Unknown archive disposition is not intake.
  const archived = archivedDisposition(source, ctx.env);
  if (archived) return { status: archived };
  if (previous.source?.digest === source.ref.digest && previous.status) return { status: previous.status };
  if (generated?.ref && !generated.proposal.isArchived && !generated.outcome) source.associated = generated;
  else {
    const waiting = waitingMatch(source, ctx.env);
    if (waiting.possible) return { status: 'ambiguous' };
    source.associated = waiting.proposal;
  }
  return null;
}

function generatedProposal(source, repo, area, summary, now, env) {
  if (source.proposal) return source.proposal.live;
  if (source.associated) {
    const path = source.associated.proposal.live;
    writeCase(env, source.ref, { proposal: path });
    return path;
  }
  const previous = readRepairCase(env, source.ref.key);
  const archived = previous.proposal && existsSync(archivedProposal(previous.proposal));
  const day = now.toISOString().slice(0, 10);
  const system = repo === 'memoro-cli' ? 'mc' : 'memoro';
  const suffix = archived ? `-${source.ref.digest}` : '';
  const path = !archived && previous.proposal ? previous.proposal
    : join(keyProposalsDir(area, env), `${day}-${system}-repair-${source.ref.key}${suffix}.md`);
  const incident = source.locator?.task ? `Task ID: ${source.locator.task}`
    : source.locator ? `Incident timestamp: ${source.locator.timestamp}; build: ${source.locator.build}` : null;
  const fingerprint = source.ref.kind === 'error' ? `Fingerprint: \`${JSON.parse(source.text).fingerprint}\`` : null;
  // No raw feedback, log message, user text or attachments are copied.
  const prose = [`# ${summary}`, `Evidence for ${repo}, from \`${source.ref.path}\`.`, incident, fingerprint,
    `Repair evidence: ${source.ref.key} ${source.ref.digest}`].filter(Boolean).join('\n\n');
  writeCase(env, source.ref, { proposal: path });
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, `${prose}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return path;
}

function archiveResolved(primary, source, reason) {
  const path = primary.proposal.live;
  const archived = archivedProposal(path);
  mkdirSync(dirname(archived), { recursive: true });
  if (!lstatSync(dirname(archived)).isDirectory()) throw new Error('proposal archive is not a directory owned by the area');
  const evidence = source.ref.key === primary.ref.key ? {} : { evidence: [source.ref.key, source.ref.digest] };
  const text = meta => `Utfall: resolved — ${reason}\n\n`
    + (Object.keys(meta).length ? `Repair archive: ${JSON.stringify(meta)}\n\n` : '') + primary.text;
  const save = (target, contents) => {
    try { writeFileSync(target, contents, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return lstatSync(target, { throwIfNoEntry: false })?.isFile() && read(target) === contents;
    }
    return true;
  };
  if (save(archived, text(evidence))) return archived;
  const versioned = versionedArchive(path, primary.ref.digest);
  if (save(versioned, text({ original: basename(path), ...evidence }))) return versioned;
  throw new Error(`the proposal archive already has a different resolution at ${versioned}`);
}

function draftPage(answer, refs, proposal) {
  const { name, title, repositories, end, reason, today, parts } = answer;
  if (!oneLine(name, 64) || !NAME_RE.test(name) || !oneLine(title) || !oneLine(end) || !oneLine(reason)
    || !oneLine(today, 800) || !Array.isArray(repositories) || !repositories.length
    || new Set(repositories).size !== repositories.length || !repositories.every(repo => REPOS.includes(repo))
    || !Array.isArray(parts) || parts.length < 3 || parts.length > 8
    || !parts.every(part => part && ['name', 'closes', 'solution', 'design', 'provedBy', 'notInPart'].every(key => oneLine(part[key], 1000)))) {
    throw new Error('repair session did not return a complete programme document');
  }
  const lines = [
    `# ${name} — ${title}`, '', paragraph(reason), '', `Repositories: ${repositories.join(', ')}.`, '',
    '## What it is for', '', paragraph(title), '', '## End', '', paragraph(end), '',
    '## Why', '', 'Restores existing functionality within Martin’s repair remit (2026-11-18, System area).', '',
    '## What runs today', '', paragraph(today), '', '## Parts', '',
  ];
  for (const [index, part] of parts.entries()) lines.push(
    `### Part ${index + 1} — ${part.name}`, '', `Closes: ${part.closes}`, '', `Solution: ${part.solution}`, '',
    `Design: ${part.design}`, '', `Proved by: ${part.provedBy}`, '', `Not in this part: ${part.notInPart}`, '',
  );
  lines.push('## Order', '', 'Read the repair order before release; cut the numbered parts in order.', '',
    '## Decided', '', 'Restore the intended behaviour without creating new functionality.', '',
    '## Not built', '', 'New functionality or user-visible design decisions outside this repair.', '',
    '## Read', '', paragraph(reason), '', '## Where things are', '');
  for (const path of new Set([...refs.map(ref => ref.path), proposal])) lines.push(`- \`${path}\``);
  return `${lines.join('\n')}\n`;
}

function settle(source, answer, ctx) {
  if (!answer || !oneLine(answer.reason, 800)
    || !['draft', 'resolved', 'insufficient', 'ambiguous'].includes(answer.status)) {
    throw new Error('repair session did not return a valid decision');
  }
  const repo = source.repo ?? source.associated?.repo ?? answer.repository;
  if (!REPOS.includes(repo)) throw new Error('repair session did not identify the affected repository');
  if (answer.area && (!AREA_RE.test(answer.area) || !answer.area.startsWith(`${repo}/`))) throw new Error('repair session did not identify a valid area');
  const area = answer.area || source.area || fallbackArea(repo);
  const now = ctx.now();
  if (answer.status === 'draft') {
    if (!answer.repositories?.includes(repo)) throw new Error('repair order omits the source repository');
    draftPage(answer, [source.ref], source.ref.path); // Validate the whole order before writing.
  }
  const proposal = generatedProposal(source, repo, area, oneLine(answer.summary) ? answer.summary : 'Repair report', now, ctx.env);
  const primary = readRepairSource({ kind: 'proposal', given: proposal, env: ctx.env });
  if (!primary.ref || primary.proposal.isArchived) throw new Error('the proposal is no longer waiting');
  if (answer.status !== 'draft') {
    const archive = answer.status === 'resolved' ? archiveResolved(primary, source, answer.reason) : null;
    const disposition = { status: answer.status, reason: answer.reason };
    writeCase(ctx.env, source.ref, { proposal, ...disposition, ...(archive ? { archive } : {}) });
    if (primary.ref.key !== source.ref.key) {
      writeCase(ctx.env, primary.ref, { ...disposition, ...(archive ? { archive } : {}) });
    }
    if (archive) unlinkSync(proposal);
    return { status: answer.status };
  }
  const sources = source.ref.key === primary.ref.key ? [source.ref] : [source.ref, primary.ref];
  const home = programsHome(ctx.env);
  if (existsSync(join(archivedProgramsHome(ctx.env), answer.name))) throw new Error(`programme ${answer.name} already exists in the archive`);
  mkdirSync(home, { recursive: true });
  createProgramme(join(home, answer.name), draftPage(answer, sources, proposal),
    newRecord({ end: answer.end, createdBy: 'repair', now, stated: true, repair: { sources } }));
  return { status: 'draft', name: answer.name };
}

const orderReading = all => all.filter(order => !order.archived && order.record.state !== 'done')
  .map(({ name, record }) => ({ name, end: record.end, repair: record.repair, state: record.state }));
const orderVersion = all => JSON.stringify(orderReading(all));

async function draftOne(request, source, ctx) {
  const locked = fn => ctx.lock(workRoot(ctx.env), fn, { strict: true, name: 'repair-draft' });
  const reread = () => {
    const current = readRepairSource(request);
    if (!current.ref || current.ref.key !== source.ref.key || current.ref.digest !== source.ref.digest) {
      throw new Error('repair source changed while it was being read; run again');
    }
    return current;
  };
  const start = locked(() => {
    const current = reread();
    const all = orders(ctx.env);
    return { outcome: decisionFor(current, all, ctx), all, current };
  });
  if (start.outcome) return start.outcome;
  const answer = await ctx.judge({ source: start.current, orders: orderReading(start.all).map(({ name, end }) => ({ name, end })), env: ctx.env });
  return locked(() => {
    const current = reread();
    const all = orders(ctx.env);
    const outcome = decisionFor(current, all, ctx);
    if (outcome) return outcome;
    if (orderVersion(all) !== orderVersion(start.all)) throw new Error('open orders changed while this source was being read; run again');
    if (current.associated?.ref.path !== start.current.associated?.ref.path
      || current.associated?.ref.digest !== start.current.associated?.ref.digest) {
      throw new Error('related proposal changed while the source was being read; run again');
    }
    return settle(current, answer, ctx);
  });
}

function message(result, path) {
  switch (result.status) {
    case 'draft': return `repair programme ${result.name} is draft — source ${path}`;
    case 'resume': return `resuming repair programme ${result.name}`;
    case 'ordered': return `source already ordered in ${result.name}`;
    case 'stopped': return `repair programme ${result.name} is at Martin (item ${result.item})`;
    case 'resolved': return `${path} — already fixed`;
    case 'declined': return `${path} — previously declined`;
    case 'insufficient': return `${path} — insufficient evidence; proposal retained`;
    case 'ambiguous': return `possible duplicate for ${path}; no order made`;
    default: throw new Error('unknown repair decision');
  }
}

export async function runRepairDraft(argv, deps = {}) {
  const { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
    lock = realLock, judge = judgeRepair, now = () => new Date() } = deps;
  const say = text => { stdout.write(`mc: ${text}\n`); return 0; };
  const fail = (text, code) => { stderr.write(`mc: ${text}\n`); return code; };
  const { flags, error, positional } = scanArgs(argv, ROUTE);
  const selected = ['proposal', 'feedback', 'error'].filter(key => flags[key] !== null);
  if (error || positional.length || selected.length > 1 || (flags.fingerprint !== null && !flags.error)
    || selected.some(kind => !flags[kind]?.trim()) || new Set(argv.filter((_, index) => index % 2 === 0)).size * 2 !== argv.length) {
    return fail(`${error ? `${error} — ` : ''}use mc repair [--proposal <path> | --feedback <file> | --error <digest-file> [--fingerprint <id>]]`, 2);
  }
  const [kind] = selected;
  const requests = kind ? [{ kind, given: resolve(cwd, flags[kind]), fingerprint: flags.fingerprint, env }]
    : pendingProposals(env).map(({ path }) => ({ kind: 'proposal', given: path, env }));
  try {
    for (const request of requests) {
      const source = readRepairSource(request);
      if (source.unreadable && kind) return fail(`cannot read repair source ${label(request.given)}`, 1);
      if (source.missingLocator) return fail('feedback needs a task ID or incident timestamp and build', 2);
      if (source.ids) return fail(`select a defect — mc repair --error ${label(request.given)} --fingerprint <id>\n${source.ids.map(id => `  ${id}`).join('\n')}`, 2);
      if (!source.ref) continue;
      const result = await draftOne(request, source, { env, lock, judge, now });
      if (kind || ['resume', 'draft'].includes(result.status)) return say(message(result, source.ref.path));
    }
    return say('no repair ready to order');
  } catch (e) {
    return fail(e.message, 1);
  }
}
