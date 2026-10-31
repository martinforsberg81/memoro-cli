import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCheckpointVerifier } from '../../src/mc/checkpoint-verifier.js';
import { STABLE_ID_RE } from '../../src/mc/goal-contract.js';
import { gateLockPath, runningRound } from '../../src/mc/gate-lock.js';
import { captureWorktree } from '../../src/mc/session-gate-evidence.js';
import { groupAlive } from '../../src/mc/session-recovery.js';

const state = (criteria = [], goal_revision = 1) => ({ goal_revision, contract: { success_criteria: criteria } });
const criterion = (id, check, verification = 'premerge') => ({ id, check, verification });
const ask = (criterion_id, observation_sequence = 1, reference = 'model text') =>
  ({ operation: 'criterion', reference, criterion_id, observation_sequence });
const askCheckpoint = (observation_sequence = 1, reference = 'model text') =>
  ({ operation: 'checkpoint', reference, observation_sequence });
const content = (fingerprint = 'f1') => ({ repository: '/repo', tree: 't1', fingerprint });

class Child extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter(); this.stdout.destroy = () => {};
    this.stderr = new EventEmitter(); this.stderr.destroy = () => {};
  }
}

/** A verifier on injected process, lane and clock. `end()` ends the running check. */
function rig(overrides = {}) {
  const log = { spawned: [], signals: [], lane: [], released: 0, timers: [], gates: [] };
  const rig = { log, child: null, contents: [], capture: () => rig.contents.shift() ?? content() };
  const verify = createCheckpointVerifier({
    root: '/mc', programme: 'prog', project: 'proj', worktree: '/work',
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', KEEP: 'yes' }, scratch: mkdtempSync(join(tmpdir(), 'mc-verifier-scratch-')),
    capture: () => rig.capture(), head: () => 'a'.repeat(40),
    reservation: () => ({ root: '/mc', lane: 'light', repo: 'memoro-cli' }),
    take: async (options) => { log.lane.push(options); },
    release: () => { log.released++; },
    spawn: (bin, args, options) => { rig.child = new Child(); log.spawned.push({ bin, args, options }); return rig.child; },
    signal: (pid, name) => { log.signals.push([pid, name]); },
    groupAlive: () => false,
    setTimer: (run, ms) => { const timer = { run, ms }; log.timers.push(timer); return timer; },
    clearTimer: (timer) => { const at = log.timers.indexOf(timer); if (at >= 0) log.timers.splice(at, 1); },
    ...overrides,
  });
  rig.verify = verify;
  rig.started = async () => { for (let i = 0; i < 20 && !rig.child; i++) await delay(1); };
  rig.settle = async () => { await delay(5); };
  rig.end = async (code = 0, signal = null) => { rig.child.emit('close', code, signal); await rig.settle(); };
  return rig;
}

test('verify returns at once and the result arrives once on a later call', async () => {
  const fx = rig();
  const current = state([criterion('c-one', 'true')]);
  const request = ask('c-one');
  assert.equal(fx.verify(request, current), null);
  assert.equal(fx.log.spawned.length, 0, 'nothing runs inside the call');
  await fx.started();
  assert.equal(fx.verify(request, current), null, 'still running');
  await fx.end(0);
  const progress = fx.verify(request, current);
  assert.deepEqual(Object.keys(progress).sort(), ['criterion_id', 'id', 'reference']);
  assert.equal(progress.criterion_id, 'c-one');
  assert.match(progress.id, STABLE_ID_RE);
  assert.ok(progress.reference.includes('a'.repeat(40)) && progress.reference.includes('revision 1') && progress.reference.includes('passed'));
  assert.ok(Buffer.byteLength(progress.reference) <= 2048);
  assert.equal(fx.verify(request, current), null, 'returned once');
  assert.equal(fx.log.spawned.length, 1, 'measured once');
});

test('one measurement at a time; a later request waits for the call after it ends', async () => {
  const fx = rig();
  const current = state([criterion('c-one', 'first'), criterion('c-two', 'second')]);
  fx.verify(ask('c-one', 1), current);
  await fx.started();
  assert.equal(fx.verify(ask('c-two', 2), current), null);
  await fx.settle();
  assert.equal(fx.log.spawned.length, 1);
  await fx.end(0);
  assert.equal(fx.log.spawned.length, 1, 'the next call starts it, not the end of the first');
  fx.child = null;
  assert.equal(fx.verify(ask('c-two', 2), current).criterion_id, 'c-one');
  await fx.started();
  assert.equal(fx.log.spawned[1].args[1], 'second');
});

test('the same criterion asked at a new observation is measured again; a changed reference too', async () => {
  const fx = rig();
  const current = state([criterion('c-one', 'true')]);
  fx.verify(ask('c-one', 1), current); await fx.started(); await fx.end(0);
  const first = fx.verify(ask('c-one', 1), current);
  fx.child = null;
  fx.verify(ask('c-one', 2), current); await fx.started(); await fx.end(0);
  const second = fx.verify(ask('c-one', 2), current);
  assert.equal(fx.log.spawned.length, 2);
  assert.equal(second.id, first.id, 'identical content cannot reset the clock twice');
});

test('the request text never reaches the shell and the environment holds no provider key', async () => {
  const fx = rig();
  const current = state([criterion('c-one', 'contract-command')]);
  const injected = '$(touch /tmp/pwned); rm -rf /';
  fx.verify({ ...ask('c-one', 1, injected), check: 'request-command' }, current);
  await fx.started();
  const { bin, args, options } = fx.log.spawned[0];
  assert.equal(bin, '/bin/sh');
  assert.deepEqual(args, ['-c', 'contract-command']);
  assert.equal(options.cwd, '/work');
  assert.equal(options.detached, true);
  assert.equal(options.env.KEEP, 'yes');
  assert.ok(options.env.MC_SCRATCH);
  assert.ok(!('ANTHROPIC_API_KEY' in options.env) && !('OPENAI_API_KEY' in options.env));
  await fx.end(0);
  assert.ok(!fx.verify(ask('c-one', 1, injected), current).reference.includes('rm -rf'));
});

test('the check holds the session gate lane and gives it back', async () => {
  const fx = rig();
  const current = state([criterion('c-one', 'true')]);
  fx.verify(ask('c-one'), current);
  await fx.started();
  assert.equal(fx.log.lane[0].lane, 'light');
  assert.equal(fx.log.lane[0].repo, 'memoro-cli');
  assert.equal(fx.log.lane[0].mode, undefined, 'takeLane defaults to the session gate mode');
  assert.equal(fx.log.released, 0);
  await fx.end(0);
  assert.equal(fx.log.released, 1);
});

test('unknown, after-integration and unmeasurable requests run nothing', async () => {
  const fx = rig();
  const current = state([criterion('later', 'true', 'after-integration')]);
  assert.equal(fx.verify(ask('missing'), current), null);
  assert.equal(fx.verify(ask('later', 2), current), null);
  assert.equal(fx.verify({ operation: 'status', observation_sequence: 3 }, current), null);
  assert.equal(fx.verify(null, current), null);
  await fx.settle();
  assert.equal(fx.log.spawned.length, 0);
  assert.equal(fx.verify(ask('later', 2), current), null);
});

test('a red check, a signal, a spawn error and a thrown lane withhold progress', async () => {
  const current = state([criterion('c-one', 'false')]);
  const red = rig();
  red.verify(ask('c-one'), current); await red.started(); await red.end(1);
  assert.equal(red.verify(ask('c-one'), current), null);

  const killed = rig();
  killed.verify(ask('c-one'), current); await killed.started(); await killed.end(null, 'SIGSEGV');
  assert.equal(killed.verify(ask('c-one'), current), null);

  const broken = rig({ spawn: () => { throw new Error('ENOENT'); } });
  broken.verify(ask('c-one'), current); await broken.settle();
  assert.equal(broken.verify(ask('c-one'), current), null);

  const refused = rig({ take: async () => { throw new Error('lane'); } });
  refused.verify(ask('c-one'), current); await refused.settle();
  assert.equal(refused.verify(ask('c-one'), current), null);
  assert.equal(refused.log.released, 0, 'a lane never held is not released');

  const noCapture = rig({ capture: () => { throw new Error('cannot fingerprint'); } });
  noCapture.verify(ask('c-one'), current); await noCapture.settle();
  assert.equal(noCapture.verify(ask('c-one'), current), null);
  assert.equal(noCapture.log.released, 1);
});

test('a time limit of the gate budget ends the whole group, SIGTERM then SIGKILL', async () => {
  const fx = rig();
  const current = state([criterion('c-one', 'sleep 1000')]);
  fx.verify(ask('c-one'), current);
  await fx.started();
  const deadline = fx.log.timers.find(timer => timer.ms === 540_000);
  assert.ok(deadline, 'the limit is 540 s');
  deadline.run();
  assert.deepEqual(fx.log.signals, [[4242, 'SIGTERM']]);
  const grace = fx.log.timers.find(timer => timer.ms === 1000);
  assert.ok(grace, 'the session grace');
  grace.run();
  assert.deepEqual(fx.log.signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  await fx.end(0);
  assert.equal(fx.verify(ask('c-one'), current), null, 'an exit after the limit is no progress');
  assert.equal(fx.log.released, 1);
});

test('a group that outlives its shell is ended and is no progress', async () => {
  let alive = true;
  const fx = rig({ groupAlive: () => alive });
  const current = state([criterion('c-one', 'sleep 1000 & exit 0')]);
  fx.verify(ask('c-one'), current);
  await fx.started();
  fx.child.emit('close', 0, null);
  assert.deepEqual(fx.log.signals, [[4242, 'SIGTERM']]);
  alive = false;
  await fx.end(0);
  assert.equal(fx.verify(ask('c-one'), current), null);
});

test('a tree that changes during the run discards the result', async () => {
  const fx = rig();
  fx.contents = [content('before'), content('after')];
  const current = state([criterion('c-one', 'true')]);
  fx.verify(ask('c-one'), current);
  await fx.started();
  await fx.end(0);
  assert.equal(fx.verify(ask('c-one'), current), null);
});

test('IDs are bound to content, goal revision, criterion and check text', async () => {
  const idFor = async (request, current, fingerprint = 'f1') => {
    const fx = rig();
    fx.capture = () => content(fingerprint);
    fx.verify(request, current); await fx.started(); await fx.end(0);
    return fx.verify(request, current).id;
  };
  const one = state([criterion('c-one', 'true'), criterion('c-two', 'true')]);
  const base = await idFor(ask('c-one'), one);
  assert.equal(await idFor(ask('c-one', 9, 'other words'), one), base, 'the request adds nothing');
  assert.notEqual(await idFor(ask('c-one'), one, 'edited'), base);
  assert.notEqual(await idFor(ask('c-one'), state([criterion('c-one', 'true')], 2)), base);
  assert.notEqual(await idFor(ask('c-two'), one), base);
  assert.notEqual(await idFor(ask('c-one'), state([criterion('c-one', 'true --other')])), base);
});

test('a result measured on an older goal revision is not delivered', async () => {
  const fx = rig();
  fx.verify(ask('c-one'), state([criterion('c-one', 'true')], 1));
  await fx.started();
  await fx.end(0);
  assert.equal(fx.verify(ask('c-one'), state([criterion('c-one', 'true')], 2)), null);
});

test('a checkpoint is mc gate --json in the worktree, with a null criterion', async () => {
  const calls = [];
  const fx = rig({
    gate: async (argv, options) => { calls.push({ argv, options }); options.stdout.write('{"ok":true,"counts":{}}\n'); return 0; },
  });
  const current = state([criterion('c-one', 'contract')]);
  fx.verify(askCheckpoint(), current);
  await fx.settle();
  assert.deepEqual(calls[0].argv, ['--json']);
  assert.equal(calls[0].options.cwd, '/work');
  assert.ok(!('ANTHROPIC_API_KEY' in calls[0].options.env));
  assert.equal(fx.log.lane.length, 0, 'the gate worker takes its own lane');
  const progress = fx.verify(askCheckpoint(), current);
  assert.equal(progress.criterion_id, null);
  assert.match(progress.id, STABLE_ID_RE);
  assert.ok(progress.reference.startsWith('checkpoint passed'));
});

test('a gate that measured nothing, went red or refused is no progress', async () => {
  const current = state([]);
  for (const [text, code] of [['NOTHING CHANGED — no changes against origin/main\n', 0], ['{"ok":false}\n', 1], ['', 2]]) {
    const fx = rig({ gate: async (argv, options) => { options.stdout.write(text); return code; } });
    fx.verify(askCheckpoint(), current);
    await fx.settle();
    assert.equal(fx.verify(askCheckpoint(), current), null, text);
  }
});

test('a gate past its budget is stopped, waited for and is no progress', async () => {
  const calls = [];
  const fx = rig({
    gate: async (argv, options) => {
      calls.push(argv);
      if (calls.length === 1) { options.spawn('node', [], {}); return 3; }
      return 1;
    },
  });
  fx.verify(askCheckpoint(), state([]));
  await fx.settle();
  assert.deepEqual(fx.log.signals, [[4242, 'SIGTERM']]);
  assert.equal(calls[1][0], '--wait');
  assert.equal(fx.verify(askCheckpoint(), state([])), null);
});

test('close ends a running check, and a closed verifier measures nothing', async () => {
  const fx = rig();
  const current = state([criterion('c-one', 'sleep 1000'), criterion('c-two', 'true')]);
  fx.verify(ask('c-one'), current);
  await fx.started();
  const closing = fx.verify.close();
  assert.deepEqual(fx.log.signals, [[4242, 'SIGTERM']]);
  fx.child.emit('close', null, 'SIGTERM');
  await closing;
  assert.equal(fx.verify(ask('c-two', 2), current), null);
  await fx.settle();
  assert.equal(fx.log.spawned.length, 1);
  await fx.verify.close();
});

test('close during the lane wait starts no check', async () => {
  let aborted = null;
  const fx = rig({
    take: ({ signal }) => new Promise((resolve, reject) => { aborted = signal; signal.addEventListener('abort', () => reject(new Error('interrupted'))); }),
  });
  fx.verify(ask('c-one'), state([criterion('c-one', 'true')]));
  await fx.settle();
  await fx.verify.close();
  assert.equal(aborted.aborted, true);
  assert.equal(fx.log.spawned.length, 0);
});

test('close ends a running gate with SIGTERM so its worker can settle', async () => {
  let finishGate = null;
  const fx = rig({
    gate: (argv, options) => { options.spawn('node', [], {}); return new Promise((resolve) => { finishGate = resolve; }); },
  });
  fx.verify(askCheckpoint(), state([]));
  await fx.settle();
  const closing = fx.verify.close();
  assert.deepEqual(fx.log.signals, [[4242, 'SIGTERM']]);
  finishGate(1);
  await closing;
  assert.equal(fx.log.signals.length, 1);
});

function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-verifier-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'file.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  return { dir, git };
}

async function result(verify, request, current, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const progress = verify(request, current);
    if (progress) return progress;
    await delay(20);
  }
  return null;
}

test('a real check on a temporary repository: output in scratch, lane released, edit gives a new ID', async () => {
  const { dir, git } = repository();
  const home = mkdtempSync(join(tmpdir(), 'mc-verifier-home-'));
  const scratch = mkdtempSync(join(tmpdir(), 'mc-verifier-out-'));
  const env = { ...process.env, MC_HOME: home, ANTHROPIC_API_KEY: 'secret', MC_SCRATCH: scratch };
  const padding = 'x'.repeat(9000);
  const current = state([criterion('c-real', `test -z "$ANTHROPIC_API_KEY" && test "$MC_SCRATCH" = "${scratch}" && printf '${padding}' && printf end`)]);
  const verify = createCheckpointVerifier({ root: home, programme: 'prog', project: 'proj', worktree: dir, env });
  const first = await result(verify, ask('c-real', 1), current);
  assert.ok(first, 'measured green');
  assert.ok(first.reference.includes(git('rev-parse', 'HEAD')));
  const output = readFileSync(join(scratch, 'c-real-1.log'), 'utf8');
  assert.equal(Buffer.byteLength(output), 8192);
  assert.ok(output.endsWith('end'));
  assert.equal(runningRound({ root: home, lane: 'heavy' }), null, 'the lane is free again');
  assert.ok(!existsSync(`${gateLockPath(home, 'heavy')}.claim`));

  assert.equal((await result(verify, ask('c-real', 2), current)).id, first.id);
  writeFileSync(join(dir, 'file.txt'), 'two\n');
  assert.notEqual((await result(verify, ask('c-real', 3), current)).id, first.id);
  await verify.close();
});

test('a real check that edits the tree is discarded and a red one withheld', async () => {
  const { dir } = repository();
  const home = mkdtempSync(join(tmpdir(), 'mc-verifier-home-'));
  const env = { ...process.env, MC_HOME: home };
  const current = state([criterion('c-edit', 'echo edit >> file.txt'), criterion('c-red', 'exit 7')]);
  const before = captureWorktree(dir).fingerprint;
  const verify = createCheckpointVerifier({ root: home, programme: 'prog', project: 'proj', worktree: dir, env });
  assert.equal(await result(verify, ask('c-edit', 1), current, 1500), null);
  assert.notEqual(captureWorktree(dir).fingerprint, before);
  assert.equal(await result(verify, ask('c-red', 2), current, 1500), null);
  await verify.close();
});

test('the time limit kills a real child process and its descendants', async () => {
  const { dir } = repository();
  const home = mkdtempSync(join(tmpdir(), 'mc-verifier-home-'));
  const pidFile = join(home, 'group');
  const env = { ...process.env, MC_HOME: home };
  const current = state([criterion('c-slow', `echo $$ > '${pidFile}'; trap '' TERM; sleep 100 & wait; sleep 100`)]);
  const verify = createCheckpointVerifier({ root: home, programme: 'prog', project: 'proj', worktree: dir, env, limitMs: 5000, termMs: 100 });
  verify(ask('c-slow'), current);
  const until = Date.now() + 30_000;
  const written = () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim();
  while (!written() && Date.now() < until) await delay(10);
  assert.ok(written(), 'the check started');
  const group = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(groupAlive(group));
  while (groupAlive(group) && Date.now() < until) await delay(20);
  assert.equal(groupAlive(group), false);
  await delay(50);
  assert.equal(verify(ask('c-slow'), current), null);
  assert.equal(runningRound({ root: home, lane: 'heavy' }), null);
  await verify.close();
});
