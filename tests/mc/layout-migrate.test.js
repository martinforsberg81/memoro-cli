/**
 * `mc layout migrate` without `--apply`: the facts, the plan, the refusals and
 * the dry run (layout-migrate.js, ruling 51). Every case builds layout 1 on a
 * temporary work root and a temporary claude home — never `~/mc` or
 * `~/.claude`.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { run } from '../../src/mc/commands/layout.js';
import { encodePath } from '../../src/mc/conversations.js';
import { gatherLayoutFacts, planLayoutMove } from '../../src/mc/layout-migrate.js';
import { git, makeTempRepo } from './_helpers/git-fixture.js';

let repo;
let root;
let claudeDir;
let env;

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const worktree = (path) => {
  mkdirSync(join(path, '..'), { recursive: true });
  git(repo.dir, `worktree add -q --detach "${path}"`);
};
const transcript = (cwd, file = 'a.jsonl') => {
  write(join(claudeDir, 'projects', encodePath(cwd), file), `${JSON.stringify({ type: 'user', cwd, message: { content: 'hello' } })}\n`);
};

/** Nothing alive, nothing standing, nothing served — unless a case says so. */
const quiet = (overrides = {}) => ({
  alive: () => false, standing: () => [], servers: () => [], commandOf: () => 'zsh', ...overrides,
});

beforeEach(() => {
  repo = makeTempRepo({ name: 'layout' });
  root = mkdtempSync(join(tmpdir(), 'mc-layout-root-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'mc-layout-claude-'));
  env = { ...process.env, MC_WORK_ROOT: root, CLAUDE_CONFIG_DIR: claudeDir };

  worktree(join(root, 'plan', 'p', 'memoro'));
  write(join(root, 'plan', 'p', '.claude', 'settings.json'), '{}\n');
  worktree(join(root, 'step', 'x', 'memoro'));
  worktree(join(root, 'step', 'deps-memoro-a-20261020', 'memoro'));
  write(join(root, 'programs', 'p', 'x', 'PLAN.json'), '{}\n');
  write(join(root, 'runner', 'projects', 'x.json'), '{"steps":[]}\n');
  write(join(root, 'runner', 'projects', 'old.json'), '{"steps":[]}\n');
  write(join(root, 'runner', 'projects', '.lock'), '');
  transcript(join(root, 'plan', 'p'));
  transcript(join(root, 'step', 'x', 'memoro'));
  // A session elsewhere under the root is not the move's.
  transcript(join(root, 'work', 'w'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  repo.cleanup();
});

const plan = (deps = quiet()) => planLayoutMove(gatherLayoutFacts({ root, env, deps }));

async function verb(argv, deps = quiet()) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    root, env, home: root, facts: deps,
    stdout: { write: (text) => { out += text; } },
    stderr: { write: (text) => { err += text; } },
  });
  return { code, out, err };
}

/** Every path under `dir` with its size and modification time. */
function snapshot(dir) {
  const seen = {};
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const stat = statSync(full);
      seen[full] = `${stat.size}:${stat.mtimeMs}`;
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return seen;
}

test('the plan: every move of layout 1, exactly and in order', () => {
  const { moves, refusals } = plan();
  assert.deepEqual(refusals, []);
  const claude = join(claudeDir, 'projects');
  const at = (...parts) => join(root, ...parts);
  assert.deepEqual(moves, [
    { kind: 'plan', from: at('plan/p/.claude'), to: at('programs/p/.claude'), how: 'rename' },
    { kind: 'plan', from: at('plan/p/memoro'), to: at('programs/p/memoro'), how: 'worktree' },
    { kind: 'plan', from: at('plan/p'), to: null, how: 'rmdir' },
    { kind: 'plan', from: at('plan'), to: null, how: 'rmdir' },
    { kind: 'step', from: at('step/deps-memoro-a-20261020/memoro'), to: at('runner/deps/deps-memoro-a-20261020/memoro'), how: 'worktree' },
    { kind: 'step', from: at('step/deps-memoro-a-20261020'), to: null, how: 'rmdir' },
    { kind: 'step', from: at('step/x/memoro'), to: at('runner/step/x/memoro'), how: 'worktree' },
    { kind: 'step', from: at('step/x'), to: null, how: 'rmdir' },
    { kind: 'step', from: at('step'), to: null, how: 'rmdir' },
    { kind: 'register', from: at('runner/projects/old.json'), to: at('runner/log/closed/registers/old.json'), how: 'rename' },
    { kind: 'register', from: at('runner/projects/x.json'), to: at('programs/p/x/STATE.json'), how: 'rename' },
    { kind: 'register', from: at('runner/projects'), to: null, how: 'rmdir' },
    {
      kind: 'transcript',
      from: join(claude, encodePath(at('plan/p'))),
      to: join(claude, encodePath(at('programs/p'))),
      how: 'transcripts',
      rewrite: { old: at('plan/p'), new: at('programs/p') },
    },
    {
      kind: 'transcript',
      from: join(claude, encodePath(at('step/x/memoro'))),
      to: join(claude, encodePath(at('runner/step/x/memoro'))),
      how: 'transcripts',
      rewrite: { old: at('step/x'), new: at('runner/step/x') },
    },
    { kind: 'hooks', from: join(claudeDir, 'settings.json'), to: join(claudeDir, 'settings.json'), how: 'hooks' },
    { kind: 'layout', from: at('runner/layout.json'), to: at('runner/layout.json'), how: 'layout' },
  ]);
});

test('a live runner refuses, naming its pid and what to do', () => {
  write(join(root, 'runner', 'runner.json'), JSON.stringify({ pid: 4242, started: '2026-10-20T08:00:00Z' }));
  const { refusals } = plan(quiet({ alive: (pid) => pid === 4242 }));
  assert.deepEqual(refusals, ['the runner is running (pid 4242) — mc run stop, and wait for it to finish']);
});

test('an open planning session refuses; a dead one does not', () => {
  write(join(root, 'runner', 'foreground', '5151.json'), JSON.stringify({ verb: 'plan', area: 'plan/p', pid: 5151 }));
  write(join(root, 'runner', 'foreground', '6161.json'), JSON.stringify({ verb: 'plan', area: 'plan/p', pid: 6161 }));
  const { refusals } = plan(quiet({ alive: (pid) => pid === 5151 }));
  assert.deepEqual(refusals, ['a planning session for p is open (pid 5151) — close it']);
});

test('a destination that exists refuses, naming it', () => {
  mkdirSync(join(root, 'programs', 'p', 'memoro'), { recursive: true });
  write(join(root, 'programs', 'p', 'x', 'STATE.json'), '{}\n');
  const { refusals } = plan();
  assert.deepEqual(refusals, [
    `${join(root, 'programs/p/memoro')} already exists — ${join(root, 'plan/p/memoro')} cannot move there`,
    `${join(root, 'programs/p/x/STATE.json')} already exists — ${join(root, 'runner/projects/x.json')} cannot move there`,
  ]);
});

test('a transcript target holding a conversation of the same name refuses', () => {
  transcript(join(root, 'programs', 'p'));
  const { refusals } = plan();
  const to = join(claudeDir, 'projects', encodePath(join(root, 'programs/p')), 'a.jsonl');
  const from = join(claudeDir, 'projects', encodePath(join(root, 'plan/p')), 'a.jsonl');
  assert.deepEqual(refusals, [`${to} already exists — ${from} cannot move there`]);
});

test('a bad programme name and a register that does not parse refuse', () => {
  mkdirSync(join(root, 'plan', 'Bad_Name'), { recursive: true });
  write(join(root, 'runner', 'projects', 'x.json'), '{ not json');
  const { moves, refusals } = plan();
  assert.equal(refusals.length, 2);
  assert.match(refusals[0], /Bad_Name is not a programme name/u);
  assert.match(refusals[1], /x\.json does not parse/u);
  assert.ok(!moves.some((move) => move.from === join(root, 'plan')), 'plan/ stays while a refused area is in it');
});

test('a process standing in an old area and a dev server serving one refuse', () => {
  const { refusals } = plan(quiet({
    standing: () => [{ pid: 777, directory: join(root, 'step', 'x'), cwd: join(root, 'step', 'x', 'memoro') }],
    commandOf: () => 'vim notes.md',
    servers: () => [{ pid: 888, live: true, worktree_path: join(root, 'step', 'x', 'memoro') }],
  }));
  assert.deepEqual(refusals, [
    `pid 777 (vim notes.md) stands in ${join(root, 'step', 'x')}`,
    `a dev server serves ${join(root, 'step', 'x', 'memoro')} — mc test dev --stop in that worktree`,
  ]);
});

test('the dry run prints the moves under their headings, exits 0, and writes nothing', async () => {
  const before = { root: snapshot(root), claude: snapshot(claudeDir) };
  const { code, out } = await verb(['migrate']);
  assert.equal(code, 0);
  assert.match(out, /would move ~\/plan\/p\/memoro → ~\/programs\/p\/memoro \(worktree\)/u);
  assert.match(out, /would move ~\/runner\/projects\/x\.json → ~\/programs\/p\/x\/STATE\.json \(rename\)/u);
  const headings = ['PLANNING SESSIONS', 'STEP AREAS', 'REGISTERS', 'TRANSCRIPTS', 'HOOKS', 'LAYOUT'].map((heading) => out.indexOf(`\n${heading}\n`));
  assert.ok(headings.every((at, index) => at > 0 && (index === 0 || at > headings[index - 1])), out);
  assert.ok(!out.includes('REFUSED'));
  assert.match(out, /16 moves, none refused\n$/u);
  assert.deepEqual({ root: snapshot(root), claude: snapshot(claudeDir) }, before);
});

test('the dry run with a refusal prints it under REFUSED, exits 1, and writes nothing', async () => {
  write(join(root, 'runner', 'runner.json'), JSON.stringify({ pid: 4242 }));
  const before = { root: snapshot(root), claude: snapshot(claudeDir) };
  const { code, out } = await verb(['migrate'], quiet({ alive: (pid) => pid === 4242 }));
  assert.equal(code, 1);
  assert.match(out, /\nREFUSED\n {2}the runner is running \(pid 4242\)/u);
  assert.match(out, /16 moves, 1 refused/u);
  assert.deepEqual({ root: snapshot(root), claude: snapshot(claudeDir) }, before);
});

test('--json is { layout, moves, refusals }', async () => {
  const { code, out } = await verb(['migrate', '--json']);
  assert.equal(code, 0);
  const answer = JSON.parse(out);
  assert.deepEqual(Object.keys(answer), ['layout', 'moves', 'refusals']);
  assert.equal(answer.layout, 1);
  assert.equal(answer.moves.length, 16);
});

test('mc layout names the layout and its four roots', async () => {
  const { code, out } = await verb([]);
  assert.equal(code, 0);
  assert.equal(out.split('\n')[0], 'layout 1');
  assert.match(out, /planning sessions {2}~\/plan\n/u);
  assert.match(out, /step areas {9}~\/step\n/u);
  assert.match(out, /registers {10}~\/runner\/projects\n/u);
});

test('in layout 2 there is nothing to move', async () => {
  write(join(root, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2, migrated: '2026-10-20T08:00:00Z' }));
  const migrated = await verb(['migrate']);
  assert.equal(migrated.code, 0);
  assert.equal(migrated.out, 'layout 2 — nothing to move\n');
  const shown = await verb([]);
  assert.equal(shown.out.split('\n')[0], 'layout 2');
  assert.match(shown.out, /step areas {9}~\/runner\/step\n/u);
});

test('--apply is not built yet, and a stray word is refused', async () => {
  assert.equal((await verb(['migrate', '--apply'])).code, 2);
  assert.equal((await verb(['move'])).code, 2);
});
