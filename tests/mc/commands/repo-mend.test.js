import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run } from '../../../src/mc/commands/repo.js';
import { readDeployMends, requestDeployRepair, updateDeployMends } from '../../../src/mc/deploy-repair.js';
import { mainMendReading, readMainMends, requestMainRepair } from '../../../src/mc/main-repair.js';
import { mergesPath } from '../../../src/mc/merge-queue.js';

const ROOT = '/w';
const STATE = `${ROOT}/runner/main-mend/memoro.json`;
const AT = '2026-11-14T10:00:00.000Z';

const entry = (id, fields = {}) => ({
  id, file: `tests/${id}.test.js`, base: 'abc1234', state: 'Martin', failures: 2, branch: `mend/main-memoro-${id}`,
  worktree: `/w/mend/${id}`, pr: null, session_log: `/w/log/${id}.jsonl`, reason: 'two attempts failed', owner: `main-red:${id}`,
  created: '2026-11-13T08:00:00.000Z', ...fields,
});

/**
 * The state file, the merge queue and gh as in-memory fakes. The lock is the strict runner lock's shape:
 * it throws when taken again while held, and gh throws while a lock is held, as the real ones would hang or
 * stall every other writer.
 */
function fixture({ entries = [entry('aaaa11')], queue = [], gh = null, prState = 'OPEN' } = {}) {
  const files = { [STATE]: JSON.stringify({ version: 1, entries }, null, 2), [mergesPath(ROOT)]: JSON.stringify(queue) };
  const f = { files, events: [], held: [], prState, writes: 0, out: '', err: '' };
  f.read = (path) => files[path] ?? null;
  f.write = (path, value) => { f.writes += 1; f.events.push(`write ${path === STATE ? 'state' : 'queue'}`); files[path] = JSON.stringify(value, null, 2); };
  f.lock = (root, fn, options = {}) => {
    if (f.held.length) throw new Error(`lock ${options.name} taken while ${f.held.at(-1)} is held`);
    f.held.push(options.name); f.events.push(`lock ${options.name}`);
    try { return fn(); } finally { f.held.pop(); }
  };
  f.gh = (cwd, args) => {
    if (f.held.length) throw new Error(`gh ${args[1]} while ${f.held.at(-1)} is held`);
    f.events.push(`gh ${args[0]} ${args[1]}`);
    if (gh) { const answer = gh(args, f); if (answer) return answer; }
    if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ state: f.prState }), stderr: '' };
    if (args[1] === 'close') { f.prState = 'CLOSED'; f.closeArgs = args; return { ok: true, stdout: '', stderr: '' }; }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  f.entries = () => JSON.parse(files[STATE]).entries;
  f.queue = () => JSON.parse(files[mergesPath(ROOT)]);
  f.mend = (argv, env = { MC_TOOL: 'person' }) => {
    f.out = ''; f.err = '';
    return run(['mend', ...argv], {
      stdout: { write: (text) => { f.out += text; } }, stderr: { write: (text) => { f.err += text; } }, env: { MC_WORK_ROOT: ROOT, ...env },
      mend: { root: ROOT, known: () => ['/home/memoro'], gh: f.gh, now: () => new Date(AT), read: f.read, write: f.write, lock: f.lock,
        readQueue: f.read, writeQueue: f.write },
    });
  };
  return f;
}

describe('mc repo mend requeue', () => {
  for (const [label, env] of [['a person', { MC_TOOL: 'person' }], ['the martin role', { MC_ROLE: 'martin' }], ['the decision role', { MC_ROLE: 'decision' }]]) {
    it(`${label} requeues a held repair: queued, no failures, its branch kept, the answer recorded`, async () => {
      const f = fixture({ entries: [entry('aaaa11', { pr: 41 })] });
      assert.equal(await f.mend(['memoro', 'aaaa11', 'requeue', '--reason', 'the fixture was wrong, retry'], env), 0, f.err);
      const [held] = f.entries();
      const role = env.MC_ROLE || 'person';
      assert.deepEqual(held, { ...entry('aaaa11', { pr: 41 }), state: 'queued', failures: 0, answered: { verb: 'requeue', by: role, at: AT, reason: 'the fixture was wrong, retry' } });
      assert.deepEqual(f.events.filter((event) => event.startsWith('gh')), [], 'requeue asks GitHub nothing');
    });
  }
});

describe('mc repo mend drop', () => {
  const dropped = (f) => f.entries()[0];

  it('closes an exclusive open pull request with a comment, confirms it, takes its queue row out, then writes the entry', async () => {
    const f = fixture({ entries: [entry('aaaa11', { pr: 41 })], queue: [{ repo: 'memoro', pr: 41, branch: 'mend/x', state: 'red' }, { repo: 'memoro', pr: 7, branch: 'other', state: 'queued' }] });
    assert.equal(await f.mend(['memoro', 'aaaa11', 'drop', '--reason', 'not worth it']), 0, f.err);
    assert.deepEqual(f.events, ['gh pr view', 'gh pr close', 'gh pr view', 'lock merges', 'write queue', 'lock main-mend', 'write state']);
    assert.match(f.closeArgs.join(' '), /--comment The main-red repair of tests\/aaaa11\.test\.js was dropped: not worth it/u);
    assert.deepEqual(f.queue().map((row) => row.pr), [7]);
    assert.deepEqual([dropped(f).state, dropped(f).answered], ['dropped', { verb: 'drop', by: 'person', at: AT, reason: 'not worth it' }]);
    assert.equal(dropped(f).pr, 41);
  });

  it('leaves a pull request that another repair still carries open and untouched', async () => {
    const f = fixture({ entries: [entry('aaaa11', { pr: 41 }), entry('bbbb22', { pr: 41, state: 'published', failures: 0 })], queue: [{ repo: 'memoro', pr: 41, state: 'queued' }] });
    assert.equal(await f.mend(['memoro', 'aaaa11', 'drop', '--reason', 'this file is not red']), 0, f.err);
    assert.deepEqual(f.events, ['lock main-mend', 'write state'], 'no gh call and the queue row stays');
    assert.equal(f.queue().length, 1);
    assert.deepEqual(f.entries().map((x) => x.state), ['dropped', 'published']);
    assert.match(f.out, /#41 left open, another repair carries it/u);
  });

  it('drops an entry that has no pull request without calling gh', async () => {
    const f = fixture();
    assert.equal(await f.mend(['memoro', 'aaaa11', 'drop', '--reason', 'gone']), 0, f.err);
    assert.deepEqual(f.events, ['lock main-mend', 'write state']);
  });

  it('a pull request already closed is not closed again; its queue row still goes', async () => {
    const f = fixture({ entries: [entry('aaaa11', { pr: 41 })], prState: 'CLOSED', queue: [{ repo: 'memoro', pr: 41, state: 'red' }] });
    assert.equal(await f.mend(['memoro', 'aaaa11', 'drop', '--reason', 'gone']), 0, f.err);
    assert.deepEqual(f.events, ['gh pr view', 'lock merges', 'write queue', 'lock main-mend', 'write state']);
    assert.deepEqual(f.queue(), []);
  });

  for (const [label, gh, words] of [
    ['gh cannot say where the pull request stands', (args) => (args[1] === 'view' ? { ok: false, stdout: '', stderr: 'offline' } : null), /could not say/u],
    ['gh cannot close it', (args) => (args[1] === 'close' ? { ok: false, stdout: '', stderr: 'forbidden' } : null), /could not close .*forbidden/u],
    ['the close is not confirmed', (args, f) => (args[1] === 'close' ? (f.prState = 'OPEN', { ok: true, stdout: '', stderr: '' }) : null), /did not confirm/u],
  ]) {
    it(`exits 1 with the entry still Martin and nothing written when ${label}`, async () => {
      const f = fixture({ entries: [entry('aaaa11', { pr: 41 })], queue: [{ repo: 'memoro', pr: 41, state: 'red' }], gh });
      const before = JSON.stringify(f.files);
      assert.equal(await f.mend(['memoro', 'aaaa11', 'drop', '--reason', 'gone']), 1);
      assert.match(f.err, words);
      assert.equal(JSON.stringify(f.files), before);
      assert.equal(f.writes, 0);
    });
  }

  it('takes no lock inside another and no gh call under one (the fakes throw on both)', async () => {
    const f = fixture({ entries: [entry('aaaa11', { pr: 41 })], queue: [{ repo: 'memoro', pr: 41, state: 'red' }] });
    assert.equal(await f.mend(['memoro', 'aaaa11', 'drop', '--reason', 'gone']), 0, f.err);
    assert.equal(await fixture({ entries: [entry('aaaa11')] }).mend(['memoro', 'aaaa11', 'requeue', '--reason', 'again']), 0);
  });

  it('the final hold reads the entry again: one that is no longer Martin is not written, and its state is named', async () => {
    const f = fixture({ entries: [entry('aaaa11', { pr: 41 })], queue: [{ repo: 'memoro', pr: 41, state: 'red' }],
      gh: (args, self) => {
        if (args[1] === 'close') { // a requeue lands while the pull request is being closed
          self.files[STATE] = JSON.stringify({ version: 1, entries: [{ ...entry('aaaa11', { pr: 41 }), state: 'queued', failures: 0 }] });
        }
        return null;
      } });
    assert.equal(await f.mend(['memoro', 'aaaa11', 'drop', '--reason', 'gone']), 1);
    assert.match(f.err, /now reads queued, not Martin; nothing was written/u);
    assert.equal(f.entries()[0].state, 'queued');
    assert.equal(f.writes, 1, 'only the queue row of the closed pull request was written');
  });

  it('a pull request left open for another repair that no longer carries it is not dropped over: exit 1 says it is still open', async () => {
    const f = fixture({ entries: [entry('aaaa11', { pr: 41 }), entry('bbbb22', { pr: 41, state: 'published', failures: 0 })] });
    // the other repair lands between the read and the final hold: the first read sees it, the hold does not
    let reads = 0;
    const read = f.read;
    f.read = (path) => {
      const text = read(path);
      if (path === STATE && ++reads === 2) f.files[STATE] = JSON.stringify({ version: 1, entries: [entry('aaaa11', { pr: 41 }), entry('bbbb22', { pr: 41, state: 'landed', failures: 0 })] });
      return path === STATE && reads === 2 ? f.files[STATE] : text;
    };
    const code = await run(['mend', 'memoro', 'aaaa11', 'drop', '--reason', 'gone'], {
      stdout: { write() {} }, stderr: { write: (text) => { f.err += text; } }, env: { MC_WORK_ROOT: ROOT, MC_TOOL: 'person' },
      mend: { root: ROOT, known: () => ['/home/memoro'], gh: f.gh, now: () => new Date(AT), read: f.read, write: f.write, lock: f.lock, readQueue: f.read, writeQueue: f.write } });
    assert.equal(code, 1);
    assert.match(f.err, /#41 was left open/u);
    assert.equal(f.entries()[0].state, 'Martin');
    assert.equal(f.writes, 0);
  });

  it('after a drop a new red for the same file is a new queued entry, and the dropped one is not a pending repair', async () => {
    const f = fixture();
    assert.equal(await f.mend(['memoro', 'aaaa11', 'drop', '--reason', 'gone']), 0, f.err);
    const state = { root: ROOT, repo: 'memoro', read: f.read, write: f.write, lock: f.lock };
    assert.deepEqual(mainMendReading(state).entries, []);
    const asked = requestMainRepair({ ...state, base: 'def5678', files: ['tests/aaaa11.test.js'], now: () => new Date(AT) });
    assert.equal(asked.created.length, 1, JSON.stringify(asked));
    const all = readMainMends(state);
    assert.deepEqual(all.map((x) => x.state), ['dropped', 'queued']);
  });
});

describe('mc repo mend refusals', () => {
  const argv = ['memoro', 'aaaa11', 'drop', '--reason', 'gone'];
  const refusedAs = async (env, what = argv) => {
    const f = fixture();
    const before = JSON.stringify(f.files);
    assert.equal(await f.mend(what, env), 2, `${JSON.stringify(env)}: ${f.err}`);
    assert.equal(JSON.stringify(f.files), before, 'the state file is byte-identical');
    assert.equal(f.events.length, 0);
    return f;
  };

  for (const role of ['build-session:goal', 'review-session', 'finish-session', 'mend-session', 'desk-prepare', 'session', 'learning', 'manager', 'helper', 'intake', 'plan-session', 'someone-new']) {
    it(`refuses MC_ROLE=${role}`, async () => { await refusedAs({ MC_ROLE: role }); });
  }
  it('refuses a coding-agent session with no role (MC_TOOL set)', async () => { await refusedAs({ MC_TOOL: 'claude' }); });
  for (const place of ['manager', 'programs/mc', 'plan/mc', 'helper', 'intake']) {
    it(`refuses a session by where it stands (${place})`, async () => { await refusedAs({ MC_TOOL: 'person', cwd: `${ROOT}/${place}` }); });
  }
  it('refuses the martin role unattended (MC_HEADLESS=1)', async () => { await refusedAs({ MC_ROLE: 'martin', MC_HEADLESS: '1' }); });

  it('refuses an unknown repository or id', async () => {
    const f = fixture();
    assert.equal(await f.mend(['elsewhere', 'aaaa11', 'drop', '--reason', 'x']), 2);
    assert.equal(await f.mend(['memoro', 'zzzz99', 'drop', '--reason', 'x']), 2);
    assert.match(f.err, /no main-red entry memoro\/zzzz99/u);
    assert.equal(f.writes, 0);
  });
  for (const state of ['queued', 'running', 'published', 'landed', 'dropped']) {
    it(`refuses an entry that reads ${state}, naming it`, async () => {
      const f = fixture({ entries: [entry('aaaa11', { state })] });
      const before = JSON.stringify(f.files);
      assert.equal(await f.mend(argv), 2);
      assert.match(f.err, new RegExp(`reads ${state}, not Martin`, 'u'));
      assert.equal(JSON.stringify(f.files), before);
    });
  }
  for (const [label, what] of [['missing', ['memoro', 'aaaa11', 'drop']], ['empty', ['memoro', 'aaaa11', 'requeue', '--reason', '']], ['blank', ['memoro', 'aaaa11', 'requeue', '--reason', '   ']]]) {
    it(`refuses a ${label} --reason`, async () => { await refusedAs({ MC_TOOL: 'person' }, what); });
  }
  it('refuses a verb that is neither requeue nor drop', async () => { await refusedAs({ MC_TOOL: 'person' }, ['memoro', 'aaaa11', 'close', '--reason', 'x']); });
});

describe('mc repo mend deploy', () => {
  /** A request seeded through the real writer, on the fixture's in-memory state. */
  function deployFixture(change = {}) {
    const f = fixture({ entries: [] });
    f.state = { root: ROOT, read: f.read, write: f.write, lock: f.lock };
    requestDeployRepair({ ...f.state, row: { started: '2026-11-14T09:00:00.000Z', sha: 'a'.repeat(40), stopped_at: 'deployer', note: 'wrangler fell over' }, holder: 'martin@laptop', now: () => new Date(AT), mkdir: () => {}, copy: () => {} });
    updateDeployMends(f.state, (entries) => { Object.assign(entries[0], { state: 'Martin', failures: 2, reason: 'two attempts failed', ...change }); });
    f.id = readDeployMends(f.state)[0].id;
    f.deployEntry = () => readDeployMends(f.state)[0];
    return f;
  }

  for (const [label, env] of [['a person', { MC_TOOL: 'person' }], ['the martin role', { MC_ROLE: 'martin' }], ['the decision role', { MC_ROLE: 'decision' }]]) {
    it(`${label} requeues a held deploy repair: queued with no failures, the answer recorded`, async () => {
      const f = deployFixture();
      assert.equal(await f.mend(['deploy', f.id, 'requeue', '--reason', 'try again'], env), 0, f.err);
      assert.deepEqual([f.deployEntry().state, f.deployEntry().failures], ['queued', 0]);
      assert.equal(f.deployEntry().answered.reason, 'try again');
    });
  }

  it('drop ends a held request, and asks GitHub nothing', async () => {
    const f = deployFixture();
    assert.equal(await f.mend(['deploy', f.id, 'drop', '--reason', 'the deploy shipped by hand']), 0, f.err);
    assert.equal(f.deployEntry().state, 'dropped');
    assert.deepEqual(f.events.filter((event) => event.startsWith('gh')), []);
  });

  it('a request that is not held cannot be requeued or dropped, and nothing is written', async () => {
    const f = deployFixture({ state: 'running' });
    const before = JSON.stringify(f.deployEntry());
    f.writes = 0;
    for (const verb of ['requeue', 'drop']) assert.equal(await f.mend(['deploy', f.id, verb, '--reason', 'x']), 2, verb);
    assert.deepEqual([JSON.stringify(f.deployEntry()), f.writes], [before, 0]);
  });

  it('an unattended session and a role that is neither the desk nor a person cannot answer a held request', async () => {
    const f = deployFixture();
    assert.equal(await f.mend(['deploy', f.id, 'requeue', '--reason', 'x'], { MC_ROLE: 'martin', MC_HEADLESS: '1' }), 2);
    assert.equal(await f.mend(['deploy', f.id, 'drop', '--reason', 'x'], { MC_ROLE: 'build-session' }), 2);
    assert.equal(f.deployEntry().state, 'Martin');
  });

  it('repaired is the mend session\'s: a running request it was named for reads repaired, from the session and no one else', async () => {
    const f = deployFixture({ state: 'running', failures: 0 });
    assert.equal(await f.mend(['deploy', f.id, 'repaired', '--reason', 'removed a stale lock'], { MC_ROLE: 'mend-session' }), 2, 'the prompt named no request');
    assert.equal(await f.mend(['deploy', f.id, 'repaired', '--reason', 'x'], { MC_TOOL: 'person' }), 2, 'a person is not the session');
    assert.equal(f.deployEntry().state, 'running');
    assert.equal(await f.mend(['deploy', f.id, 'repaired', '--reason', 'removed a stale lock'], { MC_ROLE: 'mend-session', MC_DEPLOY_MEND: f.id }), 0, f.err);
    assert.equal(f.deployEntry().state, 'repaired');
  });

  it('a missing id, answer or reason is a usage error that reads nothing', async () => {
    const f = deployFixture();
    f.writes = 0;
    assert.equal(await f.mend(['deploy']), 2);
    assert.equal(await f.mend(['deploy', f.id]), 2);
    assert.equal(await f.mend(['deploy', f.id, 'requeue']), 2);
    assert.equal(await f.mend(['deploy', f.id, 'launch', '--reason', 'x']), 2);
    assert.equal(f.writes, 0);
  });
});
