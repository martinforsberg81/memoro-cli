/**
 * Starting over: `mc pm new`, `mc pm <id>`, and `mc work <name> new`.
 *
 * The failure these replace: every way into a singleton role meant "take me to
 * the PM", so a handoff could not be performed at all. The PM respawned its own
 * window by hand, `mc pm` resumed as it always does, and nothing said the
 * handoff had not happened. `mc work <name> new` had the same shape — against a
 * background session it printed *joining …* and attached, with `new` never read.
 *
 * The same rule reaches `mc work <name> <id>`: a conversation named against a
 * running session is refused with both ways on, rather than joined — landing in
 * whatever happens to run is the outcome nobody can see is wrong from outside.
 *
 * What is asserted here is the whole mechanism: the window is respawned rather
 * than the session recreated (so an attached client rides across it), the index
 * is the one tmux reports rather than 0, the predecessor is ended politely from
 * outside and abruptly from inside — and which of the two happened is written
 * to the log. Nothing is deleted, and the successor is handed the one line that
 * reaches its predecessor.
 *
 * tmux is the stub throughout; no session is ever started. Most cases go the
 * abrupt way on purpose: it respawns the same window with the same command,
 * and asserting the rest through it keeps the suite off the tool's own exit
 * budget — two and a half seconds of real waiting, per case, for a keystroke
 * the polite tests already prove is sent.
 */
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';

const PM_MD = `---
name: pm
model: fable
singleton: true
tools: claude
---
You are the PM. Read state.md first.`;

const PREDECESSOR = '7c1e4b90-0000-4000-8000-000000000042';
const OLDER = '1a2b3c4d-0000-4000-8000-000000000001';

/**
 * A machine with a pm role defined, a stubbed tmux, and nothing else.
 *
 * `running` puts the pm session in tmux's world; `windowIndex` is what tmux
 * says its window is called; `insideIt` makes the caller a client of that very
 * session, which is the difference between the polite path and the abrupt one.
 */
function fixture({
  running = false, windowIndex = '0', insideIt = false, area = 'pm',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-fresh-'));
  const rolesDir = join(root, 'roles');
  mkdirSync(rolesDir);
  writeFileSync(join(rolesDir, 'pm.md'), PM_MD);

  const workRoot = join(root, 'work');
  const mcHome = join(root, 'home');
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  const tmux = installTmuxStub(root, {
    alive: running ? [area] : [],
    windowIndex,
    clientSession: insideIt ? `mc-${area}` : '',
  });

  return {
    root,
    workRoot,
    tmux,
    claudeHome: join(root, 'claude'),
    logPath: join(mcHome, 'logs', 'mc.log'),
    env: {
      MC_HOME: mcHome,
      MC_WORK_ROOT: workRoot,
      MC_ROLES_DIR: rolesDir,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      MC_NO_PROMPT: '1',
      PATH: `${tmux.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ...(insideIt ? { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%1' } : {}),
    },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

/** An area that already exists, with the role mark a role home carries. */
function makeHome(fx, name = 'pm', { role = 'pm' } = {}) {
  const path = join(fx.workRoot, name);
  mkdirSync(path, { recursive: true });
  if (role) writeFileSync(join(path, '.mc-role'), `${role}\n`);
  return path;
}

/** A conversation in Claude's own store, indexed by the directory it ran in. */
function recordConversation(fx, areaPath, id, entries = [{ type: 'user', message: { content: 'boot' } }]) {
  const projectDir = join(fx.claudeHome, 'projects', areaPath.replace(/[/.]/gu, '-'));
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${id}.jsonl`);
  writeFileSync(file, `${entries.map((entry) => JSON.stringify({ cwd: areaPath, ...entry })).join('\n')}\n`);
  return file;
}

const called = (fx, verb) => fx.tmux.calls().filter((line) => line.startsWith(verb));

function respawnLine(fx) {
  const found = called(fx, 'respawn-window');
  assert.equal(found.length, 1, `expected one respawn-window, got:\n${fx.tmux.calls().join('\n')}`);
  return found[0];
}

function events(fx, name) {
  if (!existsSync(fx.logPath)) return [];
  return readFileSync(fx.logPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === name);
}

describe('mc pm new — against a running pm', () => {
  it('replaces the window in place and starts a new conversation, not a resume', () => {
    const fx = fixture({ running: true, insideIt: true });
    try {
      const home = makeHome(fx);
      const transcript = recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['pm', 'new'], fx.env);
      assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);

      const line = respawnLine(fx);
      // The session and its window survive: whoever is attached stays attached.
      assert.match(line, /respawn-window -k -t mc-pm:0 -c /u, line);
      assert.deepEqual(called(fx, 'new-session'), [], 'the session must not be recreated');
      assert.deepEqual(called(fx, 'kill-session'), [], 'nothing is killed outright');
      // A new conversation: the overlay is delivered, nothing is resumed.
      assert.ok(line.includes('You are the PM. Read state.md first.'), line);
      assert.ok(!line.includes('--resume'), line);
      // And the predecessor is still exactly where it was.
      assert.ok(existsSync(transcript), 'nothing may be deleted');
    } finally { fx.cleanup(); }
  });

  it('hands the successor the one line that reaches its predecessor', () => {
    const fx = fixture({ running: true, insideIt: true });
    try {
      const home = makeHome(fx);
      recordConversation(fx, home, PREDECESSOR);
      assert.equal(runMcCli(['pm', 'new'], fx.env).status, 0);
      const line = respawnLine(fx);
      assert.ok(line.includes(`Predecessor: ${PREDECESSOR}`), line);
      assert.ok(line.includes(`mc pm ${PREDECESSOR}`), line);
    } finally { fx.cleanup(); }
  });

  it('respawns the window tmux names, not the index it is assumed to have', () => {
    // base-index is the user's setting; a home with no window 0 is ordinary.
    const fx = fixture({ running: true, windowIndex: '3', insideIt: true });
    try {
      makeHome(fx);
      assert.equal(runMcCli(['pm', 'new'], fx.env).status, 0);
      assert.match(respawnLine(fx), /-t mc-pm:3 /u);
    } finally { fx.cleanup(); }
  });

  it('from outside, the predecessor is asked to leave first — and says it was', () => {
    const fx = fixture({ running: true });
    try {
      makeHome(fx);
      const result = runMcCli(['pm', 'new'], fx.env);
      assert.equal(result.status, 0, result.stderr);
      const keys = fx.tmux.keys();
      assert.ok(keys.some((line) => line.includes('/exit')), keys.join('\n'));
      // The window is pinned while the tool leaves: a tool that does exit
      // takes the session's only window with it otherwise, evicting everyone.
      const options = called(fx, 'set-option').filter((line) => line.includes('remain-on-exit'));
      assert.deepEqual(options, [
        'set-option -w -t mc-pm:0 remain-on-exit on',
        'set-option -w -t mc-pm:0 remain-on-exit off',
      ]);
      const [logged] = events(fx, 'role.singleton-new');
      assert.equal(logged.graceful, true);
      assert.equal(logged.target, 'mc-pm');
    } finally { fx.cleanup(); }
  });

  it('from inside its own session it takes the abrupt path, and logs which', () => {
    const fx = fixture({ running: true, insideIt: true });
    try {
      const home = makeHome(fx);
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['pm', 'new'], fx.env);
      assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
      // Nobody can wait for a tool to leave when the waiting turn is the one
      // being replaced, so mc does not pretend to try.
      assert.deepEqual(fx.tmux.keys(), []);
      assert.match(result.stderr, /from inside its own session/u);
      assert.match(result.stderr, /turn in flight/u);
      const [logged] = events(fx, 'role.singleton-new');
      assert.equal(logged.graceful, false);
      assert.equal(logged.predecessor, PREDECESSOR);
      assert.match(respawnLine(fx), /-t mc-pm:0 /u);
    } finally { fx.cleanup(); }
  });

  it('--model is the successor\'s to choose; without it, the role\'s default', () => {
    const fx = fixture({ running: true, insideIt: true });
    try {
      const home = makeHome(fx);
      // A predecessor pinned to something else: a fresh session must not
      // inherit it, which would be the old conversation reaching into the new.
      recordConversation(fx, home, PREDECESSOR, [
        { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [] } },
      ]);
      assert.equal(runMcCli(['pm', 'new'], fx.env).status, 0);
      const line = respawnLine(fx);
      assert.ok(line.includes(`'--model' 'fable'`), line);
      assert.ok(!line.includes('haiku'), line);
    } finally { fx.cleanup(); }
  });

  it('--model reaches the successor when it is given', () => {
    const fx = fixture({ running: true, insideIt: true });
    try {
      makeHome(fx);
      assert.equal(runMcCli(['pm', 'new', '--model', 'opus'], fx.env).status, 0);
      assert.ok(respawnLine(fx).includes(`'--model' 'opus'`));
    } finally { fx.cleanup(); }
  });

  it('and --model without new is still refused against a live conversation', () => {
    const fx = fixture({ running: true });
    try {
      makeHome(fx);
      const result = runMcCli(['pm', '--model', 'opus'], fx.env);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cannot change model/u);
      assert.deepEqual(called(fx, 'respawn-window'), []);
    } finally { fx.cleanup(); }
  });
});

describe('mc pm new — with nothing running', () => {
  it('starts a new conversation rather than resuming the newest', () => {
    const fx = fixture();
    try {
      const home = makeHome(fx);
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['pm', 'new'], fx.env);
      assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
      const [created] = called(fx, 'new-session');
      assert.ok(created, fx.tmux.calls().join('\n'));
      assert.ok(!created.includes('--resume'), created);
      assert.ok(created.includes('You are the PM. Read state.md first.'), created);
      assert.ok(created.includes(`Predecessor: ${PREDECESSOR}`), created);
      assert.deepEqual(called(fx, 'respawn-window'), [], 'there is no predecessor process to replace');
    } finally { fx.cleanup(); }
  });

  it('a first pm ever is a new conversation with nobody to succeed', () => {
    const fx = fixture();
    try {
      const result = runMcCli(['pm', 'new'], fx.env);
      assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
      const [created] = called(fx, 'new-session');
      assert.ok(created.includes('You are the PM'), created);
      assert.ok(!created.includes('Predecessor:'), created);
    } finally { fx.cleanup(); }
  });
});

describe('mc pm <conversation id> — the way back', () => {
  it('resumes exactly that conversation, not the newest', () => {
    const fx = fixture();
    try {
      const home = makeHome(fx);
      recordConversation(fx, home, OLDER);
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['pm', OLDER.slice(0, 8)], fx.env);
      assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
      const [created] = called(fx, 'new-session');
      assert.ok(created.includes(`'--resume' '${OLDER}'`), created);
      assert.ok(!created.includes('You are the PM'), 'a resume is not re-told what it is');
      assert.match(result.stderr, /resuming 1a2b3c4d/u);
    } finally { fx.cleanup(); }
  });

  it('an id that matches nothing is an error, never a new conversation', () => {
    const fx = fixture();
    try {
      const home = makeHome(fx);
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['pm', 'deadbeef'], fx.env);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /no conversation in the pm's home starts with deadbeef/u);
      assert.deepEqual(called(fx, 'new-session'), [], 'nothing may be started');
      assert.deepEqual(called(fx, 'respawn-window'), []);
    } finally { fx.cleanup(); }
  });

  it('while the pm runs it refuses, rather than attaching to the other one', () => {
    const fx = fixture({ running: true });
    try {
      const home = makeHome(fx);
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['pm', PREDECESSOR.slice(0, 8)], fx.env);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /one conversation at a time/u);
      assert.match(result.stderr, /join what is running:  mc pm/u);
      assert.match(result.stderr, /mc work stop pm/u);
      assert.deepEqual(called(fx, 'respawn-window'), []);
      assert.deepEqual(called(fx, 'attach-session'), []);
    } finally { fx.cleanup(); }
  });

  it('and an unknown id says so before telling anyone to stop a live pm', () => {
    // "Stop it first" for an id that names nothing sends somebody to kill
    // their PM to discover a typo. The id is checked first.
    const fx = fixture({ running: true });
    try {
      const home = makeHome(fx);
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['pm', 'deadbeef'], fx.env);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /no conversation in the pm's home starts with deadbeef/u);
      assert.doesNotMatch(result.stderr, /stop it first/u);
    } finally { fx.cleanup(); }
  });

  it('two words is a usage error, and the usage names both forms', () => {
    const fx = fixture();
    try {
      const result = runMcCli(['pm', 'new', 'and-then-some'], fx.env);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /usage — mc pm \[new \| <conversation id>\]/u);
    } finally { fx.cleanup(); }
  });
});

describe('mc pm-helper gets it from the same code', () => {
  it('new against the running helper replaces its window too', () => {
    const fx = fixture({ running: true, area: 'pm-helper', insideIt: true });
    try {
      writeFileSync(join(fx.root, 'roles', 'pm-helper.md'), PM_MD.replace('name: pm', 'name: pm-helper'));
      makeHome(fx, 'pm-helper', { role: 'pm-helper' });
      const result = runMcCli(['pm-helper', 'new'], fx.env);
      assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
      assert.match(respawnLine(fx), /-t mc-pm-helper:0 /u);
    } finally { fx.cleanup(); }
  });
});

describe('mc work <name> new — the same word, the same meaning', () => {
  it('against a background session it is a new conversation, not a join', () => {
    const fx = fixture({ running: true, area: 'alpha' });
    try {
      const home = join(fx.workRoot, 'alpha');
      mkdirSync(home, { recursive: true });
      const transcript = recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['work', 'alpha', 'new'], fx.env);
      assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
      assert.doesNotMatch(result.stderr, /joining alpha/u);
      const line = respawnLine(fx);
      assert.match(line, /respawn-window -k -t mc-alpha:0 -c /u);
      assert.ok(!line.includes('--resume'), line);
      assert.deepEqual(called(fx, 'new-session'), []);
      assert.ok(existsSync(transcript), 'nothing may be deleted');
      // Politely, from outside, exactly as the role door does it.
      assert.ok(fx.tmux.keys().some((key) => key.includes('/exit')));
    } finally { fx.cleanup(); }
  });

  it('a conversation named by id is refused, never silently swapped for another', () => {
    // The other half of the same rule: joining would land in whatever is
    // running, which is not what was asked for and may not even be the same
    // conversation — and from the outside that outcome looks like success.
    const fx = fixture({ running: true, area: 'alpha' });
    try {
      const home = join(fx.workRoot, 'alpha');
      mkdirSync(home, { recursive: true });
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['work', 'alpha', PREDECESSOR.slice(0, 8)], fx.env);
      assert.equal(result.status, 1, `stdout:${result.stdout}\nstderr:${result.stderr}`);
      assert.doesNotMatch(result.stderr, /joining alpha/u);
      assert.match(result.stderr, /one conversation at a time/u);
      // Both ways on are named: in to what is running, or through it.
      assert.match(result.stderr, /join what is running:  mc work alpha/u);
      assert.match(result.stderr, /mc work stop alpha/u);
      assert.deepEqual(called(fx, 'attach-session'), [], 'nothing may be joined');
      assert.deepEqual(called(fx, 'respawn-window'), [], 'and nothing replaced');
    } finally { fx.cleanup(); }
  });

  it('--resume names the same thing and is refused the same way', () => {
    const fx = fixture({ running: true, area: 'alpha' });
    try {
      const home = join(fx.workRoot, 'alpha');
      mkdirSync(home, { recursive: true });
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['work', 'alpha', '--resume', PREDECESSOR.slice(0, 8)], fx.env);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /one conversation at a time/u);
    } finally { fx.cleanup(); }
  });

  it('and an id that matches nothing says so, rather than talking about what runs', () => {
    const fx = fixture({ running: true, area: 'alpha' });
    try {
      const home = join(fx.workRoot, 'alpha');
      mkdirSync(home, { recursive: true });
      recordConversation(fx, home, PREDECESSOR);
      const result = runMcCli(['work', 'alpha', 'deadbeef'], fx.env);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /no conversation in alpha starts with deadbeef/u);
      assert.match(result.stderr, /mc work alpha lists what is there/u);
      assert.deepEqual(called(fx, 'attach-session'), []);
    } finally { fx.cleanup(); }
  });

  it('without new, a running piece of work is still joined as it always was', () => {
    const fx = fixture({ running: true, area: 'alpha' });
    try {
      mkdirSync(join(fx.workRoot, 'alpha'), { recursive: true });
      const result = runMcCli(['work', 'alpha'], fx.env);
      assert.match(result.stderr, /joining alpha/u);
      assert.deepEqual(called(fx, 'respawn-window'), []);
    } finally { fx.cleanup(); }
  });
});
