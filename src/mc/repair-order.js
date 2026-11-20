/** Drive one repair draft through independent review, bounded revision and release. */
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { run as reviewProgramme } from './commands/programs.js';
import { deskItemId, itemDirectory, readDeskItem, writeDeskItem } from './desk-items.js';
import { proposeText } from './desk-texts.js';
import { readTextOrNull } from './goals.js';
import { archivedProgramsHome, programsHome, workRoot } from './paths.js';
import { changeProgrammeRecord, readRecord, validRepairScope } from './programme-record.js';
import { isRepairAuthor, withRepairAuthor } from './repair-authority.js';
import { oneLine } from './repair-draft.js';
import { repairDigest, repairSnapshot, sameRepairSnapshot } from './repair-manifest.js';
import { needsRepairReview, releaseRepair, reopenRepair, repairReleaseState } from './repair-release.js';
import { currentRepairReview } from './repair-review.js';
import { judgeRepair } from './repair-session.js';
import { settleRepairSources } from './repair-sources.js';
import { stopRepair } from './repair-stop.js';
import { readCanonRole } from './roles.js';
import { wakeRunner } from './run-control.js';
import { realLock } from './runner-lock.js';

const MAX_READINGS = 3;
const editable = /^(?:Closes|Solution|Design|Proved by|Not in this part): /u;

function revisedPage(text, { edits, reading }) {
  if (!Array.isArray(edits) || edits.length > 16 || !oneLine(reading, 1000)) throw new Error('the repair revision is incomplete');
  const lines = text.split('\n');
  const parts = lines.indexOf('## Parts');
  const end = lines.indexOf('## Order', parts);
  const read = lines.indexOf('## Read', end);
  if (parts < 0 || end < 0 || read < 0) throw new Error('the repair order no longer has Parts, Order and Read sections');
  for (const edit of edits) {
    const { part, before, after } = edit ?? {};
    if (!Number.isSafeInteger(part) || part < 1) throw new Error('the repair revision needs the numbered part of each edit');
    const start = lines.findIndex((line, index) => index > parts && index < end && line.startsWith(`### Part ${part} — `));
    if (start === -1) throw new Error(`the repair revision names an unknown Part ${part}`);
    const nextPart = lines.findIndex((line, index) => index > start && index < end && line.startsWith('### Part '));
    const stop = nextPart === -1 ? end : nextPart;
    if (!oneLine(before, 1500) || !oneLine(after, 1500) || !editable.test(before) || !editable.test(after)
        || before.split(':', 1)[0] !== after.split(':', 1)[0]) throw new Error('the repair revision contains an invalid edit');
    const at = lines.indexOf(before, start + 1);
    const another = lines.indexOf(before, at + 1);
    if (at < 0 || at >= stop || (another >= 0 && another < stop)) throw new Error('the repair revision did not identify one exact line');
    lines[at] = after;
  }
  const note = `Repair review: ${reading}`;
  if (!lines.includes(note)) lines.splice(read + 1, 0, '', note);
  const next = lines.join('\n');
  if (next === text) throw new Error('the repair revision made no progress');
  return next;
}

function repairAct(env, act, { lock, now }) {
  const { effect, steps, wait, reversible } = act;
  const brief = [
    '## Vad det gäller', effect, '',
    '## Alternativ och konsekvenser', '- run: Utför stegen enligt nedan.', '- wait: Låt beställningen vänta.', '',
    '## Rekommendation och skäl', steps, '',
    '## Vad som står still', wait, '',
    '## Kan valet ändras efteråt?', reversible ? 'Ja.' : 'Nej.', '',
  ].join('\n');
  const reference = `repair-act:${env.MC_PROGRAMME}`;
  const id = deskItemId('repair-act', reference, repairDigest(brief));
  return lock(workRoot(env), () => {
    const existing = readDeskItem(id, { env });
    if (existing?.state === 'closed') return null;
    if (!existing) {
      const at = now().toISOString();
      const item = { schema: 'mc-desk-item', version: 1, id, kind: 'repair-act', reference,
        source_at: at, opened_at: at, state: 'for-martin', sort: 'reserved', reversible,
        recommend: 'run', due_at: null, outcome: null };
      writeFileAtomic(join(itemDirectory(item, env), 'brief.md'), brief);
      writeDeskItem(item, { env });
    }
    return id;
  }, { strict: true, name: 'repair-reserved-act' });
}

function scopeStop(dir, env, scope, { lock, now, say, stderr }) {
  const { title, summary, heldText, reserved, item } = scope;
  let link = item;
  if (heldText) {
    const proposed = proposeText({ env, text: heldText.text, brief: heldText.brief, now: now(), lock });
    link = proposed.item?.id;
  }
  if (reserved) link = repairAct(env, reserved, { lock, now });
  const result = stopRepair(dir, env, { title, summary, item: link }, { lock, now: now(), allowUnavailableLink: true });
  if (!result.ok) throw new Error(result.problems[0]);
  if ((item || heldText || reserved) && !result.record.repair.stop.link) {
    stderr.write('mc: the related desk brief was unavailable; the repair scope stop still needs disposition\n');
  }
  say(`repair programme ${env.MC_PROGRAMME} is at Martin (item ${result.record.repair.stop_item})`);
  return 0;
}

export async function finishRepair({ name }, deps = {}) {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr, lock = realLock,
    now = () => new Date(), revise = judgeRepair, programs = reviewProgramme, wake = wakeRunner,
    settle = settleRepairSources } = deps;
  const root = workRoot(env);
  const active = join(programsHome(env), name);
  const archived = join(archivedProgramsHome(env), name);
  const dir = readRecord(active).status === 'none' && readRecord(archived).record?.state === 'done' ? archived : active;
  const locked = action => lock(root, action, { strict: true, name: 'repair-order' });
  const record = () => readRecord(dir).record;
  const say = text => stdout.write(`mc: ${text}\n`);
  const model = readCanonRole('repair')?.model;
  const author = { ...env, MC_TOOL: 'claude', MC_MODEL: model };
  return withRepairAuthor(author, name, async lease => {
    const archive = revision => locked(() => {
      const live = record();
      if (!isRepairAuthor(lease, name) || repairReleaseState(dir, live)?.release?.revision !== revision) {
        throw new Error(needsRepairReview(name));
      }
      try { settle({ env: lease, programme: name, sources: live.repair.sources, action: 'release' }); }
      catch (error) { throw new Error(`could not archive repair sources for ${name}: ${error.message} — mc repair --resume ${name}`); }
    });
    if (dir === archived) {
      const current = record();
      const release = repairReleaseState(dir, current)?.release;
      if (!release || current.repair.desk) throw new Error(`no current repair release for ${name}`);
      archive(release.revision);
      say(`repair programme ${name} is archived`);
      return 0;
    }
    const opened = reopenRepair(dir, lease, { lock });
    if (!opened.ok) throw new Error(opened.problems[0] ?? `no valid repair order for ${name}`);
    if (opened.record.state === 'ready') {
      archive(opened.record.repair.release.revision);
      say(`repair programme ${name} is ready for planning`);
      return 0;
    }
    if (opened.record.repair.pending_scope) return scopeStop(dir, lease, opened.record.repair.pending_scope, { lock, now, say, stderr });
    for (let round = 0; round < MAX_READINGS; round++) {
      const code = await programs(['review', name], { env: lease, stdout, stderr, lock, now, ...deps.programmeReview });
      if (code !== 0) throw new Error(needsRepairReview(name));
      const current = currentRepairReview(dir, { read: readTextOrNull });
      if (!current) throw new Error(needsRepairReview(name));
      if (!current.findings.length) {
        const released = releaseRepair(dir, lease, { lock });
        if (!released.ok) throw new Error(released.problems[0]);
        say(`repair programme ${name} is ready for planning`);
        try { archive(released.record.repair.release.revision); }
        finally { wake(root); }
        return 0;
      }
      if (round + 1 === MAX_READINGS) break;
      const evidence = current.snapshot.files.find(file => file.path === 'evidence/repair-source.md')?.bytes.toString('utf8');
      const answer = await revise({ env: lease, revision: {
        order: current.snapshot.text, evidence, findings: current.findings,
      } });
      if (answer?.status === 'insufficient' && oneLine(answer.reason, 800)) {
        say(`repair programme ${name} — insufficient evidence: ${answer.reason}`);
        return 0;
      }
      if (answer?.status === 'scope') {
        const { status: _status, ...scope } = answer;
        if (!validRepairScope(scope)) throw new Error('repair scope needs a title, a Swedish summary and at most one valid related desk brief');
        const pending = changeProgrammeRecord(dir, live => {
          if (!isRepairAuthor(lease, name) || live.state !== 'draft' || !live.repair || live.repair.desk
              || live.repair.pending_scope || !sameRepairSnapshot(current.snapshot, repairSnapshot(dir))) {
            return { problems: [needsRepairReview(name)] };
          }
          return { ...live, repair: { ...live.repair, pending_scope: scope } };
        }, { root, lock }, 'repair-scope-pending');
        if (!pending.ok) throw new Error(pending.problems[0]);
        return scopeStop(dir, lease, pending.record.repair.pending_scope, { lock, now, say, stderr });
      }
      if (answer?.status !== 'revise') throw new Error('the repair session returned no revision');
      const next = revisedPage(current.snapshot.text, answer);
      locked(() => {
        const live = record();
        if (!isRepairAuthor(lease, name) || live?.state !== 'draft' || live.repair?.desk || live.repair?.stop_item
            || !sameRepairSnapshot(current.snapshot, repairSnapshot(dir))) throw new Error(needsRepairReview(name));
        writeFileAtomic(join(dir, 'README.md'), next);
      });
    }
    throw new Error(needsRepairReview(name));
  }, { lock });
}
