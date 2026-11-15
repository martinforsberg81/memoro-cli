/**
 * The plan review's reading (src/mc/plan-review.js): `mc goal plan-review` launches one headless session and keeps
 * its verdict only when the session's own verb recorded it. The launch, the session, the checkout, the clock and the
 * pid check are injected; the goal's directory, the checkout and its removal are real files in a temporary
 * directory, and the real model choice runs on a catalog and a capacity built here.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as claude from '../../src/adapters/claude-code.js';
import { run as ask } from '../../src/mc/commands/ask.js';
import { refusedMove } from '../../src/mc/commands/goal.js';
import { deskRunsPath } from '../../src/mc/desk-budget.js';
import { HOLD_FILE, MEND_ROLE, parseGoal, parseLog, REVIEW_ROLE, readTextOrNull } from '../../src/mc/goals.js';
import { readRunRows } from '../../src/mc/landed.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { applyObservation, normaliseCapacity } from '../../src/mc/model-capacity.js';
import {
  authorOf, chooseReader, goalHash, LAUNCH_FILE, LIMIT_MS, markerRecord, planReviewCall, readerPrompt, readingState, RECORDS_FILE,
  REVIEW_TEXT_FILE, unsupportedClaims, verdictVerb,
} from '../../src/mc/plan-review.js';
import { TIMEOUT_EXIT } from '../../src/mc/run-plan.js';
import { writeFileAtomic } from '../../src/mc/atomic-write.js';
import { goalJsonV2 } from './_helpers/goal-file.js';

const NOW = new Date('2026-11-15T10:00:00Z');
const AFTER_START = NOW.getTime() + 60_000;
const AHEAD = '2026-11-15T15:00:00.000Z';
const LATER = '2026-11-20T00:00:00.000Z';
const SOL = Object.freeze({ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
const OPUS = Object.freeze({ tool: 'claude', model: 'opus', effort: 'high' });
const LISTED = [{ id: 'gpt-6.1-sol', efforts: ['high'] }];
const win = (fraction_used, resets_at = AHEAD) => ({ fraction_used, resets_at });
/** A capacity with claude and codex each at the given use of its plan. */
const capacityOf = (claudeUsed, codexUsed) => {
  let state = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: win(claudeUsed), seven_day: win(claudeUsed) } }, NOW);
  state = applyObservation(state, 'codex', { windows: { primary: win(codexUsed), secondary: null }, models: LISTED }, NOW);
  return state;
};
const catalogOf = (review, providerPriority = 'auto') => ({ ...DEFAULT_CATALOG, providerPriority, review });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sink = () => { const parts = []; return { write: (text) => parts.push(text), text: () => parts.join('') }; };
const AREAS = [{ repo: 'memoro-cli', path: '/x/memoro-cli', areas: [{ id: 'operations', name: 'Operations', paths: ['deploy'], questions: [{ when: 'a deploy changes', ask: 'Does the change deploy anything?' }] }] }];
const DONE = { status: 0, stdout: '', stderr: '' };

/** A goal in draft in a real directory, and the one call and its collaborators. */
function setup(t, { fields = {}, records = null, review = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-plan-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'home', 'programs', 'mc', 'goals', 'ex');
  mkdirSync(dir, { recursive: true });
  const text = goalJsonV2({ stage: 'draft', ...fields });
  writeFileSync(join(dir, 'GOAL.json'), text);
  writeFileSync(join(dir, 'LOG.md'), '## 2026-11-14T10:00Z · person · plan · ready\n\nDone: created\n');
  if (records) writeFileSync(join(dir, RECORDS_FILE), `${JSON.stringify({ records }, null, 2)}\n`);
  if (review !== null) writeFileSync(join(dir, REVIEW_TEXT_FILE), review);
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const target = { programme: 'mc', goal: 'ex', name: 'mc/ex', dir };
  const goal = parseGoal(text);
  const baseEnv = { MC_WORK_ROOT: root, MC_HOME: join(root, 'home'), MC_ROLE: 'plan', MC_GOAL: 'mc/ex', MC_PROGRAMME: 'mc', MC_TOOL: 'claude', MC_MODEL: 'opus', MC_REPO: 'memoro-cli', MC_STEP: '3', MC_PROJECT: 'x' };
  const rows = [];
  const checkoutPath = (round = 1) => join(tmp, `mc-plan-review-mc-ex-r${round}-fixture`);
  const ctxOf = (env, stdout = sink(), stderr = sink()) => ({ stdout, stderr, env, read: readTextOrNull, write: writeFileAtomic, now: NOW, lock: (_root, fn) => fn(), remove: unlinkSync });
  const deps = {
    checkoutId: () => 'fixture', now: () => NOW, alive: () => true, tmp, pid: 4242, mtime: () => AFTER_START, logRun: (row) => rows.push(row),
    catalog: catalogOf([SOL, OPUS]), capacity: capacityOf(0.5, 0.5), token: () => 'a'.repeat(48),
    launch: () => ({ ok: true, id: 'claude', shortName: 'claude', spec: { bin: '/fake/claude' }, adapter: claude }),
    billingRoute: () => ({ billing: 'plan' }),
    checkout: ({ dir: into }) => { writeFileSync(join(into, 'README.md'), 'origin/main'); return { ok: true }; },
    session: async () => DONE,
  };
  const call = async ({ env = baseEnv, avoid = null, refusal = undefined, goal: given = goal, declarations = { declared: AREAS }, extra = {} } = {}) => {
    const stdout = sink(), stderr = sink();
    const ctx = ctxOf(env, stdout, stderr);
    const why = refusal === undefined ? refusedMove({ from: 'draft', to: 'build', env, dir }) : refusal;
    const code = await planReviewCall({ target, goal: given, avoid, refusal: why, declarations, ctx, deps: { ...deps, ...extra } });
    return { code, out: stdout.text(), err: stderr.text() };
  };
  /** A session that writes PLAN-REVIEW.md and records `word` the way the reader does, from the environment the call gave it. */
  const reads = (word, { text = word === 'ok' ? 'OK' : 'NOT OK', before = null } = {}) => async (spawned) => {
    const into = spawned.args[spawned.args.indexOf('--add-dir') + 1];
    assert.equal(readFileSync(join(into, 'README.md'), 'utf8'), 'origin/main', 'the launched reader’s checkout is there');
    if (before) before(spawned);
    writeFileSync(join(dir, REVIEW_TEXT_FILE), `${text}\n\nWhat was read.\n`);
    const said = sink();
    const code = verdictVerb({ target, word, ctx: ctxOf(spawned.env, sink(), said), deps });
    assert.equal(code, 0, said.text());
    return DONE;
  };
  const files = () => Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
  const records_ = () => JSON.parse(readTextOrNull(join(dir, RECORDS_FILE)) ?? '{"records":[]}').records;
  return { root, dir, tmp, target, goal, baseEnv, rows, deps, call, reads, ctxOf, files, records: records_, checkoutPath, log: () => parseLog(readFileSync(join(dir, 'LOG.md'), 'utf8')) };
}

const READING = (verdict, goal, round, extra = {}) => ({ kind: 'reading', verdict, hash: goalHash(goal), round, tool: 'codex', model: 'gpt-6.1-sol', author: null, at: '2026-11-14T12:00:00.000Z', ...extra });

test('one turn: the reader is launched in the goal\'s directory as the plan-review role, with the goal, the areas\' questions and the unsupported claims, and without the caller\'s session identity', async (t) => {
  const f = setup(t, { fields: { change: [{ id: 'C1', where: 'src/mc/goals.js', what: 'Every writer takes the new part.' }, { id: 'C2', where: 'src', what: 'Only the reader changes (P1).' }], ids: { B: 1, P: 1, D: 1, C: 2, V: 1, R: 1, X: 1 } } });
  let seen = null;
  const { code, out, err } = await f.call({ extra: { session: async (spawned) => { seen = spawned; return f.reads('ok')(spawned); } } });
  assert.equal(code, 0, `${out}${err}`);
  assert.equal(seen.bin, '/fake/claude');
  assert.equal(seen.cwd, f.dir);
  assert.equal(seen.timeoutMs, LIMIT_MS);
  assert.equal(seen.group, true);
  const { env } = seen;
  assert.deepEqual([env.MC_ROLE, env.MC_HEADLESS, env.MC_GOAL, env.MC_TOOL, env.MC_MODEL], ['plan-review', '1', 'mc/ex', 'codex', 'gpt-6.1-sol']);
  assert.match(env.MC_PLAN_REVIEW_TOKEN, /^a{48}$/u);
  for (const key of ['MC_PROGRAMME', 'MC_STEP', 'MC_PROJECT', 'MC_REPO']) assert.equal(env[key], undefined, `${key} is the caller's, not the reader's`);
  const prompt = JSON.stringify(seen.args);
  assert.ok(prompt.includes('Make the goal plain'), 'the rendered goal');
  assert.ok(prompt.includes('Does the change deploy anything?') && prompt.includes('memoro-cli/operations'), 'the areas and their questions');
  assert.match(prompt, /C1: src\/mc\/goals\.js — Every writer takes the new part\./u, 'a claim that says every and names no premise');
  assert.doesNotMatch(prompt, /C2: .*Only the reader/u, 'a claim that names a premise id is not asked about');
  assert.ok(seen.args.includes('--add-dir') && seen.args.includes(f.checkoutPath()), 'the checkout is the one directory the reader may read besides its own');
});

test('a verdict from the session leaves one reading, one LOG entry and no launch record; ok exits 0, not OK exits 1; the token is in no file during the turn', async (t) => {
  for (const [word, exit] of [['ok', 0], ['not-ok', 1]]) {
    const f = setup(t);
    let during = null;
    const { code, out } = await f.call({ extra: { session: f.reads(word, { before: () => { during = f.files(); } }) } });
    assert.equal(code, exit, out);
    const [reading, ...more] = f.records();
    assert.equal(more.length, 0);
    assert.deepEqual(Object.keys(reading).sort(), ['at', 'author', 'hash', 'kind', 'model', 'round', 'tool', 'verdict']);
    assert.deepEqual([reading.kind, reading.verdict, reading.hash, reading.round, reading.tool, reading.model, reading.at], ['reading', word, goalHash(f.goal), 1, 'codex', 'gpt-6.1-sol', NOW.toISOString()]);
    assert.deepEqual(reading.author, { tool: 'claude', model: 'opus' });
    assert.equal(existsSync(join(f.dir, LAUNCH_FILE)), false, 'the launch record is gone');
    const entries = f.log();
    assert.equal(entries.length, 2, 'the creation and one reading');
    assert.match(entries[1].done, new RegExp(`^plan review round 1: ${word === 'ok' ? 'OK' : 'NOT OK'}$`, 'u'));
    assert.equal(existsSync(f.checkoutPath()), false, 'the checkout is removed');
    assert.ok(Object.values(during).every((text) => !text.includes('a'.repeat(48))), 'no file holds the token during the turn');
    assert.equal(JSON.parse(during[LAUNCH_FILE]).token_sha256, sha256('a'.repeat(48)), 'the launch record holds its sha256');
  }
});

test('a reading is on the other model: the author\'s is not chosen with two candidates, even with more headroom or when priority names its tool', async (t) => {
  const f = setup(t);
  const chosen = async (extra, env = f.baseEnv) => {
    let model = null;
    await f.call({ env, extra: { ...extra, session: async (spawned) => { model = `${spawned.env.MC_TOOL}:${spawned.env.MC_MODEL}`; return DONE; } } });
    return model;
  };
  const byOpus = { ...f.baseEnv, MC_TOOL: 'claude', MC_MODEL: 'opus' };
  const bySol = { ...f.baseEnv, MC_TOOL: 'codex', MC_MODEL: 'gpt-6.1-sol' };
  assert.equal(await chosen({ capacity: capacityOf(0.9, 0.1) }, bySol), 'claude:opus', 'the author\'s plan has the most room, the other one is read');
  assert.equal(await chosen({ capacity: capacityOf(0.1, 0.9) }, byOpus), 'codex:gpt-6.1-sol');
  assert.equal(await chosen({ capacity: capacityOf(0.9, 0.1), catalog: catalogOf([SOL, OPUS], 'codex') }, bySol), 'claude:opus', 'priority names the author\'s tool');
  assert.equal(await chosen({ capacity: capacityOf(0.1, 0.9), catalog: catalogOf([SOL, OPUS], 'claude') }, byOpus), 'codex:gpt-6.1-sol');
  assert.equal(await chosen({ capacity: capacityOf(0.5, 0.5) }, { ...f.baseEnv, MC_TOOL: 'codex', MC_MODEL: 'gpt-6.1-sol' }), 'claude:opus');
});

test('a candidate that can run only on its API reserve is chosen over the author\'s model; the author\'s is chosen only when no other is listed', async (t) => {
  const f = setup(t);
  const routes = [];
  const run = async (extra, env) => {
    let model = null;
    const result = await f.call({ env, extra: { billingRoute: (_tool, options) => { routes.push(options.route.billing); return { billing: 'plan' }; }, ...extra, session: async (spawned) => { model = spawned.env.MC_MODEL; return DONE; } } });
    return { ...result, model };
  };
  const byOpus = { ...f.baseEnv, MC_TOOL: 'claude', MC_MODEL: 'opus' };
  const spent = await run({ capacity: capacityOf(0.2, 1) }, byOpus);
  assert.equal(spent.model, 'gpt-6.1-sol', 'codex is at its limit and still the other model');
  assert.equal(routes.at(-1), 'credits', 'on its API reserve');
  assert.doesNotMatch(spent.out, /no other model could run/u);
  const alone = await run({ catalog: catalogOf([OPUS]) }, byOpus);
  assert.equal(alone.model, 'opus', 'the list holds the author\'s model alone');
  assert.match(alone.out, /the author is claude opus \(no other model could run\)/u);
  const stub = chooseReader({ catalog: catalogOf([SOL, OPUS]), capacity: capacityOf(0.5, 0.5), now: NOW, author: { tool: 'claude', model: 'opus' }, choose: ({ catalog }) => (catalog.review.length === 1 ? { ok: false, reason: 'nothing can run' } : { ok: true, candidate: catalog.review[1] }) });
  assert.equal(stub.candidate.model, 'opus', 'when the others answer that nothing can run, the whole list is asked');
});

test('the author is MC_TOOL and MC_MODEL, else --avoid, else unknown, and the call and the record say so', async (t) => {
  assert.deepEqual(authorOf({ MC_TOOL: 'claude', MC_MODEL: 'opus' }, 'codex:gpt-6.1-sol'), { tool: 'claude', model: 'opus' });
  assert.deepEqual(authorOf({ MC_TOOL: 'person' }, 'codex:gpt-6.1-sol'), { tool: 'codex', model: 'gpt-6.1-sol' });
  assert.deepEqual(authorOf({}, 'codex:gpt-6.1-sol'), { tool: 'codex', model: 'gpt-6.1-sol' });
  assert.equal(authorOf({}, null), null);
  assert.equal(authorOf({}, 'opus'), null);
  const person = { MC_WORK_ROOT: 'unused', MC_TOOL: 'person' };
  const given = setup(t);
  const viaAvoid = await given.call({ env: { ...given.baseEnv, MC_ROLE: undefined, MC_GOAL: undefined, MC_TOOL: 'person', MC_MODEL: undefined }, avoid: 'codex:gpt-6.1-sol', extra: { session: given.reads('ok') } });
  assert.equal(viaAvoid.code, 0, viaAvoid.err);
  assert.match(viaAvoid.out, /on claude opus — the author is codex gpt-6.1-sol/u);
  assert.deepEqual(given.records()[0].author, { tool: 'codex', model: 'gpt-6.1-sol' });
  const unknown = setup(t);
  const quiet = await unknown.call({ env: { MC_WORK_ROOT: unknown.root, MC_HOME: unknown.baseEnv.MC_HOME, ...person }, extra: { session: unknown.reads('ok') } });
  assert.equal(quiet.code, 0, quiet.err);
  assert.match(quiet.out, /the author's model is unknown, none excluded/u);
  assert.equal(unknown.records()[0].author, null);
  const bad = await unknown.call({ avoid: 'opus' });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--avoid is <tool>:<model>/u);
});

test('no verdict, a timeout, a failed session and a failed checkout leave no reading, no launch record and no checkout, exit 1; a turn that ran still writes its run row', async (t) => {
  const cases = {
    'no verdict': { session: async () => DONE },
    'timeout': { session: async () => ({ status: TIMEOUT_EXIT, stdout: '', stderr: '', timedOut: true }) },
    'a session that throws': { session: async () => { throw new Error('fake session stopped'); } },
  };
  for (const [label, extra] of Object.entries(cases)) {
    const f = setup(t);
    const { code, err } = await f.call({ extra });
    assert.equal(code, 1, label);
    assert.match(err, /no reading stored/u, label);
    assert.equal(existsSync(join(f.dir, RECORDS_FILE)), false, `${label}: no reading`);
    assert.equal(existsSync(join(f.dir, LAUNCH_FILE)), false, `${label}: the launch is closed`);
    assert.equal(existsSync(f.checkoutPath()), false, `${label}: the checkout is removed`);
    assert.equal(f.log().length, 1, `${label}: LOG.md unchanged`);
    assert.deepEqual(f.rows.map((row) => [row.kind, row.name, row.cls]), [['plan-review', 'goal:mc/ex', 'review']], label);
  }
  const timed = setup(t);
  assert.match((await timed.call({ extra: cases.timeout })).err, /exceeded twenty minutes/u);
  const failed = setup(t);
  const broken = await failed.call({ extra: { checkout: () => ({ ok: false, reason: 'git archive of memoro-cli failed' }), session: () => assert.fail('no reader without a checkout') } });
  assert.equal(broken.code, 1);
  assert.match(broken.err, /git archive of memoro-cli failed/u);
  assert.equal(existsSync(failed.checkoutPath()), false);
  assert.equal(existsSync(join(failed.dir, LAUNCH_FILE)), false);
});

test('a timeout after a valid verdict discards the reading but keeps the paid run row', async (t) => {
  for (const word of ['ok', 'not-ok']) {
    const f = setup(t);
    const { code, err } = await f.call({ extra: { session: async (spawned) => {
      await f.reads(word)(spawned);
      return { ...DONE, status: TIMEOUT_EXIT, timedOut: true };
    } } });
    assert.equal(code, 1, word);
    assert.match(err, /exceeded twenty minutes/u);
    assert.deepEqual(f.records(), []);
    assert.equal(f.log().length, 1);
    assert.equal(existsSync(join(f.dir, LAUNCH_FILE)), false);
    assert.equal(existsSync(f.checkoutPath()), false);
    assert.deepEqual(f.rows.map(({ kind, exit, note }) => [kind, exit, note]), [
      ['plan-review', TIMEOUT_EXIT, 'the reading exceeded twenty minutes'],
    ]);
  }
});

test('cleanup retains and names a replacement directory or symlink rather than deleting an unowned checkout', async (t) => {
  for (const replacement of ['directory', 'symlink']) {
    const f = setup(t);
    const original = join(f.tmp, 'original-checkout');
    const other = join(f.tmp, 'other');
    const { code, err } = await f.call({ extra: { session: async (spawned) => {
      await f.reads('ok')(spawned);
      renameSync(f.checkoutPath(), original);
      if (replacement === 'directory') mkdirSync(f.checkoutPath());
      else {
        mkdirSync(other);
        symlinkSync(other, f.checkoutPath(), 'dir');
      }
      writeFileSync(join(f.checkoutPath(), 'unowned.txt'), 'keep');
      return DONE;
    } } });
    assert.equal(code, 1, replacement);
    assert.match(err, /checkout .* is left in place.*identity/u);
    assert.ok(err.includes(f.checkoutPath()));
    assert.equal(readFileSync(join(f.checkoutPath(), 'unowned.txt'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(original, 'README.md'), 'utf8'), 'origin/main');
    assert.deepEqual(f.records(), []);
    assert.equal(existsSync(join(f.dir, LAUNCH_FILE)), false);
  }
});

test('the default run row is appended to the runner\'s runs file with kind plan-review and the goal\'s name', async (t) => {
  const f = setup(t);
  const { logRun, ...rest } = f.deps;
  const stdout = sink(), stderr = sink();
  const code = await planReviewCall({ target: f.target, goal: f.goal, avoid: null, refusal: null, declarations: { declared: AREAS }, ctx: f.ctxOf(f.baseEnv, stdout, stderr), deps: { ...rest, session: f.reads('ok') } });
  assert.equal(code, 0, stderr.text());
  const rows = readRunRows(readFileSync(deskRunsPath(f.baseEnv), 'utf8'));
  assert.deepEqual(rows.map((row) => [row.kind, row.name, row.class, row.tool, row.model]), [['plan-review', 'goal:mc/ex', 'review', 'codex', 'gpt-6.1-sol']]);
});

test('files the goal owns changed during the turn: no record is stored, exit 1 and the file is named, even with a verdict of ok', async (t) => {
  const edits = {
    'GOAL.json': (dir) => writeFileSync(join(dir, 'GOAL.json'), goalJsonV2({ stage: 'draft', title: 'Changed by the reader' })),
    'LOG.md': (dir) => writeFileSync(join(dir, 'LOG.md'), `${readFileSync(join(dir, 'LOG.md'), 'utf8')}\n## 2026-11-15T10:05Z · x · plan · ready\n\nDone: a line the reader added\n`),
    [HOLD_FILE]: (dir) => writeFileSync(join(dir, HOLD_FILE), '{"reason":"held by the reader"}\n'),
  };
  for (const [name, edit] of Object.entries(edits)) {
    const f = setup(t);
    const { code, err } = await f.call({ extra: { session: f.reads('ok', { before: () => edit(f.dir) }) } });
    assert.equal(code, 1, name);
    assert.match(err, new RegExp(`${name.replace('.', '\\.')} changed during the reading`, 'u'));
    assert.equal(existsSync(join(f.dir, RECORDS_FILE)), false, `${name}: no stored record`);
    assert.equal(existsSync(join(f.dir, LAUNCH_FILE)), false);
    assert.equal(existsSync(f.checkoutPath()), false);
    assert.equal(f.log().some((entry) => /plan review round/u.test(entry.done ?? '')), false, `${name}: no reading entry`);
  }
});

test('the verdict verb is accepted from the launched session only: each wrong token, goal, role, text and moment is refused with exit 2 and records nothing', async (t) => {
  const f = setup(t);
  const attempts = [];
  const attempt = (label, { env = {}, word = 'ok', mtime = deps => deps.mtime, now = NOW } = {}, spawned) => {
    const said = sink();
    const merged = { ...spawned.env, ...env };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete merged[key];
    const code = verdictVerb({ target: f.target, word, ctx: f.ctxOf(merged, sink(), said), deps: { ...f.deps, mtime: mtime(f.deps), now: () => now } });
    attempts.push({ label, code, said: said.text() });
    assert.equal(readTextOrNull(join(f.dir, LAUNCH_FILE)).includes('"verdict"'), false, `${label}: nothing recorded`);
  };
  const session = async (spawned) => {
    const launch = JSON.parse(readFileSync(join(f.dir, LAUNCH_FILE), 'utf8'));
    attempt('PLAN-REVIEW.md is not written', {}, spawned);
    writeFileSync(join(f.dir, REVIEW_TEXT_FILE), 'NOT OK\n\nreasons\n');
    attempt('its first line disagrees', {}, spawned);
    attempt('it was written before this round', { word: 'not-ok', mtime: () => () => Date.parse(launch.start) - 1 }, spawned);
    attempt('no token', { env: { MC_PLAN_REVIEW_TOKEN: undefined }, word: 'not-ok' }, spawned);
    attempt('a wrong token', { env: { MC_PLAN_REVIEW_TOKEN: 'b'.repeat(48) }, word: 'not-ok' }, spawned);
    attempt('the sha256 as the token', { env: { MC_PLAN_REVIEW_TOKEN: launch.token_sha256 }, word: 'not-ok' }, spawned);
    attempt('another goal', { env: { MC_GOAL: 'mc/other' }, word: 'not-ok' }, spawned);
    attempt('not the plan-review role', { env: { MC_ROLE: 'build-session:goal' }, word: 'not-ok' }, spawned);
    attempt('the word', { word: 'maybe' }, spawned);
    attempt('twenty minutes have passed', { word: 'not-ok', now: new Date(NOW.getTime() + LIMIT_MS) }, spawned);
    return DONE;
  };
  const { code } = await f.call({ extra: { session } });
  assert.equal(code, 1, 'no verdict was recorded');
  const expected = {
    'PLAN-REVIEW.md is not written': /is not written/u, 'its first line disagrees': /starts with "NOT OK", and the verdict is OK/u, 'it was written before this round': /not written in this round/u,
    'no token': /no launch token/u, 'a wrong token': /not the one this reading was launched with/u, 'the sha256 as the token': /not the one this reading was launched with/u,
    'another goal': /reads mc\/other, not mc\/ex/u, 'not the plan-review role': /only the plan-review session a call launched/u, 'the word': /ok or not-ok/u,
    'twenty minutes have passed': /not live/u,
  };
  for (const { label, code: exit, said } of attempts) {
    assert.equal(exit, 2, label);
    assert.match(said, expected[label], label);
  }
  const lateSession = setup(t);
  const ended = verdictVerb({ target: lateSession.target, word: 'ok', ctx: lateSession.ctxOf({ ...lateSession.baseEnv, MC_ROLE: 'plan-review', MC_GOAL: 'mc/ex', MC_PLAN_REVIEW_TOKEN: 'a'.repeat(48) }), deps: lateSession.deps });
  assert.equal(ended, 2, 'after the call has ended there is no launch record to answer');
});

test('a launch whose process is gone is not live, and a verdict against it is refused', async (t) => {
  const f = setup(t);
  writeFileSync(join(f.dir, LAUNCH_FILE), `${JSON.stringify({ round: 1, hash: 'h', token_sha256: sha256('a'.repeat(48)), pid: 4242, start: NOW.toISOString() })}\n`);
  writeFileSync(join(f.dir, REVIEW_TEXT_FILE), 'OK\n');
  const said = sink();
  const env = { ...f.baseEnv, MC_ROLE: 'plan-review', MC_GOAL: 'mc/ex', MC_PLAN_REVIEW_TOKEN: 'a'.repeat(48) };
  assert.equal(verdictVerb({ target: f.target, word: 'ok', ctx: f.ctxOf(env, sink(), said), deps: { ...f.deps, alive: () => false } }), 2);
  assert.match(said.text(), /not live/u);
});

test('the call is refused with exit 2, launching and writing nothing, from build, review, mend, desk-prepare and plan-review sessions', async (t) => {
  const roles = { 'build-session:goal': 'build', [REVIEW_ROLE]: 'review', [MEND_ROLE]: 'mend', 'desk-prepare': 'desk-prepare', 'plan-review': 'plan-review' };
  for (const [role, label] of Object.entries(roles)) {
    const f = setup(t);
    const before = f.files();
    const { code, err } = await f.call({ env: { ...f.baseEnv, MC_ROLE: role } , extra: { session: () => assert.fail(`${label} launched a reader`), checkout: () => assert.fail('a checkout') } });
    assert.equal(code, 2, label);
    assert.match(err, /^mc: plan-review mc\/ex: /u, label);
    assert.deepEqual(f.files(), before, `${label}: nothing written`);
    assert.deepEqual(readdirSync(f.tmp), [], `${label}: no checkout`);
    assert.deepEqual(f.rows, [], `${label}: no run row`);
  }
  for (const role of ['plan', 'learning', 'person', 'martin']) {
    const f = setup(t);
    const env = role === 'person' ? { ...f.baseEnv, MC_ROLE: undefined, MC_TOOL: 'person' } : { ...f.baseEnv, MC_ROLE: role };
    const { code, err } = await f.call({ env, extra: { session: f.reads('ok') } });
    assert.equal(code, 0, `${role}: ${err}`);
  }
});

test('the call is refused for a goal not in draft, with a live launch, and after two readings; the learning role reads once', async (t) => {
  const notDraft = setup(t, { fields: { stage: 'build' } });
  const refused = await notDraft.call({ extra: { session: () => assert.fail('launched') } });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /it is in build; a plan review is for a goal in draft/u);

  const live = setup(t);
  const launchText = `${JSON.stringify({ round: 1, hash: 'h', token_sha256: 'x', pid: 99, start: new Date(NOW.getTime() - 60_000).toISOString() }, null, 2)}\n`;
  writeFileSync(join(live.dir, LAUNCH_FILE), launchText);
  const busy = await live.call({ extra: { session: () => assert.fail('launched'), checkout: () => assert.fail('checked out') } });
  assert.equal(busy.code, 2);
  assert.match(busy.err, /a reading of round 1 is running \(pid 99/u);
  assert.equal(readFileSync(join(live.dir, LAUNCH_FILE), 'utf8'), launchText, 'the live launch is left as it was');
  assert.deepEqual(readdirSync(live.tmp), []);

  const twice = setup(t);
  writeFileSync(join(twice.dir, RECORDS_FILE), `${JSON.stringify({ records: [READING('not-ok', twice.goal, 1), READING('not-ok', twice.goal, 2)] })}\n`);
  const third = await twice.call({ extra: { session: () => assert.fail('a third round') } });
  assert.equal(third.code, 2);
  assert.match(third.err, /2 readings are stored since it entered draft — a third round is the author's decision: mc goal stage mc\/ex build --reason/u);

  const learning = setup(t, { records: [READING('not-ok', parseGoal(goalJsonV2({ stage: 'draft' })), 1)] });
  const second = await learning.call({ env: { ...learning.baseEnv, MC_ROLE: 'learning' }, extra: { session: () => assert.fail('a second reading by learning') } });
  assert.equal(second.code, 2);
  assert.match(second.err, /the learning role runs one reading per goal it wrote/u);
});

test('a dead-pid or an expired launch is closed as no reading and the next call runs; a pre-existing checkout path makes the call refuse and removes nothing', async (t) => {
  for (const [label, launch, alive] of [
    ['dead pid', { pid: 99, start: new Date(NOW.getTime() - 60_000).toISOString() }, () => false],
    ['expired', { pid: 99, start: new Date(NOW.getTime() - LIMIT_MS - 1000).toISOString() }, () => true],
  ]) {
    const f = setup(t);
    writeFileSync(join(f.dir, LAUNCH_FILE), `${JSON.stringify({ round: 1, hash: 'h', token_sha256: 'x', ...launch })}\n`);
    const abandoned = f.checkoutPath();
    mkdirSync(abandoned);
    writeFileSync(join(abandoned, 'keep.txt'), 'abandoned checkout');
    const alivePid = f.deps.alive;
    const { code, err } = await f.call({ extra: { checkoutId: () => 'next', alive: (pid) => (pid === 99 ? alive() : alivePid(pid)), session: f.reads('ok') } });
    assert.equal(code, 0, `${label}: ${err}`);
    assert.equal(f.records().length, 1, `${label}: the dead launch left no reading of its own`);
    assert.equal(readFileSync(join(abandoned, 'keep.txt'), 'utf8'), 'abandoned checkout');
    assert.equal(existsSync(join(f.tmp, 'mc-plan-review-mc-ex-r1-next')), false, 'only this call’s checkout is removed');
  }
  const f = setup(t);
  const path = f.checkoutPath();
  mkdirSync(path);
  writeFileSync(join(path, 'keep.txt'), 'someone else\'s');
  const { code, err } = await f.call({ extra: { session: () => assert.fail('launched'), checkout: () => assert.fail('overwritten') } });
  assert.equal(code, 2);
  assert.match(err, /exists and this call did not make it — nothing is launched and nothing removed/u);
  assert.equal(readFileSync(join(path, 'keep.txt'), 'utf8'), 'someone else\'s');
  assert.equal(existsSync(join(f.dir, LAUNCH_FILE)), false);
  assert.equal(existsSync(join(f.dir, RECORDS_FILE)), false);
});

test('a marker and a closed launch are not readings; readings count after the latest marker', () => {
  const goal = parseGoal(goalJsonV2({ stage: 'draft' }));
  const hash = goalHash(goal);
  assert.deepEqual(readingState([], hash), { readings: [], latest: null, status: 'none', round: 0 });
  assert.equal(readingState([markerRecord(NOW, 'build')], hash).status, 'none');
  assert.equal(readingState([{ kind: 'launch', closed: true }], hash).status, 'none');
  const ok = READING('ok', goal, 1);
  assert.equal(readingState([ok], hash).status, 'ok');
  assert.equal(readingState([ok], 'another text').status, 'ok-earlier');
  assert.equal(readingState([READING('not-ok', goal, 1)], hash).status, 'not-ok');
  const after = readingState([READING('not-ok', goal, 1), ok, markerRecord(NOW, 'build'), READING('not-ok', goal, 1)], hash);
  assert.equal(after.readings.length, 1);
  assert.equal(after.round, 1);
  assert.equal(readingState([ok, READING('maybe', goal, 2)], hash).readings.length, 1, 'a record that is not a verdict is not a reading');
});

test('a second round keeps the first reading\'s text under its round\'s name, and the first reading and its LOG entry stay', async (t) => {
  const setupGoal = parseGoal(goalJsonV2({ stage: 'draft' }));
  const f = setup(t, { records: [READING('not-ok', setupGoal, 1)], review: 'NOT OK\n\nround one said this\n' });
  const { code, err } = await f.call({ extra: { session: f.reads('ok', { text: 'OK' }) } });
  assert.equal(code, 0, err);
  assert.equal(readFileSync(join(f.dir, 'PLAN-REVIEW-1.md'), 'utf8'), 'NOT OK\n\nround one said this\n');
  assert.match(readFileSync(join(f.dir, REVIEW_TEXT_FILE), 'utf8'), /^OK\n/u);
  assert.deepEqual(f.records().map((record) => [record.verdict, record.round]), [['not-ok', 1], ['ok', 2]]);
  assert.match(f.log().at(-1).done, /plan review round 2: OK/u);
  assert.equal(existsSync(f.checkoutPath(2)), false);
});

test('mc ask is refused from a plan-review session and writes nothing', async () => {
  const stderr = sink(), stdout = sink();
  const code = await ask(['--reason', 'May I?', '--option', 'a: yes', '--option', 'b: no', '--recommend', 'a'], { env: { MC_ROLE: 'plan-review', MC_TOOL: 'claude', MC_GOAL: 'mc/ex', MC_HEADLESS: '1' }, stdout, stderr, jev: { transport: () => assert.fail('asked jev') } });
  assert.equal(code, 2);
  assert.match(stderr.text(), /a plan-review session cannot ask or decide/u);
  assert.equal(stdout.text(), '');
});

test('the prompt names every claim that says every, only or no other and cites no premise, and each declared area with its questions', () => {
  const goal = parseGoal(goalJsonV2({
    stage: 'draft',
    outcome: ['Every writer is covered.', 'The page is short.'],
    decisions: [{ id: 'D1', text: 'Only Martin decides (P1).', by: 'Martin', on: '2026-11-14' }],
    success_criteria: [{ criterion: 'No other caller moves it', check: 'a test', met: false }],
  }));
  const claims = unsupportedClaims(goal);
  assert.deepEqual(claims.map((claim) => claim.id), ['outcome 1', 'criterion 1']);
  const prompt = readerPrompt({ name: 'mc/ex', goal, declared: AREAS, dir: '/g', checkout: '/c' });
  assert.match(prompt, /memoro-cli\/operations — Operations\n    when a deploy changes\n      ask Does the change deploy anything\?/u);
  assert.match(prompt, /outcome 1: Every writer is covered\./u);
  assert.doesNotMatch(prompt, /D1: .*Only Martin/u);
  assert.match(prompt, /\/g\/PLAN-REVIEW\.md/u);
});
