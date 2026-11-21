/**
 * `mc programs after`: states, replaces and removes what a phase of an opted-in
 * programme waits for, writing the record and nothing beside it, and refuses —
 * with every file left as it was — a cycle, a phase with no goal, a programme
 * that is not opted in, an invalid record and a caller that is not allowed.
 * Every case runs under a temporary programmes home with a placeholder
 * programme `prog`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as programs } from '../../src/mc/commands/programs.js';
import { RECORD_FILE } from '../../src/mc/programme-record.js';
import { goalJson } from './_helpers/goal-file.js';

const NOW = new Date('2026-11-14T10:20:30.456Z');
const RECORD = { schema: 'mc-programme', version: 1, horizon: 'mc-autonomy', end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' };
const STATED = { ...RECORD, phases: { order: 'stated' } };

const putRecord = (home, name, record) => {
  mkdirSync(join(home, name), { recursive: true });
  writeFileSync(join(home, name, RECORD_FILE), typeof record === 'string' ? record : `${JSON.stringify(record, null, 2)}\n`);
};

/** A temporary root with `prog` holding one goal in each of phases 1, 2 and 3, a LOG.md each and a desk file. */
function area(record = STATED) {
  const root = mkdtempSync(join(tmpdir(), 'mc-after-'));
  const home = join(root, 'programs');
  for (const phase of [1, 2, 3]) {
    const dir = join(home, 'prog', 'goals', `g${phase}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'GOAL.json'), goalJson({ phase }));
    writeFileSync(join(dir, 'LOG.md'), `# g${phase}\n`);
  }
  if (record !== null) putRecord(home, 'prog', record);
  writeFileSync(join(root, 'desk.txt'), 'a desk item\n');
  return { root, home, env: { MC_WORK_ROOT: root, MC_HOME: join(root, 'mc-home') }, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Every file under `dir` and its text, so a refused call can be shown to have changed none. */
function snapshot(dir, at = dir, seen = {}) {
  for (const entry of readdirSync(at)) {
    const path = join(at, entry);
    if (statSync(path).isDirectory()) snapshot(dir, path, seen);
    else seen[path.slice(dir.length)] = readFileSync(path, 'utf8');
  }
  return seen;
}

async function call(argv, env) {
  let out = '';
  let err = '';
  const code = await programs(argv, { env, now: NOW, stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { err += text; } } });
  return { code, out, err };
}

const recordOf = (home, name = 'prog') => JSON.parse(readFileSync(join(home, name, RECORD_FILE), 'utf8'));
const WITHOUT_RECORD = (seen) => Object.fromEntries(Object.entries(seen).filter(([path]) => !path.endsWith(RECORD_FILE)));

describe('mc programs after: states, replaces and removes', () => {
  it('states, replaces and removes what a phase waits for, writing the record alone', async () => {
    const a = area();
    try {
      const before = snapshot(a.root);
      let { code, out } = await call(['after', 'prog', '3', '2', '1', '2'], a.env);
      assert.equal(code, 0, out);
      assert.equal(out, 'mc: prog · phase 3 · after phase 1, 2\n');
      assert.deepEqual(recordOf(a.home).phases, { order: 'stated', after: { 3: [1, 2] } });
      assert.deepEqual(Object.keys(recordOf(a.home)), Object.keys(STATED));
      for (const key of Object.keys(RECORD).filter((key) => key !== 'version' && key !== 'state')) assert.deepEqual(recordOf(a.home)[key], RECORD[key], key);
      assert.equal(recordOf(a.home).state, 'ready', 'open normalizes to ready');
      assert.equal(recordOf(a.home).version, 2, 'an actual write upgrades the old record');
      assert.deepEqual(WITHOUT_RECORD(snapshot(a.root)), WITHOUT_RECORD(before));

      const shown = await call(['show', 'prog'], a.env);
      assert.match(shown.out, /phases: stated/u);
      assert.match(shown.out, /phase 3 after phase 1, 2/u);

      ({ code, out } = await call(['after', 'prog', '3', '2'], a.env));
      assert.equal(code, 0);
      assert.deepEqual(recordOf(a.home).phases.after, { 3: [2] });
      assert.deepEqual(WITHOUT_RECORD(snapshot(a.root)), WITHOUT_RECORD(before));

      ({ code, out } = await call(['after', 'prog', '3', '--none'], a.env));
      assert.equal(code, 0);
      assert.equal(out, 'mc: prog · phase 3 · waits for no phase\n');
      assert.equal(Object.hasOwn(recordOf(a.home).phases.after ?? {}, '3'), false);
      assert.deepEqual(WITHOUT_RECORD(snapshot(a.root)), WITHOUT_RECORD(before));
    } finally { a.done(); }
  });
});

describe('mc programs after: refuses with the state on disk', () => {
  const refused = async (a, argv, pattern, code = 1, env = a.env) => {
    const before = snapshot(a.root);
    const result = await call(argv, env);
    assert.equal(result.code, code, `${argv.join(' ')}: ${result.err}`);
    assert.match(result.err, pattern);
    assert.equal(result.out, '');
    assert.deepEqual(snapshot(a.root), before, `${argv.join(' ')} changed a file`);
  };

  it('exits 1 for a programme or record that cannot take it', async () => {
    const a = area();
    try {
      await refused(a, ['after', 'nowhere', '2', '1'], /no programme nowhere/u);
      mkdirSync(join(a.home, 'bare'));
      await refused(a, ['after', 'bare', '2', '1'], /no record/u);
      putRecord(a.home, 'plain', RECORD);
      await refused(a, ['after', 'plain', '2', '1'], /run in sequence.*mc goal phase/su);
      putRecord(a.home, 'broken', '{');
      await refused(a, ['after', 'broken', '2', '1'], /mc programs show broken/u);
    } finally { a.done(); }
  });

  it('exits 1 for a phase with no goal', async () => {
    const a = area();
    try {
      await refused(a, ['after', 'prog', '4', '1'], /no goal in phase 4/u);
      await refused(a, ['after', 'prog', '1', '4'], /no goal in phase 4/u);
    } finally { a.done(); }
  });

  it('exits 1 for a cycle, and names the phases of a long one', async () => {
    const a = area({ ...STATED, phases: { order: 'stated', after: { 1: [3] } } });
    try {
      await refused(a, ['after', 'prog', '3', '1'], /phases? 1, 3.*cycle/su);
      putRecord(a.home, 'prog', { ...STATED, phases: { order: 'stated', after: { 1: [2], 2: [3] } } });
      await refused(a, ['after', 'prog', '3', '1'], /phases 1, 2, 3 would wait for one another in a cycle/u);
    } finally { a.done(); }
  });

  it('exits 2 for a malformed call', async () => {
    const a = area();
    try {
      await refused(a, ['after', 'prog', '2', '2'], /cannot wait for itself/u, 2);
      await refused(a, ['after', 'prog', '0', '1'], /not a phase/u, 2);
      await refused(a, ['after', 'prog', 'x', '1'], /not a phase/u, 2);
      await refused(a, ['after', 'prog', '2'], /needs the phases/u, 2);
      await refused(a, ['after', 'prog', '2', '1', '--none'], /not both/u, 2);
      await refused(a, ['after', 'prog', '2', '1', '--force'], /--force/u, 2);
    } finally { a.done(); }
  });

  it('exits 2 for a role that may not state the order, and names it', async () => {
    const a = area();
    try {
      for (const role of ['build-session:goal', 'review-session:goal', 'mend-session', 'decision', 'learning', 'work']) {
        await refused(a, ['after', 'prog', '3', '1'], new RegExp(`${role}`, 'u'), 2, { ...a.env, MC_ROLE: role });
      }
      await refused(a, ['after', 'prog', '3', '1'], /Martin role is interactive-only/u, 2, { ...a.env, MC_ROLE: 'martin', MC_HEADLESS: '1' });
      await refused(a, ['after', 'prog', '3', '1'], /build-session:goal/u, 2, { ...a.env, MC_GOAL: 'prog/g3' });
    } finally { a.done(); }
  });
});

describe('mc programs after: who may call', () => {
  it('lets a person, the manager, the plan role and interactive Martin state an order', async () => {
    for (const extra of [{}, { MC_ROLE: 'manager' }, { MC_ROLE: 'plan', MC_HEADLESS: '1' }, { MC_ROLE: 'martin' }]) {
      const a = area();
      try {
        const { code, err } = await call(['after', 'prog', '3', '2', '1'], { ...a.env, ...extra });
        assert.equal(code, 0, `${JSON.stringify(extra)}: ${err}`);
        assert.deepEqual(recordOf(a.home).phases.after, { 3: [1, 2] });
      } finally { a.done(); }
    }
  });
});

describe('mc programs after: the usage and which programmes take it', () => {
  it('holds both forms of the verb and who may call it', async () => {
    const { out } = await call([], {});
    assert.match(out, /programs after <programme> <phase> <phase>…/u);
    assert.match(out, /programs after <programme> <phase> --none/u);
    assert.match(out, /plan role/u);
  });

  it('is opted in by create and not by record', async () => {
    const a = area(null);
    try {
      let result = await call(['create', 'fresh', '--end', 'Fresh is done when it holds.'], a.env);
      assert.equal(result.code, 0, result.err);
      const keys = Object.keys(recordOf(a.home, 'fresh'));
      assert.equal(keys.at(-1), 'phases');
      assert.deepEqual(recordOf(a.home, 'fresh').phases, { order: 'stated' });
      assert.deepEqual(JSON.parse((await call(['show', 'fresh', '--json'], a.env)).out).record.phases, { order: 'stated' });
      for (const phase of [1, 2]) {
        const dir = join(a.home, 'fresh', 'goals', `g${phase}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'GOAL.json'), goalJson({ phase }));
      }
      // The page create writes is an order: its part carries a `Waits for` line, so the dependencies are the document's.
      result = await call(['after', 'fresh', '2', '1'], a.env);
      assert.deepEqual([result.code, result.err], [1, 'mc: fresh states its order in README.md — change the part\'s "Waits for" line and set it ready again\n']);
      const page = join(a.home, 'fresh', 'README.md');
      writeFileSync(page, readFileSync(page, 'utf8').replace('Waits for: nothing.\n\n', ''));
      result = await call(['after', 'fresh', '2', '1'], a.env);
      assert.equal(result.code, 0, result.err);

      mkdirSync(join(a.home, 'old', 'goals', 'g1'), { recursive: true });
      writeFileSync(join(a.home, 'old', 'goals', 'g1', 'GOAL.json'), goalJson({ phase: 1 }));
      writeFileSync(join(a.home, 'old', 'goals', 'g1', 'LOG.md'), '');
      result = await call(['record', 'old', '--end', 'Old is done when it holds.'], a.env);
      assert.equal(result.code, 0, result.err);
      assert.equal(Object.hasOwn(recordOf(a.home, 'old'), 'phases'), false);
      result = await call(['after', 'old', '1', '--none'], a.env);
      assert.equal(result.code, 1);
    } finally { a.done(); }
  });
});

// Order mc-parts-are-goals, Part 1: what a part waits for is one line in the part, and the record is written from it.
describe('an order states what its parts wait for', () => {
  const order = (...lines) => `# prog\n\nRepositories: memoro-cli.\n\n## Parts\n\n${lines.map((line, at) => `### Part ${at + 1} — P${at + 1}\n\n${line}\n`).join('\n')}`;
  const desk = (a) => ({ ...a.env, MC_ROLE: 'martin' });
  const DRAFT = { ...STATED, version: 2, state: 'draft' };
  const page = (a) => join(a.home, 'prog', 'README.md');

  it('mc programs state ready refuses, exit 1 and nothing written, a part with no line, a part that waits for one the order does not have, and parts that wait for each other', async () => {
    for (const [lines, said] of [
      [['Waits for: nothing.', 'Waits for: Part 1.', 'Closes: a gap.'], 'mc: Part 3 has no "Waits for" line — write "Waits for: nothing." or "Waits for: Part 1." in the part\n'],
      [['Waits for: nothing.', 'Waits for: nothing.', 'Waits for: Part 7.'], 'mc: Part 3 waits for Part 7, which the order does not have — name a part of the order\n'],
      [['Waits for: nothing.', 'Waits for: Part 3.', 'Waits for: Part 2.'], 'mc: Part 2 and Part 3 wait for each other — one of them waits for nothing or for another part\n'],
    ]) {
      const a = area(DRAFT);
      try {
        writeFileSync(page(a), order(...lines));
        const before = snapshot(a.root);
        const result = await call(['state', 'prog', 'ready'], desk(a));
        assert.deepEqual([result.code, result.err, result.out], [1, said, '']);
        assert.deepEqual(snapshot(a.root), before, 'nothing is written');
      } finally { a.done(); }
    }
  });

  it('mc programs state ready writes the dependencies from the lines, keyed by part, in the write that sets the state; mc programs after is then refused, exit 1', async () => {
    const a = area(DRAFT);
    try {
      writeFileSync(page(a), order('Waits for: nothing.', 'Waits for: Part 1', 'Waits for:  Part 1, Part 2.'));
      const result = await call(['state', 'prog', 'ready'], desk(a));
      assert.equal(result.code, 0, result.err);
      assert.deepEqual([recordOf(a.home).state, recordOf(a.home).phases], ['ready', { order: 'stated', after: { 2: [1], 3: [1, 2] } }]);
      assert.deepEqual(Object.keys(recordOf(a.home)), Object.keys(STATED), 'every key in its place');
      // A changed line is written by setting the order ready again.
      writeFileSync(page(a), order('Waits for: nothing.', 'Waits for: nothing.', 'Waits for: Part 2.'));
      assert.equal((await call(['state', 'prog', 'ready'], desk(a))).code, 0);
      assert.deepEqual(recordOf(a.home).phases, { order: 'stated', after: { 3: [2] } });
      const before = snapshot(a.root);
      const refused = await call(['after', 'prog', '3', '1'], a.env);
      assert.deepEqual([refused.code, refused.err, refused.out], [1, 'mc: prog states its order in README.md — change the part\'s "Waits for" line and set it ready again\n', '']);
      assert.deepEqual(snapshot(a.root), before, 'nothing is written');
      // Setting it draft reads no line.
      writeFileSync(page(a), order('Closes: a gap.'));
      assert.equal((await call(['state', 'prog', 'draft'], desk(a))).code, 0);
      assert.deepEqual(recordOf(a.home).phases, { order: 'stated', after: { 3: [2] } });
    } finally { a.done(); }
  });

  it('a record that stated no phases gets them from the lines, and a document with no part is set ready as before and still takes mc programs after', async () => {
    const plain = area({ ...RECORD, version: 2, state: 'draft' });
    try {
      writeFileSync(page(plain), order('Waits for: nothing.', 'Waits for: Part 1.'));
      assert.equal((await call(['state', 'prog', 'ready'], desk(plain))).code, 0);
      assert.deepEqual(recordOf(plain.home).phases, { order: 'stated', after: { 2: [1] } });
    } finally { plain.done(); }
    const a = area(DRAFT);
    try {
      writeFileSync(page(a), '# prog\n\nNo parts yet.\n');
      assert.equal((await call(['state', 'prog', 'ready'], desk(a))).code, 0);
      assert.deepEqual([recordOf(a.home).state, recordOf(a.home).phases], ['ready', { order: 'stated' }]);
      assert.equal((await call(['after', 'prog', '3', '1'], a.env)).code, 0);
    } finally { a.done(); }
  });
});
