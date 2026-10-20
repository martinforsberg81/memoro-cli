/**
 * `mc layout migrate`: the facts, the plan, the refusals, the dry run, and
 * `--apply` carrying it out (layout-migrate.js, ruling 51). Every case builds
 * layout 1 on a temporary work root with real git worktrees and a temporary
 * claude home — never `~/mc` or `~/.claude`.
 */
import { strict as assert } from 'node:assert';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { run } from '../../src/mc/commands/layout.js';
import { encodePath, listConversations } from '../../src/mc/conversations.js';
import { hookRegistration } from '../../src/mc/hooks.js';
import { applyLayoutMove, gatherLayoutFacts, planLayoutMove, rewriteTranscriptLine } from '../../src/mc/layout-migrate.js';
import { layoutVersion, stepAreaName } from '../../src/mc/paths.js';
import { parseEntry, readEntry, registerPath } from '../../src/mc/register.js';
import { releaseWorkArea } from '../../src/mc/work-area.js';
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

test('a stray word is refused, and --json is the dry run\'s', async () => {
  assert.equal((await verb(['move'])).code, 2);
  assert.equal((await verb(['migrate', '--apply', '--json'])).code, 2);
  assert.equal((await verb(['--apply'])).code, 2);
});

/* ------------------------------------------------------------------- apply */

/**
 * The planning session's conversation as Claude Code keeps it: a relocation,
 * a line that does not parse, a cwd that only shares a prefix, a sub-agent's
 * transcript under `<id>/`, and a memory. Returns the main transcript's lines.
 */
function richTranscript() {
  const old = join(root, 'plan', 'p');
  const dir = join(claudeDir, 'projects', encodePath(old));
  const lines = [
    JSON.stringify({ type: 'user', cwd: old, message: { content: `look in ${old}/notes` } }),
    'not json {',
    JSON.stringify({ type: 'relocated', relocatedCwd: join(old, 'memoro'), sessionId: 'a' }),
    JSON.stringify({ type: 'assistant', cwd: `${old}-other`, message: { content: 'grön' } }),
  ];
  writeFileSync(join(dir, 'a.jsonl'), `${lines.join('\n')}\n`);
  write(join(dir, 'a', 'subagents', 'agent-1.jsonl'), `${JSON.stringify({ isSidechain: true, cwd: join(old, 'memoro') })}\n`);
  write(join(dir, 'memory', 'MEMORY.md'), '# memory\n');
  return lines;
}

const sink = () => {
  const seen = { text: '' };
  return { seen, write: (text) => { seen.text += text; } };
};
const logLines = () => readFileSync(join(root, 'runner', 'log', 'layout-migrate.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const realOr = (path) => { try { return realpathSync(path); } catch { return path; } };
const worktreesOf = (dir) => git(dir, 'worktree list --porcelain').split('\n')
  .filter((line) => line.startsWith('worktree ')).map((line) => realOr(line.slice('worktree '.length)));

test('--apply moves everything in the plan, and layout 2 reads it', async () => {
  const register = readFileSync(join(root, 'runner', 'projects', 'x.json'));
  const { code, out, err } = await verb(['migrate', '--apply']);
  assert.equal(code, 0, err);
  assert.equal(err, '');
  assert.match(out, /^moved ~\/plan\/p\/\.claude → ~\/programs\/p\/\.claude \(rename\)\n/u);
  assert.match(out, /\nmoved ~\/plan\/p\/memoro → ~\/programs\/p\/memoro \(worktree\)\n/u);
  assert.match(out, /\nremoved ~\/runner\/projects \(rmdir\)\n/u);
  assert.match(out, /\nlayout 2 — 16 moves\nnext: mc layout to see the roots, then mc run start\n$/u);

  const listed = worktreesOf(repo.dir);
  for (const area of ['programs/p/memoro', 'runner/step/x/memoro', 'runner/deps/deps-memoro-a-20261020/memoro']) {
    assert.ok(listed.includes(realOr(join(root, area))), `${area} in ${listed.join(', ')}`);
    assert.equal(git(join(root, area), 'status --porcelain'), '');
  }
  assert.ok(existsSync(join(root, 'programs', 'p', '.claude', 'settings.json')));
  assert.deepEqual(readFileSync(join(root, 'programs', 'p', 'x', 'STATE.json')), register);
  assert.ok(existsSync(join(root, 'runner', 'log', 'closed', 'registers', 'old.json')));
  for (const gone of ['plan', 'step', 'runner/projects/x.json', 'runner/projects/old.json']) {
    assert.ok(!existsSync(join(root, gone)), `${gone} is gone`);
  }
  const layout = JSON.parse(readFileSync(join(root, 'runner', 'layout.json'), 'utf8'));
  assert.equal(layout.schema, 'mc-layout');
  assert.equal(layout.version, 2);
  assert.equal(layoutVersion({ root }), 2);
  assert.equal(hookRegistration(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))).ok, true);

  const log = logLines();
  assert.equal(log.length, 16);
  assert.ok(log.every((line) => line.ok === true && line.error === null && typeof line.at === 'string'));
  assert.deepEqual(log[1], { at: log[1].at, how: 'worktree', from: join(root, 'plan/p/memoro'), to: join(root, 'programs/p/memoro'), ok: true, error: null });
});

test('--apply renames the transcripts and moves every cwd in them, and nothing else', async () => {
  const lines = richTranscript();
  const old = join(root, 'plan', 'p');
  const fresh = join(root, 'programs', 'p');
  const { code, err } = await verb(['migrate', '--apply']);
  assert.equal(code, 0, err);

  const projects = join(claudeDir, 'projects');
  const planDir = join(projects, encodePath(fresh));
  const stepDir = join(projects, encodePath(join(root, 'runner', 'step', 'x', 'memoro')));
  assert.ok(!existsSync(join(projects, encodePath(old))));
  assert.ok(!existsSync(join(projects, encodePath(join(root, 'step', 'x', 'memoro')))));
  assert.ok(existsSync(join(projects, encodePath(join(root, 'work', 'w')))), 'a session elsewhere stays');

  assert.equal(readFileSync(join(planDir, 'a.jsonl'), 'utf8'), [
    JSON.stringify({ type: 'user', cwd: fresh, message: { content: `look in ${old}/notes` } }),
    lines[1],
    JSON.stringify({ type: 'relocated', relocatedCwd: join(fresh, 'memoro'), sessionId: 'a' }),
    lines[3],
    '',
  ].join('\n'));
  assert.equal(
    readFileSync(join(planDir, 'a', 'subagents', 'agent-1.jsonl'), 'utf8'),
    `${JSON.stringify({ isSidechain: true, cwd: join(fresh, 'memoro') })}\n`,
  );
  assert.equal(readFileSync(join(planDir, 'memory', 'MEMORY.md'), 'utf8'), '# memory\n');
  assert.equal(
    JSON.parse(readFileSync(join(stepDir, 'a.jsonl'), 'utf8')).cwd,
    join(root, 'runner', 'step', 'x', 'memoro'),
  );

  // `mc plan` resumes the conversation it finds in the programme's directory.
  const found = listConversations(fresh, env).filter((conversation) => conversation.tool === 'claude-code');
  assert.deepEqual(found.map((conversation) => [conversation.id, conversation.cwd]), [['a', fresh]]);
});

test('a transcript line changes only where a cwd moves', () => {
  const rewrite = { old: '/r/plan/p', new: '/r/programs/p' };
  assert.equal(rewriteTranscriptLine('{"payload":{"cwd":"/r/plan/p/m"},"n":1}', rewrite), '{"payload":{"cwd":"/r/programs/p/m"},"n":1}');
  assert.equal(rewriteTranscriptLine('{"cwd":"/r/plan/p"}\r', rewrite), '{"cwd":"/r/programs/p"}\r');
  assert.equal(rewriteTranscriptLine('{"cwd":"/r/plan/pq"}', rewrite), null);
  assert.equal(rewriteTranscriptLine('{"cwd": "/r/elsewhere"}', rewrite), null);
  assert.equal(rewriteTranscriptLine('[1]', rewrite), null);
  assert.equal(rewriteTranscriptLine('', rewrite), null);
});

test('after --apply the areas and the register are where layout 2 looks', async () => {
  const text = `${JSON.stringify({ schema: 'mc-register', version: 1, project: 'x', programme: 'p', steps: [] })}\n`;
  write(join(root, 'runner', 'projects', 'x.json'), text);
  const before = parseEntry(text);
  assert.equal((await verb(['migrate', '--apply'])).code, 0);
  assert.equal(registerPath(root, 'x'), join(root, 'programs', 'p', 'x', 'STATE.json'));
  assert.notEqual(before, null);
  assert.deepEqual(readEntry(root, 'x'), before);
  assert.equal(stepAreaName('x', { root }), 'runner/step/x');
  const release = releaseWorkArea('programs/p', { env, dryRun: true });
  assert.deepEqual(release.removed.map((worktree) => worktree.repo), ['memoro']);
  assert.deepEqual(release.kept, []);
  assert.deepEqual(release.held_by, []);
});

test('a refused --apply moves nothing and exits 1', async () => {
  write(join(root, 'runner', 'runner.json'), JSON.stringify({ pid: 4242 }));
  const before = { root: snapshot(root), claude: snapshot(claudeDir) };
  const { code, out } = await verb(['migrate', '--apply'], quiet({ alive: (pid) => pid === 4242 }));
  assert.equal(code, 1);
  assert.match(out, /^layout 1 → 2 — refused, nothing moved\n\nREFUSED\n {2}the runner is running \(pid 4242\)/u);
  assert.deepEqual({ root: snapshot(root), claude: snapshot(claudeDir) }, before);
});

test('a move that fails stops there, logged, and a second run continues from it', async () => {
  const planned = plan();
  // Made between the plan and the move: the second move's destination.
  const obstacle = join(root, 'programs', 'p', 'memoro');
  mkdirSync(obstacle);
  const stdout = sink();
  const stderr = sink();
  assert.equal(applyLayoutMove(planned, { root, home: root, stdout, stderr }), 1);
  assert.equal(stdout.seen.text, 'moved ~/plan/p/.claude → ~/programs/p/.claude (rename)\n');
  assert.match(stderr.seen.text, /^mc: move 2 of 16 failed — move ~\/plan\/p\/memoro → ~\/programs\/p\/memoro \(worktree\): .*already exists\n/u);
  assert.match(stderr.seen.text, /the 1 before it are done — mc layout migrate --apply again continues from there\n$/u);
  assert.ok(existsSync(join(root, 'programs', 'p', '.claude', 'settings.json')));
  assert.ok(existsSync(join(root, 'plan', 'p', 'memoro', '.git')), 'the worktree is where it was');
  assert.deepEqual(readdirSync(obstacle), []);
  const log = logLines();
  assert.deepEqual(log.map((line) => [line.how, line.ok]), [['rename', true], ['worktree', false]]);
  assert.match(log[1].error, /already exists/u);
  assert.ok(!existsSync(join(root, 'runner', 'layout.json')));

  rmdirSync(obstacle);
  const again = await verb(['migrate', '--apply']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /^moved ~\/plan\/p\/memoro → ~\/programs\/p\/memoro \(worktree\)\n/u);
  assert.match(again.out, /\nlayout 2 — 15 moves\n/u);
  assert.ok(worktreesOf(repo.dir).includes(realOr(obstacle)));
  assert.equal(git(obstacle, 'status --porcelain'), '');
  assert.equal(layoutVersion({ root }), 2);
  assert.equal(logLines().length, 2 + 15);
});

test('a second --apply after the move has nothing to move', async () => {
  assert.equal((await verb(['migrate', '--apply'])).code, 0);
  const again = await verb(['migrate', '--apply']);
  assert.equal(again.code, 0);
  assert.equal(again.out, 'layout 2 — nothing to move\n');
});
