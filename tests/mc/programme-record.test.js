/**
 * A programme's record (PROGRAMME.json): the validator, `mc programs create`,
 * `record`, `state` and `show`, the caller guard, the list and the page naming a
 * recorded programme before its first goal, and a programme without a record
 * left exactly as it was. Every case runs under a temporary programmes home.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { run as goal } from '../../src/mc/commands/goal.js';
import { run as plan } from '../../src/mc/commands/plan.js';
import { listingText, programmesListing, recordWriter, run as programs } from '../../src/mc/commands/programs.js';
import { readProgrammes } from '../../src/mc/page-collect.js';
import { changePhases, newRecord, normalized, readRecord, recordedProgrammes, recordPage, recordPageTemplate, RECORD_FILE, setRecordState, validateRecord, writeRecord } from '../../src/mc/programme-record.js';
import { lockPath, realLock } from '../../src/mc/runner-lock.js';
import { goalJson } from './_helpers/goal-file.js';
import { runRepairDraft } from '../../src/mc/repair-draft.js';
import { renderCliSections } from '../../src/mc/helper-cli-collect.js';
import { judgeRepair } from '../../src/mc/repair-session.js';
import { archivedProposal, readRepairSource, sha256 } from '../../src/mc/repair-sources.js';

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
      // No proposals/: a programme is an order, and proposals wait in the areas.
      assert.deepEqual(readdirSync(join(a.home, 'alpha')).sort(), ['PROGRAMME.json', 'README.md', 'evidence', 'goals']);
      assert.deepEqual(recordOf(a.home, 'alpha'), { ...DRAFT, end: 'Alpha is done when it holds.', created: '2026-11-14T10:20:30Z', phases: { order: 'stated' } });
      const page = readFileSync(join(a.home, 'alpha', 'README.md'), 'utf8');
      assert.deepEqual([...page.matchAll(/^#+ .+$/gmu)].map(([line]) => line).slice(1), ['## What it is for', '## End', '## Why', '## What runs today', '## Parts', '### Part 1 — <name>', '## Order', '## Decided', '## Not built', '## Read', '## Where things are', '## Decisions']);
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

  it('releases the desk\'s holds on unfinished goals when Martin sets state ready, and keeps every other hold', async () => {
    const a = area();
    try {
      await call(['create', 'alpha', '--end', 'e'], a.env);
      const goals = join(a.home, 'alpha', 'goals');
      const put = (name, fields, hold) => {
        mkdirSync(join(goals, name), { recursive: true });
        writeFileSync(join(goals, name, 'GOAL.json'), goalJson(fields));
        writeFileSync(join(goals, name, 'LOG.md'), '');
        if (hold) writeFileSync(join(goals, name, '.hold.json'), JSON.stringify(hold));
      };
      const desk = { by: 'martin', tool: 'claude', at: '2026-11-18T10:24Z', reason: 'taken back' };
      put('desk-held', {}, desk);
      put('waits-martin', { status: 'Martin' }, desk);
      put('created', { stage: 'draft' }, { ...desk, created: true });
      put('other', {}, { ...desk, by: 'manager' });
      put('finished', { stage: 'done', status: 'done' }, desk);
      put('free', {}, null);
      const res = await call(['state', 'alpha', 'ready'], { ...a.env, MC_ROLE: 'martin' });
      assert.equal(res.code, 0, res.err);
      for (const name of ['desk-held', 'waits-martin']) {
        assert.equal(existsSync(join(goals, name, '.hold.json')), false, name);
        assert.match(res.out, new RegExp(`alpha/${name} released \\(held since 2026-11-18T10:24Z: taken back\\)`, 'u'));
        assert.match(readFileSync(join(goals, name, 'LOG.md'), 'utf8'), /released: held by martin since 2026-11-18T10:24Z \(taken back\) — the programme was set ready/u);
      }
      for (const name of ['created', 'other', 'finished']) assert.ok(existsSync(join(goals, name, '.hold.json')), name);
      assert.match(res.out, /alpha\/created still held by martin/u);
      assert.match(res.out, /alpha\/other still held by manager — mc goal release alpha\/other frees it/u);
      assert.doesNotMatch(res.out, /alpha\/(finished|free)\b/u);
      const back = await call(['state', 'alpha', 'draft'], { ...a.env, MC_ROLE: 'martin' });
      assert.doesNotMatch(back.out, /released|still held/u, 'draft releases nothing');
    } finally { a.done(); }
  });

  it('sets state and admits goal new the same with or without a PROGRAMME-REVIEW.md report on disk, and leaves the report as it was', async () => {
    for (const report of [null, 'NOT OK\n\nfindings: 3\n', 'OK\n\nfindings: 0\n', 'findings: 1\n\nPart 1 — narrow it.\n']) {
      const label = report === null ? 'no report' : JSON.stringify(report.split('\n', 1)[0]);
      const a = area();
      try {
        await call(['create', 'alpha', '--end', 'e'], a.env);
        const reportAt = join(a.home, 'alpha', 'PROGRAMME-REVIEW.md');
        if (report !== null) writeFileSync(reportAt, report);
        const callGoal = async (name) => {
          const out = [];
          const err = [];
          const code = await goal(['new', `alpha/${name}`, '--repo', 'memoro-cli', '--class', 'fast', '--title', name], {
            home: a.home, env: a.env, now: () => NOW, known: () => ['/home/m/memoro-cli.git'],
            git: (cwd, args) => (args[0] === 'show-ref' ? { ok: false, stdout: '', stderr: '' } : { ok: true, stdout: '', stderr: '' }),
            stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) },
          });
          return { code, err: err.join('') };
        };
        const draft = await callGoal('first');
        assert.deepEqual([draft.code, /mc: alpha is draft — mc programs show alpha/u.test(draft.err)], [1, true], `${label}: goal new refused while draft`);
        const ready = await call(['state', 'alpha', 'ready'], { ...a.env, MC_ROLE: 'martin' });
        assert.equal(ready.code, 0, `${label}: ${ready.err}`);
        assert.equal(recordOf(a.home, 'alpha').state, 'ready', label);
        const made = await callGoal('first');
        assert.equal(made.code, 0, `${label}: ${made.err}`);
        assert.ok(existsSync(join(a.home, 'alpha', 'goals', 'first', 'GOAL.json')), label);
        assert.equal((await call(['state', 'alpha', 'draft'], { ...a.env, MC_ROLE: 'martin' })).code, 0, label);
        assert.equal((await callGoal('second')).code, 1, `${label}: refused again once draft`);
        assert.equal(report === null ? existsSync(reportAt) : readFileSync(reportAt, 'utf8'), report === null ? false : report, `${label}: the report is neither read into a gate nor changed`);
      } finally { a.done(); }
    }
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

  it('leaves a programme without a record as it was: six cells and record null, beside one with a record', () => {
    const group = (programme) => ({ programme, goals: [], dormant: true, statuses: {}, priority: 0 });
    const view = { horizon: null, end: 'e', state: 'ready', created: '2026-11-14T10:20:30Z', created_by: 'person' };
    const listing = programmesListing({ section: { programmes: [group('with'), group('without')] } }, { record: (name) => (name === 'with' ? view : null) });
    const [withRecord, without] = listing.programmes;
    assert.deepEqual(withRecord.record, view);
    assert.equal(without.record, null);
    const [, first, second] = listingText(listing).split('\n');
    assert.equal(first.trim().split(/ {2,}/u).length, 7, 'the programme with a record has one cell more');
    assert.match(first, /record ready · no horizon$/u);
    assert.equal(second.trim().split(/ {2,}/u).length, 6);
    assert.doesNotMatch(second, /record/u);
    assert.deepEqual(Object.keys(without).slice(0, -1), ['name', 'priority', 'state', 'dormant', 'repos', 'goals', 'statuses', 'plan_sessions']);
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

  /** An area repair programme `ops-repair` for memoro-cli/operations holding a goal in `stage`, and a proposal waiting in the memoro-cli/system area. */
  function repairArea(stage = 'build') {
    const a = area();
    const waiting = join(a.root, 'areas', 'memoro-cli', 'system', 'proposals');
    mkdirSync(waiting, { recursive: true });
    const proposal = join(waiting, '2026-11-12-mc-operations.md');
    writeFileSync(proposal, '# The operations text is stale\n\nThe runner section.\n');
    const archived = join(waiting, 'archive', '2026-11-12-mc-operations.md');
    return { ...a, waiting, proposal, archived, create: async (name) => call(['create', name, '--end', 'e', '--area', 'memoro-cli/operations', '--purpose', 'p', '--from-proposal', proposal], a.env, AREA_DEPS), stage };
  }

  it('repair: a second repair programme for an area with an open one holding a live goal is made, exit 0, and the proposal is archived as ordered in it', async () => {
    const a = repairArea();
    try {
      assert.equal((await call(['create', 'ops-repair', '--end', 'e', '--area', 'memoro-cli/operations', '--purpose', 'p'], a.env, AREA_DEPS)).code, 0);
      mkdirSync(join(a.home, 'ops-repair', 'goals', 'fix'), { recursive: true });
      writeFileSync(join(a.home, 'ops-repair', 'goals', 'fix', 'GOAL.json'), JSON.stringify({ stage: 'build' }));
      const { code, err } = await a.create('ops-repair-2');
      assert.equal(code, 0, err);
      assert.equal(JSON.parse(readFileSync(join(a.home, 'ops-repair-2', RECORD_FILE), 'utf8')).area, 'memoro-cli/operations');
      assert.equal(existsSync(a.proposal), false, 'the proposal leaves the waiting ones');
      assert.match(readFileSync(a.archived, 'utf8'), /^Utfall: ordered in programme ops-repair-2\n/u);
      assert.deepEqual(readdirSync(a.waiting), ['archive']);
    } finally { a.done(); }
  });

  it('repair: with none open, create makes the programme, archives the proposal in its area under Utfall and names the archived path on the page', async () => {
    const a = repairArea();
    try {
      const { code, out } = await a.create('ops-repair');
      assert.equal(code, 0, out);
      assert.equal(existsSync(a.proposal), false);
      const archived = readFileSync(a.archived, 'utf8');
      assert.equal(archived.split('\n')[0], 'Utfall: ordered in programme ops-repair');
      assert.match(archived, /# The operations text is stale\n\nThe runner section\./u);
      assert.match(out, new RegExp(`ops-repair: the proposal is archived at ${a.archived.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\(area memoro-cli/system\\)`, 'u'));
      const page = readFileSync(join(a.home, 'ops-repair', 'README.md'), 'utf8');
      const where = page.split(/^## Where things are\n/mu)[1].split(/^## /mu)[0];
      assert.ok(where.trimStart().startsWith(`Ordered from the proposal \`${a.archived}\`.`), where);
      assert.equal(existsSync(join(a.home, 'ops-repair', 'proposals')), false, 'the programme gets no proposals/');
    } finally { a.done(); }
  });

  it('repair: a --from-proposal that is no waiting proposal of an area is refused before anything is made', async () => {
    const a = repairArea();
    try {
      const outside = join(a.root, 'elsewhere.md');
      writeFileSync(outside, 'x');
      const archivedHere = join(a.waiting, 'archive', 'old.md');
      const programme = join(a.home, 'other', 'proposals', 'old.md');
      const root = join(a.root, 'proposals', 'old.md');
      const areaFile = join(a.root, 'areas', 'memoro-cli', 'system', 'notes.md');
      for (const file of [archivedHere, programme, root, areaFile]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'x'); }
      for (const given of [outside, join(a.waiting, 'missing.md'), archivedHere, programme, root, areaFile]) {
        const { code, err } = await call(['create', 'ops-repair', '--end', 'e', '--area', 'memoro-cli/operations', '--from-proposal', given], a.env, AREA_DEPS);
        assert.equal(code, 1, given);
        assert.match(err, /--from-proposal/u);
      }
      // A proposal whose archived name is taken was decided once: refused, and nothing is made or moved.
      mkdirSync(dirname(a.archived), { recursive: true });
      writeFileSync(a.archived, 'Utfall: ej aktuellt\n');
      const taken = await a.create('ops-repair');
      assert.equal(taken.code, 1);
      assert.match(taken.err, /exists already — the proposal was decided once; nothing was made/u);
      assert.ok(existsSync(a.proposal));
      assert.equal(existsSync(join(a.home, 'ops-repair')), false);
    } finally { a.done(); }
  });
});

describe('internal repair order drafting', () => {
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
  const proposal = (a, word, text, date = '2026-11-14') =>
    put(join(a.root, 'areas', 'memoro-cli', 'system', 'proposals', `${date}-mc-${word}.md`), text);
  const digest = (a, date, ids, dir = join(a.root, 'intake')) => put(join(dir, `errors-memoro-cli-${date}.md`),
    ['# mc itself', '## mc itself — this machine', '',
      '| fingerprint | hits | source | last seen | what |',
      ...ids.map(id => `| \`${id}\` | 1 | gate | 2026-11-14 | A command refused valid input |`), '',
      '## Failing now', ''].join('\n'));
  const collect = (a, date, message, count = 1, fingerprint = 'gate-a') => put(join(a.root, 'intake', `errors-memoro-cli-${date}.md`),
    renderCliSections({ cli: { notes: [], byStatus: {}, open: [], rows: [
      { fingerprint, count, status: 'gate', lastSeen: '2026-11-14T10:00:00Z', message },
    ] }, threshold: 2 }).join('\n'));
  const order = name => ({
    status: 'draft', name, title: 'Restore valid input', end: 'A valid request succeeds again.',
    repositories: ['memoro-cli'], repository: 'memoro-cli', reason: 'The input is documented.',
    summary: 'A command refuses valid input.', today: 'The current command rejects the supported form at src/mc-cli.js:20.',
    parts: ['Restore the command', 'Restore saved invocations', 'Restore short aliases'].map(name => ({
      name, closes: 'A supported form is refused.', solution: 'Restore the documented argument handling.',
      design: 'Return the existing success line.', provedBy: 'The valid form succeeds and unknown arguments are still rejected.',
      notInPart: 'A new flag.',
    })),
  });
  const unexpected = () => assert.fail('the session must not be started again');
  async function repair(a, argv, judge = unexpected) {
    let out = '', err = '';
    const code = await runRepairDraft(argv, { env: a.env, judge, now: () => NOW,
      stdout: { write: text => { out += text; } }, stderr: { write: text => { err += text; } } });
    return { code, out, err };
  }
  const direct = (a, kind, path, verdict) => repair(a, [`--${kind}`, path], verdict ? () => verdict : unexpected);
  const where = (a, name) => readFileSync(join(a.home, name, 'README.md'), 'utf8').split('## Where things are\n')[1];

  it('writes a full draft linked to each input route without consuming its proposal', async () => {
    const a = area();
    try {
      const p = proposal(a, 'one', 'Valid input fails.');
      const f = put(join(a.root, 'feedback.md'), 'Incident timestamp: 2026-11-14T10:00:00Z; build: 1234\nA private report.');
      const e = digest(a, '2026-11-14', ['gate-a']);
      for (const [kind, file, name] of [['proposal', p, 'from-proposal'], ['feedback', f, 'from-feedback'], ['error', e, 'from-error']]) {
        assert.deepEqual(await direct(a, kind, file, order(name)),
          { code: 0, err: '', out: `mc: repair programme ${name} is draft — source ${file}\n` });
        const record = recordOf(a.home, name);
        assert.equal(record.created_by, 'repair');
        assert.equal(record.state, 'draft');
        assert.equal(record.repair.sources[0].path, file);
        assert.match(record.repair.sources[0].digest, /^[a-f0-9]{64}$/u);
        const waiting = record.repair.sources.find(ref => ref.kind === 'proposal');
        assert.ok(existsSync(waiting.path));
        assert.ok(!existsSync(archivedProposal(waiting.path)));
        assert.ok(where(a, name).includes(file));
        assert.ok(where(a, name).includes(waiting.path));
        const page = readFileSync(join(a.home, name, 'README.md'), 'utf8');
        assert.match(page, /Repositories: memoro-cli\.[\s\S]+## End[\s\S]+### Part 1 —[\s\S]+Proved by:/u);
        assert.doesNotMatch(page + readFileSync(waiting.path, 'utf8'), /A private report\./u);
      }
      assert.deepEqual(readdirSync(a.home).sort(), ['from-error', 'from-feedback', 'from-proposal']);
      const noLocator = put(join(a.root, 'no-locator.md'), 'Only a description and build: 4.');
      assert.deepEqual(await direct(a, 'feedback', noLocator),
        { code: 2, err: 'mc: feedback needs a task ID or incident timestamp and build\n', out: '' });
      assert.equal((await direct(a, 'proposal', join(a.root, 'unreadable.md'))).code, 1);
    } finally { a.done(); }
  });

  it('converges explicit incident and fingerprint links across all routes and a moved or later digest', async () => {
    const a = area();
    try {
      const first = digest(a, '2026-11-13', ['shared']);
      const feedback = put(join(a.root, 'feedback.md'), 'Task ID: event-101\nValid input fails.');
      const p = proposal(a, 'related', `Task ID: event-101\nSource \`${feedback}\`; fingerprint \`shared\` in \`${first}\`.\n`);
      const name = 'shared-repair';
      assert.equal((await direct(a, 'proposal', p, order(name))).code, 0);
      const moved = join(a.root, 'runner', 'log', 'intake', '2026-11-14', 'errors-memoro-cli-2026-11-13.md');
      mkdirSync(dirname(moved), { recursive: true });
      renameSync(first, moved);
      const later = digest(a, '2026-11-14', ['shared']);
      for (const [kind, file] of [['feedback', feedback], ['error', first], ['error', moved], ['error', later]]) {
        assert.deepEqual(await direct(a, kind, file), { code: 0, err: '', out: `mc: resuming repair programme ${name}\n` });
      }
      const unrelated = proposal(a, 'uncertain', `Task ID: event-101\nPossibly a different problem.`);
      assert.deepEqual(await direct(a, 'proposal', unrelated),
        { code: 0, err: '', out: `mc: possible duplicate for ${unrelated}; no order made\n` });
      assert.deepEqual(readdirSync(a.home), [name]);
      assert.deepEqual(recordOf(a.home, name).repair.sources.map(ref => ref.path), [p, feedback, moved, later]);
      assert.ok(existsSync(unrelated));
    } finally { a.done(); }
  });

  it('records resolved, insufficient and unchanged declined evidence without ordering it', async () => {
    const a = area();
    try {
      const fixed = proposal(a, 'fixed', 'Former bug.');
      const weak = proposal(a, 'weak', 'A symptom with no reproduction.');
      const old = proposal(a, 'old', 'Previously considered.', '2026-11-10');
      put(archivedProposal(old), 'Utfall: ej aktuellt — not a defect\n\nPreviously considered.');
      const resolved = { status: 'resolved', reason: 'Fixed at main abcdef.', repository: 'memoro-cli' };
      const insufficient = { status: 'insufficient', reason: 'The input is not known.', repository: 'memoro-cli' };
      assert.equal((await direct(a, 'proposal', fixed, resolved)).out, `mc: ${fixed} — already fixed\n`);
      assert.equal(existsSync(fixed), false);
      assert.match(readFileSync(archivedProposal(fixed), 'utf8'), /^Utfall: resolved — Fixed at main abcdef\./u);
      assert.match((await direct(a, 'proposal', fixed)).out, /already fixed/u);
      assert.equal((await direct(a, 'proposal', old)).out, `mc: ${old} — previously declined\n`);
      assert.equal((await direct(a, 'proposal', weak, insufficient)).out, `mc: ${weak} — insufficient evidence; proposal retained\n`);
      assert.match((await direct(a, 'proposal', weak)).out, /insufficient evidence/u);
      assert.ok(existsSync(weak));
      const key = sha256(JSON.stringify(['proposal', weak]));
      assert.equal(JSON.parse(readFileSync(join(a.root, 'runner', 'repair-draft', `${key}.json`))).reason, insufficient.reason);
      assert.equal((await repair(a, [])).out, 'mc: no repair ready to order\n');
      assert.deepEqual(readdirSync(a.home), []);
      put(weak, 'New evidence supplies the absent input.');
      assert.match((await direct(a, 'proposal', weak, order('now-established'))).out, /now-established is draft/u);
    } finally { a.done(); }
  });

  it('honours a corroborated archive decline across routes without closing changed evidence', async () => {
    const a = area();
    try {
      const feedback = put(join(a.root, 'feedback.md'), 'Task ID: event-102\nValid input fails.');
      const e = collect(a, '2026-11-14', 'A command refused valid input');
      const { ref } = readRepairSource({ kind: 'error', given: e, env: a.env });
      const p = join(a.root, 'areas', 'memoro-cli', 'system', 'proposals', '2026-11-14-mc-declined-intake.md');
      const archived = archivedProposal(p);
      const body = `Task ID: event-102\nSource \`${feedback}\`; fingerprint \`gate-a\` in \`${e}\`.\n`
        + `Repair evidence: ${ref.key} ${ref.digest}\n`;
      const declined = `Utfall: ej aktuellt — not a defect\n\n${body}`;
      put(archived, declined);
      const later = collect(a, '2026-11-15', 'A command refused valid input');
      const moved = join(a.root, 'runner', 'log', 'intake', '2026-11-15', 'errors-memoro-cli-2026-11-14.md');
      mkdirSync(dirname(moved), { recursive: true });
      renameSync(e, moved);
      assert.deepEqual(await direct(a, 'proposal', archived),
        { code: 0, err: '', out: `mc: ${archived} — previously declined\n` });
      for (const [kind, file] of [['error', moved], ['error', later], ['feedback', feedback]]) {
        assert.deepEqual(await direct(a, kind, file, order('wrongly-reopened')),
          { code: 0, err: '', out: `mc: ${file} — previously declined\n` });
      }
      assert.deepEqual(readdirSync(a.home), []);
      assert.deepEqual(readdirSync(dirname(p)), ['archive']);
      assert.equal(readFileSync(archived, 'utf8'), declined);
      const repeated = proposal(a, 'same-report', body);
      assert.equal((await direct(a, 'proposal', repeated)).out, `mc: ${repeated} — previously declined\n`);
      const uncertain = put(join(a.root, 'other-feedback.md'), 'Task ID: event-102\nA different symptom.');
      assert.equal((await direct(a, 'feedback', uncertain)).out, `mc: possible duplicate for ${uncertain}; no order made\n`);
      const changed = collect(a, '2026-11-16', 'New reproduction with a different result');
      const fixed = { status: 'resolved', reason: 'Fixed on main.', repository: 'memoro-cli' };
      assert.deepEqual(await direct(a, 'error', changed, fixed),
        { code: 0, err: '', out: `mc: ${changed} — already fixed\n` });
      assert.equal((await direct(a, 'error', later)).out, `mc: ${later} — previously declined\n`);
      assert.equal((await direct(a, 'error', changed)).out, `mc: ${changed} — already fixed\n`);
      assert.deepEqual(readdirSync(a.home), []);

      const recurring = collect(a, '2026-11-17', 'A command refused valid input', 9);
      const name = 'recurring-failure';
      assert.deepEqual(await direct(a, 'error', recurring, order(name)),
        { code: 0, err: '', out: `mc: repair programme ${name} is draft — source ${recurring}\n` });
      const declinedInputs = [['error', moved], ['error', later], ['proposal', archived], ['proposal', repeated], ['feedback', feedback]];
      for (const [kind, path] of declinedInputs) {
        assert.equal((await direct(a, kind, path)).out, `mc: ${path} — previously declined\n`);
      }
      assert.equal((await direct(a, 'error', changed)).out, `mc: ${changed} — already fixed\n`);
      assert.equal((await direct(a, 'error', recurring)).out, `mc: resuming repair programme ${name}\n`);
      assert.deepEqual(readdirSync(a.home), [name]);
      const sources = recordOf(a.home, name).repair.sources;
      assert.deepEqual(sources.map(source => source.kind), ['error', 'proposal']);
      assert.equal(sources[0].path, recurring);
      assert.ok(existsSync(sources[1].path));
      assert.equal(readFileSync(archived, 'utf8'), declined);
    } finally { a.done(); }
  });

  it('keeps identical recorded evidence declined after a collector rewrite removes its fingerprint', async () => {
    const a = area();
    try {
      const day = '2026-11-14';
      const e = collect(a, day, 'A command refused valid input');
      const { ref } = readRepairSource({ kind: 'error', given: e, env: a.env });
      const evidence = `Fingerprint: \`gate-a\` in \`${e}\`.\n\nRepair evidence: ${ref.key} ${ref.digest}\n`;
      const archived = archivedProposal(join(a.root, 'areas', 'memoro-cli', 'system', 'proposals', `${day}-mc-declined.md`));
      const declined = `Utfall: ej aktuellt — not a defect\n\n# Original report\n\n${evidence}`;
      put(archived, declined);
      const waiting = `# Alternate report\n\n${evidence}`;
      const p = proposal(a, 'alternate', waiting);
      let reads = 0;
      const judge = () => { reads++; return order('duplicate-repair'); };
      const expectDecline = async path => assert.deepEqual(await repair(a, ['--proposal', path], judge),
        { code: 0, err: '', out: `mc: ${path} — previously declined\n` });

      await expectDecline(p);
      collect(a, day, 'An unrelated command failed', 1, 'gate-b');
      await expectDecline(archived);
      await expectDecline(p);
      assert.equal(reads, 0);
      assert.deepEqual(readdirSync(a.home), []);
      assert.equal(readFileSync(archived, 'utf8'), declined);
      assert.equal(readFileSync(p, 'utf8'), waiting);

      const later = collect(a, '2026-11-15', 'New evidence for the original defect');
      const { ref: changed } = readRepairSource({ kind: 'error', given: later, env: a.env });
      assert.equal(changed.key, ref.key);
      assert.notEqual(changed.digest, ref.digest);
      const revised = proposal(a, 'revised', `Fingerprint: \`gate-a\` in \`${later}\`.\n\nRepair evidence: ${changed.key} ${changed.digest}\n`);
      assert.deepEqual(await direct(a, 'proposal', revised, order('changed-evidence')),
        { code: 0, err: '', out: `mc: repair programme changed-evidence is draft — source ${revised}\n` });
      assert.deepEqual(readdirSync(a.home), ['changed-evidence']);
      await expectDecline(p);
      assert.equal(reads, 0);
    } finally { a.done(); }
  });

  it('does not treat a rewritten legacy collector link as proof of a declined evidence version', async () => {
    const a = area();
    try {
      const day = '2026-11-14';
      const e = collect(a, day, 'A command refused valid input');
      const p = join(a.root, 'areas', 'memoro-cli', 'system', 'proposals', `${day}-mc-legacy-decline.md`);
      const archived = archivedProposal(p);
      const declined = `Utfall: ej aktuellt — not a defect\n\nFingerprint: \`gate-a\` in \`${e}\`.\n`;
      put(archived, declined);
      collect(a, day, 'A command refused valid input', 9);
      assert.deepEqual(await direct(a, 'error', e),
        { code: 0, err: '', out: `mc: possible duplicate for ${e}; no order made\n` });
      assert.equal((await direct(a, 'proposal', archived)).out, `mc: ${archived} — previously declined\n`);
      assert.deepEqual(readdirSync(a.home), []);
      assert.deepEqual(readdirSync(dirname(p)), ['archive']);
      assert.equal(readFileSync(archived, 'utf8'), declined);
      assert.ok(existsSync(e));
    } finally { a.done(); }
  });

  it('archives a resolution for changed proposal evidence without replacing its prior decline', async () => {
    const a = area();
    try {
      const changed = 'New reproduction identifies the supported input.\n';
      const p = proposal(a, 'reconsidered', changed);
      const archived = archivedProposal(p);
      const declined = 'Utfall: ej aktuellt — not a defect\n\nThe input was unknown.\n';
      put(archived, declined);
      const fixed = { status: 'resolved', reason: 'Fixed on main.', repository: 'memoro-cli' };
      const result = await direct(a, 'proposal', p, fixed);
      assert.deepEqual(result, { code: 0, err: '', out: `mc: ${p} — already fixed\n` });
      assert.ok(!existsSync(p));
      assert.equal(readFileSync(archived, 'utf8'), declined);
      const [replacement] = readdirSync(dirname(archived)).filter(name => join(dirname(archived), name) !== archived);
      assert.ok(replacement, 'the resolution is a separate archive record');
      const resolvedPath = join(dirname(archived), replacement);
      assert.match(readFileSync(resolvedPath, 'utf8'), /^Utfall: resolved — Fixed on main\.\n/u);
      assert.ok(readFileSync(resolvedPath, 'utf8').endsWith(changed));
      assert.equal((await direct(a, 'proposal', p)).out, `mc: ${resolvedPath} — already fixed\n`);
      assert.equal((await direct(a, 'proposal', archived)).out, `mc: ${archived} — previously declined\n`);
      put(p, changed);
      assert.equal((await direct(a, 'proposal', p)).out, `mc: ${p} — already fixed\n`);
      assert.deepEqual(readdirSync(a.home), []);
    } finally { a.done(); }
  });

  it('requires a selection from a multi-fingerprint digest and leaves the other defects available', async () => {
    const a = area();
    try {
      const e = digest(a, '2026-11-14', ['beta', 'alpha']);
      assert.deepEqual(await direct(a, 'error', e), {
        code: 2, out: '', err: `mc: select a defect — mc repair --error ${e} --fingerprint <id>\n  alpha\n  beta\n`,
      });
      assert.deepEqual(readdirSync(a.home), []);
      const select = id => repair(a, ['--error', e, '--fingerprint', id], ({ source }) => {
        assert.equal(JSON.parse(source.text).fingerprint, id);
        return order(`restore-${id}`);
      });
      assert.equal((await select('beta')).code, 0);
      assert.deepEqual(readdirSync(a.home), ['restore-beta']);
      assert.equal((await select('alpha')).code, 0);
      assert.deepEqual(readdirSync(a.home).sort(), ['restore-alpha', 'restore-beta']);
    } finally { a.done(); }
  });

  it('reuses an intake proposal that already identifies the submitted fingerprint', async () => {
    const a = area();
    try {
      const e = digest(a, '2026-11-14', ['already-filed']);
      const p = proposal(a, 'already-filed', `Fingerprint: \`already-filed\` from \`${e}\`.\n`);
      const result = await direct(a, 'error', e, order('reuse-intake'));
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(recordOf(a.home, 'reuse-intake').repair.sources.map(ref => ref.path), [e, p]);
      assert.deepEqual(readdirSync(dirname(p)), [p.split('/').at(-1)]);
      assert.equal((await direct(a, 'proposal', p)).out, 'mc: resuming repair programme reuse-intake\n');
    } finally { a.done(); }
  });

  it('refuses ordinary ready, plan and goal creation on repair-owned orders without changing the desk route', async () => {
    const a = area();
    try {
      const p = proposal(a, 'restricted', 'A defect to draft.');
      const ordinary = proposal(a, 'desk', 'A documentation proposal.');
      assert.equal((await direct(a, 'proposal', p, order('internal-repair'))).code, 0);
      const desk = { ...a.env, MC_ROLE: 'martin' };
      const command = ['state', 'internal-repair', 'ready'];
      const ready = await call(command, desk);
      assert.equal(ready.code, 1);
      assert.match(ready.err, /repair programme internal-repair is draft/u);
      assert.equal(recordOf(a.home, 'internal-repair').state, 'draft');
      const err = [];
      const dir = join(a.home, 'internal-repair');
      const admitted = { ...recordOf(a.home, 'internal-repair'), state: 'ready' };
      // The ownership guard is independent of an ordinary ready spelling.
      put(join(dir, RECORD_FILE), JSON.stringify(admitted));
      const deps = { env: a.env, cwd: a.root, known: AREA_DEPS.known, git: () => ({ ok: true, stdout: '', stderr: '' }),
        stderr: { write: text => err.push(text) } };
      assert.equal(await goal(['new', 'internal-repair/restore', '--repo', 'memoro-cli', '--class', 'fast', '--title', 'Restore'], deps), 1);
      assert.equal(await plan(['internal-repair'], { ...deps, repos: [], ensure: unexpected }), 1);
      assert.equal(err.filter(text => /repair programme internal-repair needs review/u.test(text)).length, 2);
      assert.deepEqual(readdirSync(join(dir, 'goals')), []);
      assert.equal((await call(['create', 'desk-repair', '--end', 'Update the text.', '--area', 'memoro-cli/operations', '--from-proposal', ordinary], desk, AREA_DEPS)).code, 0);
      assert.equal((await call(['state', 'desk-repair', 'ready'], desk)).code, 0);
      assert.equal(recordOf(a.home, 'desk-repair').state, 'ready');
      assert.ok(existsSync(archivedProposal(ordinary)));
      assert.equal((await direct(a, 'proposal', ordinary)).out, 'mc: source already ordered in desk-repair\n');
      // Model the writer's already-made programme when its archive move failed.
      const ordinaryText = readFileSync(archivedProposal(ordinary), 'utf8').split('\n\n')[1];
      put(ordinary, ordinaryText);
      rmSync(archivedProposal(ordinary));
      assert.equal((await direct(a, 'proposal', ordinary)).out, 'mc: source already ordered in desk-repair\n');
      assert.ok(existsSync(ordinary));
    } finally { a.done(); }
  });

  it('bare drafting skips a stopped source and takes the oldest waiting filename', async () => {
    const a = area();
    try {
      const stopped = proposal(a, 'stopped', 'A defect already at the desk.', '2026-11-09');
      assert.equal((await direct(a, 'proposal', stopped, order('at-the-desk'))).code, 0);
      const record = recordOf(a.home, 'at-the-desk');
      record.repair.stop_item = 'fixture-stop';
      put(join(a.home, 'at-the-desk', RECORD_FILE), JSON.stringify(record));
      assert.equal((await direct(a, 'proposal', stopped)).out, 'mc: repair programme at-the-desk is at Martin (item fixture-stop)\n');
      const first = proposal(a, 'z-oldest', 'The oldest other defect.', '2026-11-10');
      proposal(a, 'a-newer', 'The newer defect.', '2026-11-11');
      const result = await repair(a, [], ({ source }) => {
        assert.equal(source.ref.path, first);
        return order('oldest-actionable');
      });
      assert.equal(result.out, `mc: repair programme oldest-actionable is draft — source ${first}\n`);
      assert.equal((await repair(a, [])).out, 'mc: resuming repair programme oldest-actionable\n');
    } finally { a.done(); }
  });

  it('starts a repair identity without tools, credentials or an inherited goal and reads pinned source', async () => {
    const a = area({ MC_ROLE: 'build-session:goal', MC_GOAL: 'old/goal', MC_PROGRAMME: 'old',
      CLOUDFLARE_API_TOKEN: 'not-for-the-session', MEMORO_TOKEN: 'also-not-for-the-session' });
    try {
      const revision = 'c'.repeat(40);
      const seen = [];
      const verdict = order('served-by-repair');
      const returned = await judgeRepair({ source: { ref: { kind: 'proposal' }, repo: 'memoro-cli', text: 'Sample evidence.' }, orders: [], env: a.env }, {
        repos: [{ name: 'memoro-cli', path: '/repo' }],
        launch: () => ({ ok: true, id: 'claude-code', spec: { bin: 'claude' } }),
        git: (_path, args) => args[0] === 'rev-parse' ? revision : args[1] === `${revision}:docs/technical/mc-help.md` ? 'Existing behaviour.' : null,
        billing: () => ({ billing: 'plan' }),
        session: async (_bin, args, { env, input }) => {
          assert.equal(args[args.indexOf('--tools') + 1], '');
          assert.doesNotMatch(args.join(' '), /Sample evidence/u);
          assert.equal(env.MC_ROLE, 'repair');
          assert.equal(env.MC_HEADLESS, '1');
          for (const key of ['MC_GOAL', 'MC_PROGRAMME', 'CLOUDFLARE_API_TOKEN', 'MEMORO_TOKEN']) assert.equal(env[key], undefined);
          const prompt = JSON.parse(JSON.parse(input).message.content);
          seen.push(prompt);
          const result = seen.length === 1 ? { status: 'read', requests: [{ repository: 'memoro-cli', file: 'docs/technical/mc-help.md' }] } : verdict;
          return { status: 0, stdout: JSON.stringify({ type: 'result', result: JSON.stringify(result) }) };
        },
      });
      assert.deepEqual(returned, verdict);
      assert.deepEqual(seen[1].evidence.map(({ revision, text }) => [revision, text]), [[revision, '1: Existing behaviour.']]);
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
