/**
 * `mc work send` — the file first, the waking second (designnote §2, §3).
 *
 * The four guarantees, asserted:
 *
 *  1. the message always survives — after every outcome but "no such area"
 *     it is readable in the recipient's `inbox/`;
 *  2. send writes nothing else — one file, and nothing anywhere near a
 *     repository, the registry, or anyone's transcript;
 *  3. waking either submits or reports — never silently half-typed into the
 *     prompt, which is the tmux Enter bug, asserted against a tmux that has
 *     been told to reproduce it;
 *  4. ordinary commands are unchanged.
 */
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { wakeConversation, writeMessage } from '../../src/mc/work-send.js';

const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * A work root with two pieces of work in it, and a tmux that does what the
 * test needs it to do.
 */
function fixture({ mode = 'reliable', alive = [], drawAfter = 0, busyFor = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-work-send-'));
  const workRoot = join(root, 'work');
  const mcHome = join(root, 'home');
  mkdirSync(join(workRoot, 'pm'), { recursive: true });
  mkdirSync(join(workRoot, 'alpha'), { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  const tmux = installTmuxStub(root, { mode, alive, drawAfter, busyFor });

  return {
    root,
    workRoot,
    mcHome,
    tmux,
    inbox: (name) => join(workRoot, name, 'inbox'),
    messages: (name) => {
      const path = join(workRoot, name, 'inbox');
      return existsSync(path) ? readdirSync(path).sort() : [];
    },
    read: (name) => {
      const [file] = readdirSync(join(workRoot, name, 'inbox')).sort();
      return readFileSync(join(workRoot, name, 'inbox', file), 'utf8');
    },
    env: {
      MC_HOME: mcHome,
      MC_WORK_ROOT: workRoot,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      PATH: `${tmux.bin}:${SAFE_PATH}`,
    },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

/** Every file under a directory, with its size and modification time. */
function snapshot(dir) {
  const seen = {};
  const walk = (here) => {
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      const full = join(here, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = statSync(full);
      seen[relative(dir, full)] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  if (existsSync(dir)) walk(dir);
  return seen;
}

describe('mc work send — the channel', () => {
  it('writes the message to the recipient\'s inbox, from whoever sent it', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'SLUTRAPPORT — klar'], fx.env, {
        cwd: join(fx.workRoot, 'alpha'),
      });
      assert.equal(sent.status, 0, sent.stderr);
      assert.equal(fx.messages('pm').length, 1);

      const text = fx.read('pm');
      assert.match(text, /^---\nfrom: alpha\nat: \d{4}-\d{2}-\d{2}T[\d:.]+Z\n---\n\nSLUTRAPPORT — klar\n$/u);
      // Named so the inbox sorts by arrival and says who each one is from.
      assert.match(fx.messages('pm')[0], /^\d{4}-\d{2}-\d{2}T[\d.-]+Z-alpha\.md$/u);
    } finally { fx.cleanup(); }
  });

  it('the sender is derived from where the shell is, not declared', () => {
    const fx = fixture();
    try {
      runMcCli(['work', 'send', 'pm', 'from inside'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.match(fx.read('pm'), /from: alpha/u);

      // Outside the work root the sender is the person at the keyboard.
      runMcCli(['work', 'send', 'alpha', 'from outside'], fx.env, { cwd: fx.root });
      assert.match(fx.read('alpha'), /from: \S+@\S+/u);
    } finally { fx.cleanup(); }
  });

  it('nothing running there is not an error: the file waits for its boot', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'a report'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /nothing is running in pm — it reads its inbox when it starts/u);
      assert.equal(fx.messages('pm').length, 1);
      // It never even tried to type at anything.
      assert.deepEqual(fx.tmux.calls().filter((line) => line.startsWith('send-keys')), []);
    } finally { fx.cleanup(); }
  });

  it('wakes a live conversation as a real turn — text, then Enter, verified', () => {
    const fx = fixture({ alive: ['pm'] });
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'wake up'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /woke pm/u);

      // One turn arrived, and it says where to look — not the message itself.
      assert.equal(fx.tmux.submitted().length, 1);
      assert.match(fx.tmux.submitted()[0], /nytt i inbox\/ från alpha/u);
      assert.equal(fx.tmux.prompt(), '', 'something was left sitting in the prompt');

      // Text and Enter were separate keystrokes, and the text went in
      // literally: a message is never allowed to become key names.
      const keys = fx.tmux.calls().filter((line) => line.startsWith('send-keys'));
      assert.equal(keys.length, 2, keys.join(' | '));
      assert.match(keys[0], /send-keys -t mc-pm -l /u);
      assert.equal(keys[1], 'send-keys -t mc-pm Enter');
    } finally { fx.cleanup(); }
  });

  it('a slow pane is waited for, not given up on', () => {
    // The live smoke's finding: under load the text was in the prompt but had
    // not been painted when mc looked, and one glance was enough to abandon a
    // wake that would have worked. Here the pane hides it for three captures.
    const fx = fixture({ alive: ['pm'], drawAfter: 3 });
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'wake up'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /woke pm/u);
      assert.doesNotMatch(sent.stdout, /never reached the prompt/u);

      // It looked more than once before believing the prompt was empty, and
      // it still pressed Enter exactly once.
      assert.ok(fx.tmux.captures() >= 4, `only ${fx.tmux.captures()} captures`);
      assert.equal(fx.tmux.calls().filter((line) => line.endsWith('Enter')).length, 1);
      assert.equal(fx.tmux.submitted().length, 1);
      assert.equal(fx.tmux.prompt(), '');
    } finally { fx.cleanup(); }
  });

  it('a conversation mid-answer is waited for past the ordinary budget', () => {
    // A streaming TUI does not repaint its input box until it pauses, so the
    // notice is there and invisible for as long as the answer runs — well past
    // the five looks a quiet pane gets. And the recipient of a message is
    // exactly the session likeliest to be busy: it is doing the work being
    // written to it about.
    const fx = fixture({ alive: ['pm'], drawAfter: 8, busyFor: 8 });
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'wake up'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /woke pm/u);
      assert.ok(fx.tmux.captures() > 5, `gave up at ${fx.tmux.captures()} captures`);
      assert.equal(fx.tmux.submitted().length, 1);
      assert.equal(fx.tmux.prompt(), '');
    } finally { fx.cleanup(); }
  });

  it('a pane that never shows the text is given up on, and says so', () => {
    // The other half of the same judgement: waiting is not waiting forever.
    // Delivered, not woken — and the file is in the inbox either way.
    const fx = fixture({ alive: ['pm'], drawAfter: 99 });
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'wake up'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /could not wake it \(the text never reached the prompt\)/u);
      assert.equal(fx.messages('pm').length, 1);
      // It gave up before pressing Enter: an unseen prompt must never be
      // submitted into on faith.
      assert.deepEqual(fx.tmux.calls().filter((line) => line.endsWith('Enter')), []);
      assert.equal(fx.tmux.captures(), 5);
    } finally { fx.cleanup(); }
  });

  it('the Enter bug: a swallowed first Enter is retried, and the turn lands', () => {
    const fx = fixture({ alive: ['pm'], mode: 'sticky' });
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'wake up'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /woke pm/u);

      const keys = fx.tmux.calls().filter((line) => line === 'send-keys -t mc-pm Enter');
      assert.equal(keys.length, 2, 'the swallowed Enter was not retried');
      assert.equal(fx.tmux.submitted().length, 1, 'the notice arrived twice or not at all');
      assert.equal(fx.tmux.prompt(), '');
    } finally { fx.cleanup(); }
  });

  it('a conversation that will not take it is reported, never assumed', () => {
    const fx = fixture({ alive: ['pm'], mode: 'broken' });
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'wake up'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      // The message is delivered, so this is not a failure — but the sender
      // is told plainly that nobody was woken.
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /could not wake it \(it stayed in the prompt\)/u);
      assert.equal(fx.messages('pm').length, 1);
      assert.match(fx.read('pm'), /wake up/u);
      // It tried twice and then stopped rather than hammering the pane.
      assert.equal(fx.tmux.calls().filter((line) => line.endsWith('Enter')).length, 2);
      // And it left the recipient's prompt as it found it. A notice abandoned
      // in the input box is not litter — it goes in in front of whatever that
      // conversation types next, so a wake mc knew had failed would have
      // corrupted the very turn it failed to start.
      assert.equal(fx.tmux.prompt(), '');
      assert.equal(fx.tmux.calls().filter((line) => line.endsWith('C-u')).length, 1);
    } finally { fx.cleanup(); }
  });

  it('the message itself never becomes keystrokes', () => {
    const fx = fixture({ alive: ['pm'] });
    try {
      runMcCli(['work', 'send', 'pm', 'C-c Escape Enter ; kill-server'], fx.env, {
        cwd: join(fx.workRoot, 'alpha'),
      });
      const typed = fx.tmux.calls().join('\n');
      assert.doesNotMatch(typed, /kill-server/u);
      assert.doesNotMatch(typed, /C-c/u);
      // It is in the inbox, whole, where it belongs.
      assert.match(fx.read('pm'), /C-c Escape Enter ; kill-server/u);
    } finally { fx.cleanup(); }
  });

  it('writes the one file and nothing else, anywhere', () => {
    const fx = fixture({ alive: ['pm'] });
    try {
      const before = { work: snapshot(fx.workRoot), home: snapshot(fx.mcHome) };
      runMcCli(['work', 'send', 'pm', 'a report'], fx.env, { cwd: join(fx.workRoot, 'alpha') });

      const after = snapshot(fx.workRoot);
      const added = Object.keys(after).filter((path) => !(path in before.work));
      const changed = Object.keys(after).filter((path) => path in before.work && after[path] !== before.work[path]);
      assert.equal(added.length, 1, added.join(', '));
      assert.match(added[0], /^pm\/inbox\/.*\.md$/u);
      assert.deepEqual(changed, []);
      assert.deepEqual(snapshot(fx.mcHome), before.home);
    } finally { fx.cleanup(); }
  });

  it('an area that does not exist is the one real failure', () => {
    const fx = fixture();
    try {
      const before = snapshot(fx.workRoot);
      const sent = runMcCli(['work', 'send', 'nowhere', 'hello'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 1);
      assert.match(sent.stderr, /nothing called "nowhere"/u);
      assert.deepEqual(snapshot(fx.workRoot), before);
    } finally { fx.cleanup(); }
  });

  it('asks for the message rather than sending an empty one', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 2);
      assert.match(sent.stderr, /what should it say\?/u);
      assert.equal(existsSync(fx.inbox('pm')), false);
    } finally { fx.cleanup(); }
  });

  it('two messages in the same millisecond are two messages', () => {
    const fx = fixture();
    try {
      const now = new Date('2026-08-15T09:00:00.000Z');
      const areaPath = join(fx.workRoot, 'pm');
      const sender = { name: 'alpha', kind: 'work-area' };
      const first = writeMessage({ areaPath, message: 'one', sender, now });
      const second = writeMessage({ areaPath, message: 'two', sender, now });
      assert.notEqual(first, second);
      assert.equal(fx.messages('pm').length, 2);
      assert.match(readFileSync(first, 'utf8'), /one/u);
      assert.match(readFileSync(second, 'utf8'), /two/u);
    } finally { fx.cleanup(); }
  });

  it('tells a sent notice from one still waiting in the box', () => {
    // The two ways of getting this wrong, pinned. A pane is scripted rather
    // than stubbed on disk so the exact layout is the subject of the test.
    const pane = (lines) => ({ status: 0, stdout: `${lines.join('\n')}\n\n\n\n\n` });
    const box = (typed) => ['+----------------------+', `| > ${typed}`, '+----------------------+', '  ? for shortcuts'];

    const runs = [];
    const scripted = (panes) => (args) => {
      runs.push(args.join(' '));
      if (args[0] === 'capture-pane') return panes.shift() ?? { status: 1 };
      return { status: 0, stdout: '' };
    };

    // Sent: the notice is a turn, with the whole empty box beneath it.
    const sent = wakeConversation({
      target: 'mc-pm',
      sender: 'alpha',
      sleep: () => {},
      run: scripted([
        pane(['a conversation', ...box('mc: nytt i inbox/ från alpha — läs nu')]),
        pane(['a conversation', '> mc: nytt i inbox/ från alpha — läs nu', ...box('')]),
      ]),
    });
    assert.deepEqual(sent, { ok: true, attempts: 1 });

    // Still waiting, and wrapped onto a second row — which is what made a
    // fixed number of lines the wrong rule.
    const waiting = wakeConversation({
      target: 'mc-pm',
      sender: 'alpha',
      sleep: () => {},
      run: scripted([
        pane(['a conversation', '+---------+', '| > mc: nytt i inbox/', 'från alpha — läs nu', '+---------+', '  ? for shortcuts']),
        pane(['a conversation', '+---------+', '| > mc: nytt i inbox/', 'från alpha — läs nu', '+---------+', '  ? for shortcuts']),
        pane(['a conversation', '+---------+', '| > mc: nytt i inbox/', 'från alpha — läs nu', '+---------+', '  ? for shortcuts']),
      ]),
    });
    assert.equal(waiting.ok, false);
    assert.equal(waiting.reason, 'it stayed in the prompt');
  });

  it('leaves the ordinary work commands exactly as they were', () => {
    const fx = fixture();
    try {
      runMcCli(['work', 'send', 'pm', 'a report'], fx.env, { cwd: join(fx.workRoot, 'alpha') });

      const listed = runMcCli(['work', 'list', '--json'], fx.env);
      assert.equal(listed.status, 0, listed.stderr);
      const areas = JSON.parse(listed.stdout).areas.map((area) => area.name).sort();
      assert.deepEqual(areas, ['alpha', 'pm']);

      const board = runMcCli(['status', '--json'], fx.env);
      assert.equal(board.status, 0, board.stderr);
      // The inbox is filing, not work: the board lists no worktree for it.
      // (It used to appear here as a repository that is not one — see
      // status-roles.test.js, which owns that rule now.)
      const page = JSON.parse(board.stdout);
      const pm = page.areas.find((area) => area.name === 'pm');
      assert.deepEqual(pm.worktrees, []);
    } finally { fx.cleanup(); }
  });
});
