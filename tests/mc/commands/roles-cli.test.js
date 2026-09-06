/**
 * `mc roles list` / `mc roles show` — a window onto the catalogue.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runMcCli } from '../_helpers/mc-cli.js';

const WORKER_MD = `---
name: worker
model: fable
singleton: false
tools: claude, codex
---
You are a worker. Escalate to the PM.`;

function fixture({ withWorker = true, withShared = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-roles-cli-'));
  const rolesDir = join(root, 'roles');
  mkdirSync(rolesDir);
  if (withWorker) writeFileSync(join(rolesDir, 'worker.md'), WORKER_MD);
  if (withShared) writeFileSync(join(rolesDir, '_common.md'), 'A turn is the unit of cost.\n');
  return { env: { MC_HOME: join(root, 'home'), MC_ROLES_DIR: rolesDir } };
}

describe('mc roles', () => {
  it('lists what is defined, with model and source', () => {
    const { env } = fixture();
    const result = runMcCli(['roles', 'list', '--json'], env);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.roles.length, 1);
    assert.equal(payload.roles[0].name, 'worker');
    assert.equal(payload.roles[0].model, 'fable');
  });

  it('shows one role whole — facts, then overlay', () => {
    const { env } = fixture();
    const result = runMcCli(['roles', 'show', 'worker'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /model:\s+fable/u);
    assert.match(result.stdout, /You are a worker\. Escalate to the PM\./u);
  });

  // `_common.md` is the text every role session is told, not a role. A
  // catalogue that has a copy of it must not list `_common` as one.
  it('does not name the shared text as a role', () => {
    const { env } = fixture({ withShared: true });
    const result = runMcCli(['roles', 'list'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /worker/u);
    assert.doesNotMatch(result.stdout, /_common/u);
  });

  it('an empty catalogue says where it looked', () => {
    const { env } = fixture({ withWorker: false });
    const result = runMcCli(['roles'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no roles defined in/u);
  });

  it('a role that is not there is a miss with a path, not a crash', () => {
    const { env } = fixture();
    const result = runMcCli(['roles', 'show', 'pm'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no role "pm"/u);
  });
});

/**
 * `mc roles check` — the one verb that looks at what is running.
 *
 * The whole test is the fault it exists for, in miniature: a session is
 * registered on the text of a role file, the file is then edited under it, and
 * the verb has to say so by pid. The session is this test process — a live pid
 * is the one thing the registers are read through (`pidAlive`), and asserting
 * on whatever happens to be open on the machine would make the suite depend on
 * the machine.
 */
describe('mc roles check', () => {
  function registered(env, role) {
    const dir = join(workRootOf(env), 'runner', 'foreground');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.pid}.json`), `${JSON.stringify({
      verb: 'work', area: 'x', tool: 'claude', model: null, pid: process.pid,
      started: '2026-09-06T09:00:00Z', role,
    })}\n`);
  }

  function workRootOf(env) { return env.MC_WORK_ROOT; }

  function checked(env, args = []) {
    const result = runMcCli(['roles', 'check', ...args, '--json'], env);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  function fixtureWithWork() {
    const { env } = fixture();
    return { env: { ...env, MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-roles-check-')) } };
  }

  it('prints what a launch would produce for a role today', () => {
    const { env } = fixtureWithWork();
    const payload = checked(env, ['worker']);
    assert.equal(payload.role.name, 'worker');
    assert.equal(payload.role.source, 'catalogue');
    assert.match(payload.role.instructions, /You are a worker\. Escalate to the PM\./u);
    assert.match(payload.role.digest, /^sha256:[0-9a-f]{12}$/u);

    const printed = runMcCli(['roles', 'check', 'worker'], env);
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /what a launch would hand a worker session today/u);
    assert.match(printed.stdout, /You are a worker\./u);
  });

  it('says nothing about a session running the text on disk', () => {
    const { env } = fixtureWithWork();
    const today = checked(env, ['worker']).role;
    registered(env, {
      name: 'worker', source: 'catalogue', digest: today.digest, text_digest: today.text_digest,
    });
    const payload = checked(env, ['worker']);
    assert.equal(payload.drifting, 0);
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0].verdict, 'ok');
  });

  it('names the session, by pid, when the role file has moved under it', () => {
    const { env } = fixtureWithWork();
    const before = checked(env, ['worker']).role;
    registered(env, {
      name: 'worker', source: 'catalogue', digest: before.digest, text_digest: before.text_digest,
    });
    // The edit that this whole project is about: the file changes, the session
    // goes on running what it was handed an hour ago.
    writeFileSync(join(env.MC_ROLES_DIR, 'worker.md'), `${WORKER_MD}\nAnd read the code first.`);

    const payload = checked(env, ['worker']);
    assert.equal(payload.drifting, 1);
    assert.equal(payload.sessions[0].pid, process.pid);
    assert.equal(payload.sessions[0].verdict, 'drift');
    assert.match(payload.sessions[0].detail, /worker\.md is sha256:/u);

    const printed = runMcCli(['roles', 'check', 'worker'], env);
    assert.match(printed.stdout, new RegExp(`${process.pid}[\\s\\S]*drift`, 'u'));
    assert.match(printed.stdout, /1 live session: 1 drift/u);
  });

  it('a session in another role is not this role\'s business', () => {
    const { env } = fixtureWithWork();
    registered(env, { name: 'brief', source: 'canon', digest: 'sha256:000000000000', text_digest: 'sha256:000000000000' });
    assert.deepEqual(checked(env, ['worker']).sessions, []);
    // …but the bare verb checks every live session against its own role, and
    // canon's `brief` has certainly not hashed to twelve zeroes.
    const all = checked(env);
    assert.equal(all.drifting, 1);
    assert.equal(all.sessions[0].role.name, 'brief');
  });
});
