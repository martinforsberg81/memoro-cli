import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { run, get } from '../../../src/mc/commands/martin.js';
import { run as ask } from '../../../src/mc/commands/ask.js';
import { appendEntry } from '../../../src/mc/goals.js';
import { collectMartinQueue, renderMartinQueue } from '../../../src/mc/martin-collect.js';
import { goalJson } from '../_helpers/goal-file.js';

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
    ...(reference ? [reference] : []), '--reason', question,
    '--option', 'a: keep rule', '--option', 'b: change rule', '--recommend', 'a',
    '--evidence', 'Investigated evidence for this rule.', ...(reserved ? ['--reserved', 'admin'] : []),
  ], { ...deps, now: () => new Date(at), jev: {
    transport: async () => { effects.push('provider'); return { status: 200, text: async () => JSON.stringify({ model: 'jev-1.14.0', answers: {
      answer: { choice: 'a', probabilities: { a: p } }, fits: { noul: 0.99 }, settled: { noul: 0.99 },
    } }) }; }, timer: () => new Promise(() => {}),
  } }) };
}

describe('mc martin get', () => {
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
    for (const [role, stage] of [['martin', 'build'], ['build-session:goal', 'build'], ['review-session:goal', 'review'], ['finish-session', 'finish'], ['mend-session', 'merge']]) {
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
  it('opens a distinct role/path with fresh queue context and launcher conventions', async () => {
    const { out, stdout, stderr } = io(); let opened;
    const code = await run(['--resume', 'abc', '--codex', '--model', 'gpt-6.1-sol'], {
      stdout, stderr, env: { MC_WORK_ROOT: '/work', MC_HOME: '/home' }, interactive: () => true,
      collect: () => ({ items: [{ reference: 'alpha/g', title: 'Current', log: [], goal_markdown: '# Current', worktrees: [], evidence_paths: [] }], programme_context: [], issues: [] }),
      open: async (options) => { opened = options; return { ok: true, code: 0 }; }, mkdir: () => {},
      role: () => ({ name: 'martin', model: 'opus', tools: ['claude','codex'], cache: '5m', overlay: 'Martin role instructions' }),
    });
    assert.equal(code, 0, out.stderr);
    assert.equal(opened.areaName, 'martin'); assert.equal(opened.verb, 'martin');
    assert.equal(opened.areaRoot, '/work/martin'); assert.equal(opened.roleName, 'martin');
    assert.equal(opened.pick, 'abc'); assert.equal(opened.tool, 'codex'); assert.equal(opened.model, 'gpt-6.1-sol');
    assert.match(opened.prompt, /alpha\/g/u); assert.match(opened.resumePrompt, /Refresh from the live decision queue/u);
  });

  it('refuses unattended launch before creating a desk or opening a child', async () => {
    let opened = 0, made = 0; const { out, stdout, stderr } = io();
    assert.equal(await run([], { stdout, stderr, env: { MC_HEADLESS: '1' }, interactive: () => true, mkdir: () => { made += 1; }, open: () => { opened += 1; } }), 2);
    assert.equal(opened, 0); assert.equal(made, 0); assert.match(out.stderr, /interactive-only/u);
  });
});

function snapshot(root) {
  const rows = [];
  function walk(path) { for (const name of readdirSync(path)) { const child = join(path, name); const st = lstatSync(child); if (st.isDirectory()) { rows.push([child, 'directory']); walk(child); } else rows.push([child, 'file', readFileSync(child).toString()]); } }
  walk(root); return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
