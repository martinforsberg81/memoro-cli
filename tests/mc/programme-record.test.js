/**
 * A programme's record (PROGRAMME.json): the validator, `mc programs create`,
 * `record`, `state` and `show`, the caller guard, the list and the page naming a
 * recorded programme before its first goal, and a programme without a record
 * left exactly as it was. Every case runs under a temporary programmes home.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { run as goal } from '../../src/mc/commands/goal.js';
import { listingText, programmesListing, recordWriter, run as programs } from '../../src/mc/commands/programs.js';
import { readProgrammes } from '../../src/mc/page-collect.js';
import { changePhases, newRecord, normalized, readRecord, recordedProgrammes, recordPage, recordPageTemplate, RECORD_FILE, setRecordState, validateRecord, writeRecord } from '../../src/mc/programme-record.js';
import { lockPath, realLock } from '../../src/mc/runner-lock.js';
import { goalJson } from './_helpers/goal-file.js';

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
const DRAFT = { schema: 'mc-programme', version: 2, horizon: 'mc-autonomy', end: 'Done when it holds.', state: 'draft', created: '2026-11-14T10:20:30Z', created_by: 'person' };
const READY = { ...DRAFT, state: 'ready' };
const OPEN_HORIZONS = { horizons: ['h-one', 'h-two', 'h-three', 'h-four', 'h-done'].map((slug) => ({ slug, state: slug === 'h-done' ? 'closed' : 'open' })) };
const recordOf = (home, name) => JSON.parse(readFileSync(join(home, name, RECORD_FILE), 'utf8'));

describe('the record validator', () => {
  it('takes a whole record, with a null horizon too', () => {
    assert.deepEqual(validateRecord(GOOD), []);
    assert.deepEqual(validateRecord({ ...GOOD, horizon: null, state: 'done', created_by: 'manager' }), []);
    assert.deepEqual(validateRecord(DRAFT), []);
    assert.deepEqual(validateRecord(READY), []);
    assert.deepEqual(validateRecord({ ...DRAFT, state: 'done' }), []);
  });

  it('names each wrong key', () => {
    const problems = validateRecord({ ...GOOD, schema: 'x', version: 3, horizon: 'Bad Slug', end: '  ', state: 'closed', created: '2026-11-14', created_by: 'runner', extra: 1 });
    for (const key of ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by', 'extra']) assert.ok(problems.some((text) => text.startsWith(`${key}:`)), key);
    assert.match(problems.find((text) => text.startsWith('extra')), /unknown key/u);
    assert.ok(validateRecord([]).length && validateRecord(null).length);
  });

  it('writes the keys in their order, to the second, with state draft', () => {
    const record = newRecord({ horizon: null, end: 'e', createdBy: 'martin', now: NOW });
    assert.deepEqual(Object.keys(record), ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by']);
    assert.equal(record.created, '2026-11-14T10:20:30Z');
    assert.equal(record.state, 'draft');
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

  it('reads a version 2 record with signed fields as valid, normalizes them away, and maps open to ready', () => {
    const v2Signed = {
      ...DRAFT,
      state: 'open',
      signed_at: '2026-11-14T10:20:30Z',
      signed_by: 'martin',
      signed_text: 'a'.repeat(64),
      cut_text: 'b'.repeat(64),
      legacy: true,
    };
    assert.deepEqual(validateRecord(v2Signed), []);
    const norm = normalized(v2Signed);
    assert.equal(norm.state, 'ready');
    assert.equal(norm.signed_at, undefined);
    assert.equal(norm.signed_by, undefined);
    assert.equal(norm.signed_text, undefined);
    assert.equal(norm.cut_text, undefined);
    assert.equal(norm.legacy, undefined);
    assert.deepEqual(Object.keys(norm), ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by']);

    const v2DraftSigned = { ...v2Signed, state: 'draft' };
    assert.deepEqual(validateRecord(v2DraftSigned), []);
    assert.equal(normalized(v2DraftSigned).state, 'draft');
  });
});

describe('mc programs create and state', () => {
  it('makes the directory, the record, the page and the empty folders, and says what next', async () => {
    const a = area();
    try {
      const { code, out } = await call(['create', 'alpha', '--end', 'Alpha is done when it holds.', '--horizon', 'mc-autonomy'], a.env);
      assert.equal(code, 0, out);
      assert.deepEqual(readdirSync(join(a.home, 'alpha')).sort(), ['PROGRAMME.json', 'README.md', 'evidence', 'goals', 'proposals']);
      assert.ok(existsSync(join(a.home, 'alpha', 'proposals', 'archive')));
      assert.deepEqual(recordOf(a.home, 'alpha'), { ...DRAFT, end: 'Alpha is done when it holds.', created: '2026-11-14T10:20:30Z', phases: { order: 'stated' } });
      const page = readFileSync(join(a.home, 'alpha', 'README.md'), 'utf8');
      assert.deepEqual([...page.matchAll(/^#+ .+$/gmu)].map(([line]) => line).slice(1), ['## What it is for', '## End', '## Why', '## What runs today', '## Parts', '### Part 1 — <name>', '## Order', '## Decided by signing', '## Not built', '## Read before sign-off', '## Where things are', '## Decisions']);
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

  it('makes a draft that refuses goal new until interactive Martin sets state ready, and returns on state draft', async () => {
    const a = area();
    try {
      await call(['create', 'alpha', '--end', 'e'], a.env);
      assert.equal(recordOf(a.home, 'alpha').state, 'draft');

      const callGoal = async () => {
        const out = [];
        const err = [];
        const code = await goal(['new', 'alpha/first', '--repo', 'memoro-cli', '--class', 'fast', '--title', 'First'], {
          home: a.home, env: a.env, now: () => NOW, known: () => ['/home/m/memoro-cli.git'],
          git: (cwd, args) => (args[0] === 'show-ref' ? { ok: false, stdout: '', stderr: '' } : { ok: true, stdout: '', stderr: '' }),
          stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) },
        });
        return { code, out: out.join(''), err: err.join('') };
      };

      // 1. Goal creation refused while draft
      const draftGoal = await callGoal();
      assert.equal(draftGoal.code, 1);
      assert.match(draftGoal.err, /mc: alpha is draft — mc programs show alpha/u);
      assert.equal(existsSync(join(a.home, 'alpha', 'goals', 'first', 'GOAL.json')), false);

      // 2. Headless or other callers cannot set state ready
      for (const env of [{ MC_ROLE: 'martin', MC_HEADLESS: '1' }, { MC_ROLE: 'manager' }, {}]) {
        const res = await call(['state', 'alpha', 'ready'], { ...a.env, ...env });
        assert.equal(res.code, 2);
        assert.match(res.err, /only Martin at the desk sets a programme state/u);
        assert.equal(recordOf(a.home, 'alpha').state, 'draft');
      }

      // 3. Interactive Martin sets state ready
      const readyRes = await call(['state', 'alpha', 'ready'], { ...a.env, MC_ROLE: 'martin' });
      assert.equal(readyRes.code, 0);
      assert.match(readyRes.out, /mc: alpha · state ready/u);
      assert.equal(recordOf(a.home, 'alpha').state, 'ready');

      // 4. Goal creation succeeds now that state is ready
      const readyGoal = await callGoal();
      assert.equal(readyGoal.code, 0, readyGoal.err);
      assert.ok(existsSync(join(a.home, 'alpha', 'goals', 'first', 'GOAL.json')));

      // 5. Interactive Martin sets state back to draft
      const backRes = await call(['state', 'alpha', 'draft'], { ...a.env, MC_ROLE: 'martin' });
      assert.equal(backRes.code, 0);
      assert.match(backRes.out, /mc: alpha · state draft/u);
      assert.equal(recordOf(a.home, 'alpha').state, 'draft');

      // 6. Goal creation refused again
      const draftGoal2 = await callGoal();
      assert.equal(draftGoal2.code, 1);
      assert.match(draftGoal2.err, /mc: alpha is draft — mc programs show alpha/u);
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
      assert.match(text.out, /state {4}draft/u);
      const json = JSON.parse((await call(['show', 'alpha', '--json'], a.env)).out);
      assert.deepEqual(json, { name: 'alpha', record: { horizon: 'mc-autonomy', end: 'Alpha done.', state: 'draft', created: '2026-11-14T10:20:30Z', created_by: 'person', phases: { order: 'stated' } } });
      mkdirSync(join(a.home, 'plain'));
      const none = await call(['show', 'plain'], a.env);
      assert.equal(none.code, 0);
      assert.match(none.out, /plain has no record/u);
      assert.equal(JSON.parse((await call(['show', 'plain', '--json'], a.env)).out).record, null);
      writeFileSync(join(a.home, 'alpha', RECORD_FILE), JSON.stringify({ ...GOOD, extra: 1, state: 'x' }));
      const broken = await call(['show', 'alpha'], a.env);
      assert.equal(broken.code, 1);
      assert.match(broken.err, /extra: unknown key/u);
      assert.match(broken.err, /state: one of draft, ready, done/u);
      assert.equal((await call(['show', 'missing'], a.env)).code, 1);
      assert.equal((await call(['show', 'Bad_Name'], a.env)).code, 2, 'a name that is not a programme name is a malformed call');
    } finally { a.done(); }
  });
});

describe('who may write a record', () => {
  it('lets a person and the interactive Martin role through, each recorded as itself', async () => {
    const a = area();
    try {
      for (const [name, extra, by] of [['one', {}, 'person'], ['two', { MC_ROLE: 'martin' }, 'martin']]) {
        assert.equal((await call(['create', name, '--end', 'e'], { ...a.env, ...extra })).code, 0, name);
        assert.equal(recordOf(a.home, name).created_by, by, name);
      }
    } finally { a.done(); }
  });

  it('refuses the manager, unattended sessions, a build session and every other role with exit 2, naming the role, and writes nothing', async () => {
    const a = area();
    try {
      for (const extra of [{ MC_ROLE: 'manager' }, { MC_ROLE: 'brief' }, { MC_ROLE: 'plan' }, { MC_ROLE: 'plan-session' }, { MC_ROLE: 'review' }, { MC_ROLE: 'mend' }, { MC_ROLE: 'intake' }, { MC_ROLE: 'someone-new' }, { MC_GOAL: 'p/g' }, { MC_ROLE: 'martin', MC_HEADLESS: '1' }, { MC_HEADLESS: '1' }]) {
        const { code, err } = await call(['create', 'x', '--end', 'e'], { ...a.env, ...extra });
        assert.equal(code, 2, JSON.stringify(extra));
        assert.match(err, /cannot create a programme|unattended/u, JSON.stringify(extra));
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
      assert.deepEqual(json.programmes[0].record, { horizon: 'mc-autonomy', end: 'e', state: 'draft', created: '2026-11-14T10:20:30Z', created_by: 'person', phases: { order: 'stated' } });
      assert.ok(json.programmes[1].record.problems.length);
      assert.equal(json.programmes[0].dormant, true);
      const text = (await call(['list'], a.env)).out;
      assert.match(text, /alpha .*no goal.*record draft · horizon mc-autonomy$/mu);
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
    const view = { horizon: null, end: 'e', state: 'ready', created: '2026-11-14T10:20:30Z', created_by: 'person' };
    const listing = programmesListing({ section: { programmes: [group('with'), group('without')] } }, { record: (name) => (name === 'with' ? view : null) });
    const [withRecord, without] = listing.programmes;
    assert.deepEqual(withRecord.record, view);
    assert.equal(without.record, null);
    const [, first, second] = listingText(listing).split('\n');
    assert.equal(first.trim().split(/ {2,}/u).length, 8, 'the programme with a record has one cell more');
    assert.match(first, /record ready · no horizon$/u);
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

/** The declaration `.mc/areas.json` of a repository at origin/main, as `git show` gives it, for the area repairs. */
const DECLARED = JSON.stringify({ schema_version: 1, areas: ['operations', 'documentation'].map((id) => ({ id, name: id, covers: id, standards: ['docs/technical/x.md'], paths: [`${id}/`], questions: [{ when: 'w', ask: 'a' }] })) });
const AREA_DEPS = {
  known: () => ['/home/m/memoro-cli.git'],
  git: (cwd, args) => (args[0] === 'show' ? { ok: true, stdout: DECLARED, stderr: '' } : { ok: true, stdout: '', stderr: '' }),
};

describe('mc programs create for an area', () => {
  it('writes the area into the record and the page, with a null horizon, and the record reads back with state draft', async () => {
    const a = area();
    try {
      const { code, out } = await call(['create', 'ops-repair', '--end', 'The text says what runs.', '--area', 'memoro-cli/operations', '--purpose', 'The runner section is stale.'], a.env, AREA_DEPS);
      assert.equal(code, 0, out);
      const record = recordOf(a.home, 'ops-repair');
      assert.deepEqual(record, { ...DRAFT, state: 'draft', horizon: null, area: 'memoro-cli/operations', end: 'The text says what runs.', phases: { order: 'stated' } });
      assert.deepEqual(Object.keys(record).slice(0, 5), ['schema', 'version', 'horizon', 'area', 'end']);
      assert.match(readFileSync(join(a.home, 'ops-repair', 'README.md'), 'utf8'), /Repairs the text of the area `memoro-cli\/operations`, a programme without a horizon\. The runner section is stale\./u);
      assert.equal(readRecord(join(a.home, 'ops-repair')).status, 'valid');
      const repair = recordPageTemplate({ area: 'memoro-cli/operations' });
      assert.match(repair, /^# <programme>/u);
      assert.doesNotMatch(repair, /## Parts|Repositories:/u);
      assert.equal(readFileSync(join(a.home, 'ops-repair', 'README.md'), 'utf8'), recordPage(repair, { name: 'ops-repair', end: 'The text says what runs.', area: 'memoro-cli/operations', purpose: 'The runner section is stale.' }));
    } finally { a.done(); }
  });

  it('a record that names an area is valid only with a null horizon and an area of the form <repo>/<id>; one without area reads as it did', () => {
    assert.deepEqual(validateRecord({ ...GOOD, horizon: null, area: 'memoro-cli/operations' }), []);
    assert.ok(validateRecord({ ...GOOD, area: 'memoro-cli/operations' }).some((text) => text.startsWith('area:') && /horizon null/u.test(text)));
    for (const bad of ['operations', 'memoro-cli/', 'Memoro/ops', 3, null]) assert.ok(validateRecord({ ...GOOD, horizon: null, area: bad }).some((text) => text.startsWith('area:')), String(bad));
    assert.deepEqual(validateRecord(GOOD), []);
    assert.deepEqual(Object.keys(newRecord({ horizon: null, end: 'e', createdBy: 'person', now: NOW })), ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by']);
  });

  it('refuses --area for a repository mc does not know, an area it does not declare and a declaration git cannot read — exit 1, nothing made', async () => {
    const a = area();
    try {
      for (const [area_, deps, why] of [
        ['nowhere/operations', AREA_DEPS, /nowhere is not a repository mc knows/u],
        ['memoro-cli/missing', AREA_DEPS, /memoro-cli declares no area missing/u],
        ['memoro-cli/operations', { ...AREA_DEPS, git: () => ({ ok: false, stdout: '', stderr: 'fatal: not a git repository' }) }, /could not read/u],
      ]) {
        const { code, err } = await call(['create', 'ops-repair', '--end', 'e', '--area', area_], a.env, deps);
        assert.equal(code, 1, area_);
        assert.match(err, why, area_);
      }
      assert.deepEqual(readdirSync(a.home), []);
    } finally { a.done(); }
  });

  it('refuses --area together with --horizon, --from-proposal without --area and an empty --purpose, exit 2, nothing made', async () => {
    const a = area();
    try {
      for (const argv of [['--area', 'memoro-cli/operations', '--horizon', 'h'], ['--from-proposal', '/x/p.md'], ['--area', 'memoro-cli/operations', '--purpose', '  ']]) {
        assert.equal((await call(['create', 'ops-repair', '--end', 'e', ...argv], a.env, AREA_DEPS)).code, 2, argv.join(' '));
      }
      assert.deepEqual(readdirSync(a.home), []);
    } finally { a.done(); }
  });

  /** An area repair programme `ops-repair` for memoro-cli/operations holding a goal in `stage`, and a proposal waiting in ~/mc/proposals/. */
  function repairArea(stage = 'build') {
    const a = area();
    mkdirSync(join(a.root, 'proposals'));
    const proposal = join(a.root, 'proposals', '2026-11-12-operations.md');
    writeFileSync(proposal, '# The operations text is stale\n\nThe runner section.\n');
    return { ...a, proposal, create: async (name) => call(['create', name, '--end', 'e', '--area', 'memoro-cli/operations', '--purpose', 'p', '--from-proposal', proposal], a.env, AREA_DEPS), stage };
  }

  it('repair: a second create for an area that has an open repair programme holding a live goal is refused, exit 1, and the proposal stays where it is', async () => {
    const a = repairArea();
    try {
      assert.equal((await call(['create', 'ops-repair', '--end', 'e', '--area', 'memoro-cli/operations', '--purpose', 'p'], a.env, AREA_DEPS)).code, 0);
      mkdirSync(join(a.home, 'ops-repair', 'goals', 'fix'), { recursive: true });
      writeFileSync(join(a.home, 'ops-repair', 'goals', 'fix', 'GOAL.json'), JSON.stringify({ stage: 'build' }));
      const { code, err } = await a.create('ops-repair-2');
      assert.equal(code, 1);
      assert.match(err, /the area memoro-cli\/operations already has the open repair programme ops-repair/u);
      assert.ok(existsSync(a.proposal), 'the proposal is not moved by a refused create');
      assert.equal(existsSync(join(a.home, 'ops-repair-2')), false);
      assert.deepEqual(readdirSync(join(a.root, 'proposals')), ['2026-11-12-operations.md']);
    } finally { a.done(); }
  });

  it('repair: with none open, create makes the programme and moves the proposal into its proposals/ under a first line naming where it came from; a done record frees the area', async () => {
    const a = repairArea();
    try {
      const { code, out } = await a.create('ops-repair');
      assert.equal(code, 0, out);
      assert.equal(existsSync(a.proposal), false);
      const moved = readFileSync(join(a.home, 'ops-repair', 'proposals', '2026-11-12-operations.md'), 'utf8');
      assert.match(moved.split('\n')[0], new RegExp(`^Moved here from ${a.proposal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} `, 'u'));
      assert.match(moved, /# The operations text is stale\n\nThe runner section\./u);
      const record = JSON.parse(readFileSync(join(a.home, 'ops-repair', RECORD_FILE), 'utf8'));
      writeFileSync(join(a.home, 'ops-repair', RECORD_FILE), JSON.stringify({ ...record, state: 'done' }));
      writeFileSync(a.proposal, '# Again\n');
      assert.equal((await a.create('ops-repair-2')).code, 0, 'a repair that is done no longer holds the area');
    } finally { a.done(); }
  });

  it('repair: a --from-proposal that is no proposal of ~/mc/proposals/ or a programme is refused before anything is made', async () => {
    const a = repairArea();
    try {
      const outside = join(a.root, 'elsewhere.md');
      writeFileSync(outside, 'x');
      const archivedHere = join(a.root, 'proposals', 'archive', 'old.md');
      const archivedThere = join(a.home, 'other', 'proposals', 'archive', 'old.md');
      for (const file of [archivedHere, archivedThere]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'x'); }
      for (const given of [outside, join(a.root, 'proposals', 'missing.md'), archivedHere, archivedThere]) {
        const { code, err } = await call(['create', 'ops-repair', '--end', 'e', '--area', 'memoro-cli/operations', '--from-proposal', given], a.env, AREA_DEPS);
        assert.equal(code, 1, given);
        assert.match(err, /--from-proposal/u);
      }
      assert.equal(existsSync(join(a.home, 'ops-repair')), false);
    } finally { a.done(); }
  });
});

describe('setRecordState: the runner sets state done on a record that is there', () => {
  const put = (dir, record) => writeFileSync(join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);

  it('writes the record whole with state done, every other key as it was and in its place, atomically', () => {
    const a = area();
    try {
      const dir = join(a.home, 'p');
      mkdirSync(dir);
      const before = { ...DRAFT, phases: { order: 'stated', after: { 2: [1] } } };
      put(dir, before);
      const writes = [];
      const result = setRecordState(dir, 'done', { root: a.root, write: (path, text) => { writes.push(path); writeFileSync(path, text); } });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.deepEqual(writes, [join(dir, RECORD_FILE)]);
      assert.deepEqual(recordOf(a.home, 'p'), { ...before, state: 'done' });
      assert.deepEqual(Object.keys(recordOf(a.home, 'p')), Object.keys({ ...before, state: 'done' }));
      assert.equal(readdirSync(dir).length, 1, 'no temporary file is left');
    } finally { a.done(); }
  });

  it('a record already in that state is not written again; an invalid record, none and a state the record does not know are never touched', () => {
    const a = area();
    try {
      const dir = join(a.home, 'p');
      mkdirSync(dir);
      put(dir, { ...DRAFT, state: 'done' });
      assert.deepEqual(setRecordState(dir, 'done', { root: a.root, write: () => assert.fail('written again') }), { ok: true, record: { ...DRAFT, state: 'done' }, changed: false });
      put(dir, DRAFT);
      const refused = setRecordState(dir, 'closed', { root: a.root, write: () => assert.fail('written') });
      assert.equal(refused.ok, false);
      assert.equal(refused.status, 'refused');
      assert.match(refused.problems[0], /^state:/u);
      writeFileSync(join(dir, RECORD_FILE), '{ not json');
      assert.equal(setRecordState(dir, 'done', { root: a.root, write: () => assert.fail('written') }).status, 'invalid');
      assert.equal(readFileSync(join(dir, RECORD_FILE), 'utf8'), '{ not json');
      const empty = join(a.home, 'none');
      mkdirSync(empty);
      assert.equal(setRecordState(empty, 'done', { root: a.root, write: () => assert.fail('written') }).status, 'none');
    } finally { a.done(); }
  });
});

describe('record replacement shares the strict runner lock', () => {
  const phases = { order: 'stated', after: { 2: [1] } };
  const writers = [
    { name: 'phase', run: (dir, options) => changePhases(dir, (old) => ({ ...old, after: { ...old.after, 3: [2] } }), options),
      concurrent: { ...READY, state: 'done', phases }, expected: { ...READY, state: 'done', phases: { ...phases, after: { 2: [1], 3: [2] } } } },
    { name: 'state', run: (dir, options) => setRecordState(dir, 'done', options),
      concurrent: { ...READY, phases }, expected: { ...READY, phases, state: 'done' } },
  ];

  for (const writer of writers) {
    it(`${writer.name} replacement reads after acquisition and retains a competing writer's fields`, () => {
      const a = area();
      try {
        const dir = join(a.home, 'p');
        mkdirSync(dir);
        const path = join(dir, RECORD_FILE);
        writeFileSync(path, JSON.stringify({ ...READY, phases: { order: 'stated' } }));
        const events = [];
        const result = writer.run(dir, {
          root: a.root,
          lock: (root, fn, options) => {
            assert.equal(root, a.root);
            writeFileSync(path, JSON.stringify(writer.concurrent));
            return realLock(root, () => { events.push('acquired'); return fn(); }, options);
          },
          read: (file) => {
            assert.ok(existsSync(lockPath(a.root)), 'the fresh read holds the shared lock');
            events.push('read');
            return readFileSync(file, 'utf8');
          },
          write: (file, text) => {
            assert.ok(existsSync(lockPath(a.root)), 'replacement holds the same lock');
            events.push('write');
            writeFileSync(file, text);
          },
        });
        assert.deepEqual(events, ['acquired', 'read', 'write']);
        assert.deepEqual(result, { ok: true, changed: true, record: writer.expected });
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), writer.expected);
        assert.equal(existsSync(lockPath(a.root)), false, 'the lock is released after replacement');
      } finally { a.done(); }
    });

    it(`${writer.name} replacement refuses an unavailable strict lock without reading or writing`, () => {
      const a = area();
      try {
        const dir = join(a.home, 'p');
        mkdirSync(dir);
        const path = join(dir, RECORD_FILE);
        const before = JSON.stringify({ ...READY, phases });
        writeFileSync(path, before);
        const events = [];
        assert.throws(() => writer.run(dir, {
          root: a.root,
          lock: (root, fn, options) => realLock(root, fn, {
            ...options,
            open: () => { throw Object.assign(new Error('lock denied'), { code: 'EACCES' }); },
            log: () => {},
          }),
          read: (file) => { events.push('read'); return readFileSync(file, 'utf8'); },
          write: () => { events.push('write'); },
        }), /lock denied/u);
        assert.deepEqual(events, [], 'strict lock refusal has no read/modify/write effects');
        assert.equal(readFileSync(path, 'utf8'), before);
      } finally { a.done(); }
    });
  }

  it('programs after uses its environment root and reports lock refusal without effects', async () => {
    const a = area();
    try {
      const dir = join(a.home, 'p');
      for (const phase of [1, 2]) {
        const goalDir = join(dir, 'goals', `g${phase}`);
        mkdirSync(goalDir, { recursive: true });
        writeFileSync(join(goalDir, 'GOAL.json'), goalJson({ phase }));
      }
      const path = join(dir, RECORD_FILE);
      const before = JSON.stringify({ ...READY, phases: { order: 'stated' } });
      writeFileSync(path, before);
      const result = await call(['after', 'p', '2', '1'], a.env, {
        lock: (root, fn, options) => {
          assert.equal(root, a.root);
          return realLock(root, fn, {
            ...options,
            open: () => { throw Object.assign(new Error('lock denied'), { code: 'EACCES' }); },
            log: () => {},
          });
        },
      });
      assert.equal(result.code, 1);
      assert.match(result.err, /could not change p's record: lock denied/u);
      assert.equal(result.out, '');
      assert.equal(readFileSync(path, 'utf8'), before);
    } finally { a.done(); }
  });
});

describe('removed verbs and advisory review', () => {
  it('refuses removed verbs with exit 2', async () => {
    const a = area();
    try {
      for (const verb of ['sign', 'return', 'drop', 'model']) {
        const res = await call([verb, 'alpha'], a.env);
        assert.equal(res.code, 2, verb);
      }
      const verdictRes = await call(['review', 'alpha', 'verdict', 'ok'], a.env);
      assert.equal(verdictRes.code, 2);
    } finally { a.done(); }
  });
});
