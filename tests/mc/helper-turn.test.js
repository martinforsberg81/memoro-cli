/**
 * `mc helper` — the turn: what it is told, what it is allowed to write, and
 * what it reports having written.
 *
 * No model and no network here. The session is a stub that writes a file
 * exactly where a real turn would, because the point of the measurement is
 * that `wrote` comes from the directory and not from what the turn said.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { intakeDir, proposalsDir } from '../../src/mc/helper-collect.js';
import { helperGround, helperPrompt, repoOfFile, runHelperTurn } from '../../src/mc/helper-turn.js';

const NOW = new Date('2026-08-29T06:00:00.000Z');
const FILE = 'errors-memoro-2026-08-29.md';
const ROLE = { name: 'helper', model: 'sonnet', tools: ['claude'], overlay: 'You are the helper turn.' };
const LAUNCH = {
  ok: true, id: 'claude-code', shortName: 'claude',
  adapter: { modelArgs: (model) => (model ? ['--model', model] : []) },
  spec: { bin: '/usr/bin/claude' },
};
const CLAUDE_JSON = JSON.stringify({ num_turns: 6, session_id: 'sess-1', subtype: 'success', usage: {} });

const PROPOSAL = `---
name: expose-operations
repo: memoro
kind: project
---

# The nightly outcomes reach no script

## Done when

The outcomes are a section in the digest.
`;

function env() {
  const root = mkdtempSync(join(tmpdir(), 'mc-turn-'));
  return { MC_WORK_ROOT: root, MC_REPOS_HOME: join(root, 'repos') };
}

/** A session that writes what a real turn writes, and reports how it was called. */
function fakeSession(seen, { write = PROPOSAL, status = 0, timedOut = false, stdout = CLAUDE_JSON } = {}) {
  return async (call) => {
    Object.assign(seen, call);
    // The turn stands in `intake/` and writes into `../proposals/` — its own
    // room beside intake, not inside the material it reads.
    if (write) writeFileSync(join(call.cwd, '..', 'proposals', '2026-08-29-expose-operations.md'), write);
    return { status, stdout, stderr: '', timedOut };
  };
}

const GROUND = async () => ({ plans: [], projectLog: null, notes: ['no docs/project/project_log.md on origin/main in memoro'] });

async function turn(overrides = {}, options = {}) {
  const e = options.env || env();
  const seen = {};
  const result = await runHelperTurn({
    env: e, now: NOW, file: options.file || join(intakeDir(e), FILE),
    deps: {
      role: () => ROLE, launch: () => LAUNCH, profile: async () => 'PROFILE',
      ground: GROUND, session: fakeSession(seen, options.session), ...overrides,
    },
  });
  return { result, seen, env: e };
}

describe('the helper turn', () => {
  it('runs the role\'s tool and model, standing in the intake directory', async () => {
    const { result, seen, env: e } = await turn();
    assert.equal(seen.bin, '/usr/bin/claude');
    assert.equal(seen.cwd, intakeDir(e), 'nothing outside ~/mc/intake is in reach');
    assert.equal(seen.timeoutMs, 10 * 60_000);
    assert.deepEqual(seen.args.slice(0, 2), ['-p', seen.args[1]]);
    assert.ok(seen.args.includes('--model') && seen.args[seen.args.indexOf('--model') + 1] === 'sonnet');
    assert.equal(result.model, 'sonnet');
    assert.equal(result.tool, 'claude');
    assert.equal(result.note, 'success');
    assert.equal(result.ok, true);
  });

  it('carries the Coding Profile and the role overlay in one instruction body', async () => {
    const { seen } = await turn();
    const at = seen.args.indexOf('--append-system-prompt');
    assert.ok(at > 0, 'claude takes instructions on --append-system-prompt');
    assert.equal(seen.args[at + 1], 'PROFILE\n\n---\n\nYou are the helper turn.');
  });

  it('names the one file and leaves the reading to the turn', async () => {
    const { seen, env: e } = await turn();
    assert.ok(seen.args[1].includes(FILE), 'the file is named');
    assert.ok(!seen.args[1].includes(intakeDir(e)), 'by its bare name — the turn stands in the directory');
    assert.ok(!seen.args[1].includes('----- DIGEST -----'), 'nothing is pasted in for it');
  });

  it('takes a file whose name says nothing, and a name that is not a path', async () => {
    const dropped = await turn({}, { file: 'screenshot.png', session: { write: null } });
    assert.ok(dropped.seen.args[1].includes('screenshot.png'));
    assert.match(dropped.seen.args[1], /decide it from what you read/u);
    assert.equal(dropped.result.ok, true);
  });

  it('measures what was written instead of believing the turn', async () => {
    const { result } = await turn();
    assert.equal(result.wrote.length, 1);
    assert.equal(result.wrote[0].file, '2026-08-29-expose-operations.md');
    // The name is all mc knows about it. What it says is the reader's business.
    assert.equal(result.waiting.length, 1);

    const said = await turn({}, { session: { write: null } });
    assert.equal(said.result.wrote.length, 0, 'a turn that wrote nothing wrote nothing');
    assert.equal(said.result.ok, true, 'and that is not a failure');
  });

  it('counts only what this turn added, not what was already waiting', async () => {
    const e = env();
    mkdirSync(proposalsDir(e), { recursive: true });
    writeFileSync(join(proposalsDir(e), '2026-08-28-older.md'), '# An older proposal\n');
    const { result } = await turn({}, { env: e, session: { write: PROPOSAL } });
    assert.deepEqual(result.wrote.map((p) => p.file), ['2026-08-29-expose-operations.md']);
    assert.equal(result.waiting.length, 2);
    assert.ok(result.wrote[0].path.startsWith(proposalsDir(e)));
  });

  it('names the directory it may write in, which is this machine\'s and not the default', async () => {
    const e = env();
    const { seen } = await turn({}, { env: e });
    assert.ok(seen.args[1].includes(proposalsDir(e)), 'the turn is told where it stands');
  });

  it('tells the turn what is already proposed, so it does not propose it twice', async () => {
    const e = env();
    mkdirSync(proposalsDir(e), { recursive: true });
    writeFileSync(join(proposalsDir(e), '2026-08-28-older.md'), '# An older proposal\n');
    const { seen } = await turn({}, { env: e });
    assert.match(seen.args[1], /PROPOSALS ALREADY WAITING[\s\S]*2026-08-28-older\.md/u);
  });

  it('reports a missing role and a missing tool rather than running nothing', async () => {
    const noRole = await turn({ role: () => null });
    assert.deepEqual([noRole.result.ok, noRole.result.reason], [false, 'no-role']);
    const noTool = await turn({ launch: () => ({ ok: false, hint: 'claude not in PATH' }) });
    assert.deepEqual([noTool.result.ok, noTool.result.reason], [false, 'no-tool']);
    assert.equal(noTool.result.note, 'claude not in PATH');
  });

  it('is not ok when the session timed out or failed', async () => {
    const timedOut = await turn({}, { session: { status: 142, timedOut: true, write: null } });
    assert.equal(timedOut.result.ok, false);
    assert.equal(timedOut.result.note, 'timeout');
    const failed = await turn({}, { session: { status: 1, stdout: 'not json', write: null } });
    assert.equal(failed.result.ok, false);
    assert.equal(failed.result.note, 'no-json');
  });

  it('passes a model asked for on the command line over the role\'s', async () => {
    const e = env();
    const seen = {};
    await runHelperTurn({
      env: e, now: NOW, file: FILE, model: 'opus',
      deps: { role: () => ROLE, launch: () => LAUNCH, profile: async () => '', ground: GROUND, session: fakeSession(seen, { write: null }) },
    });
    assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'opus');
  });
});

describe('what the turn is told', () => {
  const PLANS = [{ repo: 'memoro-cli', programme: 'mc', project: 'mc-helper', status: 'ready', next: 'Step 2 — the proposal turn' }];

  it('names the date, the file to write and the directory to write it in', () => {
    const prompt = helperPrompt({ file: FILE, now: NOW });
    assert.match(prompt, /Today is 2026-08-29/u);
    assert.match(prompt, /2026-08-29-<slug>\.md/u);
    assert.match(prompt, /or none at all/u);
  });

  /**
   * The whole of step 2: one file by name, read by the turn, one outcome for
   * that file alone. A prompt that pasted the file in could not carry a
   * screenshot, and one that asked for "the proposals" would get two.
   */
  it('names one file and asks for one outcome about it', () => {
    const prompt = helperPrompt({ file: '/Users/m/mc/intake/note.txt', now: NOW });
    assert.match(prompt, /One file in the directory you are standing in is yours this turn:\n\n {4}note\.txt\n/u);
    assert.ok(!prompt.includes('/Users/m/mc/intake/'), 'the path is not the instruction — the name is');
    assert.match(prompt, /Read it — yourself, and whole —/u);
    assert.match(prompt, /One file, one outcome: either \*\*one\*\* proposal/u);
    assert.match(prompt, /Not two from one file/u);
  });

  it('tells the turn to say when it could not read the file whole', () => {
    const prompt = helperPrompt({ file: 'huge.log', now: NOW });
    assert.match(prompt, /past your tool's read limit[\s\S]*a proposal that names the limit, or no proposal/u);
  });

  it('says which repository a digest is, and leaves any other file to the turn', () => {
    assert.match(helperPrompt({ file: FILE, now: NOW }), /It is \*\*memoro\*\*'s, so a proposal you write about it has `repo: memoro`/u);
    assert.match(helperPrompt({ file: 'errors-memoro-cli-2026-08-29.md', now: NOW }), /`repo: memoro-cli`/u);
    // What a person dropped in belongs to whichever system the contents say,
    // and the turn is the only reader that can tell.
    const dropped = helperPrompt({ file: 'screenshot.png', now: NOW });
    assert.ok(!dropped.includes('in its frontmatter'), 'no repository is asserted for it');
    assert.match(dropped, /Nothing in that name says which system[\s\S]*decide it from what you read/u);
    // And a caller that knows better than the name — the collector — is obeyed.
    assert.match(helperPrompt({ file: 'screenshot.png', repo: 'memoro-cli', now: NOW }), /`repo: memoro-cli`/u);
  });

  it('carries the plans on main and the project log as the ground to judge against', () => {
    const prompt = helperPrompt({
      file: FILE, plans: PLANS, projectLog: '| 2026-08-26 | msr-core | main-red-fix |', now: NOW,
    });
    assert.match(prompt, /\| memoro-cli \| mc \/ mc-helper \| ready \| Step 2 — the proposal turn \|/u);
    assert.match(prompt, /PROJECT LOG \(closed projects\)[\s\S]*main-red-fix/u);
  });

  it('says a source is absent rather than leaving a section that reads as empty', () => {
    const prompt = helperPrompt({ file: FILE, now: NOW });
    assert.match(prompt, /PLANS ON MAIN -----\n_none read_/u);
    assert.match(prompt, /PROJECT LOG \(closed projects\) -----\n_none read_/u);
    assert.match(prompt, /PROPOSALS ALREADY WAITING -----\n_none_/u);
  });
});

describe('which system a file in the inbox belongs to', () => {
  it('is read from the collector\'s own names and from no others', () => {
    assert.equal(repoOfFile('/w/intake/errors-memoro-2026-08-29.md'), 'memoro');
    assert.equal(repoOfFile('errors-memoro-cli-2026-08-29.md'), 'memoro-cli');
    // The unprefixed name from before memoro-cli had a digest of its own.
    assert.equal(repoOfFile('errors-2026-08-29.md'), 'memoro');
    assert.equal(repoOfFile('screenshot.png'), null);
    assert.equal(repoOfFile('errors-memoro-2026-08-29.md.bak'), null);
    assert.equal(repoOfFile(''), null);
  });
});

describe('the ground', () => {
  function repos() {
    const root = mkdtempSync(join(tmpdir(), 'mc-ground-'));
    mkdirSync(join(root, 'memoro', '.git'), { recursive: true });
    return { root, repos: [{ name: 'memoro', path: join(root, 'memoro') }, { name: 'gone', path: join(root, 'gone') }] };
  }

  it('reads every PLAN.md frontmatter on origin/main, and skips a repository that is not here', async () => {
    const { repos: list } = repos();
    const git = async (cwd, args) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'ls-tree') return 'docs/project/mc/mc-helper/PLAN.md\ndocs/project/mc/mc-run/README.md';
      if (args[1] === 'origin/main:docs/project/mc/mc-helper/PLAN.md') return '---\nstatus: ready\nnext: "Step 2"\n---\n# x';
      if (args[1] === 'origin/main:docs/project/project_log.md') return '| 2026-08-26 | msr-core |';
      return null;
    };
    const ground = await helperGround({ env: {}, repos: list, git });
    assert.deepEqual(ground.plans, [{
      repo: 'memoro', programme: 'mc', project: 'mc-helper', path: 'docs/project/mc/mc-helper/PLAN.md',
      status: 'ready', next: 'Step 2',
    }]);
    assert.match(ground.projectLog, /msr-core/u);
    assert.deepEqual(ground.notes, []);
  });

  it('notes what it could not read instead of pretending the list is complete', async () => {
    const { repos: list } = repos();
    const ground = await helperGround({ env: {}, repos: list, git: async () => null });
    assert.deepEqual(ground.plans, []);
    assert.equal(ground.projectLog, null);
    assert.deepEqual(ground.notes, [
      'memoro: could not list plans on origin/main',
      'no docs/project/project_log.md on origin/main in memoro',
    ]);
  });
});

describe('the proposal a turn leaves behind', () => {
  it('is a file a person and the brief can both read', async () => {
    const { env: e } = await turn();
    const text = readFileSync(join(proposalsDir(e), '2026-08-29-expose-operations.md'), 'utf8');
    assert.match(text, /^---\nname: expose-operations\nrepo: memoro\nkind: project\n---\n/u);
    assert.match(text, /## Done when/u);
  });
});
