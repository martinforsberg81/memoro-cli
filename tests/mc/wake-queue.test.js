/**
 * A wake refused on a draft is owed, not dropped (2026-08-22: a session with a
 * draft in its prompt stood unreachable for twenty minutes with an answer in
 * its inbox; reaching it by hand cleared the draft). Queued, retried by the
 * guard's round, visible on the board meanwhile — and nothing ever types
 * over the draft.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { dropWake, enqueueWake, flushWakeQueue, pendingWakeFor, readWakeQueue } from '../../src/mc/wake-queue.js';
import { flushPendingWakes } from '../../src/mc/work-send.js';
import { clock, renderLines } from '../../src/mc/status-render.js';
import { watchRound } from '../../src/mc/watch-sessions-loop.js';

const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('the wake queue', () => {
  const home = () => mkdtempSync(join(tmpdir(), 'mc-wake-queue-'));

  it('holds one entry per area, oldest first, and forgets on demand', () => {
    const root = home();
    try {
      assert.deepEqual(readWakeQueue({ root }), []);
      const first = enqueueWake({ name: 'alpha', target: 'mc-alpha', sender: 'pm', reason: 'draft', root, now: new Date('2026-08-22T21:14:00Z') });
      assert.equal(first.already, false);
      const again = enqueueWake({ name: 'alpha', sender: 'pm', root, now: new Date('2026-08-22T21:30:00Z') });
      assert.equal(again.already, true);
      assert.equal(again.entry.since, '2026-08-22T21:14:00.000Z', 'the first refusal is "since"');
      enqueueWake({ name: 'beta', root });
      assert.deepEqual(readWakeQueue({ root }).map((item) => item.name), ['alpha', 'beta']);
      assert.equal(pendingWakeFor('alpha', { root }).target, 'mc-alpha');
      assert.equal(dropWake({ name: 'alpha', root }), true);
      assert.equal(dropWake({ name: 'alpha', root }), false);
      assert.equal(pendingWakeFor('alpha', { root }), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a flush drops what landed and what is gone, keeps the rest with the attempt counted', () => {
    const root = home();
    try {
      for (const name of ['landed', 'gone', 'still']) enqueueWake({ name, root });
      const outcomes = flushWakeQueue({
        root,
        attempt: (entry) => ({ landed: { ok: true }, gone: { ok: false, gone: true, reason: 'stopped' }, still: { ok: false, reason: 'draft' } })[entry.name],
      });
      assert.deepEqual(outcomes.map((item) => `${item.name}:${item.outcome}`), ['landed:woke', 'gone:gone', 'still:kept']);
      const left = readWakeQueue({ root });
      assert.deepEqual(left.map((item) => item.name), ['still']);
      assert.equal(left[0].attempts, 1);
      assert.equal(left[0].last_reason, 'draft');
      // An attempt that throws keeps the entry rather than losing it.
      flushWakeQueue({ root, attempt: () => { throw new Error('tmux gone'); } });
      assert.equal(readWakeQueue({ root })[0].attempts, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/** A work root with an area, and a tmux told how the pane looks. */
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-wake-queue-cli-'));
  const workRoot = join(root, 'work');
  const mcHome = join(root, 'home');
  mkdirSync(join(workRoot, 'alpha'), { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  const tmux = installTmuxStub(root, options);
  const env = {
    MC_HOME: mcHome, MC_WORK_ROOT: workRoot, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'),
    PATH: `${tmux.bin}:${SAFE_PATH}`,
  };
  return {
    root, mcHome, tmux, env,
    send: (args) => runMcCli(['work', 'send', ...args], env, { cwd: join(workRoot, 'alpha') }),
    messages: () => (existsSync(join(workRoot, 'alpha', 'inbox')) ? readdirSync(join(workRoot, 'alpha', 'inbox')) : []),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('a wake refused on a draft is queued, and lands when the prompt clears', () => {
  it('says queued rather than did not knock, and the board shows the session unreachable since then', () => {
    const fx = fixture({ alive: ['alpha'], typedAlready: 'half a question of mine' });
    try {
      const sent = fx.send(['alpha', '--wake', 'read me']);
      assert.equal(sent.status, 0, sent.stderr);
      assert.equal(fx.messages().length, 1, 'the file is delivered either way');
      assert.match(sent.stdout, /queued — a draft is in alpha's prompt, so nothing was typed; it will be knocked when the prompt clears/u);
      assert.match(sent.stdout, /mc status shows alpha as unreachable by wake/u);
      assert.deepEqual(fx.tmux.submitted(), [], 'the draft was not sent');
      assert.equal(fx.tmux.prompt(), 'half a question of mine', 'and not touched');
      const queued = pendingWakeFor('alpha', { root: fx.mcHome });
      assert.equal(queued.target, 'mc-alpha');

      const page = renderLines({
        areas: [{ name: 'alpha', path: '/x', running: [], worktrees: [], conversations: [], waiting: false, working: true, pending_wake: queued }],
        summary: { areas: 1, waiting: 0, working: 1 },
      }, { columns: 140 }).join('\n');
      assert.match(page, new RegExp(`✉ draft in prompt — unreachable by wake since ${clock(queued.since)} \\(wake queued; it lands when the prompt clears\\)`, 'u'));
    } finally { fx.cleanup(); }
  });

  it('--json carries queued and since', () => {
    const fx = fixture({ alive: ['alpha'], typedAlready: 'draft' });
    try {
      const result = JSON.parse(fx.send(['alpha', '--wake', '--json', 'read me']).stdout);
      assert.equal(result.queued, true);
      assert.equal(result.woke, false);
      assert.equal(result.reason, 'queued');
      assert.match(result.since, /^\d{4}-/u);
    } finally { fx.cleanup(); }
  });

  it('the flush knocks once the prompt is empty, and the entry goes', () => {
    const fx = fixture({ alive: ['alpha'], typedAlready: 'draft' });
    try {
      fx.send(['alpha', '--wake', 'read me']);
      assert.ok(pendingWakeFor('alpha', { root: fx.mcHome }));
      // Still a draft: kept, nothing typed but the probe.
      const before = fx.tmux.submitted().length;
      const env = { ...process.env, PATH: fx.env.PATH, MC_WORK_ROOT: fx.env.MC_WORK_ROOT };
      const spawn = (args) => runTmux(fx, args);
      let outcomes = flushPendingWakes({ root: fx.mcHome, run: spawn, sleep: () => {} });
      assert.equal(outcomes[0].outcome, 'kept');
      assert.equal(fx.tmux.submitted().length, before);
      assert.equal(fx.tmux.prompt(), 'draft');
      // The person sends their draft; the prompt is empty; the knock lands.
      spawn(['send-keys', '-t', 'mc-alpha', 'Enter']);
      const lines = [];
      outcomes = flushPendingWakes({ root: fx.mcHome, run: spawn, sleep: () => {}, log: (line) => lines.push(line) });
      assert.equal(outcomes[0].outcome, 'woke', JSON.stringify(outcomes));
      // The notice names the path, not the word (D-0163) — also from the queue.
      const inbox = `${join(fx.env.MC_WORK_ROOT, 'alpha', 'inbox')}/`;
      assert.ok(fx.tmux.submitted().some((line) => line.includes(`mc: new in ${inbox} from`)), fx.tmux.submitted().join('\n'));
      assert.equal(pendingWakeFor('alpha', { root: fx.mcHome }), null);
      assert.match(lines[0], /queued wake landed in alpha/u);
      void env;
    } finally { fx.cleanup(); }
  });

  it('a target that stopped is dropped from the queue — the file is still in the inbox', () => {
    const fx = fixture({ alive: ['alpha'], typedAlready: 'draft' });
    try {
      fx.send(['alpha', '--wake', 'read me']);
      rmSync(join(fx.tmux.state, 'alive-mc-alpha'));
      const outcomes = flushPendingWakes({ root: fx.mcHome, run: (args) => runTmux(fx, args), sleep: () => {} });
      assert.equal(outcomes[0].outcome, 'gone');
      assert.equal(pendingWakeFor('alpha', { root: fx.mcHome }), null);
    } finally { fx.cleanup(); }
  });

  it('a knock that landed on its own forgets the queued one', () => {
    const fx = fixture({ alive: ['alpha'], typedAlready: 'draft' });
    try {
      fx.send(['alpha', '--wake', 'read me']);
      runTmux(fx, ['send-keys', '-t', 'mc-alpha', 'C-u']);
      const sent = fx.send(['alpha', '--wake', 'read me again']);
      assert.match(sent.stdout, /woke alpha/u);
      assert.equal(pendingWakeFor('alpha', { root: fx.mcHome }), null);
    } finally { fx.cleanup(); }
  });

  it('the guard\'s round tries the queue first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-wake-queue-round-'));
    try {
      const flushed = [];
      await watchRound({
        root,
        status: async () => ({ areas: [], summary: { areas: 0, waiting: 0, working: 0 } }),
        read: async () => ({ text: '' }),
        send: async () => ({ ok: true, woke: true }),
        flush: (options) => { flushed.push(options.root); return []; },
      });
      assert.deepEqual(flushed, [root]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/** Run the stub tmux as `wakeConversation` would, from the test's PATH. */
function runTmux(fx, args) {
  const { spawnSync } = require_child_process();
  return spawnSync(join(fx.tmux.bin, 'tmux'), args, { encoding: 'utf8' });
}
import { createRequire } from 'node:module';
function require_child_process() { return createRequire(import.meta.url)('node:child_process'); }
