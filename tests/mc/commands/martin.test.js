import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { run, get, usage, buildOpening, renderOpening } from '../../../src/mc/commands/martin.js';
import { run as ask } from '../../../src/mc/commands/ask.js';
import { deskRunsPath, setDeskCeiling } from '../../../src/mc/desk-budget.js';
import { tsvHeader, tsvRow } from '../../../src/mc/run-plan.js';
import { appendEntry } from '../../../src/mc/goals.js';
import { collectMartinQueue, renderMartinQueue } from '../../../src/mc/martin-collect.js';
import { deskItemId, itemDirectory, writeDeskItem } from '../../../src/mc/desk-items.js';
import { writeJsonAtomic } from '../../../src/mc/atomic-write.js';
import { lessonsDir, renderLesson } from '../../../src/mc/desk-lessons.js';
import { goalJson, goalJsonV2 } from '../_helpers/goal-file.js';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mc-martin-'));
  roots.push(home);
  const make = (p, g, fields = {}, comments = []) => {
    const dir = join(home, p, 'goals', g);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'GOAL.json'), goalJson({ status: 'Martin', ...fields }));
    writeFileSync(join(dir, 'LOG.md'), comments.join('\n\n'));
    return dir;
  };
  mkdirSync(join(home, 'alpha'), { recursive: true });
  mkdirSync(join(home, 'beta'), { recursive: true });
  writeFileSync(join(home, 'alpha', 'README.md'), 'Alpha aim');
  writeFileSync(join(home, 'beta', 'README.md'), 'Beta aim');
  return { home, make };
}
const log = (at, status, comment, tool = 'person') => `## ${at} · ${tool} · build · ${status}\n\nComment: ${comment}`;
function io() { const out = { stdout: '', stderr: '' }; return { out, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } }; }
function askFixture(home, reference, env = {}) {
  const output = io(); const effects = [];
  const deps = {
    ...output, home, env: { MC_ROLE: 'martin', MC_TOOL: 'codex', ...env },
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    write: (path, text) => { effects.push('write'); writeFileSync(path, text); },
    readKeys: () => { effects.push('keys'); return { TYPESAFE_API_KEY: 'isolated-fixture-key' }; },
    ledger: () => { effects.push('ledger'); },
  };
  return { ...output, effects, call: async ({ question = 'Original unresolved policy?', p = 0.5, at = '2026-01-01T00:00:00Z', reserved = false } = {}) => ask([
    ...(reference ? [reference] : []), '--kind', 'product', '--reason', question,
    '--option', 'a: keep rule', '--option', 'b: change rule', '--recommend', 'a',
    '--evidence', 'Investigated evidence for this rule.', ...(reserved ? ['--reserved', 'admin'] : []),
  ], { ...deps, now: () => new Date(at), jev: {
    transport: async () => { effects.push('provider'); return { status: 200, text: async () => JSON.stringify({ model: 'jev-1.14.0', answers: {
      answer: { choice: 'a', probabilities: { a: p } }, fits: { noul: 0.99 }, settled: { noul: 0.99 }, product: { noul: 0.1 },
    } }) }; }, timer: () => new Promise(() => {}),
  } }) };
}

describe('mc martin get', () => {
  it('reads a version 2 goal whole: its version, outcome, decisions and preserve as the contract, what is out of scope, and the goal as shown', () => {
    const f = fixture(); const dir = f.make('alpha', 'two', {}, [log('2026-01-02T00:00Z', 'Martin', 'Martin is asked: Which way?\nOption a: this\nOption b: that\nRecommended: a')]);
    writeFileSync(join(dir, 'GOAL.json'), goalJsonV2({ status: 'Martin' }));
    const [item] = collectMartinQueue({ home: f.home }).items;
    assert.equal(item.version, 2);
    assert.deepEqual(item.goal_text, ['Two files and a worktree.', 'And nothing else.']);
    assert.deepEqual(item.contract, ['Parts are numbered.', 'Version 1 is as before.']);
    assert.deepEqual(item.exclusions, ['Converting version 1 goals.']);
    assert.equal(item.criteria[0].evidence, 'the gate log');
    assert.match(item.goal_markdown, /^# Make the goal plain\n\nAIM\n {2}Why the goal exists\.\n\nOUTCOME\n/u);
    assert.match(item.goal_markdown, /\nDECISIONS\n {2}D1 Parts are numbered\.\n {6}by: Martin · on: 2026-11-14\n/u);
    const text = io();
    assert.equal(get([], { home: f.home, ...text }), 0);
    assert.ok(text.out.stdout.includes(item.goal_markdown.trimEnd()), 'the desk shows the goal whole');
  });
  it('does not queue a decided technical entry, and reads an unresolved question and its options whole', () => {
    const f = fixture();
    f.make('alpha', 'decided', { status: 'ready' }, [log('2026-01-02T00:00Z', 'ready', 'Decided by the session (technical): Which timer?\nOption inject: inject a timer\nOption wait: wait 15 seconds\nRecommended: inject\nEvidence: criterion 1\njev reading: a (p 0.50, fits 0.88, settled 0.30)')]);
    f.make('alpha', 'waiting', {}, [log('2026-01-03T00:00Z', 'Martin', 'Martin is asked: Which timer?\nOption inject: inject a timer\nOption wait: wait 15 seconds\nRecommended: inject\njev: a (p 0.50, fits 0.88, settled 0.30)')]);
    const result = collectMartinQueue({ home: f.home });
    assert.deepEqual(result.items.map((item) => item.reference), ['alpha/waiting']);
    assert.equal(result.items[0].question.question, 'Which timer?');
    assert.deepEqual(result.items[0].question.options, [{ key: 'inject', text: 'inject a timer' }, { key: 'wait', text: 'wait 15 seconds' }]);
  });
  it('keeps the unresolved real ask and its ordering after a different consultation is answered', async () => {
    const f = fixture();
    f.make('alpha', 'waiting', { status: 'ready' });
    f.make('beta', 'later', {}, [log('2026-01-01T12:00Z', 'Martin', 'Martin is asked: Later policy?')]);
    f.make('alpha', 'questionless', {}, [log('2026-01-03T00:00Z', 'Martin', 'runner failure: missing evidence')]);
    const writer = askFixture(f.home, 'alpha/waiting');
    assert.equal(await writer.call(), 1, writer.out.stderr);
    assert.equal(await writer.call({ question: 'Settled implementation detail?', p: 0.99, at: '2026-01-02T00:00:00Z' }), 0, writer.out.stderr);
    const questionless = askFixture(f.home, 'alpha/questionless');
    assert.equal(await questionless.call({ question: 'Another settled detail?', p: 0.99, at: '2026-01-04T00:00:00Z' }), 0, questionless.out.stderr);
    const before = snapshot(f.home);
    const result = collectMartinQueue({ home: f.home });
    assert.deepEqual(result.items.map(i => i.reference), ['alpha/waiting', 'beta/later', 'alpha/questionless']);
    assert.equal(result.items[0].question.question, 'Original unresolved policy?');
    assert.equal(result.items[0].question.at, '2026-01-01T00:00:00Z');
    assert.equal(result.items[0].status, 'Martin');
    assert.equal(result.items[2].question.reason, 'runner failure: missing evidence');
    assert.equal(result.items[2].question.at, '2026-01-03T00:00Z');
    assert.match(result.items[2].question.limitation, /No structured question/u);
    assert.deepEqual(snapshot(f.home), before);
  });

  it('sends no rulings: a docs/project rulings file in a goal repository reaches neither the queue, its context nor its text', async () => {
    const f = fixture(); f.make('alpha', 'waiting', {}, [log('2026-01-01T12:00Z', 'Martin', 'runner failure: missing evidence')]);
    const rulings = join(f.home, 'alpha', 'memoro-cli', 'docs', 'project', 'alpha');
    mkdirSync(rulings, { recursive: true });
    writeFileSync(join(rulings, 'rulings.md'), '# rulings\n\n1. Old decision text.');
    const result = collectMartinQueue({ home: f.home });
    assert.equal(result.items.length, 1);
    assert.equal(Object.hasOwn(result.items[0], 'rulings'), false);
    assert.equal(Object.hasOwn(result.programme_context[0], 'rulings'), false);
    assert.doesNotMatch(JSON.stringify(result), /Old decision text/u);
    const text = io();
    assert.equal(get([], { home: f.home, ...text }), 0);
    assert.doesNotMatch(text.out.stdout, /Old decision text|Rulings/u);
  });

  it('preserves real ask readings and every populated tail field in text and JSON outside the question tail', async () => {
    const f = fixture(); const dir = f.make('alpha', 'waiting', { status: 'ready' });
    const writer = askFixture(f.home, 'alpha/waiting');
    assert.equal(await writer.call(), 1, writer.out.stderr);
    for (const day of [2, 3, 4]) appendEntry({ dir, entry: {
      at: `2026-01-0${day}T00:00Z`, tool: 'codex', role: 'martin', stage: 'build', status: 'Martin',
      done: `Failure evidence ${day}`, comment: `Brief comment ${day}`, next: `Recovery instructions ${day}`,
    }, read: (path) => readFileSync(path, 'utf8'), write: writeFileSync });
    const before = snapshot(f.home);
    const result = collectMartinQueue({ home: f.home }); const item = result.items[0];
    const reading = writer.out.stdout.trim();
    assert.match(reading, /^mc: jev did not settle it: a .*not answered: p 0\.50/u);
    assert.equal(item.question.jev, reading);
    assert.deepEqual(item.question.options, [{ key: 'a', text: 'keep rule' }, { key: 'b', text: 'change rule' }]);
    assert.equal(item.question.recommendation, 'a');
    assert.deepEqual(item.log.map(e => e.at), [2, 3, 4].map(day => `2026-01-0${day}T00:00Z`));
    const text = io(); const json = io();
    assert.equal(get([], { home: f.home, ...text }), 0);
    assert.equal(get(['--json'], { home: f.home, ...json }), 0);
    assert.deepEqual(JSON.parse(json.out.stdout).items[0], item);
    assert.ok(text.out.stdout.includes(reading));
    assert.ok(text.out.stdout.includes('Investigated evidence for this rule.'));
    assert.ok(text.out.stdout.includes('Original unresolved policy?'));
    for (const entry of item.log) for (const field of ['done', 'comment', 'next']) assert.ok(text.out.stdout.includes(entry[field]), `${field}: ${entry[field]}`);
    assert.deepEqual(snapshot(f.home), before, 'get has no write-on-read effects');
  });

  it('filters live cross-programme records, preserves old current questions, orders stably, and dedupes programme context', () => {
    const f = fixture();
    f.make('alpha', 'older', {}, [log('2026-01-01T00:00Z', 'Martin', 'Martin is asked: Keep or change?\nOption keep: Keep it\nOption change: Change it\nRecommended: change\njev: recommended change') , ...[1,2,3,4].map(n => log(`2026-01-0${n+1}T00:00Z`, 'Martin', `continuation ${n}`, 'claude'))]);
    f.make('alpha', 'questionless', {}, [log('2026-02-01T00:00Z', 'Martin', 'Martin is asked: historical question?\nOption yes: Yes\nOption no: No\nRecommended: yes'), log('2026-02-02T00:00Z', 'ready', 'returned to build'), log('2026-03-01T00:00Z', 'Martin', 'runner failure: stale lock')]);
    f.make('alpha', 'ready', { status: 'ready' }, []);
    f.make('alpha', 'blocked', { status: 'blocked' }, []);
    f.make('alpha', 'done', { stage: 'done' }, []);
    f.make('alpha', 'dropped', { stage: 'dropped' }, []);
    f.make('beta', 'third', {}, [log('2026-01-01T00:00Z', 'Martin', 'Martin is asked: Beta question?\nOption a: A\nOption b: B\nRecommended: a')]);
    f.make('alpha', 'badlog', {}, ['## this is not a valid log heading\n\nComment: malformed']);
    const archived = join(f.home, 'alpha', 'goals', '.archive', 'old'); mkdirSync(archived, { recursive: true }); writeFileSync(join(archived, 'GOAL.json'), goalJson({ status: 'Martin' }));
    mkdirSync(join(f.home, 'alpha', 'goals', 'malformed'), { recursive: true }); writeFileSync(join(f.home, 'alpha', 'goals', 'malformed', 'GOAL.json'), '{bad');
    const before = snapshot(f.home);
    const result = collectMartinQueue({ home: f.home });
    assert.deepEqual(result.items.map(i => i.reference), ['alpha/older', 'beta/third', 'alpha/questionless', 'alpha/badlog']);
    assert.equal(result.items[0].question.question, 'Keep or change?');
    assert.deepEqual(result.items[0].question.options, [{ key: 'keep', text: 'Keep it' }, { key: 'change', text: 'Change it' }]);
    assert.equal(result.items[0].question.recommendation, 'change');
    assert.match(result.items[0].question.jev, /recommended change/u);
    assert.equal(result.items[0].log.length, 3, 'tail is bounded independently of the pending question');
    assert.equal(result.items[2].question.question, undefined, 'resolved historical question is not revived');
    assert.match(result.items[2].question.reason, /runner failure: stale lock/u);
    assert.match(result.items[2].question.limitation, /No structured question/u);
    assert.deepEqual(result.programme_context.map(p => p.programme), ['alpha', 'beta']);
    const rendered = renderMartinQueue(result);
    assert.equal((rendered.match(/Alpha aim/g) || []).length, 1, 'README text appears once for alpha');
    assert.match(rendered, /\[full LOG\.md\]\(file:/u);
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues.some(i => /malformed\/GOAL\.json$/u.test(i.path)));
    assert.ok(result.issues.some(i => /badlog\/LOG\.md$/u.test(i.path)));
    assert.deepEqual(snapshot(f.home), before, 'collector is read-only');
  });

  it('supports default/all, programme and goal selectors, text and JSON with empty and invalid results', () => {
    const f = fixture(); f.make('alpha', 'waiting', {}, [log('2026-01-01T00:00Z', 'Martin', 'Martin is asked: Question?\nOption a: A\nOption b: B\nRecommended: a')]);
    for (const flags of [[], ['--all'], ['--programme', 'alpha'], ['--goal', 'alpha/waiting']]) {
      const { out, stdout, stderr } = io();
      assert.equal(get(flags, { home: f.home, stdout, stderr }), 0, out.stderr);
      assert.match(out.stdout, /alpha\/waiting/u);
    }
    const json = io(); assert.equal(get(['--goal', 'alpha/waiting', '--json'], { home: f.home, stdout: json.stdout, stderr: json.stderr }), 0);
    assert.equal(JSON.parse(json.out.stdout).items[0].reference, 'alpha/waiting');
    const allJson = io(); assert.equal(get(['--json'], { home: f.home, stdout: allJson.stdout, stderr: allJson.stderr }), 0);
    assert.deepEqual(JSON.parse(allJson.out.stdout).items.map(i => i.reference), ['alpha/waiting']);
    for (const [args, expected] of [[['--programme','beta'], /no goals waiting/u], [['--programme','absent'], /unknown or invalid programme/u], [['--goal','alpha/nope'], /unknown or invalid goal/u], [['--all','--goal','alpha/waiting'], /exactly one/u], [['--all','--all'], /exactly one/u]]) {
      const { out, stdout, stderr } = io();
      const code = get(args, { home: f.home, stdout, stderr });
      assert.equal(code, expected.source.includes('no goals') ? 0 : 2);
      assert.match(out.stdout + out.stderr, expected);
    }
  });

  it('reports unreadable source paths instead of counting missing records as resolved', () => {
    const f = fixture();
    mkdirSync(join(f.home, 'alpha', 'goals', 'opaque'), { recursive: true });
    const items = collectMartinQueue({ home: f.home, read: () => null });
    assert.equal(items.items.length, 0);
    assert.match(items.issues[0].path, /opaque\/GOAL\.json$/u);
  });
});

describe('Martin ask authority', () => {
  it('refuses unattended Martin before goal, ledger, key or provider effects, with and without a named goal', async () => {
    const f = fixture(); f.make('alpha', 'waiting', { status: 'ready' });
    for (const reference of ['alpha/waiting', null]) for (const reserved of [false, true]) {
      const before = snapshot(f.home);
      const writer = askFixture(f.home, reference, { MC_HEADLESS: '1' });
      assert.equal(await writer.call({ reserved }), 2, writer.out.stdout + writer.out.stderr);
      assert.match(writer.out.stderr, /interactive-only/u);
      assert.deepEqual(writer.effects, []);
      assert.deepEqual(snapshot(f.home), before);
    }
  });

  it('retains interactive Martin and existing headless stage-role ask permissions with attributed logs', async () => {
    const f = fixture();
    for (const [role, stage] of [['martin', 'build'], ['build-session:goal', 'build'], ['review-session:goal', 'review'], ['mend-session', 'merge']]) {
      const name = role.replaceAll(':', '-'); const dir = f.make('alpha', name, { stage, status: 'ready' });
      const writer = askFixture(f.home, `alpha/${name}`, { MC_ROLE: role, ...(role === 'martin' ? {} : { MC_HEADLESS: '1' }) });
      assert.equal(await writer.call({ reserved: true }), 1, writer.out.stderr);
      assert.equal(JSON.parse(readFileSync(join(dir, 'GOAL.json'), 'utf8')).status, 'Martin');
      assert.match(readFileSync(join(dir, 'LOG.md'), 'utf8'), new RegExp(`by ${role}`));
      assert.equal(writer.effects.includes('provider'), false);
    }
  });
});

describe('mc martin launch', () => {
  it('advertises durable item commands and the opening brief in the routed help', () => { assert.match(usage(),/mc martin items/u); assert.match(usage(),/mc martin item <id>/u); assert.match(usage(),/mc martin brief \[--json\]/u); });
  it('opens a distinct role/path with the opening as first prompt and launcher conventions', async () => {
    const d = openingStore(); const { out, stdout, stderr } = io(); let opened;
    const code = await run(['--resume', 'abc', '--codex', '--model', 'gpt-6.1-sol'], {
      stdout, stderr, env: d.env, home: d.home, interactive: () => true, now: () => new Date(NOW), role: ROLE,
      open: async (options) => { opened = options; return { ok: true, code: 0 }; },
    });
    assert.equal(code, 0, out.stderr);
    assert.equal(opened.areaName, 'martin'); assert.equal(opened.verb, 'martin');
    assert.equal(opened.areaRoot, join(d.env.MC_WORK_ROOT, 'martin')); assert.equal(opened.roleName, 'martin');
    assert.equal(opened.overlay, 'Martin role instructions'); assert.equal(opened.defaultModel, 'opus');
    assert.equal(opened.pick, 'abc'); assert.equal(opened.tool, 'codex'); assert.equal(opened.model, 'gpt-6.1-sol');
    assert.match(opened.prompt, /^Martin's desk, opened 2026-11-14T12:00:00\.000Z\./u); assert.match(opened.prompt, /### 1\. alpha\/one/u);
    assert.match(opened.resumePrompt, /Refresh from the desk now/u); assert.ok(opened.resumePrompt.endsWith(opened.prompt));
  });
  it('writes last-open only after a successful launch, and the next opening starts from that time', async () => {
    const d = openingStore({ lastOpen: null }); const lastFile = join(d.env.MC_WORK_ROOT, 'martin', 'last-open.json'); const captured = [];
    const open = async (options) => { captured.push(options); return { ok: true, code: 0 }; };
    const first = await launch(d, '2026-11-14T08:00:00.000Z', { open });
    assert.equal(first.code, 0, first.out.stderr);
    assert.deepEqual(JSON.parse(readFileSync(lastFile, 'utf8')), { at: '2026-11-14T08:00:00.000Z' });
    assert.match(captured[0].prompt, /Decision before the opening/u, 'the first opening covers everything since the store began, up to its own time');
    assert.doesNotMatch(captured[0].prompt, /Decision at nine/u, 'a decision after the opening time is not in it');
    const second = await launch(d, NOW, { open });
    assert.equal(second.code, 0, second.out.stderr);
    assert.match(captured[1].prompt, /covers 2026-11-14T08:00:00\.000Z to 2026-11-14T12:00:00\.000Z/u);
    assert.match(captured[1].prompt, /Decision at nine/u); assert.doesNotMatch(captured[1].prompt, /Decision before the opening/u);
    assert.deepEqual(JSON.parse(readFileSync(lastFile, 'utf8')), { at: NOW });
  });
  it('leaves last-open unchanged after a refused or failed launch, and refuses a corrupt file before opening', async () => {
    const d = openingStore(); const lastFile = join(d.env.MC_WORK_ROOT, 'martin', 'last-open.json'); const before = readFileSync(lastFile, 'utf8');
    const failed = await launch(d, NOW, { open: async () => ({ ok: false, reason: 'provider refused the launch' }) });
    assert.equal(failed.code, 1); assert.equal(readFileSync(lastFile, 'utf8'), before);
    const snap = snapshot(d.root);
    const headless = await launch(d, NOW, { env: { ...d.env, MC_HEADLESS: '1' }, open: () => { throw new Error('must not open'); } });
    assert.equal(headless.code, 2); assert.match(headless.out.stderr, /interactive-only/u);
    assert.equal(readFileSync(lastFile, 'utf8'), before); assert.deepEqual(snapshot(d.root), snap);
    writeFileSync(lastFile, '{bad');
    let opened = 0;
    const corrupt = await launch(d, NOW, { open: () => { opened += 1; return { ok: true, code: 0 }; } });
    assert.equal(corrupt.code, 1); assert.equal(opened, 0); assert.match(corrupt.out.stderr, /does not hold a valid "at" time/u);
  });

  it('refuses unattended launch before creating a desk or opening a child', async () => {
    let opened = 0, made = 0; const { out, stdout, stderr } = io();
    assert.equal(await run([], { stdout, stderr, env: { MC_HEADLESS: '1' }, interactive: () => true, mkdir: () => { made += 1; }, open: () => { opened += 1; } }), 2);
    assert.equal(opened, 0); assert.equal(made, 0); assert.match(out.stderr, /interactive-only/u);
  });
});

const NOW = '2026-11-14T12:00:00.000Z';
const LAST = '2026-11-14T08:00:00.000Z';
const ROLE = () => ({ name: 'martin', model: 'opus', tools: ['claude', 'codex'], cache: '5m', overlay: 'Martin role instructions' });

/** A desk whose store already holds every item, so a sync writes nothing: four for-martin, three decided, one default, two closed by source, two prepared. */
function openingStore({ lastOpen = LAST } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-martin-opening-')); roots.push(root);
  const env = { MC_WORK_ROOT: join(root, 'mc'), MC_HOME: join(root, 'mc-home'), MC_ROLE: 'person' };
  const home = join(root, 'programs');
  const store = join(env.MC_WORK_ROOT, 'martin', 'items');
  mkdirSync(store, { recursive: true });
  mkdirSync(join(env.MC_WORK_ROOT, 'runner', 'projects'), { recursive: true }); // the runner lock's directory
  writeFileSync(join(store, '.store.json'), JSON.stringify({ schema: 'mc-desk-item-store', version: 1, first_sync_at: '2026-11-01T00:00:00.000Z' }));
  if (lastOpen) writeFileSync(join(env.MC_WORK_ROOT, 'martin', 'last-open.json'), JSON.stringify({ at: lastOpen }));
  const goal = (programme, name, { phase = 1, status = 'Martin', question = null } = {}) => {
    const dir = join(home, programme, 'goals', name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'GOAL.json'), goalJson({ status, phase }));
    writeFileSync(join(dir, 'LOG.md'), question ? log(question.at, 'Martin', `Martin is asked: ${question.text}\nOption a: keep it\nOption b: change it\nRecommended: a`) : '');
  };
  // alpha/one is the only phase-1 goal of alpha: it blocks alpha/two (phase 2, itself waiting) and alpha/three (phase 3).
  goal('alpha', 'one', { question: { at: '2026-11-13T10:00Z', text: 'Which rule should stand?' } });
  goal('alpha', 'two', { phase: 2, question: { at: '2026-11-10T09:00Z', text: 'Which timing?' } });
  goal('alpha', 'three', { phase: 3, status: 'ready' });
  goal('beta', 'irr', { question: { at: '2026-11-11T09:00Z', text: 'Which reserved act?' } });
  goal('beta', 'judge', { question: { at: '2026-11-12T09:00Z', text: 'Which screen feels right?' } });
  goal('delta', 'p1', { question: { at: '2026-11-09T08:00Z', text: 'Which ledger shape?' } });
  goal('delta', 'p2', { question: { at: '2026-11-10T08:00Z', text: 'Which fixture?' } });
  const put = (fields) => {
    const { kind = 'goal', reference, source_at, state, brief = null, prepared = null, ...rest } = fields;
    const record = { schema: 'mc-desk-item', version: 1, id: deskItemId(kind, reference, source_at), kind, reference, source_at, opened_at: source_at, state, sort: null, reversible: null, due_at: null, outcome: null, ...rest };
    writeDeskItem(record, { env });
    if (brief !== null) writeFileSync(join(itemDirectory(record, env), 'brief.md'), brief);
    if (prepared !== null) writeFileSync(join(itemDirectory(record, env), 'prepared.md'), prepared);
    return record;
  };
  put({ reference: 'alpha/one', source_at: '2026-11-13T10:00Z', state: 'for-martin', sort: 'product', reversible: true, due_at: '2026-11-14T15:00:00.000Z', brief: 'Brief: the rule of alpha.' });
  put({ reference: 'alpha/two', source_at: '2026-11-10T09:00Z', state: 'for-martin', sort: 'product', reversible: true, due_at: '2026-11-16T09:00:00.000Z', brief: 'Brief: the timing.' });
  put({ reference: 'beta/irr', source_at: '2026-11-11T09:00Z', state: 'for-martin', sort: 'reserved', reversible: false, brief: 'Brief: the reserved act.' });
  put({ reference: 'beta/judge', source_at: '2026-11-12T09:00Z', state: 'for-martin', sort: 'judgement', reversible: true, due_at: '2026-11-20T00:00:00.000Z', brief: 'Brief: look at the screen.' });
  put({ reference: 'gamma/d1', source_at: '2026-11-01T08:00Z', state: 'closed', outcome: { by: 'decision', at: '2026-11-14T07:00:00.000Z', summary: 'Decision before the opening.' } });
  put({ reference: 'gamma/d2', source_at: '2026-11-02T08:00Z', state: 'closed', outcome: { by: 'decision', at: '2026-11-14T09:00:00.000Z', summary: 'Decision at nine.' } });
  put({ reference: 'beta/d3', source_at: '2026-11-03T08:00Z', state: 'closed', outcome: { by: 'decision', at: '2026-11-14T10:00:00.000Z', summary: 'Decision at ten.' } });
  put({ reference: 'gamma/d4', source_at: '2026-11-04T08:00Z', state: 'closed', outcome: { by: 'default', at: '2026-11-14T11:00:00.000Z', summary: 'Default applied.' } });
  put({ reference: 'gamma/s1', source_at: '2026-11-05T08:00Z', state: 'closed', outcome: { by: 'source', at: '2026-11-14T09:30:00.000Z', summary: 'Source closed it.' } });
  put({ reference: 'beta/s2', source_at: '2026-11-06T08:00Z', state: 'closed', outcome: { by: 'source', at: '2026-11-14T10:30:00.000Z', summary: 'Source closed it too.' } });
  put({ reference: 'delta/p1', source_at: '2026-11-09T08:00Z', state: 'prepared', sort: 'mechanical', prepared: 'Facts for p1.' });
  put({ reference: 'delta/p2', source_at: '2026-11-10T08:00Z', state: 'prepared', sort: 'technical', prepared: 'Facts for p2.', decision_failures: [{ at: '2026-11-13T08:00:00.000Z', reason: 'session exited' }] });
  return { root, env, home };
}
function launch(d, at, deps = {}) {
  const { out, stdout, stderr } = io();
  return run([], { stdout, stderr, env: d.env, home: d.home, interactive: () => true, now: () => new Date(at), role: ROLE, open: async () => ({ ok: true, code: 0 }), ...deps }).then((code) => ({ code, out }));
}

describe('mc martin brief', () => {
  it('prints the five parts in order, blocking work first, from the store', async () => {
    const d = openingStore(); const text = io();
    assert.equal(await run(['brief'], { ...text, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, text.out.stderr);
    const out = text.out.stdout;
    const at = (part) => { const index = out.indexOf(part); assert.notEqual(index, -1, part); return index; };
    const headings = ['## Yours (4)', '## Decided without you', '## Not ready', '## Cost', '## What the system changed'].map(at);
    assert.deepEqual([...headings].sort((a, b) => a - b), headings);
    assert.match(out, /^Martin's desk, opened 2026-11-14T12:00:00\.000Z\. Decided-without-you covers 2026-11-14T08:00:00\.000Z to 2026-11-14T12:00:00\.000Z\./u);
    const yours = ['### 1. alpha/one · product · reversible', '### 2. alpha/two · product · reversible', '### 3. beta/irr · reserved · not reversible', '### 4. beta/judge · judgement · reversible'].map(at);
    assert.deepEqual([...yours].sort((a, b) => a - b), yours, 'blocking first, then oldest source');
    assert.ok(yours[0] > headings[0] && yours[3] < headings[1]);
    assert.match(out, /blocks 2 later-phase goals of alpha/u);
    assert.match(out, /Due 2026-11-14T15:00:00\.000Z: if nothing is said/u);
    assert.doesNotMatch(out, /Due 2026-11-16/u);
    assert.match(out, /Brief: the reserved act\./u);
    assert.ok(out.includes('- 2026-11-14T09:00:00.000Z · Decision at nine. (gamma/d2, decision)'));
    assert.ok(out.includes('- 2026-11-14T10:00:00.000Z · Decision at ten. (beta/d3, decision)'));
    assert.ok(out.includes('- 2026-11-14T11:00:00.000Z · Default applied. (gamma/d4, default)'));
    assert.doesNotMatch(out, /Decision before the opening/u, 'a decision before last-open is not in this interval');
    assert.match(out, /Closed by source in the same interval: 2\./u);
    assert.match(out, /2 items still new or prepared\. Oldest: delta\/p1 \(prepared\), waiting 124 hours since 2026-11-09T08:00Z\./u);
    assert.match(out, /Failed: delta\/p2 \(preparation failed 0 times, decision 1 time\)\./u);
    assert.match(out, /Today \(UTC 2026-11-14\): \$0\.0000\. Last seven days: \$0\.0000\. Ceiling: off\./u);
  });
  it('--json carries the same data as the text, and brief writes no file', async () => {
    const d = openingStore(); const deps = { env: d.env, home: d.home, now: () => new Date(NOW) };
    const before = snapshot(d.root);
    const text = io(); assert.equal(await run(['brief'], { ...text, ...deps }), 0, text.out.stderr);
    const json = io(); assert.equal(await run(['brief', '--json'], { ...json, ...deps }), 0, json.out.stderr);
    const data = JSON.parse(json.out.stdout);
    assert.equal(renderOpening(data), text.out.stdout);
    assert.deepEqual(data, buildOpening({ env: d.env, home: d.home, now: new Date(NOW), last: LAST }));
    assert.deepEqual(snapshot(d.root), before, 'brief writes no file, and last-open.json is not touched');
  });
  it('prints what the system changed as its fifth part, from the lessons and items alone: landed changes, counts, the late one, the dismissal, five weekly figures', async () => {
    const d = openingStore(); const dir = lessonsDir(d.env); mkdirSync(dir, { recursive: true });
    const id = (reference, at) => deskItemId('goal', reference, at);
    const lesson = (name, fields) => writeFileSync(join(dir, `${name}.md`), renderLesson({
      name, kind: 'wrong-question', item: null, programme: null, state: 'open', goal: null, pr: null, place: null, by: 'decision',
      carried_at: null, landed_at: null, dismissed_at: null, reason: null, repeat_of: null, ...fields,
      parts: { happened: 'SECRET-LESSON-TEXT what happened', rule: 'SECRET-LESSON-TEXT the rule', where: 'SECRET-LESSON-TEXT where' },
    }));
    // Landed since the opening at 08:00: one changes src/mc, one a canon page.
    lesson('2026-11-04-code', { at: '2026-11-04T10:00:00Z', item: id('beta/irr', '2026-11-11T09:00Z'), state: 'landed', goal: 'alpha/one', pr: 'memoro-cli#1501', place: 'src/mc/desk-decision.js', carried_at: '2026-11-10T10:00:00Z', landed_at: '2026-11-14T09:00:00Z' });
    lesson('2026-11-06-prompt', { at: '2026-11-06T10:00:00Z', kind: 'not-martins', item: id('gamma/d4', '2026-11-04T08:00Z'), state: 'landed', goal: 'alpha/three', pr: 'memoro-cli#1502', place: 'canon/roles/martin.md', carried_at: '2026-11-10T10:00:00Z', landed_at: '2026-11-14T10:00:00Z' });
    // Landed before the opening: not listed, but the earlier change the repeat below says did not work.
    lesson('2026-11-02-earlier', { at: '2026-11-02T10:00:00Z', state: 'landed', goal: 'alpha/one', pr: 'memoro-cli#1490', place: 'canon/roles/decision.md', landed_at: '2026-11-10T10:00:00Z' });
    lesson('2026-11-12-overturned', { at: '2026-11-12T10:00:00Z', kind: 'overturned', state: 'landed', goal: 'alpha/one', pr: 'memoro-cli#1495', place: 'docs/technical/mc-roles.md', landed_at: '2026-11-13T10:00:00Z' });
    // Open: the repeat (a day), one of four days, and one 16 days old.
    lesson('2026-11-13-repeat', { at: '2026-11-13T09:00:00Z', place: 'canon/roles/decision.md', repeat_of: 'memoro-cli#1490' });
    lesson('2026-11-10-open', { at: '2026-11-10T12:00:00Z', kind: 'unsettled' });
    lesson('2026-10-29-late', { at: '2026-10-29T12:00:00Z', kind: 'unsettled' });
    lesson('2026-11-08-carried', { at: '2026-11-08T12:00:00Z', kind: 'answer-differs', state: 'in-goal', goal: 'beta/judge', carried_at: '2026-11-09T12:00:00Z' });
    lesson('2026-11-12-dismissed', { at: '2026-11-12T12:00:00Z', state: 'dismissed', dismissed_at: '2026-11-14T10:30:00Z', reason: 'One accident: the disk was full.' });
    const before = snapshot(d.root);
    const text = io(); assert.equal(await run(['brief'], { ...text, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, text.out.stderr);
    const part = text.out.stdout.slice(text.out.stdout.indexOf('## What the system changed'));
    assert.deepEqual(part.split('\n').slice(0, 9), [
      '## What the system changed', '',
      '- Make the goal plain — code (src/mc/desk-decision.js) — memoro-cli#1501',
      '- Make the goal plain — prompt (canon/roles/martin.md) — memoro-cli#1502',
      '', 'Lessons still open: 3, oldest 16 days. In a goal that has not landed: 1, oldest 6 days.',
      'Late (older than 14 days, neither landed nor dismissed): 2026-10-29-late (open, 16 days).',
      'Dismissed since the last opening: 1. 2026-11-12-dismissed: One accident: the disk was full.', '',
    ]);
    // Weeks, oldest first. Items opened / share that reached Martin / share of those not his / overturned / repeats of a landed change — counted by hand from the store above.
    assert.deepEqual(part.split('\n').slice(-5), [
      '- 2026-10-17 to 2026-10-24: 0; - (0); - (0); 0; 0',
      '- 2026-10-24 to 2026-10-31: 0; - (0); - (0); 0; 0',
      '- 2026-10-31 to 2026-11-07: 6; 16.7% (1); 100% (1); 0; 0',
      '- 2026-11-07 to 2026-11-14: 6; 66.7% (4); 25% (1); 1; 1',
      '',
    ].slice(0, 5));
    const json = io(); assert.equal(await run(['brief', '--json'], { ...json, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, json.out.stderr);
    const data = JSON.parse(json.out.stdout);
    assert.deepEqual(data.changes.weeks.map((w) => [w.items_opened, w.reached_martin, w.reached_share, w.not_his, w.not_his_share, w.overturned, w.repeats]),
      [[0, 0, null, 0, null, 0, 0], [0, 0, null, 0, null, 0, 0], [6, 1, 16.7, 1, 100, 0, 0], [6, 4, 66.7, 1, 25, 1, 1]]);
    assert.deepEqual(data.changes.landed.map((x) => [x.pr, x.where]), [['memoro-cli#1501', 'code'], ['memoro-cli#1502', 'prompt']]);
    assert.deepEqual([data.changes.open, data.changes.in_goal, data.changes.late.map((x) => x.name), data.changes.dismissed.map((x) => x.reason)],
      [{ count: 3, oldest_days: 16 }, { count: 1, oldest_days: 6 }, ['2026-10-29-late'], ['One accident: the disk was full.']]);
    assert.equal(renderOpening(data), text.out.stdout);
    for (const out of [text.out.stdout, json.out.stdout]) assert.doesNotMatch(out, /SECRET-LESSON-TEXT/u, 'no lesson text appears');
    assert.deepEqual(snapshot(d.root), before, 'brief writes nothing');
  });
  it('names a landed change by its goal\'s title also when the goal is archived, and by its reference when the goal is found nowhere', async () => {
    const d = openingStore(); const dir = lessonsDir(d.env); mkdirSync(dir, { recursive: true });
    const archived = (programme, name, fields) => { const at = join(d.home, programme, 'goals', '.archive', name); mkdirSync(at, { recursive: true }); writeFileSync(join(at, 'GOAL.json'), goalJson({ stage: 'done', status: 'ready', ...fields })); writeFileSync(join(at, 'LOG.md'), ''); };
    archived('alpha', 'gone', { title: 'The archived title', prs: ['memoro-cli#2001'] });
    archived('alpha', 'one', { title: 'The archived reused name', prs: ['memoro-cli#2003'] }); // alpha/one is also live, build, "Make the goal plain"
    const lesson = (name, fields) => writeFileSync(join(dir, `${name}.md`), renderLesson({
      name, kind: 'wrong-question', item: null, programme: null, state: 'landed', goal: null, pr: null, place: 'src/mc/run.js', by: 'decision', at: '2026-11-04T10:00:00Z',
      carried_at: '2026-11-10T10:00:00Z', landed_at: '2026-11-14T09:00:00Z', dismissed_at: null, reason: null, repeat_of: null, ...fields,
      parts: { happened: 'h', rule: 'r', where: 'w' },
    }));
    lesson('2026-11-04-archived', { goal: 'alpha/gone', pr: 'memoro-cli#2001', landed_at: '2026-11-14T09:00:00Z' });
    lesson('2026-11-04-nowhere', { goal: 'alpha/nowhere', pr: 'memoro-cli#2002', landed_at: '2026-11-14T10:00:00Z' });
    lesson('2026-11-04-reused', { goal: 'alpha/one', pr: 'memoro-cli#2003', landed_at: '2026-11-14T11:00:00Z' });
    const json = io(); assert.equal(await run(['brief', '--json'], { ...json, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, json.out.stderr);
    const data = JSON.parse(json.out.stdout);
    assert.deepEqual(data.changes.landed.map((x) => [x.what, x.pr]), [['The archived title', 'memoro-cli#2001'], ['alpha/nowhere', 'memoro-cli#2002'], ['The archived reused name', 'memoro-cli#2003']]);
    const text = io(); assert.equal(await run(['brief'], { ...text, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, text.out.stderr);
    const lines = text.out.stdout.split('\n');
    for (const line of ['- The archived title — code (src/mc/run.js) — memoro-cli#2001', '- alpha/nowhere — code (src/mc/run.js) — memoro-cli#2002', '- The archived reused name — code (src/mc/run.js) — memoro-cli#2003']) assert.ok(lines.includes(line), line);
    assert.equal(data.yours.find((x) => x.reference === 'alpha/one').blocks, 2, 'later-phase blocking reads the live goals only');
  });
  it('counts the runs of unknown cost within the seven days its sums cover', async () => {
    const d = openingStore(); mkdirSync(join(d.env.MC_WORK_ROOT, 'runner', 'log'), { recursive: true });
    const rows = [['2026-11-14T01:00:00Z', 'desk-prepare', 2], ['2026-11-14T02:00:00Z', 'decision', undefined], ['2026-11-09T12:00:00Z', 'learning', 3], ['2026-11-06T12:00:00Z', 'decision', undefined], ['2026-11-14T03:00:00Z', 'intake', undefined]];
    writeFileSync(deskRunsPath(d.env), `${tsvHeader()}\n${rows.map(([ts, kind, cost]) => tsvRow({ ts, kind, cost })).join('\n')}\n`);
    setDeskCeiling(4, { env: d.env });
    const text = io(); assert.equal(await run(['brief'], { ...text, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, text.out.stderr);
    assert.match(text.out.stdout, /Today \(UTC 2026-11-14\): \$2\.0000\. Last seven days: \$5\.0000\. Ceiling: \$4\/day\.\nRuns with unknown cost, not counted: 1\.\n/u);
    const json = io(); assert.equal(await run(['brief', '--json'], { ...json, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, json.out.stderr);
    assert.deepEqual([JSON.parse(json.out.stdout).cost.unknown_cost_runs, JSON.parse(json.out.stdout).cost.last_seven_days], [1, 5]);
  });
  it('a first opening with no last-open.json says so and writes none', async () => {
    const d = openingStore({ lastOpen: null }); const out = io();
    assert.equal(await run(['brief'], { ...out, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, out.out.stderr);
    assert.match(out.out.stdout, /\(first opening\)/u);
    assert.equal(existsSync(join(d.env.MC_WORK_ROOT, 'martin', 'last-open.json')), false);
  });
});

describe('mc martin item transitions', () => {
  function stored(state='new') {
    const root=mkdtempSync(join(tmpdir(),'mc-martin-item-')); roots.push(root);
    const env={MC_WORK_ROOT:join(root,'mc'),MC_HOME:join(root,'mc-home')};
    const source_at='2026-11-14T10:00:00Z', id=deskItemId('goal','alpha/one',source_at);
    const record={schema:'mc-desk-item',version:1,id,kind:'goal',reference:'alpha/one',source_at,opened_at:source_at,state,sort:null,reversible:null,due_at:null,outcome:null};
    mkdirSync(join(env.MC_WORK_ROOT,'runner','projects'),{recursive:true}); // the runner lock's directory
    writeDeskItem(record,{env}); return {env,record,dir:itemDirectory(record,env)};
  }
  it('requires each prepared artifact and advances prepared, brief and close with a deterministic clock', async()=>{
    const f=stored(); const roleEnv={...f.env,MC_ROLE:'decision'}; let result=io();
    const newBytes=readFileSync(join(f.dir,'item.json'),'utf8');
    assert.equal(await run(['item',f.record.id,'prepared','--sort','technical'],{...result,env:roleEnv}),2);
    assert.match(result.out.stderr,/new.*prepared applies/u);
    assert.equal(readFileSync(join(f.dir,'item.json'),'utf8'),newBytes);
    writeFileSync(join(f.dir,'prepared.md'),'Evidence');
    assert.equal(await run(['item',f.record.id,'prepared','--sort','technical'],{...io(),env:roleEnv}),0);
    const preparedBytes=readFileSync(join(f.dir,'item.json'),'utf8'); result=io();
    rmSync(join(f.dir,'brief.md'),{force:true});
    assert.equal(await run(['item',f.record.id,'brief','--sort','product','--reversible','yes'],{...result,env:roleEnv}),2);
    assert.match(result.out.stderr,/prepared.*brief or close applies/u); assert.equal(readFileSync(join(f.dir,'item.json'),'utf8'),preparedBytes);
    writeFileSync(join(f.dir,'brief.md'),'Choice');
    assert.equal(await run(['item',f.record.id,'brief','--sort','product','--reversible','yes'],{...io(),env:roleEnv,now:()=>new Date('2026-11-14T10:00:00Z')}),0);
    let current=JSON.parse(readFileSync(join(f.dir,'item.json'),'utf8'));
    assert.equal(current.state,'for-martin'); assert.equal(current.due_at,'2026-11-16T10:00:00.000Z');
    assert.equal(await run(['item',f.record.id,'close','--by','martin','--summary','Martin chose the recommended option.'],{...io(),env:{...f.env,MC_ROLE:'martin'},now:()=>new Date('2026-11-14T11:00:00Z')}),0);
    current=JSON.parse(readFileSync(join(f.dir,'item.json'),'utf8')); assert.equal(current.state,'closed'); assert.equal(current.outcome.by,'martin');
    const fixed=stored('prepared'); writeFileSync(join(fixed.dir,'brief.md'),'No default');
    assert.equal(await run(['item',fixed.record.id,'brief','--sort','judgement','--reversible','no'],{...io(),env:{...fixed.env,MC_ROLE:'decision'},now:()=>new Date('2026-11-14T10:00:00Z')}),0);
    const fixedRecord=JSON.parse(readFileSync(join(fixed.dir,'item.json'),'utf8')); assert.equal(fixedRecord.due_at,null); assert.equal(fixedRecord.reversible,false);
  });
  it('the learning role lists the items without syncing: no lock, no write, and a source a sync would change is left as it is', async()=>{
    const f=stored('new'); // the open item of alpha/one
    const closedSource='2026-11-14T11:00:00Z', closedId=deskItemId('goal','alpha/two',closedSource);
    writeDeskItem({schema:'mc-desk-item',version:1,id:closedId,kind:'goal',reference:'alpha/two',source_at:closedSource,opened_at:closedSource,state:'closed',sort:null,reversible:null,due_at:null,outcome:{by:'martin',at:closedSource,summary:'Answered.'}},{env:f.env});
    const home=join(f.env.MC_WORK_ROOT,'programs'); mkdirSync(join(home,'alpha','goals','one'),{recursive:true});
    writeFileSync(join(home,'alpha','goals','one','GOAL.json'),goalJson({status:'ready'})); // a sync would close the open item by source
    const before=snapshot(f.env.MC_WORK_ROOT); const out=io();
    const lock=()=>{ throw new Error('the runner lock is held by pid 4242 — try again'); };
    assert.equal(await run(['items','--state','closed','--json'],{...out,env:{...f.env,MC_ROLE:'learning'},home,syncDeps:{lock}}),0,out.out.stderr);
    assert.equal(out.out.stderr,'');
    assert.deepEqual(JSON.parse(out.out.stdout).map(x=>x.id),[closedId]);
    assert.deepEqual(snapshot(f.env.MC_WORK_ROOT),before);
  });
  it('refuses invalid sorts, role writes, closed transitions and unknown ids without modifying bytes', async()=>{
    const f=stored('prepared'); writeFileSync(join(f.dir,'brief.md'),'Brief');
    const path=join(f.dir,'item.json'); const before=readFileSync(path,'utf8');
    for (const [args,env] of [
      [['item',f.record.id,'brief','--sort','technical','--reversible','no'],{...f.env,MC_ROLE:'decision'}],
      [['item',f.record.id,'close','--by','martin','--summary','A choice.'],{...f.env,MC_ROLE:'build-session:goal'}],
      [['item','unknown','prepared','--sort','technical'],{...f.env,MC_ROLE:'decision'}],
      [['item',f.record.id,'brief','--sort','product','--reversible','yes'],{...f.env,MC_ROLE:'desk-prepare'}],
    ]) { const result=io(); assert.equal(await run(args,{...result,env}),2); assert.match(result.out.stderr,/is (?:prepared|new|for-martin|closed)|unknown item/u); assert.equal(readFileSync(path,'utf8'),before); }
    const deskRoot=join(f.env.MC_WORK_ROOT,'martin','items'); const denied=io();
    assert.equal(await run(['items'],{...denied,env:{...f.env,MC_ROLE:'build-session:goal'}}),2);
    assert.match(denied.out.stderr,/cannot sync desk items/u); assert.equal(existsSync(join(deskRoot,'.store.json')),false);
    const closed=stored('closed'); const closedPath=join(closed.dir,'item.json'); const closedBefore=readFileSync(closedPath,'utf8');
    const refuse=io(); assert.equal(await run(['item',closed.record.id,'close','--by','decision','--summary','Already done.'],{...refuse,env:{...closed.env,MC_ROLE:'decision'}}),2);
    assert.match(refuse.out.stderr,/closed.*no verb applies/u); assert.equal(readFileSync(closedPath,'utf8'),closedBefore);
    const absent=stored('new'); const absentPath=join(absent.dir,'item.json'); const absentBefore=readFileSync(absentPath,'utf8');
    for (const args of [['item',absent.record.id,'prepared','--sort','mechanical'],['item',absent.record.id,'brief','--sort','product','--reversible','no']]) {
      const result=io(); assert.equal(await run(args,{...result,env:{...absent.env,MC_ROLE:'decision'}}),2); assert.match(result.out.stderr,/new.*prepared applies/u); assert.equal(readFileSync(absentPath,'utf8'),absentBefore);
    }
  });
  const refusedCases = [
    ['prepared requires prepared.md', 'new', ['prepared', '--sort', 'technical'], [], 'decision'],
    ['brief requires brief.md', 'prepared', ['brief', '--sort', 'product', '--reversible', 'yes'], [], 'decision'],
    ...['mechanical', 'technical'].map(sort => [`brief refuses ${sort}`, 'prepared', ['brief', '--sort', sort, '--reversible', 'no'], ['brief.md'], 'decision']),
    ...['prepared', 'brief', 'close'].map(verb => [`closed refuses ${verb}`, 'closed', [verb, '--sort', 'product', '--reversible', 'yes', '--by', 'martin', '--summary', 'Done.'], ['prepared.md', 'brief.md'], 'decision']),
    ...[['new', 'brief'], ['new', 'close'], ['prepared', 'prepared'], ['for-martin', 'prepared'], ['for-martin', 'brief']].map(([state, verb]) => [`${state} refuses ${verb}`, state, [verb, '--sort', 'product', '--reversible', 'yes', '--by', 'martin', '--summary', 'Done.'], ['prepared.md', 'brief.md'], 'decision']),
    ['unknown id', 'new', ['prepared', '--sort', 'technical'], ['prepared.md'], 'decision', 'unknown'],
    ...['build-session', 'review-session', 'finish-session', 'mend-session', 'plan', 'helper'].map(role => [`refuses role ${role}`, 'new', ['prepared', '--sort', 'technical'], ['prepared.md'], role]),
    ...['brief', 'close'].map(verb => [`desk-prepare refuses ${verb}`, 'prepared', [verb, '--sort', 'product', '--reversible', 'yes', '--by', 'decision', '--summary', 'Done.'], ['brief.md'], 'desk-prepare']),
    ...[
      ['new', 'prepared', ['--sort', 'technical']],
      ['prepared', 'brief', ['--sort', 'product', '--reversible', 'no']],
      ['prepared', 'close', ['--by', 'martin', '--summary', 'Fixture close.']],
    ].map(([state, verb, flags]) => [`${verb} refuses surplus positionals`, state, [verb, 'unexpected', ...flags], ['prepared.md', 'brief.md'], 'decision']),
  ];
  for (const [name, state, args, artifacts, role, id] of refusedCases) it(name, async () => {
    const f = stored(state);
    for (const artifact of artifacts) writeFileSync(join(f.dir, artifact), 'Evidence');
    const before = snapshot(f.env.MC_WORK_ROOT); const result = io();
    assert.equal(await run(['item', id || f.record.id, ...args], { ...result, env: { ...f.env, MC_ROLE: role } }), 2);
    assert.match(result.out.stderr, id ? /unknown item.*no item state or verb applies/u : new RegExp(`is ${state};.*${state === 'new' ? 'prepared' : state === 'prepared' ? 'brief or close' : state === 'for-martin' ? 'close' : 'no verb'} applies`, 'u'));
    assert.deepEqual(snapshot(f.env.MC_WORK_ROOT), before, 'refusal writes no file');
  });
  // A main-red question is answered by `mc repo mend`; a hand close would hide a repair that still waits on Martin.
  describe('closing a main-red item', () => {
    function mainRed(entryFields = null) {
      const root = mkdtempSync(join(tmpdir(), 'mc-martin-red-')); roots.push(root);
      const env = { MC_WORK_ROOT: join(root, 'mc'), MC_HOME: join(root, 'mc-home') };
      const reference = 'main-red:memoro/red1', source_at = '2026-11-14T10:00:00Z', id = deskItemId('main-red', reference, source_at);
      const record = { schema: 'mc-desk-item', version: 1, id, kind: 'main-red', reference, source_at, opened_at: source_at, state: 'for-martin', sort: 'product', reversible: false, due_at: null, outcome: null };
      mkdirSync(join(env.MC_WORK_ROOT, 'runner', 'main-mend'), { recursive: true });
      const state = join(env.MC_WORK_ROOT, 'runner', 'main-mend', 'memoro.json');
      if (entryFields) writeFileSync(state, JSON.stringify({ version: 1, entries: [{ id: 'red1', file: 'tests/a.test.js', state: 'Martin', created: source_at, ...entryFields }] }));
      writeDeskItem(record, { env });
      return { env, record, state, dir: itemDirectory(record, env) };
    }
    const close = (f, by, role) => run(['item', f.record.id, 'close', '--by', by, '--summary', 'Closed by hand.'], { ...(f.out = io()), env: { ...f.env, MC_ROLE: role }, now: () => new Date('2026-11-14T11:00:00Z') });
    for (const [by, role] of [['decision', 'decision'], ['martin', 'martin'], ['default', 'decision']]) {
      it(`exits 2 naming mc repo mend while the entry reads Martin (--by ${by}), and writes nothing`, async () => {
        const f = mainRed({}); const itemBefore = readFileSync(join(f.dir, 'item.json'), 'utf8'), stateBefore = readFileSync(f.state, 'utf8');
        assert.equal(await close(f, by, role), 2);
        assert.match(f.out.out.stderr, /still reads Martin; answer it with mc repo mend memoro red1 requeue\|drop/u);
        assert.equal(readFileSync(join(f.dir, 'item.json'), 'utf8'), itemBefore);
        assert.equal(readFileSync(f.state, 'utf8'), stateBefore);
      });
    }
    for (const [label, make] of [['unreadable', (f) => writeFileSync(f.state, '{')], ['missing', (f) => rmSync(f.state)]]) {
      it(`exits 2 with item.json unchanged when the state file is ${label}`, async () => {
        const f = mainRed({}); make(f); const before = readFileSync(join(f.dir, 'item.json'), 'utf8');
        assert.equal(await close(f, 'decision', 'decision'), 2);
        assert.match(f.out.out.stderr, /cannot be read.*mc repo mend memoro red1/u);
        assert.equal(readFileSync(join(f.dir, 'item.json'), 'utf8'), before);
      });
    }
    for (const answer of [{ state: 'queued', failures: 0 }, { state: 'dropped' }]) {
      it(`succeeds once the entry was answered (${answer.state})`, async () => {
        const f = mainRed({ ...answer, answered: { verb: answer.state === 'queued' ? 'requeue' : 'drop', by: 'person', at: '2026-11-14T10:30:00.000Z', reason: 'x' } });
        assert.equal(await close(f, 'decision', 'decision'), 0, f.out.out.stderr);
        assert.equal(JSON.parse(readFileSync(join(f.dir, 'item.json'), 'utf8')).state, 'closed');
      });
    }
    it('judges the entry as the hold reads it, not as it was before: an answer that lands first lets the close through', async () => {
      const f = mainRed({}); let reads = 0;
      const lock = (root, fn) => { writeFileSync(f.state, JSON.stringify({ version: 1, entries: [{ id: 'red1', file: 'tests/a.test.js', state: 'queued', created: '2026-11-14T10:00:00Z', answered: { verb: 'requeue', by: 'person', at: '2026-11-14T10:30:00.000Z', reason: 'x' } }] })); reads += 1; return fn(); };
      const out = io();
      assert.equal(await run(['item', f.record.id, 'close', '--by', 'decision', '--summary', 'Closed.'], { ...out, env: { ...f.env, MC_ROLE: 'decision' }, lock }), 0, out.out.stderr);
      assert.equal(reads, 1);
    });
  });
  it('refuses surplus listing arguments before sync writes anything', async () => {
    const f = stored(); const before = snapshot(f.env.MC_WORK_ROOT); const result = io();
    assert.equal(await run(['items', 'unexpected'], { ...result, env: f.env }), 2);
    assert.deepEqual(snapshot(f.env.MC_WORK_ROOT), before);
  });
  it('allows desk-prepare to prepare and decision to close prepared directly using a summary file', async () => {
    const f = stored(); writeFileSync(join(f.dir, 'prepared.md'), 'Evidence');
    assert.equal(await run(['item', f.record.id, 'prepared', '--sort', 'mechanical'], { ...io(), env: { ...f.env, MC_ROLE: 'desk-prepare' } }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'item.json'), 'utf8')), { ...f.record, state: 'prepared', sort: 'mechanical' });
    const summary = join(f.dir, 'summary.md'); writeFileSync(summary, 'Resolved mechanically.\n');
    assert.equal(await run(['item', f.record.id, 'close', '--by', 'decision', '--summary-file', summary], { ...io(), env: { ...f.env, MC_ROLE: 'decision' }, now: () => new Date(f.record.source_at) }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'item.json'), 'utf8')), { ...f.record, state: 'closed', sort: 'mechanical', outcome: { by: 'decision', at: new Date(f.record.source_at).toISOString(), summary: 'Resolved mechanically.' } });
  });
  for (const reversible of ['yes', 'no']) it(`prepared advances to for-martin with reversible ${reversible}`, async () => {
    const f = stored('prepared'); writeFileSync(join(f.dir, 'brief.md'), 'Recommendation');
    assert.equal(await run(['item', f.record.id, 'brief', '--sort', 'reserved', '--reversible', reversible], { ...io(), env: { ...f.env, MC_ROLE: 'decision' }, now: () => new Date(f.record.source_at) }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'item.json'), 'utf8')), { ...f.record, state: 'for-martin', sort: 'reserved', reversible: reversible === 'yes', due_at: reversible === 'yes' ? '2026-11-16T10:00:00.000Z' : null });
  });
  it('for-martin closes with a default outcome and exposes persisted fields and artifacts', async () => {
    const f = stored('for-martin'); writeFileSync(join(f.dir, 'prepared.md'), 'Evidence'); writeFileSync(join(f.dir, 'brief.md'), 'Recommendation');
    assert.equal(await run(['item', f.record.id, 'close', '--by', 'default', '--summary', 'The default applies.'], { ...io(), env: { ...f.env, MC_ROLE: 'decision' }, now: () => new Date(f.record.source_at) }), 0);
    const current = JSON.parse(readFileSync(join(f.dir, 'item.json'), 'utf8'));
    assert.deepEqual(current, { ...f.record, state: 'closed', outcome: { by: 'default', at: new Date(f.record.source_at).toISOString(), summary: 'The default applies.' } });
    const output = io(); assert.equal(await run(['item', f.record.id], { ...output, env: f.env, home: join(f.env.MC_WORK_ROOT, 'programs') }), 0);
    const { source, prepared, brief, ...detail } = JSON.parse(output.out.stdout);
    assert.deepEqual(detail, current); assert.equal(source, null); assert.equal(prepared, 'Evidence'); assert.equal(brief, 'Recommendation');
  });
  // The sync closes by source while the deciding session works: the session's close still stands and keeps the closure it replaces.
  const sourceClosure = { by: 'source', at: '2026-11-14T10:20:00.000Z', summary: 'The source resolved.' };
  const closeArgs = (f, by) => ['item', f.record.id, 'close', '--by', by, '--summary', 'Settled.'];
  for (const by of ['decision', 'martin', 'default']) it(`close --by ${by} over a source closure replaces it and records it as outcome.replaced`, async () => {
    const f = stored('prepared'); const path = join(f.dir, 'item.json');
    writeJsonAtomic(path, { ...f.record, sort: 'product', state: 'closed', outcome: sourceClosure });
    const result = io();
    assert.equal(await run(closeArgs(f, by), { ...result, env: { ...f.env, MC_ROLE: by === 'decision' ? 'decision' : 'martin' }, now: () => new Date('2026-11-14T11:00:00Z') }), 0, result.out.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ...f.record, sort: 'product', state: 'closed', outcome: { by, at: '2026-11-14T11:00:00.000Z', summary: 'Settled.', replaced: sourceClosure } });
  });
  it('a real sync closes a prepared item by source; the decision close then stands, is listed as decided and counts no source closure', async () => {
    const f = stored('prepared'); const path = join(f.dir, 'item.json'); const home = join(f.env.MC_WORK_ROOT, 'programs');
    writeJsonAtomic(path, { ...f.record, sort: 'technical' });
    mkdirSync(join(home, 'alpha', 'goals', 'one'), { recursive: true }); writeFileSync(join(home, 'alpha', 'README.md'), 'Alpha');
    writeFileSync(join(home, 'alpha', 'goals', 'one', 'GOAL.json'), goalJson({ status: 'ready' }));
    assert.equal(await run(['items'], { ...io(), env: f.env, home, syncDeps: { now: () => new Date('2026-11-14T10:30:00Z') } }), 0);
    mkdirSync(join(f.env.MC_WORK_ROOT, 'martin'), { recursive: true }); writeFileSync(join(f.env.MC_WORK_ROOT, 'martin', 'last-open.json'), JSON.stringify({ at: '2026-11-14T09:00:00Z' }));
    const source = JSON.parse(readFileSync(path, 'utf8')); assert.deepEqual([source.state, source.outcome.by, source.sort], ['closed', 'source', 'technical']);
    const asked = (by, role) => run(['item', f.record.id, 'close', '--by', by, '--summary', 'Carried out.'], { ...io(), env: { ...f.env, MC_ROLE: role }, home, now: () => new Date('2026-11-14T11:00:00Z') });
    assert.equal(await asked('decision', 'decision'), 0);
    const closed = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual([closed.state, closed.outcome.by, closed.outcome.summary, closed.outcome.replaced], ['closed', 'decision', 'Carried out.', source.outcome]);
    const opening = io(); assert.equal(await run(['brief', '--json'], { ...opening, env: f.env, home, now: () => new Date(NOW) }), 0, opening.out.stderr);
    const data = JSON.parse(opening.out.stdout);
    assert.deepEqual(data.decided.programmes.flatMap(p => p.items.map(i => [i.id, i.by, i.summary])), [[f.record.id, 'decision', 'Carried out.']]);
    assert.equal(data.decided.closed_by_source, 0);
    const before = readFileSync(path, 'utf8'); const again = io();
    assert.equal(await run(closeArgs(f, 'decision'), { ...again, env: { ...f.env, MC_ROLE: 'decision' }, home }), 2);
    assert.equal(readFileSync(path, 'utf8'), before, 'a second close is refused');
  });
  it('a for-martin item the source closed takes close --by martin, which only stops counting as a source closure', async () => {
    const f = stored('for-martin'); const path = join(f.dir, 'item.json'); const home = join(f.env.MC_WORK_ROOT, 'programs');
    writeJsonAtomic(path, { ...f.record, sort: 'product', reversible: false });
    mkdirSync(join(home, 'alpha', 'goals', 'one'), { recursive: true }); writeFileSync(join(home, 'alpha', 'README.md'), 'Alpha');
    writeFileSync(join(home, 'alpha', 'goals', 'one', 'GOAL.json'), goalJson({ status: 'ready' }));
    assert.equal(await run(['items'], { ...io(), env: f.env, home, syncDeps: { now: () => new Date('2026-11-14T10:30:00Z') } }), 0);
    mkdirSync(join(f.env.MC_WORK_ROOT, 'martin'), { recursive: true }); writeFileSync(join(f.env.MC_WORK_ROOT, 'martin', 'last-open.json'), JSON.stringify({ at: '2026-11-14T09:00:00Z' }));
    const count = async () => { const out = io(); await run(['brief', '--json'], { ...out, env: f.env, home, now: () => new Date(NOW) }); return JSON.parse(out.out.stdout).decided; };
    assert.equal((await count()).closed_by_source, 1);
    assert.equal(await run(['item', f.record.id, 'close', '--by', 'martin', '--summary', 'Martin chose.'], { ...io(), env: { ...f.env, MC_ROLE: 'martin' }, home, now: () => new Date('2026-11-14T11:00:00Z') }), 0);
    const decided = await count(); assert.equal(decided.closed_by_source, 0); assert.deepEqual(decided.programmes, [], 'his own close is not listed as decided without him');
  });
  it('a source closure of an item that never had a sort, and a decision closure, are still refused without a byte changed', async () => {
    for (const closed of [{ sort: null, outcome: sourceClosure }, { sort: 'product', outcome: { by: 'decision', at: sourceClosure.at, summary: 'Done.' } }]) {
      const f = stored('prepared'); const path = join(f.dir, 'item.json');
      writeJsonAtomic(path, { ...f.record, state: 'closed', ...closed }); const before = readFileSync(path, 'utf8'); const result = io();
      assert.equal(await run(closeArgs(f, 'decision'), { ...result, env: { ...f.env, MC_ROLE: 'decision' } }), 2);
      assert.match(result.out.stderr, /is closed;/u); assert.equal(readFileSync(path, 'utf8'), before);
    }
  });
  it('the verb is judged on the record read under the lock: a source closure that lands first is replaced, a decision that lands first stands', async () => {
    const f = stored('prepared'); const path = join(f.dir, 'item.json'); const prepared = { ...f.record, sort: 'technical' }; writeJsonAtomic(path, prepared);
    const holds = [];
    const first = (outcome) => (root, fn, options) => { holds.push([root, options]); writeJsonAtomic(path, { ...prepared, state: 'closed', outcome }); return fn(); };
    const result = io();
    assert.equal(await run(closeArgs(f, 'decision'), { ...result, env: { ...f.env, MC_ROLE: 'decision' }, now: () => new Date('2026-11-14T11:00:00Z'), lock: first(sourceClosure) }), 0, result.out.stderr);
    assert.deepEqual(holds, [[f.env.MC_WORK_ROOT, { strict: true, name: 'desk-item' }]]);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).outcome, { by: 'decision', at: '2026-11-14T11:00:00.000Z', summary: 'Settled.', replaced: sourceClosure });
    // Martin's close through the real verb lands first: the decision close is refused and the file's bytes are Martin's.
    writeJsonAtomic(path, prepared); const refused = io(); let competitor = null;
    const martinFirst = (root, fn) => {
      run(['item', f.record.id, 'close', '--by', 'martin', '--summary', 'Martin chose.'], { ...io(), env: { ...f.env, MC_ROLE: 'martin' }, now: () => new Date('2026-11-14T10:30:00Z') });
      competitor = readFileSync(path, 'utf8'); return fn();
    };
    assert.equal(await run(closeArgs(f, 'decision'), { ...refused, env: { ...f.env, MC_ROLE: 'decision' }, lock: martinFirst }), 2);
    assert.match(refused.out.stderr, /is closed;/u);
    assert.deepEqual(JSON.parse(competitor).outcome, { by: 'martin', at: '2026-11-14T10:30:00.000Z', summary: 'Martin chose.' }, 'the competitor closed it --by martin');
    assert.equal(readFileSync(path, 'utf8'), competitor, "the file's bytes are the competitor's");
    const advance = io(); writeJsonAtomic(path, { ...f.record, state: 'new' }); // the item moved on before the hold: new is not prepared
    assert.equal(await run(['item', f.record.id, 'brief', '--sort', 'product', '--reversible', 'yes'], { ...advance, env: { ...f.env, MC_ROLE: 'decision' }, lock: (root, fn) => { writeJsonAtomic(path, { ...f.record, state: 'new' }); return fn(); } }), 2);
  });
  it('an item verb that cannot take the lock prints one mc: line, exits 1 and changes nothing', async () => {
    const f = stored('prepared'); writeFileSync(join(f.dir, 'brief.md'), 'Brief'); const before = snapshot(f.env.MC_WORK_ROOT); const result = io();
    const lock = () => { throw new Error('the runner lock is held by pid 4242 — try again'); };
    assert.equal(await run(['item', f.record.id, 'close', '--by', 'decision', '--summary', 'Settled.'], { ...result, env: { ...f.env, MC_ROLE: 'decision' }, lock }), 1);
    assert.equal(result.out.stderr, 'mc: the runner lock is held by pid 4242 — try again\n'); assert.equal(result.out.stdout, '');
    assert.deepEqual(snapshot(f.env.MC_WORK_ROOT), before);
  });
  it('items, brief and the opening that cannot take the lock print one mc: line, return 1, open nothing and write no last-open.json', async () => {
    const d = openingStore({ lastOpen: null }); const lock = () => { throw new Error('the runner lock is held by pid 4242 — try again'); };
    const line = 'mc: the runner lock is held by pid 4242 — try again\n'; const before = snapshot(d.root);
    const listing = io(); assert.equal(await run(['items'], { ...listing, env: d.env, home: d.home, syncDeps: { lock } }), 1);
    assert.deepEqual([listing.out.stdout, listing.out.stderr], ['', line]);
    const brief = io(); assert.equal(await run(['brief'], { ...brief, env: d.env, home: d.home, now: () => new Date(NOW), syncDeps: { lock } }), 1);
    assert.deepEqual([brief.out.stdout, brief.out.stderr], ['', line]);
    let opened = false;
    const started = await launch(d, NOW, { syncDeps: { lock }, open: async () => { opened = true; return { ok: true, code: 0 }; } });
    assert.equal(started.code, 1); assert.deepEqual([started.out.stdout, started.out.stderr], ['', line]); assert.equal(opened, false);
    assert.equal(existsSync(join(d.env.MC_WORK_ROOT, 'martin', 'last-open.json')), false);
    assert.deepEqual(snapshot(d.root), before);
  });
  it('lists each historical goal question or runner reason by its own source time even after resolution', async () => {
    const f = stored(); const home = join(f.env.MC_WORK_ROOT, 'programs'); const dir = join(home, 'alpha', 'goals', 'one'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, 'alpha', 'README.md'), 'Alpha');
    writeFileSync(join(dir, 'GOAL.json'), goalJson({ status: 'Martin' }));
    const history = [log(f.record.source_at, 'Martin', 'Martin is asked: Original question?'), log('2026-11-14T11:00:00Z', 'Martin', 'Martin is asked: Later question?')];
    writeFileSync(join(dir, 'LOG.md'), history.join('\n\n'));
    async function listing() {
      const out = io(); assert.equal(await run(['items', '--json'], { ...out, env: f.env, home }), 0, out.out.stderr);
      return JSON.parse(out.out.stdout);
    }
    let rows = await listing();
    assert.deepEqual(rows.map(x => [x.state, x.question]), [['new', 'Later question?'], ['closed', 'Original question?']]);
    writeFileSync(join(dir, 'GOAL.json'), goalJson({ status: 'ready' }));
    rows = await listing(); assert.deepEqual(rows.map(x => [x.state, x.question]), [['closed', 'Original question?'], ['closed', 'Later question?']]);
    const runnerAt = '2026-11-14T12:00:00Z';
    writeFileSync(join(dir, 'GOAL.json'), goalJson({ status: 'Martin' }));
    writeFileSync(join(dir, 'LOG.md'), [...history, log('2026-11-14T11:30:00Z', 'ready', 'Resolved'), log(runnerAt, 'Martin', 'runner failure: no response')].join('\n\n'));
    rows = await listing(); assert.equal(rows[0].question, 'runner failure: no response');
    const detail = io(); assert.equal(await run(['item', rows[0].id], { ...detail, env: f.env, home }), 0);
    const { source, prepared, brief, ...persistedDetail } = JSON.parse(detail.out.stdout);
    const { question, ...persistedListing } = rows[0];
    assert.deepEqual(persistedListing, JSON.parse(readFileSync(join(itemDirectory(rows[0], f.env), 'item.json'), 'utf8')));
    assert.deepEqual(persistedDetail, persistedListing); assert.equal(source.question.at, runnerAt);
    assert.equal(prepared, null); assert.equal(brief, null);
  });
  it('renders a decision ledger record on both the item detail and item listing', async()=>{
    const f=stored(); f.record.kind='decision'; f.record.reference=`decision:${f.record.source_at}`; f.record.id=deskItemId('decision',f.record.reference,f.record.source_at); f.dir=itemDirectory(f.record,f.env); writeDeskItem(f.record,{env:f.env});
    const ledger=join(f.env.MC_HOME,'jev','decisions.jsonl'); mkdirSync(join(f.env.MC_HOME,'jev'),{recursive:true});
    writeFileSync(ledger,JSON.stringify({at:f.record.source_at,outcome:'decided',recommend:'keep',question:'Which rule should stand?',answers:{answer:{choice:'change'},product:0.1}})+'\n');
    const detail=io(); assert.equal(await run(['item',f.record.id],{...detail,env:f.env}),0); const {source,prepared,brief,...record}=JSON.parse(detail.out.stdout); assert.deepEqual(record,f.record); assert.equal(source.question,'Which rule should stand?'); assert.equal(prepared,null); assert.equal(brief,null);
    const listing=io(); assert.equal(await run(['items','--json'],{...listing,env:f.env}),0); const shown=JSON.parse(listing.out.stdout).find(x=>x.id===f.record.id); const {question,...listed}=shown; assert.deepEqual(listed,f.record); assert.equal(question,'Which rule should stand?');
  });
});

describe('mc martin brief with horizons', () => {
  const HEADS = ['Yours (4)', 'Decided without you', 'Not ready', 'Cost', 'What the system changed'].map((h) => `## ${h}`);
  const KEYS = ['generated_at', 'last_opened', 'since', 'yours', 'decided', 'not_ready', 'cost', 'changes'];
  const headingsOf = (text) => text.split('\n').filter((line) => line.startsWith('## '));
  const PLAYBACK = ['How it is read', 'How one sees it is reached', 'What is built first', 'What is not built', 'The strangest thing the wording permits'].map((h) => `## ${h}\n\ntext\n`).join('\n');
  const STATEMENT = '\nLine one.\n\nLine two.\nLine three.\nLine four.';
  /** One horizon verb through the real command, as `role` (a headless manager for reached) at the injected time. */
  async function horizon(d, argv, at, { role = 'person', headless = false, stdin = PLAYBACK } = {}) {
    const text = io(); const env = { ...d.env, MC_ROLE: role, ...(headless ? { MC_HEADLESS: '1' } : {}) };
    const code = await run(['horizon', ...argv], { ...text, env, now: () => new Date(at), readStdin: () => stdin });
    assert.equal(code, 0, `${argv.join(' ')}: ${text.out.stderr}`);
  }
  const setOne = (d, slug, at = '2026-11-14T07:00:00.000Z') => horizon(d, ['set', slug, '--title', `Title of ${slug}`, '--file', '-'], at);
  const brief = async (d, ...flags) => { const text = io(); assert.equal(await run(['brief', ...flags], { ...text, env: d.env, home: d.home, now: () => new Date(NOW) }), 0, text.out.stderr); return text.out.stdout; };
  const cut = (text) => { const from = text.indexOf('## Horizons'); assert.notEqual(from, -1); return text.slice(0, from) + text.slice(text.indexOf('## Decided without you')); };
  /** The store of criterion 5 (b): four open at the end, one reached today, one reached yesterday, one dropped. */
  async function withHorizons(d) {
    for (const slug of ['open-a', 'open-b', 'open-c', 'done-today', 'done-old', 'dropped-one', 'reopened-one']) await setOne(d, slug);
    await horizon(d, ['reached', 'done-today', '--file', '-'], '2026-11-14T09:00:00.000Z', { role: 'manager', headless: true, stdin: STATEMENT });
    await horizon(d, ['reached', 'done-old', '--file', '-'], '2026-11-13T09:00:00.000Z', { stdin: 'Old statement.\n' });
    await horizon(d, ['drop', 'dropped-one', '--reason', 'No longer wanted'], '2026-11-14T09:30:00.000Z');
    await horizon(d, ['reached', 'reopened-one', '--file', '-'], '2026-11-14T09:10:00.000Z', { stdin: 'Briefly reached.\n' });
    await horizon(d, ['reopen', 'reopened-one', '--reason', 'It was not'], '2026-11-14T09:20:00.000Z');
  }

  it('(a) a desk with no horizon opens as before: the same parts, the same keys, and the same text with an empty or a record-less directory', async () => {
    const d = openingStore(); const t0 = await brief(d);
    assert.deepEqual(headingsOf(t0), HEADS);
    assert.deepEqual(Object.keys(JSON.parse(await brief(d, '--json'))), KEYS);
    mkdirSync(join(d.env.MC_WORK_ROOT, 'martin', 'horizons'));
    assert.equal(await brief(d), t0);
    mkdirSync(join(d.env.MC_WORK_ROOT, 'martin', 'horizons', 'no-record'));
    assert.equal(await brief(d), t0);
    assert.deepEqual(Object.keys(JSON.parse(await brief(d, '--json'))), KEYS);
  });

  it('(b) the part stands between Yours and Decided without you, lists what was reached since the last opening, then the open ones in order, and nothing else changes', async () => {
    const d = openingStore(); const t0 = await brief(d); const json0 = JSON.parse(await brief(d, '--json'));
    await withHorizons(d); const before = snapshot(d.root);
    const text = await brief(d); const json = JSON.parse(await brief(d, '--json'));
    assert.equal(cut(text), t0, 'the opening with the part cut out is the opening without horizons');
    assert.ok(text.indexOf('### 4. beta/judge') < text.indexOf('## Horizons') && text.indexOf('## Horizons') < text.indexOf('## Decided without you'));
    const part = text.slice(text.indexOf('## Horizons'), text.indexOf('## Decided without you'));
    const at = (needle) => { const index = part.indexOf(needle); assert.notEqual(index, -1, needle); return index; };
    const reachedAt = at('Reached since the last opening:'), openAt = at('Open, in order:');
    assert.ok(reachedAt < at('Title of done-today') && at('Title of done-today') < openAt);
    for (const needle of ['done-today', '2026-11-14T09:00:00.000Z', 'manager', 'Line one.', 'Line two.', 'Line three.']) assert.ok(at(needle) > reachedAt && at(needle) < openAt, needle);
    const order = ['open-a', 'open-b', 'open-c', 'reopened-one'].map((slug) => { assert.ok(part.includes(`Title of ${slug}`)); return at(`Title of ${slug}`); });
    assert.ok(order[0] > openAt); assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(!text.includes('Line four.'));
    for (const absent of ['Title of done-old', 'Title of dropped-one']) assert.ok(!text.includes(absent), absent);
    assert.ok(part.includes('open-a') && part.includes('reopened-one'));
    const { horizons, ...rest } = json;
    assert.deepEqual(horizons, {
      reached: [{ slug: 'done-today', title: 'Title of done-today', reached_at: '2026-11-14T09:00:00.000Z', reached_by: 'manager', first_lines: ['Line one.', 'Line two.', 'Line three.'] }],
      open: ['open-a', 'open-b', 'open-c', 'reopened-one'].map((slug, index) => ({ slug, title: `Title of ${slug}`, position: index + 1 })),
      unreadable: [],
    });
    assert.deepEqual(rest, json0);
    assert.equal(renderOpening(json), text);
    assert.deepEqual(snapshot(d.root), before, 'the opening writes no file');
  });

  it('(c) with nothing open the part says so and holds neither list', async () => {
    const d = openingStore(); await setOne(d, 'old-one'); await setOne(d, 'gone-one');
    await horizon(d, ['reached', 'old-one', '--file', '-'], '2026-11-14T07:30:00.000Z', { stdin: 'Done.\n' });
    await horizon(d, ['drop', 'gone-one', '--reason', 'No'], '2026-11-14T09:00:00.000Z');
    const text = await brief(d); const part = text.slice(text.indexOf('## Horizons'), text.indexOf('## Decided without you'));
    assert.ok(text.includes('## Horizons')); assert.ok(part.split('\n').includes('No horizon is open.'));
    assert.ok(!part.includes('Reached since the last opening:') && !part.includes('Open, in order:'));
  });

  it('(d) a first opening lists what was reached on the day before', async () => {
    const d = openingStore({ lastOpen: null }); await setOne(d, 'yesterday-one', '2026-11-12T07:00:00.000Z');
    await horizon(d, ['reached', 'yesterday-one', '--file', '-'], '2026-11-13T09:00:00.000Z', { stdin: 'Done yesterday.\n' });
    const text = await brief(d); const part = text.slice(text.indexOf('## Horizons'), text.indexOf('## Decided without you'));
    assert.equal(JSON.parse(await brief(d, '--json')).since, '2026-11-01T00:00:00.000Z');
    assert.ok(part.indexOf('Reached since the last opening:') !== -1 && part.indexOf('Title of yesterday-one') > part.indexOf('Reached since the last opening:'));
  });

  it('(e) a record that cannot be read is named, never overwritten, and the verbs go on with the others', async () => {
    const d = openingStore(); await setOne(d, 'fine-one');
    const broken = join(d.env.MC_WORK_ROOT, 'martin', 'horizons', 'broken'); mkdirSync(broken); writeFileSync(join(broken, 'horizon.json'), '{');
    const bytes = readFileSync(join(broken, 'horizon.json'), 'utf8');
    const text = await brief(d); const json = JSON.parse(await brief(d, '--json'));
    assert.deepEqual(json.horizons.unreadable, ['broken']);
    const lines = text.slice(text.indexOf('## Horizons'), text.indexOf('## Decided without you')).trimEnd().split('\n');
    assert.ok(lines[lines.length - 1].includes('broken'), lines.at(-1));
    const listed = io(); assert.equal(await run(['horizons'], { ...listed, env: d.env, now: () => new Date(NOW) }), 0);
    assert.ok(listed.out.stdout.includes('fine-one')); assert.match(listed.out.stderr, /^mc: [^\n]*broken[^\n]*\n$/u);
    const refused = io();
    assert.equal(await run(['horizon', 'set', 'broken', '--title', 'T', '--file', '-'], { ...refused, env: { ...d.env, MC_ROLE: 'martin' }, now: () => new Date(NOW), readStdin: () => PLAYBACK }), 2);
    assert.equal(readFileSync(join(broken, 'horizon.json'), 'utf8'), bytes);
  });

  it('(f) the launch hands the opening model the text brief prints', async () => {
    const d = openingStore(); await withHorizons(d); const printed = await brief(d); const prompts = [];
    const r = await launch(d, NOW, { open: async (spec) => { prompts.push(spec.prompt); return { ok: true, code: 0 }; } });
    assert.equal(r.code, 0, r.out.stderr); assert.equal(prompts.length, 1); assert.equal(prompts[0], printed);
  });
});

function snapshot(root) {
  const rows = [];
  function walk(path) { for (const name of readdirSync(path)) { const child = join(path, name); const st = lstatSync(child); if (st.isDirectory()) { rows.push([child, 'directory']); walk(child); } else rows.push([child, 'file', readFileSync(child).toString()]); } }
  walk(root); return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

describe('mc martin ceiling', () => {
  it('ships off, sets a ceiling, shows today desk sum, and switches off again', async () => {
    const f = fixture(); const env = { MC_WORK_ROOT: f.home, MC_HOME: join(f.home, 'mc-home'), MC_TOOL: 'person' };
    const now = () => new Date('2026-11-14T10:00:00Z');
    mkdirSync(join(f.home, 'runner', 'log'), { recursive: true });
    const rows = [['2026-11-14T01:00:00Z','desk-prepare',2], ['2026-11-14T02:00:00Z','decision',3], ['2026-11-13T23:00:00Z','decision',100], ['2026-11-14T02:00:00Z','intake',100]];
    writeFileSync(deskRunsPath(env), `${tsvHeader()}\n${rows.map(([ts,kind,cost]) => tsvRow({ts,kind,cost})).join('\n')}\n`);
    const initial = snapshot(f.home);
    for (const [args, expected] of [[[], 'off'], [['5'], '$5/day'], [[], '$5/day'], [['off'], 'off'], [[], 'off']]) {
      const output = io();
      assert.equal(await run(['ceiling', ...args], { ...output, env, now }), 0, output.out.stderr);
      assert.equal(output.out.stdout, `mc: desk ceiling: ${expected}; today (2026-11-14 UTC): $5.0000\n`);
      if (!args.length && expected === 'off' && !existsSync(join(f.home,'runner','desk.json'))) assert.deepEqual(snapshot(f.home), initial);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(f.home,'runner','desk.json'),'utf8')), { ceiling_usd_per_day: null });
  });
  it('refuses invalid settings and session writes without changing files', async () => {
    const f = fixture(); const env = { MC_WORK_ROOT: f.home, MC_HOME: join(f.home,'mc-home'), MC_TOOL: 'person' };
    for (const [args, extra] of [[['-1'], {}], [['NaN'], {}], [['5','off'], {}], [['Infinity'], {}], [['5'], { MC_ROLE: 'desk-prepare' }], [['off'], { MC_ROLE: 'build-session:goal' }]]) {
      const before = snapshot(f.home), output = io();
      assert.equal(await run(['ceiling', ...args], { ...output, env: { ...env, ...extra } }), 2);
      assert.deepEqual(snapshot(f.home), before);
    }
  });
});

describe('mc martin prepare', () => {
  it('uses the same headless turn by hand and refuses a session launcher', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-manual-prepare-')); roots.push(root);
    const env = { MC_WORK_ROOT: root, MC_HOME: join(root,'mc-home'), MC_TOOL: 'person' };
    const record = { id: deskItemId('goal','alpha/item','2026-11-14T00:00:00Z'), kind: 'goal', reference: 'alpha/item', state: 'new', source_at: '2026-11-14T00:00:00Z' };
    writeDeskItem(record, { env });
    let calls = 0;
    const output = io();
    const prepareDeps = { route: () => ({ ok: true, candidate: { tool: 'claude', model: 'sonnet', effort: 'high' } }),
      launch: () => ({ ok: true, id: 'claude-code', spec: {bin:'/fake/claude'} }), billingRoute: () => ({billing:'plan'}),
      session: async call => {
        calls++; assert.equal(call.cwd, itemDirectory(record, env)); assert.equal(call.env.MC_ROLE,'desk-prepare');
        writeFileSync(join(call.cwd,'prepared.md'),'Facts');
        assert.equal(await run(['item',record.id,'prepared','--sort','technical'],{...io(),env:call.env}),0);
        return {status:0,stdout:'{}',stderr:''};
      },
    };
    const before = snapshot(root);
    assert.equal(await run(['prepare',record.id],{...output,env:{...env,MC_ROLE:'desk-prepare'},prepareDeps}),2);
    assert.deepEqual(snapshot(root),before); assert.equal(calls,0);
    assert.equal(await run(['prepare',record.id],{...output,env,prepareDeps}),0,output.out.stderr);
    assert.equal(calls,1); assert.equal(JSON.parse(readFileSync(join(itemDirectory(record,env),'item.json'),'utf8')).state,'prepared');
  });
});
