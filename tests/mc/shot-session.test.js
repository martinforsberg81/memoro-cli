/**
 * A kept browser — `mc shot … --keep`, `mc shot next`, `close` and `sessions` —
 * against fake script processes.
 *
 * No browser and no dev server. `--keep` spawns a few lines of node that read
 * the request, listen on its socket and answer canned lines; `next` talks to a
 * small server on a temp socket in this process, with a session file written
 * beside it. What is asserted is mc's half: the session file and what it
 * leaves out, the step line it sends, and what it prints back.
 */
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { run, usage } from '../../src/mc/commands/shot.js';

const TOKEN = 'tok-5ecret-7e57';

const FAKE_SCRIPT = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
const side = process.env.SHOT_SIDE;
const request = JSON.parse(readFileSync(process.env.MEMORO_SHOT_REQUEST, 'utf8'));
appendFileSync(side, JSON.stringify({ request }) + '\\n');
const picture = (out) => { if (out) writeFileSync(out, Buffer.from('89504e470d0a1a0a', 'hex')); };
const clicked = (actions) => (actions || []).filter((a) => a.kind === 'click').map((a) => a.selector);
setTimeout(() => process.exit(0), 30000).unref();
const server = createServer((conn) => {
  let buffered = '';
  conn.setEncoding('utf8');
  conn.on('data', (chunk) => {
    buffered += chunk;
    const at = buffered.indexOf('\\n');
    if (at < 0) return;
    const step = JSON.parse(buffered.slice(0, at));
    appendFileSync(side, JSON.stringify({ step }) + '\\n');
    if (step.close) {
      conn.end(JSON.stringify({ ok: true, closed: true }) + '\\n', () => { server.close(); process.exit(0); });
      return;
    }
    picture(step.out);
    conn.end(JSON.stringify({ ok: true, file: step.out, url: 'http://x/app/', acted: step.actions, clicked: clicked(step.actions), warnings: [] }) + '\\n');
  });
});
server.listen(request.socket, () => {
  process.stderr.write('fake: listening\\n');
  picture(request.out);
  console.log(JSON.stringify({ ok: true, file: request.out, url: request.base_url + '/app/', acted: request.actions, clicked: clicked(request.actions), warnings: [] }));
});
`;

const SHOT_JSON = {
  schema_version: 1,
  argv: [process.execPath, 'fake-session.mjs'],
  default_viewport: 'desktop',
  viewports: { desktop: { width: 1440, height: 900, dpr: 2 } },
  targets: [{ name: 'home', path: '/app/' }, { name: 'vault', path: '/app/tools/vault' }],
};

const TEST_JSON = {
  schema_version: 1,
  environments: { dev: { service: 'memoro-measure' }, prod: { base_url: 'https://meetmemoro.app/' } },
  account: { token_env: 'TEST_SEEDED_TOKEN', url_env: 'MEMORO_TEST_ACCOUNT_URL', route: '/demo/' },
  suites: [{ name: 'smoke', argv: ['true'] }],
};

const clicks = (actions) => (actions || []).filter((a) => a.kind === 'click').map((a) => a.selector);

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A short home under /tmp (a unix socket path is short), with two memoro worktrees. */
function fixture() {
  const home = mkdtempSync('/tmp/mcss-');
  const worktrees = {};
  for (const name of ['memoro', 'memoro-b']) {
    const worktree = join(home, name);
    mkdirSync(join(worktree, '.mc'), { recursive: true });
    writeFileSync(join(worktree, '.mc', 'shot.json'), JSON.stringify(SHOT_JSON));
    writeFileSync(join(worktree, '.mc', 'test.json'), JSON.stringify(TEST_JSON));
    writeFileSync(join(worktree, 'fake-session.mjs'), FAKE_SCRIPT);
    worktrees[name] = worktree;
  }
  const sessions = join(home, 'mc', 'shots', 'sessions');
  return { home, worktree: worktrees.memoro, other: worktrees['memoro-b'], side: join(home, 'side.jsonl'), sessions };
}

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

const NOW = new Date(2026, 9, 25, 10, 30, 0);

async function mc(argv, fx, { env = {}, ...deps } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    stdout,
    stderr,
    env: {
      ...process.env, MC_HOME: join(fx.home, 'mc'), MC_REPOS_HOME: fx.home, SHOT_SIDE: fx.side, ...env,
    },
    cwd: fx.home,
    now: () => NOW,
    callerWorktree: () => null,
    ensureAppServer: async () => ({ ok: true, baseUrl: 'http://127.0.0.1:8787', server: { url: 'http://127.0.0.1:8787/', instance_id: 'srv-1' } }),
    servedTree: (worktree) => ({ worktree, line: `${worktree} — main @ abc` }),
    tokenFor: async () => ({ name: 'TEST_SEEDED_TOKEN', token: TOKEN, from: 'keychain' }),
    ...deps,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/**
 * A session served from this process: a socket answering each step line with
 * `answer(step)`, and its session file. `received` is every line it was sent.
 */
async function fakeSession(fx, {
  id, worktree = fx.worktree, where = 'dev', pid = process.pid, lastUsed = NOW, serverId = 'srv-1',
  answer = (step) => ({ ok: true, file: step.out, url: 'http://127.0.0.1:8787/app/tools/vault', acted: step.actions, clicked: clicks(step.actions), warnings: [] }),
  onClose = () => {},
}) {
  mkdirSync(fx.sessions, { recursive: true, mode: 0o700 });
  const socket = join(fx.sessions, `${id}.sock`);
  const log = join(fx.sessions, `${id}.log`);
  writeFileSync(log, 'fake: listening\n');
  const received = [];
  const server = createServer((conn) => {
    let buffered = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffered += chunk;
      const at = buffered.indexOf('\n');
      if (at < 0) return;
      const step = JSON.parse(buffered.slice(0, at));
      received.push(step);
      if (step.close) { onClose(); conn.end(`${JSON.stringify({ ok: true })}\n`); return; }
      conn.end(`${JSON.stringify(answer(step))}\n`);
    });
  });
  await new Promise((done) => { server.listen(socket, done); });
  cleanups.push(() => new Promise((done) => { server.close(() => done()); }));
  const session = {
    id, pid, socket, log, where, worktree, account: 'seeded', target: 'vault', viewport: 'desktop',
    base_url: 'http://127.0.0.1:8787', server_id: serverId, sign_in_path: '/dev/login?account=seeded&ready=1',
    started: lastUsed.toISOString(), last_used: lastUsed.toISOString(), steps: 0,
  };
  writeFileSync(join(fx.sessions, `${id}.json`), JSON.stringify(session));
  return { received, file: join(fx.sessions, `${id}.json`), session };
}

const sessionOf = (fx, id) => JSON.parse(readFileSync(join(fx.sessions, `${id}.json`), 'utf8'));
const sideLines = (fx) => readFileSync(fx.side, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000);

describe('mc shot --keep', () => {
  it('prints what a shot prints, then the kept line, and writes a session file without secrets', async () => {
    const fx = fixture();
    const out = join(fx.home, 'first.png');
    const kept = await mc(['prod', 'vault', '--keep', '--click', 'text=Create Vault', '--out', out], fx);
    cleanups.push(() => mc(['close', '--all'], fx));
    assert.equal(kept.code, 0, kept.stderr);
    const lines = kept.stdout.trim().split('\n');
    assert.equal(lines[0], out, 'the path first, alone, as a shot');
    assert.equal(lines[1], 'https://meetmemoro.app/app/');
    assert.equal(lines.at(-1), 'mc: kept as s1 — mc shot next s1 [--click …] [--eval …] …; mc shot close s1');

    const { request } = sideLines(fx)[0];
    assert.equal(request.mode, 'session');
    assert.equal(request.socket, join(fx.sessions, 's1.sock'));
    assert.match(request.sign_in.url, new RegExp(TOKEN, 'u'), 'the token reaches the script, in the request file');

    const text = readFileSync(join(fx.sessions, 's1.json'), 'utf8');
    const session = JSON.parse(text);
    for (const key of ['id', 'pid', 'socket', 'log', 'where', 'worktree', 'account', 'target', 'viewport', 'base_url', 'server_id', 'started', 'last_used']) {
      assert.ok(Object.hasOwn(session, key), key);
    }
    assert.equal(session.id, 's1');
    assert.equal(session.where, 'prod');
    assert.equal(session.target, 'vault');
    assert.equal(session.base_url, 'https://meetmemoro.app');
    assert.doesNotMatch(text, new RegExp(`${TOKEN}|/demo/|sign_in"|cookie`, 'u'), 'no token, no cookie, no prod sign-in URL');
    assert.equal(statSync(fx.sessions).mode & 0o777, 0o700);
    assert.equal(statSync(join(fx.sessions, 's1.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(fx.sessions, 's1.sock')).mode & 0o777, 0o600);
    assert.match(readFileSync(session.log, 'utf8'), /fake: listening/u, 'the script\'s stderr goes to the session log');

    // The next step reaches that same process, and close ends it.
    const step = await mc(['next', '--no-shot', '--eval', '1+1'], fx);
    assert.equal(step.code, 0, step.stderr);
    assert.equal(sideLines(fx)[1].step.step, 1);
    const closed = await mc(['close', 's1'], fx);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.stdout, 'mc: closed s1\n');
    assert.equal(sideLines(fx)[2].step.close, true);
    assert.equal(existsSync(join(fx.sessions, 's1.json')), false);
    assert.equal(existsSync(join(fx.sessions, 's1.sock')), false);
  });

  it('is refused with --compare', async () => {
    const fx = fixture();
    const refused = await mc(['dev', 'home', '--keep', '--compare', 'main'], fx);
    assert.equal(refused.code, 2);
    assert.equal(refused.stderr, 'mc: --keep keeps one browser and --compare runs two\n');
  });

  it('a fifth closes the longest idle one and says so', async () => {
    const fx = fixture();
    const alive = new Set([900001, 900002, 900003, 900004]);
    const real = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deps = { alive: (pid) => alive.has(pid) || real(pid), closeWaitMs: 500 };
    const idle = { s1: 5, s2: 42, s3: 1, s4: 12 };
    const fakes = {};
    for (const [n, id] of ['s1', 's2', 's3', 's4'].entries()) {
      const pid = 900001 + n;
      fakes[id] = await fakeSession(fx, { id, pid, lastUsed: minutesAgo(idle[id]), onClose: () => alive.delete(pid) });
    }
    const fifth = await mc(['dev', 'home', '--keep', '--out', join(fx.home, 'fifth.png')], fx, deps);
    cleanups.push(() => mc(['close', '--all'], fx, deps));
    assert.equal(fifth.code, 0, fifth.stderr);
    assert.match(fifth.stderr, /mc: 4 browsers are kept at most, so s2 \(idle 42 min\) was closed/u);
    assert.deepEqual(fakes.s2.received, [{ close: true }]);
    assert.match(fifth.stdout, /mc: kept as s2 —/u, 'the lowest number not live');
    assert.notEqual(sessionOf(fx, 's2').pid, 900002, 's2 is the new browser now');
    const listed = await mc(['sessions'], fx, deps);
    assert.deepEqual(listed.stdout.trim().split('\n').map((line) => line.split(' ')[0]), ['s1', 's2', 's3', 's4']);
  });
});

describe('mc shot next', () => {
  it('picks this worktree\'s session, sends the step in argv order and prints it as a shot', async () => {
    const fx = fixture();
    const elsewhere = await fakeSession(fx, { id: 's1', worktree: fx.worktree, lastUsed: minutesAgo(1) });
    const older = await fakeSession(fx, { id: 's2', worktree: fx.other, lastUsed: minutesAgo(9) });
    const mine = await fakeSession(fx, {
      id: 's3',
      worktree: fx.other,
      lastUsed: minutesAgo(3),
      answer: (step) => ({
        ok: true,
        file: step.out,
        url: 'http://127.0.0.1:8787/app/tools/vault',
        acted: step.actions,
        errors: [{ kind: 'console', text: 'Vault locked', count: 2 }],
        evaluated: [{ value: 'title' }],
        warnings: ['slow'],
      }),
    });
    const ran = await mc([
      'next', '--fill', 'input[name=title]=Bank', '--click', 'text=Save', '--eval', 'document.activeElement.name',
      '--press', 'Enter', '--wait-for', '.entry', '--timeout', '20',
    ], fx, { callerWorktree: () => fx.other });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(elsewhere.received.length + older.received.length, 0, 'the most recently used of this worktree');
    const [step] = mine.received;
    assert.deepEqual(Object.keys(step), [
      'step', 'actions', 'wait_for', 'scroll', 'measure', 'element', 'shell', 'full_page', 'out', 'goto', 'reload', 'shot', 'timeout_ms',
    ]);
    assert.equal(step.step, 1);
    assert.deepEqual(step.actions, [
      { kind: 'fill', selector: 'input[name=title]', text: 'Bank' },
      { kind: 'click', selector: 'text=Save' },
      { kind: 'eval', script: 'document.activeElement.name' },
      { kind: 'press', key: 'Enter' },
    ]);
    assert.equal(step.wait_for, '.entry');
    assert.equal(step.timeout_ms, 20_000);
    assert.equal(step.shot, true);
    assert.equal(step.out, join(fx.home, 'mc', 'shots', '20261025-103000-dev-vault-s3-1-desktop.png'));
    assert.deepEqual(ran.stdout.split('\n'), [
      step.out,
      'http://127.0.0.1:8787/app/tools/vault',
      'error  console  Vault locked ×2',
      'eval 1  "title"',
      'mc: warning — slow',
      '',
    ]);
    const kept = sessionOf(fx, 's3');
    assert.equal(kept.steps, 1);
    assert.equal(kept.last_used, NOW.toISOString());

    const named = await mc(['next', 's1', '--goto', 'home', '--no-shot'], fx, { callerWorktree: () => fx.other });
    assert.equal(named.code, 0, named.stderr);
    assert.deepEqual(elsewhere.received[0].goto, { name: 'home' });
    assert.equal(elsewhere.received[0].out, null);
    assert.equal(elsewhere.received[0].shot, false);
    assert.equal(named.stdout, 'http://127.0.0.1:8787/app/tools/vault\n', 'no picture, no path line');
  });

  it('exits 1 on a failed step and keeps the session where it stood', async () => {
    const fx = fixture();
    const fake = await fakeSession(fx, {
      id: 's1',
      answer: (step) => (step.step === 1
        ? {
          ok: true, file: step.out, url: 'http://x/app/', acted: [],
          failed: { step: 1, kind: 'click', selector: 'text=Missing', error: 'not visible within 10 s', here: 'a dialog' },
        }
        : { ok: true, file: step.out, url: 'http://x/app/', acted: step.actions, clicked: clicks(step.actions) }),
    });
    const failed = await mc(['next', '--click', 'text=Missing'], fx);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /^failed {2}step 1 \(click text=Missing\): not visible within 10 s$/mu);
    assert.match(failed.stdout, /^ {2}here: a dialog$/mu);
    assert.equal(existsSync(fake.file), true, 'the session is kept');
    const again = await mc(['next', '--click', 'text=Other'], fx);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fake.received[1].step, 2);
  });

  it('a restarted dev server sends rebase and says what it cost', async () => {
    const fx = fixture();
    const fake = await fakeSession(fx, {
      id: 's1',
      answer: (step) => ({ ok: true, file: step.out, url: 'http://127.0.0.1:8790/app/tools/vault', acted: step.actions, clicked: clicks(step.actions), rebased: { path: '/app/tools/vault' } }),
    });
    const restarted = async () => ({ ok: true, baseUrl: 'http://127.0.0.1:8790', server: { url: 'http://127.0.0.1:8790/', instance_id: 'srv-2' } });
    const ran = await mc(['next', '--click', 'text=New entry'], fx, { ensureAppServer: restarted });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(fake.received[0].rebase, {
      base_url: 'http://127.0.0.1:8790',
      sign_in: { kind: 'url', url: 'http://127.0.0.1:8790/dev/login?account=seeded&ready=1' },
    });
    assert.equal(
      ran.stdout.trim().split('\n').at(-1),
      'mc: the tree was edited, so the server restarted — the page was opened again at /app/tools/vault; what it held in memory is gone',
    );
    const session = sessionOf(fx, 's1');
    assert.equal(session.server_id, 'srv-2');
    assert.equal(session.base_url, 'http://127.0.0.1:8790');
    const same = await mc(['next', '--no-shot', '--eval', '1'], fx, { ensureAppServer: restarted });
    assert.equal(Object.hasOwn(fake.received[1], 'rebase'), false, 'the same server, no rebase');
    assert.doesNotMatch(same.stdout, /restarted/u);
  });

  it('prod never rebases', async () => {
    const fx = fixture();
    const fake = await fakeSession(fx, { id: 's1', where: 'prod', serverId: null });
    let asked = false;
    const ran = await mc(['next', '--no-shot', '--eval', '1'], fx, { ensureAppServer: async () => { asked = true; return { ok: false }; } });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(asked, false);
    assert.equal(Object.hasOwn(fake.received[0], 'rebase'), false);
  });

  it('a dead session is one line, and its file goes', async () => {
    const fx = fixture();
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const fake = await fakeSession(fx, { id: 's1', pid: dead });
    writeFileSync(fake.session.log, 'fake: listening\nError: browser has disconnected\n');
    const ran = await mc(['next', '--click', 'x'], fx);
    assert.equal(ran.code, 1);
    assert.equal(ran.stdout, '');
    assert.equal(ran.stderr, 'mc: s1 has ended (Error: browser has disconnected) — start again with mc shot dev vault --keep\n');
    assert.equal(existsSync(fake.file), false);
    assert.equal(fake.received.length, 0);
  });

  it('a socket that refuses is a dead session too, and nothing kept is said in one line', async () => {
    const fx = fixture();
    mkdirSync(fx.sessions, { recursive: true });
    writeFileSync(join(fx.sessions, 's2.json'), JSON.stringify({
      id: 's2', pid: process.pid, socket: join(fx.sessions, 's2.sock'), log: join(fx.sessions, 's2.log'), where: 'prod',
      worktree: fx.worktree, target: 'home', viewport: 'desktop', last_used: NOW.toISOString(),
    }));
    const ran = await mc(['next', 's2', '--no-shot', '--eval', '1'], fx);
    assert.equal(ran.code, 1);
    assert.equal(ran.stderr, 'mc: s2 has ended (it left no log) — start again with mc shot prod home --keep\n');
    const none = await mc(['next', '--click', 'x'], fx);
    assert.equal(none.code, 1);
    assert.equal(none.stderr, 'mc: no browser is kept — mc shot <dev|prod> <target> --keep keeps one\n');
  });

  it('two sessions elsewhere and none here: name one', async () => {
    const fx = fixture();
    await fakeSession(fx, { id: 's1', worktree: fx.other });
    await fakeSession(fx, { id: 's2', worktree: fx.other });
    const ran = await mc(['next', '--click', 'x'], fx, { callerWorktree: () => join(fx.home, 'elsewhere'), env: { MC_REPOS_HOME: join(fx.home, 'none') } });
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /2 browsers are kept and none is this worktree's — name one: s1 \(dev vault, memoro-b\), s2 \(dev vault, memoro-b\)/u);
  });
});

describe('mc shot sessions and close', () => {
  it('sessions lists the live ones and removes the dead ones\' files', async () => {
    const fx = fixture();
    await fakeSession(fx, { id: 's1', lastUsed: minutesAgo(7) });
    const dead = await fakeSession(fx, { id: 's2', pid: spawnSync(process.execPath, ['-e', '']).pid });
    const listed = await mc(['sessions'], fx);
    assert.equal(listed.code, 0);
    assert.equal(listed.stdout, 's1  dev vault  memoro  desktop  idle 7 min\n');
    assert.equal(existsSync(dead.file), false);
    assert.equal(existsSync(dead.session.log), false);
  });

  it('close asks first, then ends a process that does not leave', async () => {
    const fx = fixture();
    const alive = new Set([900007]);
    const killed = [];
    const fake = await fakeSession(fx, { id: 's1', pid: 900007 });
    const closed = await mc(['close'], fx, {
      alive: (pid) => alive.has(pid), closeWaitMs: 200, kill: (pid, signal) => { killed.push([pid, signal]); alive.delete(pid); },
    });
    assert.equal(closed.code, 0, closed.stderr);
    assert.deepEqual(fake.received, [{ close: true }]);
    assert.deepEqual(killed, [[900007, 'SIGTERM']]);
    assert.equal(closed.stdout, 'mc: closed s1 — it did not leave within 5 s, so it was ended\n');
    assert.equal(existsSync(fake.file), false);
    const none = await mc(['sessions'], fx);
    assert.match(none.stdout, /no browser is kept/u);
  });
});

describe('mc shot --help', () => {
  it('lists the forms and the example', () => {
    for (const form of ['--keep', 'mc shot next [<id>] [step flags]', 'mc shot close [<id>|--all]', 'mc shot sessions',
      '--goto <path|target>', '--reload', '--no-shot',
      "mc shot dev /app/tools/vault --keep --fill 'input[name=setupPassword]=…'",
      "mc shot next --click 'text=New entry' --eval 'document.activeElement.name'"]) {
      assert.ok(usage().includes(form), form);
    }
  });
});
