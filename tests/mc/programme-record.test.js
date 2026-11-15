/**
 * A programme's record (PROGRAMME.json): the validator, `mc programs create`,
 * `record` and `show`, the caller guard, the list and the page naming a
 * recorded programme before its first goal, and a programme without a record
 * left exactly as it was. Every case runs under a temporary programmes home.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { run as goal } from '../../src/mc/commands/goal.js';
import { listingText, programmesListing, recordWriter, run as programs } from '../../src/mc/commands/programs.js';
import { readProgrammes } from '../../src/mc/page-collect.js';
import { changePhases, documentProblems, dropRecord, newRecord, readRecord, recordedProgrammes, recordPage, recordPageTemplate, RECORD_FILE, returnRecord, setRecordState, signRecord, validateRecord, writeRecord } from '../../src/mc/programme-record.js';
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
const UNSIGNED = { signed_at: null, signed_by: null, signed_text: null, cut_text: null };
const DRAFT = { ...GOOD, version: 2, state: 'draft', ...UNSIGNED };
const LEGACY = { ...GOOD, version: 2, ...UNSIGNED, legacy: true };
const SIGNED = { ...DRAFT, state: 'open', signed_at: '2026-11-14T10:20:30Z', signed_by: 'martin', signed_text: 'a'.repeat(64), cut_text: 'b'.repeat(64) };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const OPEN_HORIZONS = { horizons: ['h-one', 'h-two', 'h-three', 'h-four', 'h-done'].map((slug) => ({ slug, state: slug === 'h-done' ? 'closed' : 'open' })) };
const recordOf = (home, name) => JSON.parse(readFileSync(join(home, name, RECORD_FILE), 'utf8'));

describe('the record validator', () => {
  it('takes a whole record, with a null horizon too', () => {
    assert.deepEqual(validateRecord(GOOD), []);
    assert.deepEqual(validateRecord({ ...GOOD, horizon: null, state: 'done', created_by: 'manager' }), []);
  });

  it('names each wrong key', () => {
    const problems = validateRecord({ ...GOOD, schema: 'x', version: 3, horizon: 'Bad Slug', end: '  ', state: 'closed', created: '2026-11-14', created_by: 'runner', extra: 1 });
    for (const key of ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by', 'extra']) assert.ok(problems.some((text) => text.startsWith(`${key}:`)), key);
    assert.match(problems.find((text) => text.startsWith('extra')), /unknown key/u);
    assert.ok(validateRecord([]).length && validateRecord(null).length);
  });

  it('writes the keys in their order, to the second', () => {
    const record = newRecord({ horizon: null, end: 'e', createdBy: 'martin', now: NOW });
    assert.deepEqual(Object.keys(record), ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by', ...Object.keys(UNSIGNED)]);
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
      assert.match(broken.err, /state: one of open, done/u);
      assert.equal((await call(['show', 'missing'], a.env)).code, 1);
      assert.equal((await call(['show', 'Bad_Name'], a.env)).code, 2, 'a name that is not a programme name is a malformed call');
    } finally { a.done(); }
  });
});

describe('who may write a record', () => {
  it('lets a person, the interactive Martin role and the manager through, each recorded as itself — the manager with --purpose and an open horizon', async () => {
    const a = area();
    try {
      for (const [name, extra, by] of [['one', {}, 'person'], ['two', { MC_ROLE: 'martin' }, 'martin'], ['three', { MC_ROLE: 'manager' }, 'manager'], ['four', { MC_ROLE: 'brief' }, 'manager']]) {
        const manager = by === 'manager';
        const argv = ['create', name, '--end', 'e', ...(manager ? ['--purpose', 'What it delivers.', '--horizon', `h-${name}`] : [])];
        assert.equal((await call(argv, { ...a.env, ...extra }, { horizons: () => OPEN_HORIZONS })).code, 0, name);
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
    assert.deepEqual(documentProblems(template), []);
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
  it('writes the area into the record and the page, with a null horizon, and the record reads back', async () => {
    const a = area();
    try {
      const { code, out } = await call(['create', 'ops-repair', '--end', 'The text says what runs.', '--area', 'memoro-cli/operations', '--purpose', 'The runner section is stale.'], a.env, AREA_DEPS);
      assert.equal(code, 0, out);
      const record = recordOf(a.home, 'ops-repair');
      assert.deepEqual(record, { ...DRAFT, state: 'open', horizon: null, area: 'memoro-cli/operations', end: 'The text says what runs.', phases: { order: 'stated' } });
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
    assert.deepEqual(Object.keys(newRecord({ horizon: null, end: 'e', createdBy: 'person', now: NOW })), ['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by', ...Object.keys(UNSIGNED)]);
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
      // A file under a proposals archive/ has been decided already: it is no proposal.
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

describe('mc programs create as the manager', () => {
  const asManager = (a) => ({ ...a.env, MC_ROLE: 'manager' });

  it('names --purpose and exactly one of --horizon and --area, else exit 2 with nothing made; record is refused to it', async () => {
    const a = area();
    try {
      for (const argv of [['--horizon', 'h-one'], ['--purpose', 'p'], ['--purpose', 'p', '--horizon', 'h-one', '--area', 'memoro-cli/operations']]) {
        const { code } = await call(['create', 'x', '--end', 'e', ...argv], asManager(a), { ...AREA_DEPS, horizons: () => OPEN_HORIZONS });
        assert.equal(code, 2, argv.join(' '));
      }
      const record = await call(['record', 'x', '--end', 'e'], asManager(a));
      assert.equal(record.code, 2);
      assert.match(record.err, /the manager role cannot write a record/u);
      assert.deepEqual(readdirSync(a.home), []);
    } finally { a.done(); }
  });

  it('refuses a horizon that is not open or already has a valid open record, exit 1; an invalid record on another programme holds nothing back; the page exists with the record', async () => {
    const a = area();
    try {
      const deps = { ...AREA_DEPS, horizons: () => OPEN_HORIZONS };
      const create = (name, horizon) => call(['create', name, '--end', 'e', '--purpose', 'What it delivers.', '--horizon', horizon], asManager(a), deps);
      assert.equal((await create('gone', 'h-done')).code, 1);
      assert.equal((await create('unknown', 'h-nothing')).code, 1);
      assert.match((await create('unknown', 'h-nothing')).err, /is not an open horizon/u);
      mkdirSync(join(a.home, 'broken')); writeFileSync(join(a.home, 'broken', RECORD_FILE), '{ not json');
      assert.equal((await create('first', 'h-one')).code, 0);
      assert.ok(existsSync(join(a.home, 'first', 'README.md')) && existsSync(join(a.home, 'first', RECORD_FILE)));
      assert.match(readFileSync(join(a.home, 'first', 'README.md'), 'utf8'), /Serves the horizon `h-one`\. What it delivers\./u);
      // The manager's draft-as-serving rule is a later step; retain the existing open-record refusal.
      writeFileSync(join(a.home, 'first', RECORD_FILE), JSON.stringify({ ...GOOD, horizon: 'h-one' }));
      const second = await create('second', 'h-one');
      assert.equal(second.code, 1);
      assert.match(second.err, /the horizon h-one already has the open programme first/u);
      assert.equal(existsSync(join(a.home, 'second')), false);
      // Done frees the horizon again.
      writeFileSync(join(a.home, 'first', RECORD_FILE), JSON.stringify({ ...recordOf(a.home, 'first'), state: 'done' }));
      assert.equal((await create('second', 'h-one')).code, 0);
    } finally { a.done(); }
  });

  it('a person and the interactive Martin role are not held to --purpose or to an open horizon', async () => {
    const a = area();
    try {
      for (const extra of [{}, { MC_ROLE: 'martin' }]) {
        assert.equal((await call(['create', `p-${extra.MC_ROLE ?? 'person'}`, '--end', 'e', '--horizon', 'h-never-heard-of'], { ...a.env, ...extra }, { horizons: () => OPEN_HORIZONS })).code, 0);
      }
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
      const before = { ...GOOD, phases: { order: 'stated', after: { 2: [1] } } };
      put(dir, before);
      const writes = [];
      const result = setRecordState(dir, 'done', { root: a.root, write: (path, text) => { writes.push(path); writeFileSync(path, text); } });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.deepEqual(writes, [join(dir, RECORD_FILE)]);
      assert.deepEqual(recordOf(a.home, 'p'), { ...LEGACY, ...before, version: 2, state: 'done' });
      assert.deepEqual(Object.keys(recordOf(a.home, 'p')), Object.keys({ ...before, ...UNSIGNED, legacy: true }), 'the original keys keep their order and the legacy signature keys are added');
      assert.equal(readdirSync(dir).length, 1, 'no temporary file is left');
    } finally { a.done(); }
  });

  it('a record already in that state is not written again; an invalid record, none and a state the record does not know are never touched', () => {
    const a = area();
    try {
      const dir = join(a.home, 'p');
      mkdirSync(dir);
      put(dir, { ...GOOD, state: 'done' });
      assert.deepEqual(setRecordState(dir, 'done', { root: a.root, write: () => assert.fail('written again') }), { ok: true, record: { ...LEGACY, state: 'done' }, changed: false });
      put(dir, GOOD);
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
      concurrent: { ...SIGNED, state: 'done', phases }, expected: { ...SIGNED, state: 'done', phases: { ...phases, after: { 2: [1], 3: [2] } } } },
    { name: 'state', run: (dir, options) => setRecordState(dir, 'done', options),
      concurrent: { ...SIGNED, phases }, expected: { ...SIGNED, phases, state: 'done' } },
  ];

  for (const writer of writers) {
    it(`${writer.name} replacement reads after acquisition and retains a competing writer's fields`, () => {
      const a = area();
      try {
        const dir = join(a.home, 'p');
        mkdirSync(dir);
        const path = join(dir, RECORD_FILE);
        writeFileSync(path, JSON.stringify({ ...GOOD, phases: { order: 'stated' } }));
        const events = [];
        const result = writer.run(dir, {
          root: a.root,
          lock: (root, fn, options) => {
            assert.equal(root, a.root);
            // Another writer completed before this writer acquired the shared lock.
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
        const before = JSON.stringify({ ...GOOD, phases });
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
      const before = JSON.stringify({ ...GOOD, phases: { order: 'stated' } });
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

describe('v2 record signatures and legacy reads', () => {
  it('requires the four signature/cut keys, valid values and state-dependent nullability', () => {
    for (const state of ['draft', 'dropped']) {
      assert.deepEqual(validateRecord({ ...DRAFT, state, cut_text: 'b'.repeat(64) }), [], `${state} retains a previous cut`);
      assert.ok(validateRecord({ ...SIGNED, state }).some((p) => /must be null/u.test(p)), state);
    }
    for (const state of ['open', 'done']) {
      assert.deepEqual(validateRecord({ ...SIGNED, state }), [], state);
      assert.ok(validateRecord({ ...DRAFT, state }).some((p) => /required together/u.test(p)), `${state} needs a signature`);
      assert.deepEqual(validateRecord({ ...LEGACY, state }), [], `${state} legacy exception`);
      assert.deepEqual(validateRecord({ ...DRAFT, state, horizon: null, area: 'memoro-cli/operations' }), [], `${state} repair exception`);
      assert.ok(validateRecord({ ...DRAFT, state, legacy: false }).length, 'false does not grant the legacy exception');
    }
    assert.deepEqual(validateRecord({ ...SIGNED, signed_at: NOW.toISOString() }), [], 'ISO times may include fractions');
    for (const key of Object.keys(UNSIGNED)) {
      const missing = { ...DRAFT }; delete missing[key];
      assert.ok(validateRecord(missing).some((p) => p.startsWith(`${key}:`)), `missing ${key}`);
    }
    for (const [key, bad] of [['signed_at', 'not a date'], ['signed_by', 'manager'], ['signed_text', 'a'.repeat(63)], ['signed_text', 123], ['cut_text', 'G'.repeat(64)], ['legacy', 'yes']]) {
      assert.ok(validateRecord({ ...SIGNED, [key]: bad }).some((p) => p.startsWith(`${key}:`)), `${key}=${bad}`);
    }
    for (const key of ['signed_at', 'signed_by', 'signed_text']) {
      assert.ok(validateRecord({ ...SIGNED, [key]: null, legacy: true }).some((p) => /required together/u.test(p)), 'legacy does not excuse a partial signature');
    }
    assert.ok(validateRecord({ ...GOOD, state: 'draft' }).some((p) => p.startsWith('state:')), 'v1 has only open and done');
    assert.ok(validateRecord({ ...GOOD, signed_text: null }).some((p) => /unknown key/u.test(p)), 'v1 cannot carry v2 keys');
  });

  it('creates drafts for every author, with or without a horizon, and open unsigned area repairs', () => {
    for (const createdBy of ['person', 'martin', 'manager']) {
      for (const horizon of [null, 'h-one']) {
        const record = newRecord({ horizon, end: 'It holds.', createdBy, now: NOW });
        assert.equal(record.version, 2);
        assert.equal(record.state, 'draft');
        assert.equal(record.legacy, undefined);
        for (const key of Object.keys(UNSIGNED)) assert.equal(record[key], null, key);
        assert.deepEqual(validateRecord(record), []);
      }
    }
    const repair = newRecord({ area: 'memoro-cli/operations', end: 'Repaired.', createdBy: 'manager', now: NOW });
    assert.equal(repair.state, 'open');
    assert.deepEqual(validateRecord(repair), []);
  });

  it('normalizes each old state without rewriting bytes, then upgrades only an actual phase/state write', () => {
    const a = area();
    try {
      const dir = join(a.home, 'old'); mkdirSync(dir);
      const file = join(dir, RECORD_FILE);
      for (const state of ['open', 'done']) {
        const bytes = ` ${JSON.stringify({ ...GOOD, state })}\n`;
        writeFileSync(file, bytes);
        assert.deepEqual(readRecord(dir), { status: 'valid', record: { ...LEGACY, state } });
        assert.equal(readFileSync(file, 'utf8'), bytes, 'reading is not a migration');
        assert.equal(setRecordState(dir, state, { root: a.root }).changed, false);
        assert.equal(readFileSync(file, 'utf8'), bytes, 'a no-op does not upgrade');
        const result = changePhases(dir, () => ({ order: 'stated' }), { root: a.root });
        assert.equal(result.ok, true);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...LEGACY, state, phases: { order: 'stated' } });
      }
      writeFileSync(file, JSON.stringify(GOOD));
      assert.equal(setRecordState(dir, 'done', { root: a.root }).ok, true);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...LEGACY, state: 'done' });
      const created = join(a.home, 'copy'); mkdirSync(created);
      writeRecord(created, GOOD);
      assert.deepEqual(recordOf(a.home, 'copy'), LEGACY, 'create-only writes also persist normalized legacy data');
      assert.throws(() => writeRecord(created, DRAFT), /EEXIST/u);
      assert.deepEqual(recordOf(a.home, 'copy'), LEGACY, 'create-only never replaces an existing record');
    } finally { a.done(); }
  });
});

describe('programme document structure at sign-off', () => {
  const headings = ['What it is for', 'End', 'Why', 'What runs today', 'Parts', 'Order', 'Decided by signing', 'Not built', 'Read before sign-off', 'Where things are'];
  const labels = ['Closes', 'Solution', 'Design', 'Proved by', 'Not in this part'];
  const section = (text, heading) => {
    const start = text.indexOf(`## ${heading}\n`);
    const next = text.indexOf('\n## ', start + 3);
    return { start, end: next < 0 ? text.length : next + 1 };
  };

  it('requires every ordered nonempty heading/entry and each part label before either sign-off file is written', async () => {
    const a = area();
    try {
      const dir = join(a.home, 'p'); mkdirSync(dir);
      const template = recordPageTemplate();
      assert.deepEqual(documentProblems(template), []);
      const cases = [];
      for (const heading of headings) {
        const { start, end } = section(template, heading);
        cases.push({ name: `missing ${heading}`, entry: heading, text: template.slice(0, start) + template.slice(end) });
        cases.push({ name: `empty ${heading}`, entry: heading, text: template.slice(0, start) + `## ${heading}\n\n` + template.slice(end) });
        // Move the section before the first one (or after the last for the first).
        const block = template.slice(start, end);
        const rest = template.slice(0, start) + template.slice(end);
        const position = heading === headings[0] ? section(rest, headings.at(-1)).end : rest.indexOf('## What it is for');
        cases.push({ name: `reordered ${heading}`, entry: 'order', text: rest.slice(0, position) + block + rest.slice(position) });
      }
      for (const label of labels) {
        const start = template.indexOf(`${label}:`);
        const next = template.indexOf('\n\n', start);
        const rest = template.slice(0, start) + template.slice(next + 2);
        cases.push({ name: `missing ${label}`, entry: label, text: rest });
        cases.push({ name: `empty ${label}`, entry: label, text: template.slice(0, start) + `${label}:\n\n` + template.slice(next + 2) });
        const position = label === labels[0] ? rest.indexOf('## Order') : rest.indexOf('Closes:');
        cases.push({ name: `reordered ${label}`, entry: 'order', text: rest.slice(0, position) + template.slice(start, next + 2) + rest.slice(position) });
      }
      cases.push(
        { name: 'missing title', entry: 'title', text: template.replace(/^# .+\n/u, '') },
        { name: 'empty title', entry: 'title', text: template.replace(/^# .+\n/u, '# \n') },
        { name: 'missing scope', entry: 'scope', text: template.replace(/<One paragraph[^\n]+>\n/u, '') },
        { name: 'missing Repositories', entry: 'Repositories:', text: template.replace(/^Repositories:.+\n/mu, '') },
        { name: 'empty Repositories', entry: 'Repositories:', text: template.replace(/^Repositories:.+$/mu, 'Repositories:') },
        { name: 'late Repositories', entry: 'Repositories:', text: template.replace(/^Repositories:.+\n/mu, '') + '\nRepositories: memoro-cli\n' },
      );
      for (const one of cases) {
        writeFileSync(join(dir, RECORD_FILE), JSON.stringify(DRAFT));
        writeFileSync(join(dir, 'README.md'), one.text);
        const before = readFileSync(join(dir, RECORD_FILE), 'utf8');
        // An otherwise current independent reading isolates structure from the review precondition.
        const report = 'OK\nfindings: 0\n';
        writeFileSync(join(dir, 'PROGRAMME-REVIEW.md'), report);
        writeFileSync(join(dir, '.programme-review.json'), JSON.stringify({ verdict: 'ok', hash: hash(one.text), at: NOW.toISOString(), findings: 0, report_sha256: hash(report) }));
        const result = await call(['sign', 'p'], { ...a.env, MC_ROLE: 'martin' });
        assert.equal(result.code, 1, one.name);
        assert.ok(result.err.includes(one.entry), `${one.name}: ${result.err}`);
        assert.equal(readFileSync(join(dir, RECORD_FILE), 'utf8'), before, one.name);
        assert.equal(existsSync(join(dir, 'SIGNED.md')), false, one.name);
      }
    } finally { a.done(); }
  });

  it('checks each part separately, ignores fenced substitute labels, and makes no quality judgement', () => {
    const template = recordPageTemplate();
    const { start, end } = section(template, 'Parts');
    const part = template.slice(start + '## Parts\n\n'.length, end);
    const two = template.slice(0, end) + part.replace('Part 1', 'Part 2') + template.slice(end);
    assert.deepEqual(documentProblems(two), []);
    const badSecond = two.replace('### Part 2 — <name>\n\nCloses:', '### Part 2 — <name>\n\nRemoved:');
    assert.ok(documentProblems(badSecond).some((p) => /Part 2.*Closes/u.test(p)));
    assert.ok(documentProblems(template.replace('Closes:', '```markdown\nCloses: replacement\n```\nRemoved:')).some((p) => /Closes/u.test(p)));
    const free = template.replace('Solution:', 'Solution, in any wording:').replace(/<[^>]+>/gu, 'x');
    assert.deepEqual(documentProblems(free), [], 'labels permit arbitrary following text and prose quality is not judged');
  });
});

describe('signed record transitions', () => {
  function fixture(record = DRAFT) {
    const a = area();
    const dir = join(a.home, 'p'); mkdirSync(dir);
    const file = join(dir, RECORD_FILE);
    writeFileSync(file, JSON.stringify(record));
    writeFileSync(join(dir, 'README.md'), '# p\n\nA working page.\n');
    return { ...a, dir, file, options: { root: a.root } };
  }

  it('signs exact README bytes plus nested design hashes, drops legacy and retains cut/phases', () => {
    const a = fixture({ ...DRAFT, legacy: true, cut_text: 'b'.repeat(64), phases: { order: 'stated', after: { 2: [1] } } });
    try {
      mkdirSync(join(a.dir, 'designs', 'phone'), { recursive: true });
      const bytes = Buffer.from([0, 255, 1, 128]);
      writeFileSync(join(a.dir, 'designs', 'phone', 'dark.png'), bytes);
      writeFileSync(join(a.dir, 'designs', 'desktop.png'), 'desktop');
      const before = readFileSync(join(a.dir, 'README.md'), 'utf8');
      const result = signRecord(a.dir, { ...a.options, at: NOW });
      assert.equal(result.ok, true);
      const signed = `${before}\n## Signed designs\n\n${hash('desktop')}  designs/desktop.png\n${hash(bytes)}  designs/phone/dark.png\n`;
      assert.equal(readFileSync(join(a.dir, 'SIGNED.md'), 'utf8'), signed);
      assert.deepEqual(recordOf(a.home, 'p'), { ...DRAFT, state: 'open', signed_at: '2026-11-14T10:20:30Z', signed_by: 'martin', signed_text: hash(signed), cut_text: 'b'.repeat(64), phases: { order: 'stated', after: { 2: [1] } } });
      assert.equal(readFileSync(join(a.dir, 'README.md'), 'utf8'), before);
      writeFileSync(join(a.dir, 'README.md'), '# p\n\nA later decision.\n');
      assert.equal(readFileSync(join(a.dir, 'SIGNED.md'), 'utf8'), signed, 'working decisions cannot edit the signature');
    } finally { a.done(); }
  });

  it('returns to draft without losing the previous cut or signed copy, then replaces the copy on re-sign', () => {
    const a = fixture(SIGNED);
    try {
      writeFileSync(join(a.dir, 'SIGNED.md'), 'previous signed copy');
      const result = returnRecord(a.dir, a.options);
      assert.equal(result.ok, true);
      assert.deepEqual(recordOf(a.home, 'p'), { ...DRAFT, cut_text: SIGNED.cut_text });
      assert.equal(readFileSync(join(a.dir, 'SIGNED.md'), 'utf8'), 'previous signed copy');
      assert.equal(signRecord(a.dir, { ...a.options, at: NOW }).ok, true, 'no designs directory is required');
      assert.equal(recordOf(a.home, 'p').cut_text, SIGNED.cut_text);
      assert.equal(readFileSync(join(a.dir, 'SIGNED.md'), 'utf8'), '# p\n\nA working page.\n\n## Signed designs\n\n');
      assert.notEqual(recordOf(a.home, 'p').signed_text, SIGNED.signed_text);
    } finally { a.done(); }
  });

  it('drops only a draft, retaining the directory, cut, signed copy and other files for the command to shelve', () => {
    const a = fixture({ ...DRAFT, cut_text: SIGNED.cut_text });
    try {
      writeFileSync(join(a.dir, 'SIGNED.md'), 'retained old copy');
      writeFileSync(join(a.dir, 'dirty-work'), 'unpublished');
      const result = dropRecord(a.dir, a.options);
      assert.equal(result.ok, true);
      assert.deepEqual(recordOf(a.home, 'p'), { ...DRAFT, state: 'dropped', cut_text: SIGNED.cut_text });
      assert.deepEqual(readdirSync(a.dir).sort(), ['PROGRAMME.json', 'README.md', 'SIGNED.md', 'dirty-work']);
      assert.equal(readFileSync(join(a.dir, 'dirty-work'), 'utf8'), 'unpublished');
      assert.equal(readFileSync(join(a.dir, 'SIGNED.md'), 'utf8'), 'retained old copy');
    } finally { a.done(); }
  });

  const transitions = [
    { name: 'sign', run: (a, options) => signRecord(a.dir, { at: NOW, ...options }), from: 'draft', next: 'open' },
    { name: 'return', run: (a, options) => returnRecord(a.dir, options), from: 'open', next: 'draft' },
    { name: 'drop', run: (a, options) => dropRecord(a.dir, options), from: 'draft', next: 'dropped' },
  ];
  for (const transition of transitions) {
    it(`${transition.name} refuses every wrong state before changing the record or signed copy`, () => {
      const a = fixture();
      try {
        writeFileSync(join(a.dir, 'SIGNED.md'), 'unchanged');
        for (const state of ['draft', 'open', 'done', 'dropped'].filter((s) => s !== transition.from)) {
          // Unsigned legacy open/done can otherwise validate as dropped: prove the state guard itself.
          const base = state === 'open' || state === 'done' ? (transition.name === 'drop' ? LEGACY : SIGNED) : DRAFT;
          const before = JSON.stringify({ ...base, state });
          writeFileSync(a.file, before);
          const result = transition.run(a, a.options);
          assert.equal(result.ok, false, state);
          assert.equal(result.status, 'refused');
          assert.match(result.problems[0], new RegExp(`must be ${transition.from}`, 'u'));
          assert.equal(readFileSync(a.file, 'utf8'), before);
          assert.equal(readFileSync(join(a.dir, 'SIGNED.md'), 'utf8'), 'unchanged');
        }
      } finally { a.done(); }
    });

    it(`${transition.name} takes the strict lock before a fresh read and retains competing fields`, () => {
      const a = fixture(transition.from === 'open' ? SIGNED : DRAFT);
      try {
        const phase = { order: 'stated', after: { 3: [1, 2] } };
        const events = [];
        const result = transition.run(a, {
          root: a.root,
          lock: (root, fn, options) => {
            assert.equal(root, a.root);
            assert.equal(options.strict, true);
            assert.equal(options.name, `programme-${transition.name}`);
            const concurrent = { ...(transition.from === 'open' ? SIGNED : DRAFT), phases: phase, cut_text: 'c'.repeat(64) };
            writeFileSync(a.file, JSON.stringify(concurrent));
            return realLock(root, () => { events.push('lock'); return fn(); }, options);
          },
          read: (file) => { assert.ok(existsSync(lockPath(a.root))); events.push('read'); return readFileSync(file, 'utf8'); },
          write: (file, text) => { assert.ok(existsSync(lockPath(a.root))); events.push(file.endsWith('SIGNED.md') ? 'signed' : 'record'); writeFileSync(file, text); },
        });
        assert.deepEqual(events, transition.name === 'sign' ? ['lock', 'read', 'signed', 'record'] : ['lock', 'read', 'record']);
        assert.equal(result.ok, true);
        assert.equal(result.record.state, transition.next);
        assert.equal(result.record.cut_text, 'c'.repeat(64));
        assert.deepEqual(result.record.phases, phase);
        assert.equal(existsSync(lockPath(a.root)), false);
        // A concurrent state change is also read inside the lock, not overwritten.
        const before = JSON.stringify({ ...SIGNED, state: 'done' });
        const refused = transition.run(a, { ...a.options, lock: (root, fn, options) => { writeFileSync(a.file, before); return realLock(root, fn, options); } });
        assert.equal(refused.ok, false);
        assert.equal(readFileSync(a.file, 'utf8'), before);
      } finally { a.done(); }
    });

    it(`${transition.name} refuses a denied strict lock with no reads, copies or writes`, () => {
      const a = fixture(transition.from === 'open' ? SIGNED : DRAFT);
      try {
        const before = readFileSync(a.file, 'utf8');
        assert.throws(() => transition.run(a, {
          root: a.root,
          lock: (root, fn, options) => realLock(root, fn, { ...options, open: () => { throw Object.assign(new Error('lock denied'), { code: 'EACCES' }); }, log: () => {} }),
          read: () => assert.fail('no read without the lock'), write: () => assert.fail('no write without the lock'),
        }), /lock denied/u);
        assert.equal(readFileSync(a.file, 'utf8'), before);
        assert.equal(existsSync(join(a.dir, 'SIGNED.md')), false);
      } finally { a.done(); }
    });
  }

  it('checks the exact document under the lock and makes no signed copy when checks or validation refuse', () => {
    const a = fixture();
    try {
      const before = readFileSync(a.file, 'utf8');
      const result = signRecord(a.dir, { ...a.options, at: NOW, check: ({ record, text }) => {
        assert.ok(existsSync(lockPath(a.root)));
        assert.deepEqual(record, DRAFT);
        assert.equal(text, '# p\n\nA working page.\n');
        return ['no reading of its current text'];
      } });
      assert.deepEqual(result, { ok: false, status: 'refused', problems: ['no reading of its current text'] });
      const invalid = signRecord(a.dir, { ...a.options, at: { toISOString: () => 'not a date' } });
      assert.equal(invalid.ok, false);
      assert.match(invalid.problems[0], /^signed_at:/u);
      assert.equal(readFileSync(a.file, 'utf8'), before);
      assert.equal(existsSync(join(a.dir, 'SIGNED.md')), false, 'validate before either file is written');
    } finally { a.done(); }
  });
});
