/** Commissioned horizon protection: the real store and verbs on a fixture home; no model, no network, no process. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run as martin, usage } from '../../src/mc/commands/martin.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const T1 = '2026-11-14T10:00:00.000Z', T2 = '2026-11-14T11:00:00.000Z', T3 = '2026-11-14T12:00:00.000Z', T4 = '2026-11-14T13:00:00.000Z';
const HEADINGS = ['How it is read', 'How one sees it is reached', 'What is built first', 'What is not built', 'The strangest thing the wording permits'];
const KEYS = ['read', 'reached', 'first', 'not_built', 'strangest'];
const texts = (tag) => HEADINGS.map((_, i) => `Text ${i + 1} of ${tag}.`);
const playback = (tag = 'x') => `${HEADINGS.map((h, i) => `## ${h}\n\n${texts(tag)[i]}\n`).join('\n')}`;
const NULLS = ['reached_at', 'reached_by', 'reopened_at', 'reopened_by', 'reopen_reason', 'dropped_at', 'dropped_by', 'drop_reason'];

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-horizons-')); roots.push(root);
  mkdirSync(join(root, 'mc', 'runner', 'projects'), { recursive: true }); // the runner lock's directory
  return { root, env: { MC_WORK_ROOT: join(root, 'mc'), MC_HOME: join(root, 'mc-home') }, dir: join(root, 'mc', 'martin', 'horizons') };
}
/** Every file under the fixture home, by path: what "nothing was written" is compared against. */
function tree(dir, out = {}) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names.sort()) { const path = join(dir, name); if (statSync(path).isDirectory()) tree(path, out); else out[path] = readFileSync(path, 'utf8'); }
  return out;
}
function io() { const o = { stdout: '', stderr: '' }; return { o, stdout: { write: (s) => { o.stdout += s; } }, stderr: { write: (s) => { o.stderr += s; } } }; }
/** One call of the verb: `role` null leaves MC_ROLE out; `extra` is added to the env; `at` is the injected clock. */
async function call(h, argv, { role = 'martin', headless = false, extra = {}, stdin = playback(), at = T1, lock, readFile } = {}) {
  const out = io();
  const env = { ...h.env, ...(role === null ? {} : { MC_ROLE: role }), ...(headless ? { MC_HEADLESS: '1' } : {}), ...extra };
  const code = await martin(argv, { ...out, env, now: () => new Date(at), readStdin: () => stdin, ...(lock ? { lock } : {}), ...(readFile ? { readFile } : {}) });
  return { code, ...out.o };
}
const set = (h, slug, opts = {}, ...more) => call(h, ['horizon', 'set', slug, '--title', `Title of ${slug}`, '--file', '-', ...more], opts);
const read = (h, slug) => JSON.parse(readFileSync(join(h.dir, slug, 'horizon.json'), 'utf8'));
const list = async (h, ...args) => JSON.parse((await call(h, ['horizons', '--json', ...args], { role: 'build-session:goal', headless: true })).stdout);
const ok = (r) => { assert.equal(r.code, 0, r.stderr); return r; };
/** A refusal: exit 2, one `mc:` line, nothing on stdout. */
function refused(r, label = '') {
  assert.equal(r.code, 2, `${label}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /^mc: [^\n]+\n$/u, label); assert.equal(r.stdout, '', label);
}
/** The record a fixture writes by hand, for what the verbs cannot make (two open ones at one position). */
function plant(h, slug, { position, set_at, state = 'open' }) {
  mkdirSync(join(h.dir, slug), { recursive: true });
  writeFileSync(join(h.dir, slug, 'playback.md'), playback(slug));
  writeJsonAtomic(join(h.dir, slug, 'horizon.json'), { schema: 'mc-desk-horizon', version: 1, slug, title: `Title of ${slug}`, state, position, set_at, set_by: 'martin', ...Object.fromEntries(NULLS.map((k) => [k, null])) });
}
/** Three open horizons, one of them reached later: alpha-one, beta-two and gamma-three in that order. */
async function three(h) {
  for (const slug of ['alpha-one', 'beta-two', 'gamma-three']) ok(await set(h, slug, { at: T1 }));
}

describe('a horizon is stored and read back whole (criterion 1)', () => {
  it('(a) set stores the record and the playback, from a file and from standard input', async () => {
    const h = home();
    const r = ok(await set(h, 'alpha-one', { at: T1 }));
    assert.equal(r.stdout, 'alpha-one · open · 1\n');
    assert.deepEqual(read(h, 'alpha-one'), { schema: 'mc-desk-horizon', version: 1, slug: 'alpha-one', title: 'Title of alpha-one', state: 'open', position: 1, set_at: T1, set_by: 'martin', ...Object.fromEntries(NULLS.map((k) => [k, null])) });
    assert.equal(readFileSync(join(h.dir, 'alpha-one', 'playback.md'), 'utf8'), playback());
    const g = home(); const file = join(g.root, 'playback.md'); writeFileSync(file, playback());
    ok(await call(g, ['horizon', 'set', 'alpha-one', '--title', 'T', '--file', file]));
    assert.equal(readFileSync(join(g.dir, 'alpha-one', 'playback.md'), 'utf8'), playback());
  });

  it('(b) a person adds last, --position 1 goes first, and horizons lists them for any caller without writing', async () => {
    const h = home();
    ok(await set(h, 'alpha-one', { at: T1 }));
    const second = ok(await set(h, 'beta-two', { role: null }));
    assert.equal(second.stdout, 'beta-two · open · 2\n'); assert.equal(read(h, 'beta-two').set_by, 'person');
    ok(await set(h, 'gamma-three', {}, '--position', '1'));
    const before = tree(h.root);
    const json = await list(h);
    assert.deepEqual(json.map((x) => x.slug), ['gamma-three', 'alpha-one', 'beta-two']);
    for (const x of json) assert.deepEqual(x, read(h, x.slug));
    const text = await call(h, ['horizons'], { role: 'build-session:goal', headless: true });
    assert.equal(text.code, 0);
    assert.equal(text.stdout, 'gamma-three · open · 1 · Title of gamma-three\nalpha-one · open · 2 · Title of alpha-one\nbeta-two · open · 3 · Title of beta-two\n');
    assert.deepEqual(tree(h.root), before);
  });

  it('(c) show gives the record, the five texts and now_true, as JSON and as text, and writes nothing', async () => {
    const h = home(); ok(await set(h, 'alpha-one', { at: T1 }));
    const before = tree(h.root);
    const json = JSON.parse(ok(await call(h, ['horizon', 'show', 'alpha-one', '--json'], { role: 'work', headless: true })).stdout);
    assert.deepEqual(json, { ...read(h, 'alpha-one'), playback: Object.fromEntries(KEYS.map((k, i) => [k, texts('x')[i]])), now_true: null });
    const text = ok(await call(h, ['horizon', 'show', 'alpha-one'])).stdout;
    assert.ok(text.includes('Title of alpha-one'));
    for (const t of texts('x')) assert.ok(text.includes(t), t);
    refused(await call(h, ['horizon', 'show', 'nope']), 'show nope');
    assert.deepEqual(tree(h.root), before);
  });

  it('(d) move puts the horizon at the place and renumbers the others', async () => {
    const h = home(); await three(h);
    assert.equal(ok(await call(h, ['horizon', 'move', 'beta-two', '--position', '1'])).stdout, 'beta-two · open · 1\n');
    assert.deepEqual((await list(h)).map((x) => [x.slug, x.position]), [['beta-two', 1], ['alpha-one', 2], ['gamma-three', 3]]);
    ok(await call(h, ['horizon', 'move', 'beta-two', '--position', '3']));
    assert.deepEqual((await list(h)).map((x) => [x.slug, x.position]), [['alpha-one', 1], ['gamma-three', 2], ['beta-two', 3]]);
  });

  it('(e) reached records who and when, keeps what is now true, and the lists split by state', async () => {
    const h = home(); await three(h); ok(await call(h, ['horizon', 'move', 'beta-two', '--position', '1']));
    const statement = 'The user can now do the thing.\nAnd another.\n';
    const r = ok(await call(h, ['horizon', 'reached', 'gamma-three', '--file', '-'], { at: T2, stdin: statement }));
    assert.equal(r.stdout, 'gamma-three · reached\n');
    assert.deepEqual(read(h, 'gamma-three'), { ...read(h, 'gamma-three'), state: 'reached', position: null, reached_at: T2, reached_by: 'martin' });
    assert.equal(readFileSync(join(h.dir, 'gamma-three', 'reached.md'), 'utf8'), statement);
    assert.equal(JSON.parse((await call(h, ['horizon', 'show', 'gamma-three', '--json'])).stdout).now_true, statement);
    assert.deepEqual((await list(h)).filter((x) => x.state === 'open').map((x) => [x.slug, x.position]), [['beta-two', 1], ['alpha-one', 2]]);
    assert.deepEqual((await list(h, '--state', 'open')).map((x) => x.slug), ['beta-two', 'alpha-one']);
    assert.deepEqual((await list(h, '--state', 'reached')).map((x) => x.slug), ['gamma-three']);
    refused(await call(h, ['horizons', '--state', 'nonsense']), 'nonsense state');
  });

  it('(f) reopen clears the reached fields, keeps one line of reason, and --position places it', async () => {
    const h = home(); await three(h);
    ok(await call(h, ['horizon', 'reached', 'gamma-three', '--file', '-'], { at: T2, stdin: 'Done.\n' }));
    const r = ok(await call(h, ['horizon', 'reopen', 'gamma-three', '--reason', 'it was not\n  really  done'], { at: T3 }));
    assert.equal(r.stdout, 'gamma-three · open · 3\n');
    const x = read(h, 'gamma-three');
    assert.deepEqual([x.state, x.position, x.reached_at, x.reached_by, x.reopened_at, x.reopened_by, x.reopen_reason], ['open', 3, null, null, T3, 'martin', 'it was not really done']);
    assert.equal(JSON.parse((await call(h, ['horizon', 'show', 'gamma-three', '--json'])).stdout).now_true, null);
    const g = home(); await three(g);
    ok(await call(g, ['horizon', 'reached', 'gamma-three', '--file', '-'], { stdin: 'Done.\n' }));
    assert.equal(ok(await call(g, ['horizon', 'reopen', 'gamma-three', '--reason', 'no', '--position', '1'])).stdout, 'gamma-three · open · 1\n');
    assert.deepEqual((await list(g)).map((y) => [y.slug, y.position]), [['gamma-three', 1], ['alpha-one', 2], ['beta-two', 3]]);
  });

  it('(g) drop keeps the files, closes the gap, and the lists run open, reached, dropped; a dropped slug is not reused', async () => {
    const h = home(); await three(h);
    ok(await call(h, ['horizon', 'reached', 'gamma-three', '--file', '-'], { at: T2, stdin: 'Done.\n' }));
    const r = ok(await call(h, ['horizon', 'drop', 'alpha-one', '--reason', 'Superseded'], { at: T4 }));
    assert.equal(r.stdout, 'alpha-one · dropped\n');
    const x = read(h, 'alpha-one');
    assert.deepEqual([x.state, x.position, x.dropped_at, x.dropped_by, x.drop_reason], ['dropped', null, T4, 'martin', 'Superseded']);
    assert.ok(Object.keys(tree(join(h.dir, 'alpha-one'))).length === 2);
    assert.deepEqual((await list(h, '--state', 'open')).map((y) => [y.slug, y.position]), [['beta-two', 1]]);
    assert.equal((await call(h, ['horizons'])).stdout, 'beta-two · open · 1 · Title of beta-two\ngamma-three · reached · - · Title of gamma-three\nalpha-one · dropped · - · Title of alpha-one\n');
    const before = tree(h.root);
    refused(await set(h, 'alpha-one'), 'set on a dropped slug'); assert.deepEqual(tree(h.root), before);
  });

  it('(h) every transition and position that is not allowed exits 2 and writes nothing', async () => {
    const h = home(); await three(h); ok(await set(h, 'delta-four'));
    ok(await call(h, ['horizon', 'reached', 'gamma-three', '--file', '-'], { stdin: 'Done.\n' }));
    ok(await call(h, ['horizon', 'drop', 'delta-four', '--reason', 'no']));
    const open = 'alpha-one', reached = 'gamma-three', dropped = 'delta-four';
    const cases = [
      ['reached', reached], ['reached', dropped], ['reopen', open], ['reopen', dropped], ['drop', reached], ['drop', dropped], ['move', reached], ['move', dropped],
      ['move', 'nope'], ['reached', 'nope'], ['reopen', 'nope'], ['drop', 'nope'],
    ].map(([verb, slug]) => ['horizon', verb, slug, ...(verb === 'move' ? ['--position', '1'] : verb === 'reached' ? ['--file', '-'] : ['--reason', 'because'])]);
    for (const position of ['0', '1.5', 'x', '4']) { cases.push(['horizon', 'set', 'new-one', '--title', 'T', '--file', '-', '--position', position]); cases.push(['horizon', 'reopen', reached, '--reason', 'r', '--position', position]); }
    cases.push(['horizon', 'move', open, '--position', '3']);
    for (const argv of cases) {
      const before = tree(h.root);
      refused(await call(h, argv, { stdin: 'text\n' }), argv.join(' '));
      assert.deepEqual(tree(h.root), before, argv.join(' '));
    }
    // the allowed edges of the same ranges: n+1 for set and reopen, n for move
    ok(await call(h, ['horizon', 'reopen', reached, '--reason', 'r', '--position', '3']));
    ok(await call(h, ['horizon', 'move', reached, '--position', '3']));
  });

  it('(i) two open records at one position read by set time, then slug, and the next move numbers them 1..n once each', async () => {
    const h = home();
    plant(h, 'zeta', { position: 1, set_at: T1 }); plant(h, 'beta', { position: 1, set_at: T2 }); plant(h, 'alpha', { position: 1, set_at: T2 });
    assert.deepEqual((await list(h)).map((x) => x.slug), ['zeta', 'alpha', 'beta']);
    ok(await call(h, ['horizon', 'move', 'beta', '--position', '1']));
    assert.deepEqual((await list(h)).map((x) => [x.slug, x.position]), [['beta', 1], ['zeta', 2], ['alpha', 3]]);
  });

  it('(j) usage names each of the seven forms', () => {
    const text = usage();
    for (const row of [
      'mc martin horizon set <slug> --title <text> --file <path|-> [--position <n>]', 'mc martin horizon show <slug> [--json]', 'mc martin horizon move <slug> --position <n>',
      'mc martin horizon reached <slug> --file <path|->', 'mc martin horizon reopen <slug> --reason <text> [--position <n>]', 'mc martin horizon drop <slug> --reason <text>',
      'mc martin horizons [--state open|reached|dropped] [--json]',
    ]) assert.ok(text.includes(row), row);
  });

  it('an interrupted set leaves no horizon: the next set replaces the leftover playback', async () => {
    const h = home(); mkdirSync(join(h.dir, 'alpha-one'), { recursive: true }); writeFileSync(join(h.dir, 'alpha-one', 'playback.md'), 'leftover');
    assert.deepEqual(await list(h), []);
    ok(await set(h, 'alpha-one'));
    assert.equal(readFileSync(join(h.dir, 'alpha-one', 'playback.md'), 'utf8'), playback());
  });
});

const ROLES = ['manager', 'decision', 'learning', 'desk-prepare', 'plan', 'build-session:goal', 'review-session:goal', 'mend-session', 'intake', 'work', 'some-new-role'];
/** Every caller a write refuses: each role with and without MC_HEADLESS, a tool session, the desk unattended, and a role-less caller unattended. */
const REFUSED = [
  ...ROLES.flatMap((role) => [{ role, label: role }, { role, headless: true, label: `${role} headless` }]),
  { role: null, extra: { MC_TOOL: 'codex' }, label: 'tool session' }, { role: 'martin', headless: true, label: 'martin headless' }, { role: null, headless: true, label: 'role-less headless' },
];
/** A store with one open and one reached horizon. */
async function held() { const h = home(); ok(await set(h, 'open-one')); ok(await set(h, 'done-one')); ok(await call(h, ['horizon', 'reached', 'done-one', '--file', '-'], { stdin: 'Done.\n' })); return h; }

describe('who may write a horizon (criterion 2)', () => {
  const writes = {
    set: (h) => ['horizon', 'set', 'new-one', '--title', 'T', '--file', '-'],
    move: () => ['horizon', 'move', 'open-one', '--position', '1'],
    reopen: () => ['horizon', 'reopen', 'done-one', '--reason', 'r'],
    drop: () => ['horizon', 'drop', 'open-one', '--reason', 'r'],
  };
  for (const [verb, argvOf, letter] of [['set', writes.set, 'a'], ['move', writes.move, 'b'], ['reopen', writes.reopen, 'b'], ['drop', writes.drop, 'b']]) {
    it(`(${letter}) ${verb} is refused to every other role and caller, naming mc martin, and accepted for the desk and a person`, async () => {
      const h = await held();
      for (const caller of REFUSED) {
        const before = tree(h.root);
        const r = await call(h, argvOf(h), caller);
        refused(r, `${verb} ${caller.label}`); assert.match(r.stderr, /mc martin/u, caller.label);
        assert.deepEqual(tree(h.root), before, `${verb} ${caller.label}: nothing written`);
      }
      ok(await call(await held(), argvOf(), { role: 'martin' }));
      ok(await call(await held(), argvOf(), { role: null }));
    });
  }

  it('(c) reached is open to the desk, a person and the unattended manager only', async () => {
    for (const [caller, by] of [[{ role: 'martin' }, 'martin'], [{ role: null }, 'person'], [{ role: 'manager', headless: true }, 'manager']]) {
      const h = await held(); const r = await call(h, ['horizon', 'reached', 'open-one', '--file', '-'], { ...caller, stdin: 'Done.\n' });
      ok(r); assert.equal(read(h, 'open-one').reached_by, by);
    }
    const h = await held();
    for (const caller of [{ role: 'manager', label: 'interactive manager' }, ...REFUSED.filter((x) => x.role !== 'manager' || !x.headless)]) {
      const before = tree(h.root);
      const r = await call(h, ['horizon', 'reached', 'open-one', '--file', '-'], { ...caller, stdin: 'Done.\n' });
      refused(r, caller.label ?? caller.role); assert.deepEqual(tree(h.root), before, caller.label);
      if (caller.role === 'manager' && !caller.headless) assert.match(r.stderr, /mc martin/u);
    }
  });

  it('(d) the role is judged before the arguments', async () => {
    const h = await held(); const before = tree(h.root);
    const r = await call(h, ['horizon', 'set', 'new-one', '--title', 'T'], { role: 'decision' });
    refused(r); assert.match(r.stderr, /mc martin/u); assert.doesNotMatch(r.stderr, /--file/u);
    assert.deepEqual(tree(h.root), before);
  });

  it('(e) any caller reads', async () => {
    const h = await held();
    for (const caller of REFUSED) {
      for (const argv of [['horizons'], ['horizons', '--json'], ['horizon', 'show', 'open-one']]) {
        const r = await call(h, argv, caller); assert.equal(r.code, 0, `${caller.label} ${argv.join(' ')}: ${r.stderr}`); assert.ok(r.stdout.includes('open-one'));
      }
    }
  });
});

describe('no horizon is stored without what it needs (criterion 3)', () => {
  const bad = (headings) => headings.map((h) => `## ${h}\n\ntext\n`).join('\n');
  it('refuses a playback that lacks, reorders, adds or empties a part, naming what is wrong', async () => {
    const h = await held();
    const names = HEADINGS.map((x) => `## ${x}`).join(', ');
    const empty = `${HEADINGS.map((x, i) => `## ${x}\n\n${i === 2 ? '   \n' : 'text'}\n`).join('\n')}`;
    const cases = [
      [bad(HEADINGS.slice(1)), names], [bad([HEADINGS[1], HEADINGS[0], ...HEADINGS.slice(2)]), names], [`${bad(HEADINGS)}\n## A sixth\n\ntext\n`, names], [empty, 'What is built first'],
    ];
    for (const [stdin, named] of cases) {
      const before = tree(h.root);
      const r = await set(h, 'new-one', { stdin }); refused(r, named); assert.ok(r.stderr.includes(named), r.stderr);
      assert.deepEqual(tree(h.root), before);
    }
  });

  it('refuses a missing or unreadable file, a missing or bad title and a bad slug', async () => {
    const h = await held(); const before = tree(h.root);
    const base = ['horizon', 'set', 'new-one', '--title', 'T', '--file', '-'];
    const cases = [
      ['horizon', 'set', 'new-one', '--title', 'T', '--file', join(h.root, 'absent.md')], ['horizon', 'set', 'new-one', '--title', 'T'], ['horizon', 'set', 'new-one', '--file', '-'],
      ['horizon', 'set', '--title', 'T', '--file', '-'], ['horizon', 'set', 'new-one', '--title', '', '--file', '-'], ['horizon', 'set', 'new-one', '--title', '   ', '--file', '-'],
      ['horizon', 'set', 'new-one', '--title', 'one\ntwo', '--file', '-'],
      ...['Alpha', '-a', 'a_b', 'a/b', 'a'.repeat(65)].map((slug) => ['horizon', 'set', slug, ...base.slice(3)]),
    ];
    for (const argv of cases) { refused(await call(h, argv), argv.join(' ')); assert.deepEqual(tree(h.root), before, argv.join(' ')); }
    ok(await call(h, ['horizon', 'set', 'a'.repeat(64), ...base.slice(3)]));
  });

  it('refuses reached without text, reopen and drop without a reason, move without a position, and an unknown verb', async () => {
    const h = await held(); const before = tree(h.root);
    for (const stdin of ['', '  \n\t\n']) refused(await call(h, ['horizon', 'reached', 'open-one', '--file', '-'], { stdin }), 'empty reached');
    const cases = [
      ['horizon', 'reached', 'open-one', '--file', join(h.root, 'absent.md')], ['horizon', 'reached', 'open-one'],
      ['horizon', 'reopen', 'done-one'], ['horizon', 'reopen', 'done-one', '--reason', '   '], ['horizon', 'drop', 'open-one'], ['horizon', 'drop', 'open-one', '--reason', '  '],
      ['horizon', 'move', 'open-one'], ['horizon'], ['horizon', 'bogus', 'open-one'],
    ];
    for (const argv of cases) { const r = await call(h, argv); refused(r, argv.join(' ')); assert.deepEqual(tree(h.root), before, argv.join(' ')); }
    const usageLine = await call(h, ['horizon', 'bogus', 'open-one']);
    assert.match(usageLine.stderr, /horizon set .*show .*move .*reached .*reopen .*drop/u);
  });
});

describe('every write is one read-modify-write under the strict lock (criterion 4)', () => {
  const verbs = {
    set: (h) => ({ argv: ['horizon', 'set', 'new-one', '--title', 'T', '--file', '-'] }),
    move: () => ({ argv: ['horizon', 'move', 'open-one', '--position', '1'] }),
    reached: () => ({ argv: ['horizon', 'reached', 'open-one', '--file', '-'] }),
    reopen: () => ({ argv: ['horizon', 'reopen', 'done-one', '--reason', 'r'] }),
    drop: () => ({ argv: ['horizon', 'drop', 'open-one', '--reason', 'r'] }),
  };
  it('(a) takes the lock exactly once, with the work root, a function and the strict desk-horizon options', async () => {
    for (const [verb, make] of Object.entries(verbs)) {
      const h = await held(); const calls = [];
      const lock = (root, fn, opts) => { calls.push([root, typeof fn, opts]); return fn(); };
      ok(await call(h, make(h).argv, { lock, stdin: verb === 'set' ? playback() : 'Done.\n' }));
      assert.deepEqual(calls, [[h.env.MC_WORK_ROOT, 'function', { strict: true, name: 'desk-horizon' }]], verb);
    }
  });

  it('(b) decides on the records read inside the hold: a competitor that lands first keeps its place', async () => {
    const h = home(); ok(await set(h, 'first-one')); let competitor;
    const lock = (root, fn) => { competitor = set(h, 'second-one', {}); return fn(); }; // the call runs to its end before it returns a promise
    const r = ok(await set(h, 'third-one', { lock }));
    assert.equal(r.stdout, 'third-one · open · 3\n'); ok(await competitor);
    assert.deepEqual((await list(h)).map((x) => [x.slug, x.position]).sort(), [['first-one', 1], ['second-one', 2], ['third-one', 3]]);
  });

  it('(c) judges the transition on the state found in the hold: a drop after a competitor marked it reached is refused', async () => {
    const h = home(); ok(await set(h, 'only-one')); let competitor; let left;
    const lock = (root, fn) => {
      competitor = call(h, ['horizon', 'reached', 'only-one', '--file', '-'], { role: 'manager', headless: true, stdin: 'Done.\n' }); // runs to its write before it returns a promise
      left = tree(join(h.dir, 'only-one')); // what the competitor wrote, before the drop decides
      return fn();
    };
    const r = await call(h, ['horizon', 'drop', 'only-one', '--reason', 'r'], { lock });
    refused(r); assert.match(r.stderr, /reached/u); ok(await competitor);
    assert.deepEqual(Object.keys(left).map((path) => path.slice(h.dir.length + 1)), ['only-one/horizon.json', 'only-one/playback.md', 'only-one/reached.md']);
    assert.equal(JSON.parse(left[join(h.dir, 'only-one', 'horizon.json')]).reached_by, 'manager');
    assert.deepEqual(tree(join(h.dir, 'only-one')), left, 'the horizon\'s files are byte for byte what the competitor wrote');
  });

  it('(d) a lock that cannot be had ends each write with exit 1, its own message, and nothing written', async () => {
    const lock = () => { throw new Error('the runner lock is held by pid 4242 — try again'); };
    for (const [verb, make] of Object.entries(verbs)) {
      const h = await held(); const before = tree(h.root);
      const r = await call(h, make(h).argv, { lock, stdin: verb === 'set' ? playback() : 'Done.\n' });
      assert.equal(r.code, 1, verb); assert.equal(r.stderr, 'mc: the runner lock is held by pid 4242 — try again\n'); assert.equal(r.stdout, '');
      assert.deepEqual(tree(h.root), before, verb);
    }
  });

  it('(e) reads take no lock', async () => {
    const h = await held(); const lock = () => { throw new Error('the runner lock is held by pid 4242 — try again'); };
    for (const argv of [['horizons'], ['horizons', '--json'], ['horizon', 'show', 'open-one']]) { const r = await call(h, argv, { lock }); assert.equal(r.code, 0, argv.join(' ')); assert.ok(r.stdout.includes('open-one')); }
  });
});
