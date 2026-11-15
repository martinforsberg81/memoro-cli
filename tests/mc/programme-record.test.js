/**
 * A programme's record (PROGRAMME.json): the validator, `mc programs create`,
 * `record` and `show`, the caller guard, the list and the page naming a
 * recorded programme before its first goal, and a programme without a record
 * left exactly as it was. Every case runs under a temporary programmes home.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as goal } from '../../src/mc/commands/goal.js';
import { listingText, programmesListing, recordWriter, run as programs } from '../../src/mc/commands/programs.js';
import { readProgrammes } from '../../src/mc/page-collect.js';
import { newRecord, readRecord, recordedProgrammes, recordPage, recordPageTemplate, RECORD_FILE, validateRecord } from '../../src/mc/programme-record.js';

const NOW = new Date('2026-11-14T10:20:30.456Z');

/** A fresh work root with `programs/` in it; `env` points the verbs at it and names no role. */
function area(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-record-'));
  mkdirSync(join(root, 'programs'));
  return { root, home: join(root, 'programs'), env: { MC_WORK_ROOT: root, MC_HOME: join(root, 'mc-home'), ...extra }, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** One call of `mc programs …`: its exit code and both streams. */
async function call(argv, env, deps = {}) {
  let out = '';
  let err = '';
  const code = await programs(argv, { env, now: NOW, stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { err += text; } }, ...deps });
  return { code, out, err };
}

const GOOD = { schema: 'mc-programme', version: 1, horizon: 'mc-autonomy', end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' };
const recordOf = (home, name) => JSON.parse(readFileSync(join(home, name, RECORD_FILE), 'utf8'));

describe('the record validator', () => {
  it('takes a whole record, with a null horizon too', () => {
    assert.deepEqual(validateRecord(GOOD), []);
    assert.deepEqual(validateRecord({ ...GOOD, horizon: null, state: 'done', created_by: 'manager' }), []);
  });

  it('names each wrong key', () => {
    const problems = validateRecord({ ...GOOD, schema: 'x', version: 2, horizon: 'Bad Slug', end: '  ', state: 'closed', created: '2026-11-14', created_by: 'runner', extra: 1 });
    for (const key of ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by', 'extra']) assert.ok(problems.some((text) => text.startsWith(`${key}:`)), key);
    assert.match(problems.find((text) => text.startsWith('extra')), /unknown key/u);
    assert.ok(validateRecord([]).length && validateRecord(null).length);
  });

  it('writes the keys in their order, to the second', () => {
    const record = newRecord({ horizon: null, end: 'e', createdBy: 'martin', now: NOW });
    assert.deepEqual(Object.keys(record), ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by']);
    assert.equal(record.created, '2026-11-14T10:20:30Z');
  });

  it('reads none, valid and invalid apart, and never throws on text that is not JSON', () => {
    const a = area();
    try {
      assert.equal(readRecord(join(a.home, 'x')).status, 'none');
      mkdirSync(join(a.home, 'x'));
      writeFileSync(join(a.home, 'x', RECORD_FILE), 'not json');
      assert.equal(readRecord(join(a.home, 'x')).status, 'invalid');
      writeFileSync(join(a.home, 'x', RECORD_FILE), JSON.stringify(GOOD));
      assert.equal(readRecord(join(a.home, 'x')).status, 'valid');
    } finally { a.done(); }
  });
});

describe('mc programs create', () => {
  it('makes the directory, the record, the page and the empty folders, and says what next', async () => {
    const a = area();
    try {
      const { code, out } = await call(['create', 'alpha', '--end', 'Alpha is done when it holds.', '--horizon', 'mc-autonomy'], a.env);
      assert.equal(code, 0, out);
      assert.deepEqual(readdirSync(join(a.home, 'alpha')).sort(), ['PROGRAMME.json', 'README.md', 'evidence', 'goals', 'proposals']);
      assert.ok(existsSync(join(a.home, 'alpha', 'proposals', 'archive')));
      assert.deepEqual(recordOf(a.home, 'alpha'), { ...GOOD, end: 'Alpha is done when it holds.', created: '2026-11-14T10:20:30Z', phases: { order: 'stated' } });
      const page = readFileSync(join(a.home, 'alpha', 'README.md'), 'utf8');
      assert.deepEqual([...page.matchAll(/^#+ .+$/gmu)].map(([line]) => line).slice(1), ['## What it is for', '## End', '## Decisions', '## Phases', '## Where things are']);
      assert.match(page, /^# alpha — /u);
      assert.match(page, /## End\n\nAlpha is done when it holds\./u);
      assert.match(page, /Serves the horizon `mc-autonomy`/u);
      assert.match(out, /mc goal new alpha\/<goal>/u);
    } finally { a.done(); }
  });

  it('writes a null horizon without --horizon', async () => {
    const a = area();
    try {
      assert.equal((await call(['create', 'alpha', '--end', 'e'], a.env)).code, 0);
      assert.equal(recordOf(a.home, 'alpha').horizon, null);
      assert.doesNotMatch(readFileSync(join(a.home, 'alpha', 'README.md'), 'utf8'), /Serves the horizon/u);
    } finally { a.done(); }
  });

  it('refuses a name that exists — a bare directory or one with a record — and leaves it as it is', async () => {
    const a = area();
    try {
      mkdirSync(join(a.home, 'bare'));
      const { code, err } = await call(['create', 'bare', '--end', 'e'], a.env);
      assert.equal(code, 1);
      assert.match(err, /programme bare exists/u);
      assert.deepEqual(readdirSync(join(a.home, 'bare')), []);
      await call(['create', 'alpha', '--end', 'first'], a.env);
      const before = readFileSync(join(a.home, 'alpha', RECORD_FILE), 'utf8');
      assert.equal((await call(['create', 'alpha', '--end', 'second'], a.env)).code, 1);
      assert.equal(readFileSync(join(a.home, 'alpha', RECORD_FILE), 'utf8'), before);
    } finally { a.done(); }
  });

  it('refuses a name the list knows that has no directory here — a programme on main — and makes nothing', async () => {
    const a = area();
    try {
      const read = () => ({ section: { programmes: [{ programme: 'onmain', goals: [], dormant: true, statuses: {} }] } });
      const { code, err } = await call(['create', 'onmain', '--end', 'e'], a.env, { read });
      assert.equal(code, 1);
      assert.match(err, /programme onmain exists.*mc programs record.*mc programs show/u);
      assert.deepEqual(readdirSync(a.home), []);
    } finally { a.done(); }
  });

  it('refuses a bad request with exit 2 before it writes anything', async () => {
    const a = area();
    try {
      for (const argv of [['create'], ['create', 'Bad_Name', '--end', 'e'], ['create', 'a'], ['create', 'a', '--end', '  '], ['create', 'a', '--end', 'e', '--horizon', 'No Slug'], ['create', 'a', 'b', '--end', 'e'], ['create', 'a', '--end', 'e', '--bogus']]) {
        assert.equal((await call(argv, a.env)).code, 2, argv.join(' '));
      }
      assert.deepEqual(readdirSync(a.home), []);
    } finally { a.done(); }
  });

  it('leaves nothing behind when the page template cannot be read', async () => {
    const a = area();
    try {
      const { code, err } = await call(['create', 'alpha', '--end', 'e'], a.env, { canon: join(a.root, 'no-canon') });
      assert.equal(code, 1);
      assert.match(err, /template/u);
      assert.deepEqual(readdirSync(a.home), []);
    } finally { a.done(); }
  });

  it('makes a programme `mc goal new` can put its first goal in', async () => {
    const a = area();
    try {
      await call(['create', 'alpha', '--end', 'e'], a.env);
      const out = [];
      const err = [];
      const code = await goal(['new', 'alpha/first', '--repo', 'memoro-cli', '--class', 'fast', '--title', 'First'], {
        home: a.home, env: a.env, now: () => NOW, known: () => ['/home/m/memoro-cli.git'], git: (cwd, args) => (args[0] === 'show-ref' ? { ok: false, stdout: '', stderr: '' } : { ok: true, stdout: '', stderr: '' }),
        stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) },
      });
      assert.equal(code, 0, err.join(''));
      assert.ok(existsSync(join(a.home, 'alpha', 'goals', 'first', 'GOAL.json')));
    } finally { a.done(); }
  });
});

describe('mc programs record and show', () => {
  it('gives a directory without a record its record, and never replaces one', async () => {
    const a = area();
    try {
      mkdirSync(join(a.home, 'old'));
      writeFileSync(join(a.home, 'old', 'README.md'), 'page\n');
      assert.equal((await call(['record', 'old', '--end', 'Old is done.', '--horizon', 'mc-autonomy'], a.env)).code, 0);
      assert.equal(recordOf(a.home, 'old').created_by, 'person');
      assert.equal(readFileSync(join(a.home, 'old', 'README.md'), 'utf8'), 'page\n', 'the page is not touched');
      const again = await call(['record', 'old', '--end', 'Other.'], a.env);
      assert.equal(again.code, 1);
      assert.equal(recordOf(a.home, 'old').end, 'Old is done.');
      assert.equal((await call(['record', 'nowhere', '--end', 'e'], a.env)).code, 1);
      assert.equal(existsSync(join(a.home, 'nowhere')), false);
    } finally { a.done(); }
  });

  it('shows a record as text and JSON, says when there is none, and reports a broken one with its problems', async () => {
    const a = area();
    try {
      await call(['create', 'alpha', '--end', 'Alpha done.', '--horizon', 'mc-autonomy'], a.env);
      const text = await call(['show', 'alpha'], a.env);
      assert.equal(text.code, 0);
      assert.match(text.out, /horizon {2}mc-autonomy/u);
      assert.match(text.out, /end {6}Alpha done\./u);
      const json = JSON.parse((await call(['show', 'alpha', '--json'], a.env)).out);
      assert.deepEqual(json, { name: 'alpha', record: { horizon: 'mc-autonomy', end: 'Alpha done.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person', phases: { order: 'stated' } } });
      mkdirSync(join(a.home, 'plain'));
      const none = await call(['show', 'plain'], a.env);
      assert.equal(none.code, 0);
      assert.match(none.out, /plain has no record/u);
      assert.equal(JSON.parse((await call(['show', 'plain', '--json'], a.env)).out).record, null);
      writeFileSync(join(a.home, 'alpha', RECORD_FILE), JSON.stringify({ ...GOOD, extra: 1, state: 'x' }));
      const broken = await call(['show', 'alpha'], a.env);
      assert.equal(broken.code, 1);
      assert.match(broken.err, /extra: unknown key/u);
      assert.match(broken.err, /state: one of open, done/u);
      assert.equal((await call(['show', 'missing'], a.env)).code, 1);
      assert.equal((await call(['show', 'Bad_Name'], a.env)).code, 2, 'a name that is not a programme name is a malformed call');
    } finally { a.done(); }
  });
});

describe('who may write a record', () => {
  it('lets a person, the interactive Martin role and the manager through, each recorded as itself', async () => {
    const a = area();
    try {
      for (const [name, extra, by] of [['one', {}, 'person'], ['two', { MC_ROLE: 'martin' }, 'martin'], ['three', { MC_ROLE: 'manager' }, 'manager'], ['four', { MC_ROLE: 'brief' }, 'manager']]) {
        assert.equal((await call(['create', name, '--end', 'e'], { ...a.env, ...extra })).code, 0, name);
        assert.equal(recordOf(a.home, name).created_by, by, name);
      }
    } finally { a.done(); }
  });

  it('refuses every other role, a build session and an unattended Martin with exit 2, naming the role, and writes nothing', async () => {
    const a = area();
    try {
      for (const extra of [{ MC_ROLE: 'plan' }, { MC_ROLE: 'plan-session' }, { MC_ROLE: 'review' }, { MC_ROLE: 'mend' }, { MC_ROLE: 'intake' }, { MC_ROLE: 'someone-new' }, { MC_GOAL: 'p/g' }, { MC_ROLE: 'martin', MC_HEADLESS: '1' }]) {
        const { code, err } = await call(['create', 'x', '--end', 'e'], { ...a.env, ...extra });
        assert.equal(code, 2, JSON.stringify(extra));
        assert.match(err, /cannot create a programme|interactive-only/u, JSON.stringify(extra));
        const record = await call(['record', 'x', '--end', 'e'], { ...a.env, ...extra });
        assert.equal(record.code, 2, JSON.stringify(extra));
      }
      assert.deepEqual(readdirSync(a.home), []);
      assert.match((await call(['create', 'x', '--end', 'e'], { ...a.env, MC_ROLE: 'review' })).err, /review/u);
    } finally { a.done(); }
  });

  it('reads the role from the environment alone: the tool named there changes nothing', () => {
    assert.deepEqual(recordWriter({ MC_TOOL: 'codex' }), { by: 'person' });
    assert.ok(recordWriter({ MC_TOOL: 'claude', MC_GOAL: 'p/g' }).refusal);
    assert.equal(recordWriter({ MC_ROLE: 'martin', MC_TOOL: 'codex' }).by, 'martin');
  });

  it('lets every caller read: show and list name no role', async () => {
    const a = area();
    try {
      await call(['create', 'alpha', '--end', 'e'], a.env);
      assert.equal((await call(['show', 'alpha'], { ...a.env, MC_ROLE: 'review' })).code, 0);
      assert.equal((await call(['list'], { ...a.env, MC_ROLE: 'review' })).code, 0);
    } finally { a.done(); }
  });
});

describe('the list and the page', () => {
  it('names a recorded programme before its first goal, with a record key and a record cell', async () => {
    const a = area();
    try {
      await call(['create', 'alpha', '--end', 'e', '--horizon', 'mc-autonomy'], a.env);
      mkdirSync(join(a.home, 'broken'));
      writeFileSync(join(a.home, 'broken', RECORD_FILE), '{');
      const json = JSON.parse((await call(['list', '--json'], a.env)).out);
      const names = json.programmes.map((item) => item.name);
      assert.deepEqual(names, ['alpha', 'broken']);
      assert.deepEqual(json.programmes[0].record, { horizon: 'mc-autonomy', end: 'e', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person', phases: { order: 'stated' } });
      assert.ok(json.programmes[1].record.problems.length);
      assert.equal(json.programmes[0].dormant, true);
      const text = (await call(['list'], a.env)).out;
      assert.match(text, /alpha .*no goal.*record open · horizon mc-autonomy$/mu);
      assert.match(text, /broken .*record invalid$/mu);
    } finally { a.done(); }
  });

  it('puts a recorded programme with no goal in the page data', () => {
    const a = area();
    try {
      mkdirSync(join(a.home, 'alpha'));
      writeFileSync(join(a.home, 'alpha', RECORD_FILE), JSON.stringify(GOOD));
      mkdirSync(join(a.home, 'plain'));
      const { section } = readProgrammes({ env: a.env });
      assert.deepEqual(section.programmes.map((group) => group.programme), ['alpha']);
      assert.deepEqual(recordedProgrammes(a.home), ['alpha']);
    } finally { a.done(); }
  });

  it('leaves a programme without a record as it was: seven cells and record null, beside one with a record', () => {
    const group = (programme) => ({ programme, goals: [], dormant: true, statuses: {}, priority: 0 });
    const view = { horizon: null, end: 'e', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' };
    const listing = programmesListing({ section: { programmes: [group('with'), group('without')] } }, { record: (name) => (name === 'with' ? view : null) });
    const [withRecord, without] = listing.programmes;
    assert.deepEqual(withRecord.record, view);
    assert.equal(without.record, null);
    const [, first, second] = listingText(listing).split('\n');
    assert.equal(first.trim().split(/ {2,}/u).length, 8, 'the programme with a record has one cell more');
    assert.match(first, /record open · no horizon$/u);
    assert.equal(second.trim().split(/ {2,}/u).length, 7);
    assert.doesNotMatch(second, /record/u);
    assert.deepEqual(Object.keys(without).slice(0, -1), ['name', 'priority', 'state', 'dormant', 'repos', 'goals', 'proposals', 'statuses', 'plan_sessions']);
  });
});

describe('the record page', () => {
  it('is the first fenced block of the packaged template, with the name, end and horizon filled in', () => {
    const template = recordPageTemplate();
    assert.match(template, /^# <programme>/u);
    const page = recordPage(template, { name: 'alpha', end: '# not a heading', horizon: null });
    assert.match(page, /^# alpha — /u);
    assert.match(page, /\\# not a heading/u, 'a sentence that starts with # is not a heading');
    assert.equal(recordPageTemplate({ canon: '/no/such/canon' }), null);
  });
});
