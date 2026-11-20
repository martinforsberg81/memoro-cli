/**
 * Programme review (src/mc/programme-review.js): `mc programs review` launches
 * one independent headless reading of the programme document at origin/main exports.
 * Advisory: writes PROGRAMME-REVIEW.md beside the programme, records no verdict or currency.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as claude from '../../src/adapters/claude-code.js';
import { archiveDue, archiveOnOk, keepReading, parseWriteBack, readArchiveState } from '../../src/mc/archive-turn.js';
import { writeFileAtomic, writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { run as ask } from '../../src/mc/commands/ask.js';
import { run as goal } from '../../src/mc/commands/goal.js';
import { run as martin } from '../../src/mc/commands/martin.js';
import { run as merge } from '../../src/mc/commands/merge.js';
import { run as repair } from '../../src/mc/commands/repair.js';
import { run as programs } from '../../src/mc/commands/programs.js';
import { goalReferences, listDirsOf, readTextOrNull, REVIEW_ROLE } from '../../src/mc/goals.js';
import { itemStore, readDeskItem, syncDeskItems } from '../../src/mc/desk-items.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';
import { landJob, queueMerge } from '../../src/mc/merger.js';
import { newRecord, readRecord, RECORD_FILE, recordPageTemplate, writeRecord } from '../../src/mc/programme-record.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { applyObservation, normaliseCapacity } from '../../src/mc/model-capacity.js';
import {
  PROGRAMME_REVIEW_FILE, PROGRAMME_REVIEW_LAUNCH, PROGRAMME_REVIEW_LIMIT_MS,
} from '../../src/mc/programme-review.js';
import { TIMEOUT_EXIT } from '../../src/mc/run-plan.js';
import { withRepairAuthor } from '../../src/mc/repair-authority.js';
import { currentRepairReview } from '../../src/mc/repair-review.js';
import { reopenRepair, repairReleaseState } from '../../src/mc/repair-release.js';
import { archivedProposal, readRepairSource, settleRepairSources } from '../../src/mc/repair-sources.js';
import { repairGoalAdmission } from '../../src/mc/repair-reconcile.js';
import { finishTurn, programmeDue } from '../../src/mc/programme-turn.js';
import { realLock } from '../../src/mc/runner-lock.js';
import { goalJson } from './_helpers/goal-file.js';

const NOW = new Date('2026-11-15T10:00:00Z');
const AFTER_START = NOW.getTime() + 60_000;
const AHEAD = '2026-11-15T15:00:00.000Z';
const SOL = Object.freeze({ tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' });
const OPUS = Object.freeze({ tool: 'claude', model: 'opus', effort: 'high' });
const LISTED = [{ id: 'gpt-6.2-sol', efforts: ['high'] }];
const win = (fraction_used, resets_at = AHEAD) => ({ fraction_used, resets_at });
const capacityOf = (claudeUsed, codexUsed) => {
  let state = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: win(claudeUsed), seven_day: win(claudeUsed) } }, NOW);
  state = applyObservation(state, 'codex', { windows: { primary: win(codexUsed), secondary: null }, models: LISTED }, NOW);
  return state;
};
const catalogOf = (review, providerPriority = 'auto') => ({ ...DEFAULT_CATALOG, providerPriority, review });
const sink = () => { const parts = []; return { write: (text) => parts.push(text), text: () => parts.join('') }; };
const DONE = { status: 0, stdout: '', stderr: '' };

function baseSetup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-programme-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const baseEnv = { MC_WORK_ROOT: root, MC_HOME: join(root, 'home'), MC_ROLE: 'plan', MC_PROGRAMME: 'p', MC_TOOL: 'claude', MC_MODEL: 'opus' };
  const rows = [];
  const deps = {
    checkoutId: () => 'fixture', now: () => NOW, alive: () => true, tmp, pid: 4242, mtime: () => AFTER_START, logRun: (row) => rows.push(row),
    catalog: catalogOf([SOL, OPUS]), capacity: capacityOf(0.5, 0.5), token: () => 'a'.repeat(48),
    launch: () => ({ ok: true, id: 'claude-code', shortName: 'claude', spec: { bin: '/fake/claude' }, adapter: claude }),
    billingRoute: () => ({ billing: 'plan' }),
    checkout: ({ dir: into }) => { writeFileSync(join(into, 'README.md'), 'origin/main'); return { ok: true }; },
    session: async () => DONE,
  };
  return { root, tmp, baseEnv, rows, deps };
}

function programmeSetup(t) {
  const shared = baseSetup(t);
  const dir = join(shared.root, 'programs', 'p');
  mkdirSync(dir, { recursive: true });
  const page = recordPageTemplate().replace(/^Repositories:.*$/mu, 'Repositories: memoro-cli, memoro.');
  writeFileSync(join(dir, 'README.md'), page);
  writeRecord(dir, newRecord({ end: 'The promised result runs.', createdBy: 'manager', now: NOW }));
  const env = { ...shared.baseEnv, MC_ROLE: 'martin', MC_PROGRAMME: 'p', MC_SESSION_STARTED: 'old', MC_SCRATCH: '/old/scratch' };
  const known = ['/known/memoro-cli.git', '/known/memoro'];
  const checkout = join(shared.tmp, 'mc-programme-review-p-fixture');
  const deps = { ...shared.deps, checkout: ({ repos, dir: into }) => {
    assert.deepEqual(repos, [{ repo: 'memoro-cli', path: known[0] }, { repo: 'memoro', path: known[1] }]);
    for (const { repo } of repos) {
      mkdirSync(join(into, repo));
      writeFileSync(join(into, repo, 'main.txt'), `origin/main of ${repo}`);
    }
    return { ok: true };
  } };
  const call = async (argv = ['review', 'p'], { identity = env, extra = {}, lock = (_root, fn) => fn(), command = {} } = {}) => {
    const stdout = sink(), stderr = sink();
    const code = await programs(argv, { env: identity, stdout, stderr, known: () => known, lock, now: () => NOW, review: { ...deps, ...extra }, ...command });
    return { code, out: stdout.text(), err: stderr.text() };
  };
  const files = () => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).filter(file => file.isFile())
    .map(({ name }) => [name, readFileSync(join(dir, name), 'utf8')]));
  const reads = (before = () => {}) => async (spawned) => {
    await before(spawned);
    writeFileSync(join(dir, PROGRAMME_REVIEW_FILE), 'findings: 0\n\nNo findings.\n');
    return DONE;
  };
  return { ...shared, dir, page, env, checkout, deps, call, reads, files,
    martin: { ...env, MC_ROLE: 'martin', MC_HEADLESS: undefined, MC_GOAL: undefined } };
}

const NO_FINDINGS = 'findings: 0\n\n## Not checked\nNone.\n';
const ONE_FINDING = 'findings: 1\n\n### Finding 1 — Invalid proof\nPart: 1\nEntry: Proved by\nEvidence: The fixture does not fail.\nNarrowest fix: Use a fixture that exposes the defect.\n\n## Not checked\nNone.\n';

function repairSetup(t) {
  const f = programmeSetup(t);
  const artifact = join(f.dir, 'designs', 'part-1', 'current.txt');
  mkdirSync(join(f.dir, 'designs', 'part-1'), { recursive: true });
  writeFileSync(artifact, 'original evidence');
  writeFileSync(join(f.dir, 'README.md'), `${f.page}\n- [Evidence](designs/part-1/current.txt)\n- Source: \`/proposals/waiting.md\`\n`);
  rmSync(join(f.dir, RECORD_FILE));
  writeRecord(f.dir, newRecord({ end: 'The promised result runs.', createdBy: 'repair', now: NOW, repair: {
    sources: [{ kind: 'proposal', path: '/proposals/waiting.md', key: 'a'.repeat(64), digest: 'b'.repeat(64) }],
  } }));
  const receipt = () => currentRepairReview(f.dir, { read: path => existsSync(path) ? readFileSync(path, 'utf8') : null });
  const review = (identity, session, extra) => f.call(['review', 'p'], { identity, extra: { session, ...extra } });
  const reader = ({ report = NO_FINDINGS, status = 0, during } = {}) => async spawned => {
    assert.equal(spawned.env.MC_REPAIR_TOKEN, undefined);
    assert.notEqual(spawned.cwd, f.dir);
    assert.equal(readFileSync(join(f.checkout, 'order', 'designs', 'part-1', 'current.txt'), 'utf8'), 'original evidence');
    during?.();
    assert.equal(readFileSync(join(f.checkout, 'order', 'designs', 'part-1', 'current.txt'), 'utf8'), 'original evidence');
    if (report !== null) writeFileSync(join(spawned.cwd, PROGRAMME_REVIEW_FILE), report);
    return { ...DONE, status };
  };
  return { ...f, artifact, receipt, review, reader, asAuthor: fn => withRepairAuthor(f.baseEnv, 'p', fn) };
}

test('mc repair re-reviews a revision, releases it, and resumes source archival without a second review', async t => {
  const f = baseSetup(t);
  const home = join(f.root, 'programs');
  const dir = join(home, 'restore');
  const path = join(f.root, 'areas', 'memoro-cli', 'system', 'proposals', '2026-11-14-mc-restore.md');
  const target = archivedProposal(path);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'The command refuses its documented input.');
  writeFileSync(join(target, '..'), 'Simulate an unavailable archive directory.');
  const answer = {
    status: 'draft', name: 'restore', title: 'Restore valid input', end: 'Valid input is accepted.',
    reason: 'The command contract accepts the input.', today: 'src/mc.js at abc accepts a different form.',
    summary: 'A command refuses valid input.', repository: 'memoro-cli', repositories: ['memoro-cli'],
    parts: ['Restore command', 'Restore saved input', 'Restore alias'].map(name => ({
      name, closes: 'Valid input fails.', solution: 'Restore documented parsing.',
      design: 'Show the normal success line.', provedBy: 'Run a valid request.', notInPart: 'New input.',
    })),
  };
  let readings = 0, revisions = 0, wakes = 0;
  let orderSeen;
  const run = async (argv, judge = () => assert.fail('already drafted'), session = () => assert.fail('already reviewed')) => {
    const stdout = sink(), stderr = sink();
    const code = await repair(argv, {
      env: { MC_WORK_ROOT: f.root }, stdout, stderr, judge, now: () => NOW,
      revise: ({ revision }) => {
        revisions++;
        assert.equal(revision.findings[0].Entry, 'Proved by');
        return { status: 'revise', reading: 'The fixture now asserts the restored output.', edits: [{
          part: 1, before: 'Proved by: Run a valid request.', after: 'Proved by: Assert the existing success line.',
        }] };
      },
      wake: () => { wakes++; },
      programmeReview: { known: () => ['/known/memoro-cli'], review: { ...f.deps, session } },
    });
    return { code, out: stdout.text(), err: stderr.text() };
  };
  const first = await run(['--proposal', path], () => answer, async spawned => {
    readings++;
    const order = join(spawned.cwd, '..', 'order');
    orderSeen = readFileSync(join(order, 'README.md'), 'utf8');
    assert.match(readFileSync(join(order, 'evidence', 'repair-source.md'), 'utf8'), /A command refuses valid input/u);
    const report = readings === 1 ? ONE_FINDING : NO_FINDINGS;
    writeFileSync(join(spawned.cwd, PROGRAMME_REVIEW_FILE), report);
    return DONE;
  });
  assert.equal(first.code, 1, first.err);
  assert.match(first.out, /restore is ready for planning/u);
  assert.match(first.err, /could not archive repair sources.*--resume restore/u);
  assert.match(orderSeen, /Proved by: Assert the existing success line[\s\S]*Repair review: The fixture now asserts/u);
  assert.equal(readings, 2);
  assert.equal(revisions, 1);
  assert.equal(wakes, 1);
  const record = () => readRecord(dir).record;
  const released = record().repair.release.revision;
  const due = programmeDue({ programme: 'restore', home, list: listDirsOf, read: readTextOrNull, state: { status: 'none' } });
  assert.equal(due.revision, released);
  assert.equal(record().state, 'ready');

  rmSync(join(target, '..'));
  writeFileSync(path, 'Different waiting evidence.');
  const resumed = await run(['--resume', 'restore']);
  assert.equal(resumed.code, 0, resumed.err);
  assert.match(resumed.out, /restore is ready for planning/u);
  assert.equal(record().repair.release.revision, released);
  assert.equal(readFileSync(path, 'utf8'), 'Different waiting evidence.');
  assert.match(readFileSync(target, 'utf8'), /Utfall: ordered in programme restore[\s\S]*The command refuses its documented input/u);
  assert.equal((await run(['--proposal', path])).out, 'mc: source already ordered in restore\n');

  writeFileSync(join(dir, 'README.md'), orderSeen.replace('Restore command', 'Restore documented command'));
  assert.equal(repairReleaseState(dir, record()).release, undefined);
  const stale = await run(['--resume', 'restore'], undefined, async spawned => {
    assert.equal(record().state, 'draft');
    assert.match(readFileSync(join(spawned.cwd, '..', 'order', 'README.md'), 'utf8'), /Restore documented command/u);
    writeFileSync(join(spawned.cwd, PROGRAMME_REVIEW_FILE), NO_FINDINGS);
    return DONE;
  });
  assert.equal(stale.code, 0, stale.err);
  assert.notEqual(record().repair.release.revision, released);
  assert.deepEqual(record().repair.sources.map(source => source.path), [path]);
  assert.equal(readFileSync(path, 'utf8'), 'Different waiting evidence.');

  const widePath = path.replace('restore.md', 'wide.md');
  writeFileSync(widePath, 'Restoration would require an operator act.');
  const stopped = await run(['--proposal', widePath], () => ({
    ...answer, name: 'wide', scope: {
      title: 'Produktionsåtkomst', summary: 'Reparationen behöver ett avgränsat beslut om produktionsåtkomst.',
      reserved: { kind: 'credentials', effect: 'En behörighet behöver återställas.', steps: 'Återställ den befintliga behörigheten i konsolen.', wait: 'Därefter kan underlaget bedömas.', reversible: true },
    },
  }));
  assert.equal(stopped.code, 0, stopped.err);
  const held = readRecord(join(home, 'wide')).record;
  assert.equal(held.state, 'Martin');
  assert.match(stopped.out, /wide is at Martin/u);
  assert.equal(held.repair.stop.link.kind, 'reserved');
  assert.equal(readDeskItem(held.repair.stop.link.id, { env: { MC_WORK_ROOT: f.root } }).sort, 'reserved');
  assert.equal(programmeDue({ programme: 'wide', home, list: listDirsOf, read: readTextOrNull, state: { status: 'none' } }).due, false);

});

test('repair review: only the live assigned author gets a receipt of fixed binding inputs from an independent reader', async t => {
  const f = repairSetup(t);
  await f.asAuthor(async author => {
    for (const unrelated of [f.martin, { ...author, MC_REPAIR_TOKEN: 'b'.repeat(48) }, { ...author, MC_PROGRAMME: 'other' }]) {
      const refused = await f.review(unrelated, () => assert.fail('unrelated session launched a reader'));
      assert.equal(refused.code, 2);
      assert.match(refused.err, /only the assigned repair session/u);
      assert.equal(f.receipt(), null);
    }
    writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), NO_FINDINGS);
    assert.equal(f.receipt(), null, 'a report alone is not a reading');
    const alone = await f.review(author, () => assert.fail('the author cannot be its own reader'), { catalog: catalogOf([OPUS]) });
    assert.equal(alone.code, 2);
    const result = await f.review(author, f.reader());
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(f.receipt().receipt.reader, { tool: 'codex', model: 'gpt-6.2-sol' });
    assert.deepEqual(f.receipt().receipt.manifest.inputs.map(([path]) => path), ['README.md', 'designs/part-1/current.txt']);
    writeFileSync(f.artifact, 'edited after reading');
    assert.equal(f.receipt(), null, 'the valid report and receipt no longer describe current evidence');
  });
});

test('repair review: a reverted binding edit, failed reader, malformed or missing fresh output never grants a receipt', async t => {
  const f = repairSetup(t);
  await f.asAuthor(async author => {
    for (const [reader, why] of [
      [f.reader({ during: () => { writeFileSync(f.artifact, 'changed'); writeFileSync(f.artifact, 'original evidence'); } }), /binding programme input changed/u],
      [f.reader({ status: 1 }), /reading failed \(exit 1\)/u],
      [f.reader({ report: 'findings: 1\n\n## Not checked\nNone.\n' }), /fresh, valid findings report/u],
      [f.reader({ report: null }), /fresh, valid findings report/u],
    ]) {
      const good = await f.review(author, f.reader());
      assert.equal(good.code, 0, good.err);
      assert.ok(f.receipt());
      const rejected = await f.review(author, reader);
      assert.equal(rejected.code, 2);
      assert.match(rejected.err, why);
      assert.equal(f.receipt(), null, 'failed follow-up revoked the preceding receipt');
    }
  });
});

test('repair release: only a current receipt with settled findings opens the order; reopening cannot reuse its release', async t => {
  const f = repairSetup(t);
  const ordinary = programmeSetup(t);
  const ordinaryRelease = await ordinary.call(['release', 'p']);
  assert.equal(ordinaryRelease.code, 1);
  assert.match(ordinaryRelease.err, /not a repair-owned programme/u);
  assert.equal(readRecord(ordinary.dir).record.state, 'draft');
  const record = () => readRecord(f.dir).record;
  const pagePath = join(f.dir, 'README.md');
  const page = readFileSync(pagePath, 'utf8');

  await f.asAuthor(async author => {
    const release = identity => f.call(['release', 'p'], { identity: identity ?? author });
    const needsReview = async () => {
      const refused = await release();
      assert.equal(refused.code, 1);
      assert.equal(refused.err, 'mc: repair programme p needs review — mc repair --resume p\n');
      assert.equal(record().state, 'draft');
    };

    writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), NO_FINDINGS);
    await needsReview();
    const findings = await f.review(author, f.reader({ report: ONE_FINDING }));
    assert.equal(findings.code, 0, findings.err);
    assert.equal(f.receipt().findings[0].Entry, 'Proved by');
    await needsReview();
    const reviewed = await f.review(author, f.reader());
    assert.equal(reviewed.code, 0, reviewed.err);
    const unrelated = await release({ ...author, MC_REPAIR_TOKEN: 'b'.repeat(48) });
    assert.equal(unrelated.code, 1);
    assert.match(unrelated.err, /only the assigned repair session/u);

    writeFileSync(pagePath, `${page}\nChanged after reading.\n`);
    await needsReview();
    writeFileSync(pagePath, page);
    writeFileSync(f.artifact, 'changed after reading');
    await needsReview();
    writeFileSync(f.artifact, 'original evidence');
    const first = await release();
    assert.equal(first.code, 0, first.err);
    assert.equal(first.out, 'mc: repair programme p is ready for planning\n');
    const original = record();
    assert.equal(repairReleaseState(f.dir, original).release.revision, original.repair.release.revision);
    assert.equal(reopenRepair(f.dir, author).changed, false, 'current release is not replaced');

    writeFileSync(f.artifact, 'changed after release');
    assert.match(repairReleaseState(f.dir, record()).problems[0], /needs review/u);
    assert.match((await f.call(['list'])).out, /p · ready \(needs review\)/u);
    assert.equal(reopenRepair(f.dir, author).changed, true);
    assert.deepEqual(record().repair.sources, original.repair.sources);
    writeFileSync(f.artifact, 'original evidence');
    await needsReview();
    const reread = await f.review(author, f.reader());
    assert.equal(reread.code, 0, reread.err);
    assert.equal((await release()).code, 0);
    assert.notEqual(record().repair.release.revision, original.repair.release.revision, 'a new release is a new handoff even for the same bytes');
  });
});

test('repair planning: stale ready blocks new and runnable goals; a changed part needs a new contract and reconciliation', async t => {
  const f = repairSetup(t);
  const home = join(f.root, 'programs');
  const pagePath = join(f.dir, 'README.md');
  const page = readFileSync(pagePath, 'utf8');
  const seams = { programme: 'p', home, list: listDirsOf, read: readTextOrNull, state: { status: 'none' } };
  const record = () => readRecord(f.dir).record;
  const readsDue = () => programmeDue(seams);
  const admitted = revision => repairGoalAdmission(f.dir, 'restore', { revision });
  const plan = () => ({ ...f.baseEnv, MC_HEADLESS: '1', MC_REPAIR_REVISION: record().repair.release.revision });
  const runGoal = async (args, env = plan()) => {
    const stdout = sink(), stderr = sink();
    const code = await goal(args, { env, stdout, stderr, known: () => ['/known/memoro-cli'], git: () => ({ ok: true, stdout: '', stderr: '' }) });
    return { code, err: stderr.text() };
  };
  const newArgs = name => ['new', `p/${name}`, '--repo', 'memoro-cli', '--class', 'fast', '--title', 'Restore', '--structure', '1'];
  const reconcile = () => f.call(['reconcile', 'p', '--reason', 'Compared Part 1 and its goal contract.'], { identity: plan() });
  await f.asAuthor(async author => {
    const release = async () => {
      const reviewed = await f.review(author, f.reader());
      assert.equal(reviewed.code, 0, reviewed.err);
      const result = await f.call(['release', 'p'], { identity: author });
      assert.equal(result.code, 0, result.err);
      return record().repair.release.revision;
    };
    writeFileSync(pagePath, page.replace(/### Part 1 — [^\n]+/u, '### Part 1 — Restore rows'));
    const first = await release();
    const planner = plan();
    assert.equal(readsDue().revision, first);
    for (const args of [newArgs('restore'), ['document', 'add', 'p/restore', '--label', 'Part 1', '--path', pagePath]]) {
      const made = await runGoal(args);
      assert.equal(made.code, 0, made.err);
    }
    assert.match(admitted().problems[0], /not reconciled/u);
    const firstReconciled = await reconcile();
    assert.equal(firstReconciled.code, 0, firstReconciled.err);
    assert.equal(finishTurn({ ...seams, revision: first }).kind, 'cut');
    assert.equal(admitted().release.revision, first);

    writeFileSync(pagePath, readFileSync(pagePath, 'utf8').replace('Part 1 — Restore rows', 'Part 1 — Restore panels'));
    assert.equal(readsDue().due, false);
    assert.match(readsDue().reason, /needs review/u);
    assert.match(admitted().problems[0], /needs review/u);
    const refused = await runGoal(newArgs('another'), planner);
    assert.equal(refused.code, 1, refused.err);
    assert.match(refused.err, /needs review/u);
    assert.equal(existsSync(join(f.dir, 'goals', 'another')), false);
    assert.equal(reopenRepair(f.dir, author).changed, true);
    const second = await release();
    assert.notEqual(first, second);
    assert.equal(readsDue().revision, second, 'even though Part 1 already has a goal');
    assert.match(admitted().problems[0], /not reconciled/u);
    const unchanged = await reconcile();
    assert.equal(unchanged.code, 1);
    assert.match(unchanged.err, /released part changed/u);
    const obsolete = await runGoal(['set', 'p/restore', 'contract', '--text', 'Contract from an older turn.'], planner);
    assert.equal(obsolete.code, 1);
    assert.match(obsolete.err, /different repair release/u);
    const update = await runGoal(['set', 'p/restore', 'contract', '--text', 'Restore the panels to their settled order.']);
    assert.equal(update.code, 0, update.err);
    const secondReconciled = await reconcile();
    assert.equal(secondReconciled.code, 0, secondReconciled.err);
    assert.equal(readsDue().due, false);
    assert.equal(admitted(second).release.revision, second);
    assert.match(admitted(first).problems[0], /different repair release/u);
  });
});

test('repair delivery: a queued or in-flight PR cannot use a stale order or a later release', async t => {
  const f = repairSetup(t);
  const home = join(f.root, 'programs');
  const page = join(f.dir, 'README.md');
  const order = readFileSync(page, 'utf8').replace(/### Part 1 — [^\n]+/u, '### Part 1 — Restore rows');
  writeFileSync(page, order);
  const dir = join(f.dir, 'goals', 'restore');
  const file = join(dir, 'GOAL.json');
  const sha = '1'.repeat(40);
  const criterion = { criterion: 'Rows in settled order', check: 'mc gate', met: true };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, goalJson({ prs: ['memoro-cli#17'], success_criteria: [criterion], documents: [{ label: 'Part 1', path: page }] }));
  const queue = options => queueMerge({ root: f.root, ...options, start: () => ({}) });
  const goalsOf = () => goalReferences({ home });
  const forge = () => ({ ok: true, status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: sha, headRefName: 'goal/restore' }) });
  let goalWrites = 0;
  const land = (job, mergeRound) => landJob(job, {
    root: f.root, mergeRound, gh: forge, goalsOf, say: () => {}, record: () => {}, recordStart: () => {},
    readRunningRound: () => null, readLeaseFn: () => null, readRunningDeploy: () => null,
    dropFromPage: () => {}, setGoal: () => { goalWrites++; },
  });
  await f.asAuthor(async author => {
    const release = async () => {
      assert.equal((await f.review(author, f.reader())).code, 0);
      assert.equal((await f.call(['release', 'p'], { identity: author })).code, 0);
      return readRecord(f.dir).record.repair.release.revision;
    };
    const identity = (revision, extra) => ({ ...f.baseEnv, MC_HEADLESS: '1', MC_REPAIR_REVISION: revision, ...extra });
    const reconcile = revision => f.call(['reconcile', 'p', '--reason', 'Compared Part 1 and the goal contract.'], { identity: identity(revision) });
    const call = async (args, env) => {
      const stdout = sink(), stderr = sink();
      const code = await goal(args, {
        env, stdout, stderr, known: () => ['/known/memoro-cli'], gh: (_cwd, args) => forge(args), queue,
        git: () => ({ ok: true, stdout: '', stderr: '' }),
      });
      return { code, err: stderr.text() };
    };
    const intoMerge = async revision => {
      // The ordinary goal build/review evidence is fixture input; execute the actual merge handoff verb.
      const current = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, goalJson({ ...current, stage: 'review', success_criteria: [criterion] }));
      writeFileSync(join(dir, 'REVIEW.md'), `head: memoro-cli ${sha}\ncriterion 1: OK\n`);
      const result = await call(['stage', 'p/restore', 'merge'], identity(revision, {
        MC_GOAL: 'p/restore', MC_ROLE: REVIEW_ROLE, MC_REVIEW_HEAD: sha,
      }));
      assert.equal(result.code, 0, result.err);
      return parseQueue(readFileSync(mergesPath(f.root), 'utf8'))[0];
    };
    const stale = () => writeFileSync(page, order.replace(/### Part 1 — [^\n]+/u, '### Part 1 — Restore panels'));
    const first = await release();
    const before = await reconcile(first);
    assert.equal(before.code, 0, before.err);
    const old = await intoMerge(first);
    assert.equal(old.repair_revision, first);
    assert.equal(old.sha, sha);
    const [inFlight] = await land(old, async options => {
      assert.equal(options.expectedHead, sha);
      assert.equal(await options.beforeMerge(), true);
      stale();
      const reason = await options.beforeMerge();
      assert.match(reason, /needs review/u);
      return { ok: false, merged: false, stopped_at: 'repair-release', reason };
    });
    assert.equal(inFlight.landed, false);
    const neverRound = () => assert.fail('an obsolete job cannot start its round');
    const [queued] = await land(old, neverRound);
    assert.equal(queued.report.stopped_at, 'repair-release');
    assert.match(queued.report.reason, /needs review/u);
    assert.throws(() => queue({ ...old, repoPath: old.repo_path, repairRevision: first }), /needs review/u);
    const throughMerge = async (flags, measure) => {
      const stdout = sink(), stderr = sink();
      const code = await merge(['memoro-cli', '17', ...flags], {
        env: f.baseEnv, root: f.root, goalsOf, stdout, stderr, resolveRepoPath: () => '/known/memoro-cli',
        prFiles: () => ['src/rows.js'], startMerger: () => assert.fail('obsolete delivery cannot start the merger'),
        gh: args => {
          assert.equal(args[1], 'view', 'stale repair cannot squash through a command route');
          return { ...forge(), stdout: JSON.stringify({ number: 17, title: 'Restore', baseRefName: 'main',
            state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: sha, headRefName: 'goal/restore',
            files: [{ path: 'docs/technical/rows.md' }] }) };
        },
        measure,
      });
      return { code, said: stdout.text() + stderr.text() };
    };
    for (const flags of [[], ['--admin'], ['--docs']]) {
      const { code, said } = await throughMerge(flags, () => assert.fail('obsolete documentation delivery cannot start measurement'));
      assert.equal(code, 1);
      assert.match(said, /needs review/u);
    }

    assert.equal(reopenRepair(f.dir, author).changed, true);
    const next = await release();
    assert.notEqual(next, first);
    const planner = identity(next);
    for (const args of [
      ['stage', 'p/restore', 'build'],
      ['set', 'p/restore', 'contract', '--text', 'Restore the panels to their settled order.'],
      ['criterion', 'unmet', 'p/restore', '1'],
    ]) {
      const result = await call(args, planner);
      assert.equal(result.code, 0, result.err);
    }
    const after = await reconcile(next);
    assert.equal(after.code, 0, after.err);
    const current = await intoMerge(next);
    assert.equal(current.repair_revision, next);
    const obsolete = await call(['stage', 'p/restore', 'merge'], identity(first, {
      MC_GOAL: 'p/restore', MC_ROLE: REVIEW_ROLE, MC_REVIEW_HEAD: sha,
    }));
    assert.equal(obsolete.code, 1);
    assert.match(obsolete.err, /different repair release/u);
    const [oldAfterRelease] = await land(old, neverRound);
    assert.equal(oldAfterRelease.report.stopped_at, 'repair-release');
    assert.match(oldAfterRelease.report.reason, /different repair release/u);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'merge', 'the newer handoff remains in merge');
    const revised = readFileSync(page, 'utf8');
    let measured = false;
    const docs = await throughMerge(['--docs'], () => {
      measured = true;
      writeFileSync(page, `${revised}\nChanged during the documentation round.\n`);
      return { ok: true };
    });
    assert.equal(measured, true);
    assert.equal(docs.code, 1);
    assert.match(docs.said, /needs review/u);
    writeFileSync(page, revised);
    const [landedBeforeReadBack] = await land(current, async options => {
      assert.equal(await options.beforeMerge(), true);
      writeFileSync(page, `${readFileSync(page, 'utf8')}\nChanged while GitHub took the merge.\n`);
      return { ok: true, merged: true, merge_commit: '2'.repeat(40) };
    });
    assert.equal(landedBeforeReadBack.landed, true, 'the merge that already landed is not undone');
    assert.equal(goalWrites, 0, 'no obsolete answer may change the goal, including a completed squash');
  });
});

test('repair archival: stale inputs and an old write-back cannot complete a newer release', async t => {
  const f = repairSetup(t);
  const home = join(f.root, 'programs');
  const pagePath = join(f.dir, 'README.md');
  const landed = join(f.dir, 'goals', '.archive', 'restore');
  mkdirSync(landed, { recursive: true });
  writeFileSync(join(landed, 'GOAL.json'), goalJson({ stage: 'done', repos: ['memoro-cli'], documents: [{ label: 'Part 1', path: pagePath }] }));
  const seams = { root: f.root, home, programme: 'p', list: listDirsOf, read: readTextOrNull, writeJson: writeJsonAtomic, lock: realLock };
  const due = () => archiveDue({ ...seams, state: readArchiveState(seams) });
  const keep = revision => keepReading({ ...seams, revision, goals: ['restore'], at: NOW.toISOString() });
  const archived = join(f.root, 'archive', 'p');
  mkdirSync(join(f.root, 'archive'));
  let moves = 0;
  const archive = () => archiveOnOk({ ...seams, restrictedDir: join(f.root, 'restricted'), proposalsTarget: () => assert.fail('no legacy proposals'),
    write: writeFileAtomic, remove: path => rmSync(path), exists: existsSync,
    archive: async ({ fence, onShelved }) => {
      assert.equal(fence(), null);
      moves++;
      renameSync(f.dir, archived);
      onShelved(archived);
      return 0;
    },
  });
  await f.asAuthor(async author => {
    const release = async () => {
      const reviewed = await f.review(author, f.reader());
      assert.equal(reviewed.code, 0, reviewed.err);
      const result = await f.call(['release', 'p'], { identity: author });
      assert.equal(result.code, 0, result.err);
      const revision = readRecord(f.dir).record.repair.release.revision;
      const identity = { ...f.baseEnv, MC_HEADLESS: '1', MC_REPAIR_REVISION: revision };
      const reconciled = await f.call(['reconcile', 'p', '--reason', 'Part 1 still describes the landed restoration.'], { identity });
      assert.equal(reconciled.code, 0, reconciled.err);
      return revision;
    };

    const first = await release();
    assert.equal(due().mode, 'read');
    keep(first);
    assert.equal(due().mode, 'archive');
    writeFileSync(pagePath, `${readFileSync(pagePath, 'utf8')}\nAdditional reading.\n`);
    assert.equal(due().due, false);
    assert.match(due().reason, /needs review/u);
    assert.equal((await archive()).stale, true);
    assert.equal(moves, 0);
    assert.throws(() => keep(first), /needs review/u);
    assert.equal(reopenRepair(f.dir, author).changed, true);
    const second = await release();
    assert.equal(due().mode, 'read', 'the kept OK is for the first release, not the second');
    assert.equal((await archive()).stale, true);
    assert.equal(moves, 0);
    assert.throws(() => keep(first), /different repair release/u);
    const result = parseWriteBack(`release: ${first}\nrestore: OK — none — No behaviour changed.\nverdict: OK\n`, { goals: ['restore'], checkouts: {}, revision: second });
    assert.deepEqual(result.problems, ['the write-back belongs to a different repair release']);
    keep(second);
    const archiveResult = await archive();
    assert.equal(archiveResult.ok, true, archiveResult.reason);
    assert.equal(moves, 1);
    assert.equal(readRecord(archived).record.state, 'done');
  });
});

for (const [action, confirmation, lateLanding] of [
  ['decline', 'declined', false], ['decline', 'declined', true],
  ['return', 'returned to repair', false], ['takeover', 'taken over by Martin', false],
]) {
  test(`repair stop: desk sync and ${action} after a part landed${lateLanding ? ' with a late merged PR' : ''}`, async t => {
    const f = repairSetup(t);
    const home = join(f.root, 'programs');
    const page = join(f.dir, 'README.md');
    const firstPage = readFileSync(page, 'utf8').replace('## Order',
      '### Part 2 — Restore another row\n\nSolution: Restore the settled row order.\n\n## Order');
    writeFileSync(page, firstPage);
    const landed = join(f.dir, 'goals', '.archive', 'landed');
    const remaining = join(f.dir, 'goals', 'remaining');
    const proposal = join(f.root, 'areas', 'memoro-cli', 'system', 'proposals', '2026-11-19-mc-restore.md');
    for (const dir of [landed, remaining, join(proposal, '..')]) mkdirSync(dir, { recursive: true });
    writeFileSync(proposal, '# Rows in the wrong order\n');
    const ref = readRepairSource({ kind: 'proposal', given: proposal, env: f.baseEnv }).ref;
    const original = readRecord(f.dir).record;
    writeJsonAtomic(join(f.dir, RECORD_FILE), { ...original, repair: { sources: [ref] } });
    writeFileSync(join(landed, 'GOAL.json'), goalJson({ stage: 'done', documents: [{ label: 'Part 1', path: page }] }));
    const remainingText = goalJson({ stage: 'build', documents: [{ label: 'Part 2', path: page }], prs: ['memoro-cli#17'] });
    writeFileSync(join(remaining, 'GOAL.json'), remainingText);

    const record = () => readRecord(f.dir).record;
    const seams = { root: f.root, home, programme: 'p', list: listDirsOf, read: readTextOrNull, writeJson: writeJsonAtomic, lock: realLock };
    const plan = () => programmeDue({ ...seams, state: { status: 'none' } });
    const due = () => archiveDue({ ...seams, state: readArchiveState(seams) });
    const admit = revision => repairGoalAdmission(f.dir, 'remaining', { revision });
    const desk = async args => {
      const stdout = sink(), stderr = sink();
      const code = await martin(args, { env: f.martin, stdout, stderr, now: () => NOW });
      return { code, out: stdout.text(), err: stderr.text() };
    };
    const reason = 'Behåll den redan rättade raden.';
    const disposition = ['disposition', 'p', action, '--reason', reason];
    const summary = 'Två rader visas i fel ordning. Beställningen föreslår en ny gruppordning och går utanför reparationsmandatet. Återstående arbete är stoppat.';
    await f.asAuthor(async author => {
      const read = await f.review(author, f.reader());
      assert.equal(read.code, 0, read.err);
      assert.equal((await f.call(['release', 'p'], { identity: author })).code, 0);
      const prior = record().repair.release.revision;
      const planner = { ...f.baseEnv, MC_HEADLESS: '1', MC_REPAIR_REVISION: prior };
      const reconciled = await f.call(['reconcile', 'p', '--reason', 'Reviewed both parts.'], { identity: planner });
      assert.equal(reconciled.code, 0, reconciled.err);
      assert.equal(admit(prior).release.revision, prior);
      if (lateLanding) realLock(f.root, () => settleRepairSources({ env: f.baseEnv, sources: [ref], programme: 'p', action: 'order' }), { strict: true });
      writeFileSync(page, firstPage.replace('Restore the settled row order.', 'Choose a new grouping.'));
      assert.equal(reopenRepair(f.dir, author).ok, true);
      const stop = ['repair-stop', 'p', '--title', 'ny gruppordning', '--summary', summary];
      let textItem;
      if (action === 'return') {
        const brief = join(f.root, 'brief.md');
        writeFileSync(brief, '## Vad den säger\n\nOrdningen är fast.\n\n## Vad som föreslås\n\nEn annan gruppordning.\n\n## Vad som hittades\n\nTvå rader visas fel.\n');
        const proposed = await desk(['propose', '--text', 'Den fasta gruppordningen', '--file', brief]);
        assert.equal(proposed.code, 0, proposed.err);
        textItem = proposed.out.match(/\b[a-f0-9]{24}\b/u)?.[0];
        assert.ok(textItem);
        stop.push('--item', textItem);
      }
      const unrelated = await f.call(stop, { identity: { ...author, MC_REPAIR_TOKEN: 'b'.repeat(48) } });
      assert.equal(unrelated.code, 1);
      assert.equal(record().state, 'draft');
      const held = await f.call(stop, { identity: author, lock: realLock });
      assert.equal(held.code, 0, held.err);
      const id = record().repair.stop_item;
      assert.equal(held.out, `mc: repair programme p is at Martin (item ${id})\n`);
      assert.match((await f.call(['list'])).out, /p · Martin/u);
      assert.equal(plan().due, false);
      assert.match(admit(prior).problems[0], /at Martin/u);
      assert.equal(due().due, false);

      rmSync(join(itemStore(f.baseEnv), id), { recursive: true });
      syncDeskItems({ env: f.baseEnv });
      syncDeskItems({ env: f.baseEnv });
      const open = readDeskItem(id, { env: f.baseEnv });
      assert.equal(open?.state, 'for-martin');
      assert.deepEqual(open.landed, ['landed']);
      const opening = (await desk(['brief'])).out;
      const section = opening.indexOf('## Reparationsbeställningar som väntar på dig');
      assert.ok(section > opening.indexOf('## Your acts') && section < opening.indexOf('## Not ready'));
      assert.ok(opening.includes(`p — ny gruppordning (item ${id})`) && opening.includes(summary));
      assert.doesNotMatch(opening, /Stuck after the decision pass/u);
      if (textItem) {
        assert.ok(opening.includes(`Textändring: item ${textItem}`));
        assert.equal(opening.split('Ordningen är fast.').length, 2, 'linked brief appears once in its established section');
      }
      const item = JSON.parse((await desk(['item', id])).out);
      assert.match(item.brief, /Redan landat: landed/u);
      const close = await desk(['item', id, 'close', '--by', 'martin', '--summary', 'Close outside the programme.']);
      assert.equal(close.code, 2);
      assert.match(close.err, /mc programs disposition p/u);
      assert.deepEqual(readDeskItem(id, { env: f.baseEnv }), open);
      assert.equal(plan().due, false);
      assert.equal((await f.call(disposition, { identity: { ...f.martin, MC_HEADLESS: '1' } })).code, 2);
      assert.equal((await f.call(disposition, { identity: {} })).code, 2);
      assert.equal(record().state, 'Martin');

      const result = await f.call(disposition, { lock: realLock, identity: f.martin,
        command: { readPr: () => lateLanding ? 'MERGED' : 'OPEN', wake: () => {} } });
      assert.equal(result.code, 0, result.err);
      assert.equal(result.out, `mc: p — ${confirmation}\n`);
      syncDeskItems({ env: f.baseEnv });
      const closed = readDeskItem(id, { env: f.baseEnv });
      assert.equal(closed.state, 'closed');
      assert.equal(closed.outcome.disposition, action);
      assert.equal(closed.outcome.summary, reason);
      assert.doesNotMatch((await desk(['brief'])).out, /Reparationsbeställningar som väntar på dig/u);
      assert.deepEqual(record().repair.sources, [ref]);
      assert.equal(plan().due, false);
      assert.ok(admit(prior).problems);
      assert.ok(existsSync(join(landed, 'GOAL.json')));
      if (action === 'decline') {
        assert.equal(existsSync(proposal), false);
        if (lateLanding) assert.match(readFileSync(archivedProposal(proposal), 'utf8'), /^Utfall: ordered in programme p/u);
        assert.match(readRepairSource({ kind: 'proposal', given: proposal, env: f.baseEnv }).outcome, /^declined — p:/u);
        assert.match(readFileSync(join(remaining, 'GOAL.json'), 'utf8'), /"stage": "dropped"/u);
        assert.equal(due().due, false, 'ordinary goal cleanup has not archived the dropped goal yet');
        renameSync(remaining, join(f.dir, 'goals', '.archive', 'remaining'));
        const picked = due();
        assert.equal(picked.mode, 'read');
        assert.deepEqual(picked.goals, lateLanding ? ['landed', 'remaining'] : ['landed']);
        assert.deepEqual(picked.dropped, lateLanding ? [] : ['remaining']);
        assert.deepEqual(picked.partiallyLanded, lateLanding ? ['remaining'] : undefined);
        assert.throws(() => keepReading({ ...seams, revision: prior, goals: ['landed'], at: NOW.toISOString() }), /different repair disposition/u);
        const destination = join(f.root, 'archive', 'programs', 'p');
        mkdirSync(join(destination, '..'), { recursive: true });
        const archive = () => archiveOnOk({ ...seams, restrictedDir: join(f.root, 'restricted'), proposalsTarget: () => assert.fail('no legacy proposal'),
          write: writeFileAtomic, remove: path => rmSync(path), exists: existsSync,
          archive: async ({ fence, onShelved }) => {
            assert.equal(fence(), null);
            renameSync(f.dir, destination);
            onShelved(destination);
            return 0;
          },
        });
        assert.equal((await archive()).stale, true, 'decline alone does not authorize archival');
        keepReading({ ...seams, revision: picked.revision, goals: picked.goals, at: NOW.toISOString() });
        assert.equal(due().mode, 'archive');
        const archived = await archive();
        assert.equal(archived.ok, true, archived.reason);
        assert.equal(readRecord(destination).record.state, 'done');
        // Recover the projection even when the disposition has already moved with the order.
        writeJsonAtomic(join(itemStore(f.baseEnv), id, 'item.json'), open);
        syncDeskItems({ env: f.baseEnv });
        assert.deepEqual(readDeskItem(id, { env: f.baseEnv }), closed);
      } else {
        assert.equal(record().state, 'draft');
        assert.equal(readFileSync(join(remaining, 'GOAL.json'), 'utf8'), remainingText);
        assert.equal(existsSync(proposal), true);
        if (action === 'return') {
          assert.equal(record().repair.desk, undefined);
          const release = await f.call(['release', 'p'], { identity: author });
          assert.match(release.err, /needs review/u);
        } else {
          assert.equal(record().repair.desk, true);
          const ready = () => f.call(['state', 'p', 'ready'], { identity: f.martin });
          const premature = await ready();
          assert.match(premature.err, /released part changed/u);
          assert.equal(record().state, 'draft');
          const attemptedRepair = await f.review(author, () => assert.fail('desk takeover read by old author'));
          assert.equal(attemptedRepair.code, 2);
          const out = sink(), err = sink();
          assert.equal(await goal(['set', 'p/remaining', 'contract', '--text', 'The desk approved the revised grouping.'],
            { env: f.martin, stdout: out, stderr: err }), 0, err.text());
          const authorised = await ready();
          assert.equal(authorised.code, 0, authorised.err);
          assert.equal(plan().due, false, 'the desk has already reconciled the cut');
          assert.match(admit(prior).problems[0], /different repair release/u);
          assert.equal(admit().release.revision, record().repair.release.revision);
        }
      }
    });
  });
}

test('programme review: real command launches its own identity on named origin/main exports, and writes review file', async (t) => {
  const f = programmeSetup(t);
  const result = await f.call(['review', 'p'], { extra: { session: f.reads((spawned) => {
    assert.equal(spawned.timeoutMs, 30 * 60_000);
    assert.equal(spawned.timeoutMs, PROGRAMME_REVIEW_LIMIT_MS);
    assert.equal(spawned.cwd, f.dir);
    assert.deepEqual([spawned.env.MC_ROLE, spawned.env.MC_PROGRAMME, spawned.env.MC_HEADLESS], ['programme-review', 'p', '1']);
    for (const key of ['MC_GOAL', 'MC_STEP', 'MC_PROJECT', 'MC_REPO', 'MC_SESSION_STARTED', 'MC_SCRATCH']) assert.equal(spawned.env[key], undefined, key);
    assert.equal(spawned.env.MC_PROGRAMME_REVIEW_TOKEN, 'a'.repeat(48));
    assert.deepEqual([spawned.env.MC_TOOL, spawned.env.MC_MODEL], ['codex', 'gpt-6.2-sol'], 'shared author exclusion');
    assert.ok(spawned.args.includes('--add-dir') && spawned.args.includes(f.checkout));
    const prompt = JSON.stringify(spawned.args);
    for (const repo of ['memoro-cli', 'memoro']) {
      assert.ok(prompt.includes(join(f.checkout, repo)));
      assert.equal(readFileSync(join(f.checkout, repo, 'main.txt'), 'utf8'), `origin/main of ${repo}`);
    }
    assert.ok(prompt.includes('README.md follows:'));
    assert.ok(Object.values(f.files()).every((text) => !text.includes(spawned.env.MC_PROGRAMME_REVIEW_TOKEN)), 'no raw token persisted');
  }) } });
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(`review written — ${join(f.dir, PROGRAMME_REVIEW_FILE)}`));
  assert.deepEqual(Object.keys(f.files()).sort(), ['PROGRAMME-REVIEW.md', 'PROGRAMME.json', 'README.md'].sort(), 'no .programme-review.json or desk item');
  assert.equal(existsSync(f.checkout), false);
  assert.deepEqual(f.rows.map(({ kind, name, cls }) => [kind, name, cls]), [['programme-review', 'programme:p', 'review']]);
});

test('programme review: caller authority and repository declarations refuse before launch or effects', async (t) => {
  for (const identity of [
    { MC_ROLE: 'build-session:goal' }, { MC_ROLE: 'review-session:goal' }, { MC_ROLE: 'mend-session' },
    { MC_ROLE: 'desk-prepare' }, { MC_ROLE: 'decision' }, { MC_ROLE: 'programme-review' },
    { MC_ROLE: 'martin', MC_HEADLESS: '1' }, { MC_ROLE: 'plan', MC_HEADLESS: '1' },
    { MC_ROLE: 'plan', MC_HEADLESS: undefined, MC_GOAL: 'p/g' },
    // Only Martin at the desk: the manager, the interactive plan and a person are refused too.
    { MC_ROLE: 'manager', MC_HEADLESS: '1' }, { MC_ROLE: 'manager', MC_HEADLESS: undefined }, { MC_ROLE: 'plan', MC_HEADLESS: undefined, MC_GOAL: undefined },
    { MC_ROLE: undefined, MC_HEADLESS: undefined, MC_GOAL: undefined },
  ]) {
    const f = programmeSetup(t), before = f.files();
    const result = await f.call(['review', 'p'], { identity: { ...f.env, ...identity }, extra: { session: f.reads() } });
    assert.equal(result.code, 2, JSON.stringify(identity));
    assert.match(result.err, /only Martin at the desk calls a programme reading/u, JSON.stringify(identity));
    assert.deepEqual(f.files(), before);
    assert.deepEqual(readdirSync(f.tmp), []);
  }
  const desk = programmeSetup(t);
  assert.equal((await desk.call(['review', 'p'], { identity: desk.martin, extra: { session: desk.reads() } })).code, 0);
  for (const line of ['', 'Repositories:', 'Repositories: /private/repository', 'Repositories: unknown.']) {
    const f = programmeSetup(t);
    writeFileSync(join(f.dir, 'README.md'), f.page.replace(/^Repositories:.*$/mu, line));
    const before = f.files();
    const result = await f.call(['review', 'p'], { extra: { session: () => assert.fail('invalid repositories launched') } });
    assert.equal(result.code, 2, line);
    assert.match(result.err, /Repositories:/u);
    assert.deepEqual(f.files(), before);
  }
});

test('programme review: session that ends without writing report exits 1', async (t) => {
  const f = programmeSetup(t);
  const result = await f.call(['review', 'p'], { extra: { session: async () => DONE } });
  assert.equal(result.code, 1);
  assert.match(result.err, /no reading stored — the session ended without writing PROGRAMME-REVIEW.md/u);
});

test('programme review: a report an earlier reading left is not this reading\'s — the call exits 1 and leaves it as it was', async (t) => {
  const f = programmeSetup(t);
  const earlier = 'findings: 2\n\nAn earlier reading.\n';
  writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), earlier);
  const result = await f.call(['review', 'p'], { extra: { session: async () => DONE, mtime: () => NOW.getTime() - 3_600_000 } });
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /no reading stored — the session ended without writing PROGRAMME-REVIEW.md — the one on disk is an earlier reading's/u);
  assert.doesNotMatch(result.out, /review written/u);
  assert.equal(readFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'utf8'), earlier, 'nothing is removed or rewritten');
  // The same session writing the report again, after the launch, is this reading's.
  const again = await f.call(['review', 'p'], { extra: { session: f.reads(), mtime: () => AFTER_START } });
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /review written/u);
});

test('programme review: timeout or unavailable routing exits 2', async (t) => {
  for (const condition of ['timeout', 'export', 'route']) {
    const f = programmeSetup(t);
    const extra = {
      timeout: { session: async () => ({ ...DONE, status: TIMEOUT_EXIT, timedOut: true }) },
      export: { checkout: () => ({ ok: false, reason: 'export failed' }) },
      route: { route: () => ({ ok: false, reason: 'no capacity' }) },
    }[condition];
    const result = await f.call(['review', 'p'], { extra });
    assert.equal(result.code, 2, condition);
    if (condition === 'timeout') assert.match(result.err, /thirty minutes/u);
  }
});

test('programme review: verdict subcommand and sign exit 2', async (t) => {
  const f = programmeSetup(t);
  const verdictRes = await f.call(['review', 'p', 'verdict', 'ok']);
  assert.equal(verdictRes.code, 2);
  const signRes = await f.call(['sign', 'p']);
  assert.equal(signRes.code, 2);
});

test('programme review: completion rechecks README inside the strict metadata lock', async (t) => {
  const f = programmeSetup(t);
  const result = await f.call(['review', 'p'], {
    extra: { session: f.reads(() => {
      writeFileSync(join(f.dir, 'README.md'), f.page + '\nconcurrent edit\n');
    }) },
  });
  assert.equal(result.code, 2);
  assert.match(result.err, /README.md changed during the reading/u);
  assert.equal(f.rows.at(-1).kind, 'programme-review', 'failed storage still records the completed provider run');
});

test('mc ask is refused from a programme-review session before jev or writes', async () => {
  const stderr = sink(), stdout = sink();
  const code = await ask(['--reason', 'May I?', '--option', 'a: yes', '--option', 'b: no', '--recommend', 'a'], {
    env: { MC_ROLE: 'programme-review', MC_PROGRAMME: 'p', MC_HEADLESS: '1' }, stdout, stderr,
    readKeys: () => assert.fail('read credentials'), jev: { transport: () => assert.fail('asked jev') },
  });
  assert.equal(code, 2);
  assert.match(stderr.text(), /programme-review session cannot ask or decide/u);
  assert.equal(stdout.text(), '');
});
