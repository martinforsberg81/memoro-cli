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
import { run as programs } from '../../src/mc/commands/programs.js';
import { listDirsOf, readTextOrNull } from '../../src/mc/goals.js';
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
  const call = async (argv = ['review', 'p'], { identity = env, extra = {}, lock = (_root, fn) => fn() } = {}) => {
    const stdout = sink(), stderr = sink();
    const code = await programs(argv, { env: identity, stdout, stderr, known: () => known, lock, now: () => NOW, review: { ...deps, ...extra } });
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
  const artifact = join(f.dir, 'evidence', 'current.txt');
  mkdirSync(join(f.dir, 'evidence'));
  writeFileSync(artifact, 'original evidence');
  writeFileSync(join(f.dir, 'README.md'), `${f.page}\n- [Evidence](evidence/current.txt)\n- Source: \`/proposals/waiting.md\`\n`);
  rmSync(join(f.dir, RECORD_FILE));
  writeRecord(f.dir, newRecord({ end: 'The promised result runs.', createdBy: 'repair', now: NOW, repair: {
    sources: [{ kind: 'proposal', path: '/proposals/waiting.md', key: 'a'.repeat(64), digest: 'b'.repeat(64) }],
  } }));
  const receipt = () => currentRepairReview(f.dir, { read: path => existsSync(path) ? readFileSync(path, 'utf8') : null });
  const review = (identity, session, extra) => f.call(['review', 'p'], { identity, extra: { session, ...extra } });
  const reader = ({ report = NO_FINDINGS, status = 0, during } = {}) => async spawned => {
    assert.equal(spawned.env.MC_REPAIR_TOKEN, undefined);
    assert.notEqual(spawned.cwd, f.dir);
    assert.equal(readFileSync(join(f.checkout, 'order', 'evidence', 'current.txt'), 'utf8'), 'original evidence');
    during?.();
    assert.equal(readFileSync(join(f.checkout, 'order', 'evidence', 'current.txt'), 'utf8'), 'original evidence');
    if (report !== null) writeFileSync(join(spawned.cwd, PROGRAMME_REVIEW_FILE), report);
    return { ...DONE, status };
  };
  return { ...f, artifact, receipt, review, reader, asAuthor: fn => withRepairAuthor(f.baseEnv, 'p', fn) };
}

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
    assert.deepEqual(f.receipt().receipt.manifest.inputs.map(([path]) => path), ['README.md', 'evidence/current.txt']);
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
