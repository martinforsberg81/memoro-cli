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

import * as agyAdapter from '../../src/adapters/antigravity-cli.js';
import * as claude from '../../src/adapters/claude-code.js';
import { run as ask } from '../../src/mc/commands/ask.js';
import { run as programs } from '../../src/mc/commands/programs.js';
import { newRecord, recordPageTemplate, writeRecord } from '../../src/mc/programme-record.js';
import { refusedMove } from '../../src/mc/commands/goal.js';
import { deskRunsPath } from '../../src/mc/desk-budget.js';
import { HOLD_FILE, MEND_ROLE, parseGoal, parseLog, REVIEW_ROLE, readTextOrNull } from '../../src/mc/goals.js';
import { readRunRows } from '../../src/mc/landed.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { applyObservation, normaliseCapacity, readCapacity } from '../../src/mc/model-capacity.js';
import { runnerDir } from '../../src/mc/paths.js';
import {
  authorOf, chooseReader, goalHash, LAUNCH_FILE, LIMIT_MS, markerRecord, partsLacks, planReviewCall, readerPrompt, readerWalk, readingState, RECORDS_FILE,
  REVIEW_TEXT_FILE, unreadFor, UNREAD_FILE, unsupportedClaims, verdictVerb, PROGRAMME_REVIEW_FILE, PROGRAMME_REVIEW_RECORD, PROGRAMME_REVIEW_LAUNCH, PROGRAMME_REVIEW_LIMIT_MS,
} from '../../src/mc/plan-review.js';
import { QUOTA_SLEEP_MS, TIMEOUT_EXIT } from '../../src/mc/run-plan.js';
import { writeFileAtomic } from '../../src/mc/atomic-write.js';
import { goalJsonV2 } from './_helpers/goal-file.js';

const FILE_BOOT_MS = performance.now();
let reportedBoot = false;

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
    launch: () => ({ ok: true, id: 'claude-code', shortName: 'claude', spec: { bin: '/fake/claude' }, adapter: claude }),
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

test('plan review\'s removal of the author promotes no other candidate to first choice: the catalog\'s first stays first only while it is not the author', () => {
  const ARGON = Object.freeze({ tool: 'agy', model: 'gemini-4-argon-high', effort: 'high' });
  const catalog = catalogOf([ARGON, OPUS, SOL]);
  const withArgon = (claudeUsed, codexUsed) => applyObservation(capacityOf(claudeUsed, codexUsed), 'agy', { windows: { five_hour: win(0.5), weekly: win(0.5) } }, NOW);
  // The author is the first candidate: claude is not promoted, the ranking chooses and codex has the room.
  const byArgon = chooseReader({ catalog, capacity: withArgon(0.9, 0.1), now: NOW, author: { tool: 'agy', model: 'gemini-4-argon-high' } });
  assert.equal(byArgon.candidate.tool, 'codex');
  assert.doesNotMatch(byArgon.why, /first choice/u);
  // The author is a later candidate and the first can run: it is read on the first.
  const byOpus = chooseReader({ catalog, capacity: withArgon(0.1, 0.1), now: NOW, author: { tool: 'claude', model: 'opus' } });
  assert.equal(byOpus.candidate.tool, 'agy');
  assert.match(byOpus.why, /review candidate 1, the first choice/u);
});

test('the author is --avoid when given, else MC_TOOL and MC_MODEL, else unknown, and the call and the record say so', async (t) => {
  assert.deepEqual(authorOf({ MC_TOOL: 'claude', MC_MODEL: 'opus' }, 'codex:gpt-6.1-sol'), { tool: 'codex', model: 'gpt-6.1-sol' });
  assert.deepEqual(authorOf({ MC_TOOL: 'claude', MC_MODEL: 'fable' }, 'claude:opus'), { tool: 'claude', model: 'opus' }, '--avoid names the author');
  assert.deepEqual(authorOf({ MC_TOOL: 'claude', MC_MODEL: 'fable' }, null), { tool: 'claude', model: 'fable' }, 'without --avoid, the caller is the author');
  assert.equal(authorOf({ MC_TOOL: 'person' }, null), null, 'a person with no --avoid: unknown');
  assert.deepEqual(authorOf({ MC_TOOL: 'claude', MC_MODEL: 'opus' }, null), { tool: 'claude', model: 'opus' });
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

test('falls through: a candidate that cannot launch, or whose billing route is unavailable, is set aside with its reason and the next one reads; the author is last', async (t) => {
  const f = setup(t);
  const readBy = async (extra, env = f.baseEnv) => {
    let model = null;
    const result = await f.call({ env, extra: { ...extra, session: async (spawned) => { model = `${spawned.env.MC_TOOL}:${spawned.env.MC_MODEL}`; return DONE; } } });
    return { ...result, model };
  };
  const noCodexLaunch = await readBy({ launch: (tool) => (tool === 'codex' ? { ok: false, reason: 'no adapter' } : f.deps.launch()) });
  assert.equal(noCodexLaunch.model, 'claude:opus', 'the author\'s model reads when the other cannot launch');
  assert.match(noCodexLaunch.err, /codex:gpt-6\.1-sol cannot read — no adapter; trying the next reader/u);
  assert.match(noCodexLaunch.out, /on claude opus — the author is claude opus \(no other model could run\)/u);
  const noCodexRoute = await readBy({ billingRoute: (tool) => (tool === 'codex' ? { billing: 'unavailable', why: 'no API route' } : { billing: 'plan' }) });
  assert.equal(noCodexRoute.model, 'claude:opus');
  assert.match(noCodexRoute.err, /codex:gpt-6\.1-sol cannot read — no API route; trying the next reader/u);
  const onBoth = await readBy({}, { ...f.baseEnv, MC_TOOL: 'codex', MC_MODEL: 'gpt-6.1-sol' });
  assert.equal(onBoth.model, 'claude:opus', 'the caller\'s model is the author, so it is last and the other reads');
});

test('falls through: with [A, B, C] and the author C, A is set aside by its billing route and B by its launch, and the author\'s model C is read last', async (t) => {
  const f = setup(t);
  const ARGON = Object.freeze({ tool: 'agy', model: 'gemini-4-argon-high', effort: 'high' });
  const capacity = applyObservation(capacityOf(0.5, 0.5), 'agy', { windows: { five_hour: win(0.5), weekly: win(0.5) } }, NOW);
  let model = null;
  const result = await f.call({
    env: { ...f.baseEnv, MC_TOOL: 'codex', MC_MODEL: 'gpt-6.1-sol' },
    extra: {
      catalog: catalogOf([ARGON, OPUS, SOL]), capacity,
      billingRoute: (tool) => (tool === 'agy' ? { billing: 'unavailable', why: 'no API route' } : { billing: 'plan' }),
      launch: (tool) => (tool === 'claude' ? { ok: false, reason: 'no adapter' } : f.deps.launch()),
      session: async (spawned) => { model = `${spawned.env.MC_TOOL}:${spawned.env.MC_MODEL}`; return DONE; },
    },
  });
  assert.equal(model, 'codex:gpt-6.1-sol', 'the author\'s model reads last');
  assert.match(result.err, /agy:gemini-4-argon-high cannot read — no API route; trying the next reader/u);
  assert.match(result.err, /claude:opus cannot read — no adapter; trying the next reader/u);
  assert.match(result.out, /on codex gpt-6\.1-sol — the author is codex gpt-6\.1-sol \(no other model could run\)/u);
});

test('falls through: once the first choice is set aside, the list is asked with no first choice, so no other candidate is promoted', () => {
  const calls = [];
  const choose = (args) => { calls.push(args); return { ok: true, candidate: args.catalog.review[0], why: '' }; };
  const walked = readerWalk({
    catalog: catalogOf([SOL, OPUS]), capacity: capacityOf(0.5, 0.5), now: NOW, author: null, choose,
    launch: () => ({ ok: true }), billing: (tool) => ({ billing: tool === 'codex' ? 'unavailable' : 'plan', why: 'no API route' }),
  });
  assert.equal(calls[0].first, SOL, 'the first choice is asked first');
  assert.equal(calls[1].first, null, 'set aside: no first choice');
  assert.deepEqual(calls[1].catalog.review, [OPUS]);
  assert.equal(walked.ok, true);
  assert.equal(walked.candidate, OPUS);
  assert.deepEqual(walked.setAside, [{ tool: 'codex', model: 'gpt-6.1-sol', reason: 'no API route' }]);
});

test('avoid names the author whoever calls: with the caller on codex and --avoid claude:opus, codex reads and the record names claude opus', async (t) => {
  const f = setup(t);
  let model = null;
  const result = await f.call({
    env: { ...f.baseEnv, MC_TOOL: 'codex', MC_MODEL: 'gpt-6.1-sol' }, avoid: 'claude:opus',
    extra: { session: async (spawned) => { model = `${spawned.env.MC_TOOL}:${spawned.env.MC_MODEL}`; return f.reads('ok')(spawned); } },
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(model, 'codex:gpt-6.1-sol');
  assert.deepEqual(f.records()[0].author, { tool: 'claude', model: 'opus' });
});

test('no reader: exit 3 with nothing read, the unread record for the current text, no launch record and no reading; a later launch removes the record', async (t) => {
  const f = setup(t);
  let spawned = false;
  const none = await f.call({ extra: { launch: () => ({ ok: false, reason: 'no adapter' }), session: async () => { spawned = true; return DONE; } } });
  assert.equal(none.code, 3, none.err);
  assert.equal(spawned, false, 'nothing is read');
  assert.match(none.err, /no reader can run — nothing was read; the draft waits for a reader \(codex gpt-6\.1-sol: no adapter; claude opus: no adapter/u);
  assert.equal(existsSync(join(f.dir, LAUNCH_FILE)), false, 'no launch record');
  assert.equal(existsSync(join(f.dir, RECORDS_FILE)), false, 'no reading is stored');
  assert.equal(existsSync(f.checkoutPath()), false, 'no checkout');
  assert.equal(f.log().length, 1, 'LOG.md unchanged');
  const unread = JSON.parse(f.files()[UNREAD_FILE]);
  assert.deepEqual(Object.keys(unread).sort(), ['at', 'author', 'hash', 'reason', 'set_aside']);
  assert.equal(unread.hash, goalHash(f.goal));
  assert.equal(unread.at, NOW.toISOString());
  assert.deepEqual(unread.author, { tool: 'claude', model: 'opus' });
  assert.deepEqual(unread.set_aside.map(({ tool, model, reason }) => [tool, model, reason]), [['codex', 'gpt-6.1-sol', 'no adapter'], ['claude', 'opus', 'no adapter']]);
  assert.equal(unreadFor(f.dir, readTextOrNull, goalHash(f.goal))?.hash, goalHash(f.goal), 'the record names the current text');
  assert.equal(unreadFor(f.dir, readTextOrNull, 'another text'), null, 'and no other text');
  const later = await f.call({ extra: { session: f.reads('ok') } });
  assert.equal(later.code, 0, later.err);
  assert.equal(existsSync(join(f.dir, UNREAD_FILE)), false, 'the launch removed the unread record');
});

test('no reader while a reading runs: exit 2 naming the running launch, and no unread record is written', async (t) => {
  const f = setup(t);
  writeFileSync(join(f.dir, LAUNCH_FILE), `${JSON.stringify({ binding: 'mc/ex', role: 'plan-review', round: 1, hash: goalHash(f.goal), token_sha256: sha256('x'), pid: 4141, start: NOW.toISOString(), tool: 'codex', model: 'gpt-6.1-sol', author: null })}\n`);
  const result = await f.call({ extra: { launch: () => ({ ok: false, reason: 'no adapter' }) } });
  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /a reading of round 1 is running \(pid 4141/u);
  assert.equal(existsSync(join(f.dir, UNREAD_FILE)), false);
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

const PAGED = { id: 'rule', name: 'Rule', covers: 'What rule covers.', standards: ['docs/rule.md'], paths: ['src/rule/'], questions: [{ when: 'rule changes', ask: 'Is rule still true?' }], page: 'docs/areas/rule.md' };
const SOURCE = { id: 'games', name: 'The games', covers: 'What the games are for.', standards: [], paths: ['src/games/'], questions: [], page: 'docs/areas/games.md' };

test('the prompt gives a rule area\'s page as a path under the checkout before its questions, and the source areas apart, with what they cover and their page and no question', () => {
  const goal = parseGoal(goalJsonV2({ stage: 'draft' }));
  const prompt = readerPrompt({ name: 'p/g', goal, declared: [{ repo: 'r', path: '/r', areas: [PAGED, SOURCE] }], dir: '/g', checkout: '/c' });
  const areas = prompt.slice(prompt.indexOf('THE DECLARED RULE AREAS'));
  assert.match(areas, /^THE DECLARED RULE AREAS OF ITS REPOSITORIES, with their questions\n  r\/rule — Rule\n    page \/c\/r\/docs\/areas\/rule\.md\n    when rule changes\n      ask Is rule still true\?\n\nTHE SOURCE AREAS/u);
  assert.match(areas, /\n  r\/games — The games\n    covers What the games are for\.\n    page \/c\/r\/docs\/areas\/games\.md\n\nSTATEMENTS THAT SAY/u);
  assert.equal(areas.indexOf('r/games'), areas.indexOf('THE SOURCE AREAS') + areas.slice(areas.indexOf('THE SOURCE AREAS')).indexOf('r/games'), 'r/games is listed under the source section alone');
  assert.doesNotMatch(areas.slice(areas.indexOf('r/games')), /when |ask /u);
  const plain = readerPrompt({ name: 'p/g', goal, declared: [{ repo: 'r', path: '/r', areas: [{ ...PAGED, page: undefined }] }], dir: '/g', checkout: '/c' });
  assert.doesNotMatch(plain, /page |SOURCE AREAS/u, 'no page and no source area give no line and no section');
});

test('the prompt marks an area that declares seen and asks question 8 only when the goal stands touched on one; the prompt is the same without seen', () => {
  const goalWith = (stand) => parseGoal(goalJsonV2({ stage: 'draft', obligations: [{ area: 'r/rule', stand, text: 't', ...(stand === 'touched' ? { standard: 'r/docs/rule.md#Rule' } : {}) }] }));
  const prompt = (stand, area) => readerPrompt({ name: 'p/g', goal: goalWith(stand), declared: [{ repo: 'r', path: '/r', areas: [area] }], dir: '/g', checkout: '/c' });
  const seen = prompt('touched', { ...PAGED, seen: true });
  assert.match(seen, /\n  r\/rule — Rule · judged as the user sees it\n/u);
  assert.match(seen, /\nQUESTION 8 IS ASKED: the goal stands touched on r\/rule, judged as the user sees it — answer it for that area\n/u);
  const untouched = prompt('untouched', { ...PAGED, seen: true });
  assert.match(untouched, /r\/rule — Rule · judged as the user sees it/u, 'the area is still marked');
  assert.doesNotMatch(untouched, /QUESTION 8/u, 'a goal untouched on it is not asked question 8');
  const plain = prompt('touched', PAGED);
  assert.doesNotMatch(plain, /QUESTION 8|judged as the user sees it/u);
  assert.equal(plain, prompt('touched', { ...PAGED, seen: undefined }), 'no seen key and an absent one give one prompt');
});

const GOAL_OF_RULE = { version: 2, repos: ['r'], outcome: ['x'], change: [{ id: 'C1', where: 'src/rule/b.js', what: 'y' }], success_criteria: [{ criterion: 'c', check: 'k', met: false }], obligations: [{ area: 'r/rule', stand: 'untouched', text: 't' }] };
const lacksWith = (answers = {}, areas = [PAGED, SOURCE]) => partsLacks(GOAL_OF_RULE, 'p/g', { declarations: () => ({ declared: [{ repo: 'r', path: '/r', areas }] }), onMain: (repo, path) => answers[path] ?? { state: 'present' } });

test('the parts check asks no stand of a source area and names a page that is not on origin/main, or cannot be asked, with the area, the page and the repository', () => {
  assert.deepEqual(lacksWith(), [], 'no stand on the source area, both pages present');
  const noPage = lacksWith({ 'docs/areas/games.md': { state: 'absent' } });
  assert.equal(noPage.length, 1);
  assert.match(noPage[0], /r\/games.*docs\/areas\/games\.md.*origin\/main of r/u);
  const rule = lacksWith({ 'docs/areas/rule.md': { state: 'absent' } });
  assert.equal(rule.length, 1);
  assert.match(rule[0], /r\/rule.*docs\/areas\/rule\.md/u);
  const unknown = lacksWith({ 'docs/areas/games.md': { state: 'unknown', why: 'git gave no answer' } });
  assert.equal(unknown.length, 1);
  assert.match(unknown[0], /docs\/areas\/games\.md.*git gave no answer/u);
  assert.equal(lacksWith({}, [PAGED, { ...SOURCE, id: 'other' }]).some((line) => /no stand/u.test(line)), false);
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

test('a plan review whose agy session reads a login refusal writes agy\'s refusal, and the next choice passes it by; an API-billed one writes nothing', async (t) => {
  const ARGON = Object.freeze({ tool: 'agy', model: 'gemini-4-argon-high', effort: 'high' });
  const catalog = catalogOf([ARGON, OPUS, SOL]);
  const agy = () => ({ ok: true, id: 'antigravity-cli', shortName: 'agy', spec: { bin: '/fake/agy' }, adapter: agyAdapter });
  const signedOut = async () => ({ status: 1, stdout: '', stderr: 'Error: authentication required, please sign in' });
  const f = setup(t);
  const { code } = await f.call({ extra: { catalog, launch: agy, session: signedOut } });
  assert.equal(code, 1, 'no verdict, no reading');
  const kept = readCapacity({ root: runnerDir(f.baseEnv) });
  assert.equal(kept.providers.agy.refusal_until, new Date(NOW.getTime() + QUOTA_SLEEP_MS).toISOString(), 'refused for the quota sleep, the read naming no reset');
  const next = chooseReader({ catalog, capacity: applyObservation(capacityOf(0.5, 0.5), 'agy', { windows: { five_hour: win(0.1), weekly: win(0.1) } }, NOW), now: NOW });
  assert.equal(next.candidate.tool, 'agy', 'unrefused, agy is the first choice');
  assert.notEqual(chooseReader({ catalog, capacity: kept, now: NOW }).candidate.tool, 'agy', 'refused, the choice passes agy by');

  const api = setup(t);
  await api.call({ extra: { catalog, launch: agy, session: signedOut, billingRoute: () => ({ billing: 'credits' }) } });
  assert.equal(readCapacity({ root: runnerDir(api.baseEnv) }).providers.agy?.refusal_until ?? null, null, 'an API-billed session refused nothing about the plan');
});


/** Reuse the goal reader's provider/clock boundaries; the programme handlers and every owned file are real. */
function programmeSetup(t) {
  const setupStart = performance.now();
  if (!reportedBoot) { t.diagnostic(`plan-review file process startup through imports: ${FILE_BOOT_MS.toFixed(3)} ms`); reportedBoot = true; }
  const shared = setup(t);
  const dir = join(shared.root, 'programs', 'p');
  mkdirSync(dir, { recursive: true });
  const page = recordPageTemplate().replace(/^Repositories:.*$/mu, 'Repositories: memoro-cli, memoro.');
  writeFileSync(join(dir, 'README.md'), page);
  writeRecord(dir, newRecord({ end: 'The promised result runs.', createdBy: 'manager', now: NOW }));
  const env = { ...shared.baseEnv, MC_ROLE: 'manager', MC_PROGRAMME: 'p', MC_HEADLESS: '1', MC_SESSION_STARTED: 'old', MC_SCRATCH: '/old/scratch', MC_PLAN_REVIEW_TOKEN: 'inherited' };
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
  const files = () => Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), 'utf8')]));
  const verdicts = [];
  const reads = (word, before = () => {}) => async (spawned) => {
    await before(spawned);
    writeFileSync(join(dir, PROGRAMME_REVIEW_FILE), `${word === 'ok' ? 'OK' : 'NOT OK'}\nfindings: 2\n\nPart 1, Solution: evidence and narrow fix.\n`);
    const result = await call(['review', 'p', 'verdict', word], { identity: spawned.env });
    verdicts.push(result);
    assert.equal(result.code, 0, result.err);
    return DONE;
  };
  const meta = () => JSON.parse(readTextOrNull(join(dir, PROGRAMME_REVIEW_RECORD)) ?? 'null');
  t.diagnostic(`programme fixture setup (including shared real-files fixture): ${(performance.now() - setupStart).toFixed(3)} ms`);
  return { ...shared, dir, page, env, checkout, deps, call, reads, files, meta, verdicts,
    martin: { ...env, MC_ROLE: 'martin', MC_HEADLESS: undefined, MC_GOAL: undefined } };
}

test('programme review: real command launches its own identity on named origin/main exports, records both verdicts and permits a third reading', async (t) => {
  const f = programmeSetup(t);
  for (const word of ['ok', 'not-ok', 'ok']) {
    const result = await f.call(['review', 'p'], { extra: { session: f.reads(word, (spawned) => {
      assert.equal(spawned.timeoutMs, 30 * 60_000);
      assert.equal(spawned.timeoutMs, PROGRAMME_REVIEW_LIMIT_MS);
      assert.equal(spawned.cwd, f.dir);
      assert.deepEqual([spawned.env.MC_ROLE, spawned.env.MC_PROGRAMME, spawned.env.MC_HEADLESS], ['programme-review', 'p', '1']);
      for (const key of ['MC_GOAL', 'MC_STEP', 'MC_PROJECT', 'MC_REPO', 'MC_PLAN_REVIEW_TOKEN', 'MC_SESSION_STARTED', 'MC_SCRATCH']) assert.equal(spawned.env[key], undefined, key);
      assert.equal(spawned.env.MC_PROGRAMME_REVIEW_TOKEN, 'a'.repeat(48));
      assert.deepEqual([spawned.env.MC_TOOL, spawned.env.MC_MODEL], ['codex', 'gpt-6.1-sol'], 'shared author exclusion');
      assert.ok(spawned.args.includes('--add-dir') && spawned.args.includes(f.checkout));
      const prompt = JSON.stringify(spawned.args);
      for (const repo of ['memoro-cli', 'memoro']) {
        assert.ok(prompt.includes(join(f.checkout, repo)));
        assert.equal(readFileSync(join(f.checkout, repo, 'main.txt'), 'utf8'), `origin/main of ${repo}`);
      }
      assert.ok(prompt.includes('README.md follows:'));
      assert.ok(prompt.includes('playback and basis'));
      assert.ok(Object.values(f.files()).every((text) => !text.includes(spawned.env.MC_PROGRAMME_REVIEW_TOKEN)), 'no raw token persisted');
    }) } });
    assert.equal(result.code, word === 'ok' ? 0 : 1, result.err);
    assert.ok(result.out.includes(join(f.dir, PROGRAMME_REVIEW_FILE)));
    assert.ok(result.out.includes(word === 'ok' ? 'OK' : 'NOT OK'));
    assert.deepEqual([f.meta().verdict, f.meta().findings, f.meta().hash, f.meta().at], [word, 2, sha256(f.page), NOW.toISOString()]);
    assert.equal(f.meta().report_sha256, sha256(readFileSync(join(f.dir, PROGRAMME_REVIEW_FILE))));
    assert.deepEqual(Object.keys(f.files()).sort(), [PROGRAMME_REVIEW_RECORD, 'PROGRAMME-REVIEW.md', 'PROGRAMME.json', 'README.md'].sort(), 'no launch or desk item');
    assert.equal(existsSync(f.checkout), false);
  }
  assert.deepEqual(f.rows.map(({ kind, name, cls }) => [kind, name, cls]), Array(3).fill(['programme-review', 'programme:p', 'review']));
});

test('programme review: caller authority and repository declarations refuse before launch or effects', async (t) => {
  for (const identity of [
    { MC_ROLE: 'build-session:goal' }, { MC_ROLE: 'review-session:goal' }, { MC_ROLE: 'mend-session' },
    { MC_ROLE: 'desk-prepare' }, { MC_ROLE: 'decision' }, { MC_ROLE: 'programme-review' }, { MC_ROLE: 'plan-review' },
    { MC_ROLE: 'martin', MC_HEADLESS: '1' }, { MC_ROLE: 'plan', MC_HEADLESS: '1' },
    { MC_ROLE: 'plan', MC_HEADLESS: undefined, MC_GOAL: 'p/g' },
  ]) {
    const f = programmeSetup(t), before = f.files();
    const result = await f.call(['review', 'p'], { identity: { ...f.env, ...identity }, extra: { session: f.reads('ok') } });
    assert.equal(result.code, 2, JSON.stringify(identity));
    assert.deepEqual(f.files(), before);
    assert.deepEqual(readdirSync(f.tmp), []);
  }
  for (const identity of [
    { MC_ROLE: 'manager', MC_HEADLESS: '1' }, { MC_ROLE: 'martin' }, { MC_ROLE: 'plan' }, { MC_ROLE: undefined },
  ]) {
    const f = programmeSetup(t);
    assert.equal((await f.call(['review', 'p'], { identity: { ...f.env, MC_HEADLESS: undefined, MC_GOAL: undefined, ...identity }, extra: { session: f.reads('ok') } })).code, 0);
  }
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

test('programme review: missing verdict, timeout (even after a verdict), failed export or unavailable routing exit 2 without current metadata', async (t) => {
  for (const condition of ['no verdict', 'timeout', 'timeout after verdict', 'export', 'route', 'adapter', 'billing']) {
    const f = programmeSetup(t);
    const extra = {
      'no verdict': { session: async () => DONE },
      timeout: { session: async () => ({ ...DONE, status: TIMEOUT_EXIT, timedOut: true }) },
      'timeout after verdict': { session: async (spawned) => { await f.reads('ok')(spawned); return { ...DONE, timedOut: true, status: TIMEOUT_EXIT }; } },
      export: { checkout: () => ({ ok: false, reason: 'export failed' }) },
      route: { route: () => ({ ok: false, reason: 'no capacity' }) },
      adapter: { launch: () => ({ ok: false, reason: 'no adapter' }) },
      billing: { billingRoute: () => ({ billing: 'unavailable', why: 'no billing' }) },
    }[condition];
    const result = await f.call(['review', 'p'], { extra });
    assert.equal(result.code, 2, `${condition}: ${result.err}`);
    assert.equal(f.meta(), null, condition);
    assert.equal(existsSync(join(f.dir, PROGRAMME_REVIEW_LAUNCH)), false);
    assert.equal(existsSync(f.checkout), false);
    if (condition.includes('timeout')) assert.match(result.err, /thirty minutes/u);
  }
});

test('programme review: each forged role, programme, token, launch, report or expired/dead call refuses the real verdict handler', async (t) => {
  const cases = ['role', 'programme', 'token absent', 'token wrong', 'token hash', 'launch role', 'launch binding', 'launch dead', 'expired', 'future', 'report absent', 'report old', 'report verdict', 'report findings', 'changed README'];
  for (const fault of cases) {
    const f = programmeSetup(t);
    let observed;
    const result = await f.call(['review', 'p'], { extra: { session: async (spawned) => {
      let identity = { ...spawned.env };
      let extra = {};
      const launchPath = join(f.dir, PROGRAMME_REVIEW_LAUNCH);
      const launch = JSON.parse(readFileSync(launchPath, 'utf8'));
      writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'OK\nfindings: 0\n');
      if (fault === 'role') identity.MC_ROLE = 'plan-review';
      if (fault === 'programme') identity.MC_PROGRAMME = 'other';
      if (fault === 'token absent') delete identity.MC_PROGRAMME_REVIEW_TOKEN;
      if (fault === 'token wrong') identity.MC_PROGRAMME_REVIEW_TOKEN = 'wrong';
      if (fault === 'token hash') identity.MC_PROGRAMME_REVIEW_TOKEN = launch.token_sha256;
      if (fault === 'launch role') writeFileSync(launchPath, JSON.stringify({ ...launch, role: 'plan-review' }));
      if (fault === 'launch binding') writeFileSync(launchPath, JSON.stringify({ ...launch, binding: 'other' }));
      if (fault === 'launch dead') extra.alive = () => false;
      if (fault === 'expired') extra.now = () => new Date(NOW.getTime() + PROGRAMME_REVIEW_LIMIT_MS);
      if (fault === 'future') extra.now = () => new Date(NOW.getTime() - 1);
      if (fault === 'report absent') unlinkSync(join(f.dir, PROGRAMME_REVIEW_FILE));
      if (fault === 'report old') extra.mtime = () => NOW.getTime() - 1;
      if (fault === 'report verdict') writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'NOT OK\nfindings: 0\n');
      if (fault === 'report findings') writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'OK\n\nno count\n');
      if (fault === 'changed README') writeFileSync(join(f.dir, 'README.md'), f.page + '\nchanged\n');
      const before = readFileSync(launchPath, 'utf8');
      const verdict = await f.call(['review', 'p', 'verdict', 'ok'], { identity, extra });
      observed = { verdict, before, after: readFileSync(launchPath, 'utf8') };
      return DONE;
    } } });
    assert.ok(observed, `${fault}: verdict handler was reached`);
    assert.equal(observed.verdict.code, 2, `${fault}: ${observed.verdict.err}`);
    assert.equal(observed.after, observed.before, `${fault}: no verdict write`);
    assert.equal(result.code, 2, fault);
    assert.equal(f.meta(), null, fault);
    const late = await f.call(['review', 'p', 'verdict', 'ok'], { identity: { ...f.env, MC_ROLE: 'programme-review', MC_PROGRAMME: 'p', MC_PROGRAMME_REVIEW_TOKEN: 'a'.repeat(48) } });
    assert.equal(late.code, 2, 'ended launch cannot answer');
  }
});

test('programme review: a valid verdict cannot persist changed README, changed report, or replaced launch; cleanup preserves an unowned export', async (t) => {
  for (const fault of ['README', 'report', 'launch', 'export']) {
    const f = programmeSetup(t);
    const result = await f.call(['review', 'p'], { extra: { session: async (spawned) => {
      await f.reads('ok')(spawned);
      if (fault === 'README') writeFileSync(join(f.dir, 'README.md'), f.page + '\nchanged after verdict\n');
      if (fault === 'report') writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'OK\nfindings: 999\nreplacement\n');
      if (fault === 'launch') {
        const path = join(f.dir, PROGRAMME_REVIEW_LAUNCH);
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), token_sha256: sha256('other') }));
      }
      if (fault === 'export') {
        renameSync(f.checkout, f.checkout + '-original');
        mkdirSync(f.checkout);
        writeFileSync(join(f.checkout, 'keep'), 'not ours');
      }
      return DONE;
    } } });
    assert.deepEqual(f.verdicts.map(({ code }) => code), [0], `${fault}: the prior verdict really was valid`);
    assert.equal(result.code, 2, `${fault}: ${result.err}`);
    assert.equal(f.meta(), null, fault);
    if (fault === 'export') {
      assert.match(result.err, /left in place.*identity/u);
      assert.equal(readFileSync(join(f.checkout, 'keep'), 'utf8'), 'not ours');
    }
  }
});

test('programme sign: no reading never signs, a reading of an earlier text signs at the desk and is logged, NOT OK requires a logged reason, and OK signs exact bytes', async (t) => {
  for (const condition of ['none', 'stale', 'not-ok', 'ok', 'changed report']) {
    const f = programmeSetup(t);
    if (condition !== 'none') {
      const word = condition === 'not-ok' ? 'not-ok' : 'ok';
      assert.equal((await f.call(['review', 'p'], { extra: { session: f.reads(word) } })).code, word === 'ok' ? 0 : 1);
    }
    if (condition === 'stale') writeFileSync(join(f.dir, 'README.md'), f.page + '\nnew text\n');
    if (condition === 'changed report') writeFileSync(join(f.dir, PROGRAMME_REVIEW_FILE), 'OK\nfindings: 2\nnot the recorded reading\n');
    const before = f.files();
    const signed = await f.call(['sign', 'p'], { identity: f.martin });
    assert.equal(signed.code, ['ok', 'stale'].includes(condition) ? 0 : 1, `${condition}: ${signed.err}`);
    if (condition === 'stale') assert.match(readFileSync(join(f.dir, 'LOG.md'), 'utf8'), /the reading read an earlier text; the edits since were made at the desk/u);
    if (['ok', 'stale'].includes(condition)) {
      const record = JSON.parse(readFileSync(join(f.dir, 'PROGRAMME.json'), 'utf8'));
      assert.equal(record.state, 'open');
      assert.equal(record.signed_by, 'martin');
      assert.equal(record.signed_text, sha256(readFileSync(join(f.dir, 'SIGNED.md'))));
      assert.ok(readFileSync(join(f.dir, 'SIGNED.md'), 'utf8').startsWith(f.page));
    } else {
      assert.deepEqual(f.files(), before, `${condition}: no signature or other effects`);
      const override = await f.call(['sign', 'p', '--reason', 'Explicitly accepted the findings'], { identity: f.martin });
      assert.equal(override.code, condition === 'not-ok' ? 0 : 1, `${condition}: ${override.err}`);
      if (condition === 'not-ok') assert.match(readFileSync(join(f.dir, 'LOG.md'), 'utf8'), /martin · signed — Explicitly accepted the findings/u);
      else {
        assert.match(override.err, /has no reading — mc programs review p/u);
        assert.deepEqual(f.files(), before, 'reason cannot invent a current reading');
      }
    }
  }
});


test('programme review: completion rechecks README inside the strict metadata lock', async (t) => {
  const f = programmeSetup(t);
  const locks = [];
  const result = await f.call(['review', 'p'], {
    lock: (root, fn, options) => {
      assert.equal(root, f.root);
      assert.equal(options.strict, true);
      locks.push(options.name);
      if (options.name === 'programme-review-store') writeFileSync(join(f.dir, 'README.md'), f.page + '\nconcurrent edit\n');
      return fn();
    },
    extra: { session: f.reads('ok') },
  });
  assert.equal(result.code, 2);
  assert.match(result.err, /README.md changed during the reading/u);
  assert.deepEqual(locks, ['programme-review-claim', 'programme-review-store']);
  assert.equal(f.meta(), null);
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
