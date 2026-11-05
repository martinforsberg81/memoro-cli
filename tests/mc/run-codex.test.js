import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEMORY_MIN_FREE_PERCENT, realDeps, runLoop } from '../../src/mc/run.js';
import { PRESSURE_BYTES } from '../../src/mc/disk-pressure.js';
import { goalJson } from './_helpers/goal-file.js';

/**
 * A codex goal session, end to end, with a stub codex.
 *
 * Every other runner test drives `deps` on fakes: nothing is spawned and the
 * launch is a table. This one is the opposite — real `realDeps`, a real git
 * repository with a real origin, a real goal worktree whose `.git` is a file
 * pointing outside it, and a real process spawned for the session. Only the
 * three binaries on PATH are not real.
 *
 * `codex` is a stub because codex is not installed on this machine. What the
 * stub does prove is everything on mc's side of the boundary: that a goal's
 * class routed to codex reaches `resolveLaunch`, that the argument list mc
 * builds is the one the process is started with, that the event stream codex
 * answers in is read into the usage columns, and that the session lands in
 * runs.tsv and in runner.log. What it cannot prove is that the real codex
 * accepts those arguments — that needs codex installed.
 */

// Arguments are recorded one per record and not one per line: the prompt has
// newlines of its own.
const ARG_SEP = '<<mc-arg>>\n';

// It writes beside the bin it is reached from: `<base>/codex-argv.txt`.
const CODEX_STUB = `#!/bin/sh
argv="\${0%/*}/../codex-argv.txt"
: > "$argv"
for a in "$@"; do printf '%s<<mc-arg>>\\n' "$a" >> "$argv"; done
echo '{"type":"thread.started","thread_id":"codex-thread-42"}'
echo '{"type":"item.completed","item":{"type":"agent_message"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":900,"output_tokens":340}}'
exit 0
`;

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { encoding: 'utf8' });
}

/**
 * The three stubs, written and run once per file, and linked into each
 * world's bin: on macOS a freshly written script pays 0.3-0.9 s at its first
 * exec (2026-11-03), and each test wrote three.
 */
const STUBS = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-run-codex-stubs-'));
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of [['codex', CODEX_STUB], ['gh', '#!/bin/sh\nexit 0\n'], ['tmux', '#!/bin/sh\nexit 1\n']]) {
    const path = join(dir, 'bin', name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    spawnSync(path, [], { stdio: 'ignore' });
  }
  return join(dir, 'bin');
})();

function stub(dir, name) {
  symlinkSync(join(STUBS, name), join(dir, name));
}

/**
 * The world the runner is started in: a stub codex, a repository with an
 * origin, and one open goal of class `fast` under the work root's
 * `programs/mc/goals/cx/`, whose worktree is a real worktree of it on
 * `goal/cx`.
 */
function codexWorld(t) {
  const base = mkdtempSync(join(tmpdir(), 'mc-run-codex-'));
  const bin = join(base, 'bin');
  const reposHome = join(base, 'repos');
  const work = join(base, 'work');
  const repo = join(reposHome, 'memoro-cli');
  const origin = join(base, 'origin', 'memoro-cli.git');
  const argvFile = join(base, 'codex-argv.txt');
  for (const dir of [bin, reposHome, work, join(base, 'origin')]) mkdirSync(dir, { recursive: true });

  // The three binaries the runner reaches for. `gh` answers nothing; `tmux`
  // says no session.
  stub(bin, 'codex');
  stub(bin, 'gh');
  stub(bin, 'tmux');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), '# memoro-cli\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'readme');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const dir = join(work, 'programs', 'mc', 'goals', 'cx');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'GOAL.json'), goalJson({ repos: ['memoro-cli'], class: 'fast', title: 'cx' }));
  writeFileSync(join(dir, 'LOG.md'), '');
  const worktree = join(dir, 'memoro-cli');
  git(repo, 'worktree', 'add', '-q', '-b', 'goal/cx', worktree, 'origin/main');
  assert.match(readFileSync(join(worktree, '.git'), 'utf8'), /gitdir: .*\/\.git\/worktrees\//u);

  // Claude refused for an hour, codex seen with room: the default catalog puts
  // claude first for `fast`, so the goal runs on codex.
  const now = Date.now();
  const later = new Date(now + 3 * 3600_000).toISOString();
  mkdirSync(join(work, 'runner'), { recursive: true });
  writeFileSync(join(work, 'runner', 'model-capacity.json'), JSON.stringify({
    schema: 'mc-model-capacity',
    version: 1,
    providers: {
      claude: { observed_at: new Date(now).toISOString(), windows: { five_hour: { fraction_used: 0.1, resets_at: later }, seven_day: { fraction_used: 0.1, resets_at: later } }, models: null, refusal_until: new Date(now + 3600_000).toISOString(), failure: null },
      codex: { observed_at: new Date(now).toISOString(), windows: { primary: { fraction_used: 0.2, resets_at: later }, secondary: null }, models: [{ id: 'gpt-6-luna', efforts: ['high'] }], refusal_until: null, failure: null },
    },
  }));

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MC_WORK_ROOT: work, MC_REPOS_HOME: reposHome };
  // `resolveLaunch` finds codex with `which -a codex`, which reads the
  // process's own PATH and not `deps.env` — so this one has to move too.
  const realPath = process.env.PATH;
  process.env.PATH = env.PATH;
  t.after(() => { process.env.PATH = realPath; });

  return { env, work, argvFile, worktree };
}

test('a fast goal on a refused claude runs on codex through the adapter, and lands in runs.tsv and runner.log', async (t) => {
  const { env, work, argvFile, worktree } = codexWorld(t);
  // The disk and the memory are the host's: a full disk or a loaded machine
  // would refuse the session this test is about, so both read as room enough.
  // At the pressure line exactly, and no pass halves: nothing of this machine's disk is read or tidied.
  const deps = { ...realDeps(env), freeBytes: () => PRESSURE_BYTES, pressureTidy: undefined, pressureDocker: undefined, freeMemoryPercent: () => MEMORY_MIN_FREE_PERCENT, log: () => {} };
  assert.equal(await runLoop({ once: true, merge: false, deps }), 0);

  // The row: a goal's build, exit 0, the usage the event stream carried, and
  // what it was routed to.
  const rows = readFileSync(join(work, 'runner', 'log', 'runs.tsv'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 2, rows.join('\n'));
  const cells = rows[1].split('\t');
  const [ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note] = cells;
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(
    { name, kind, exit, pr, turns, input, output, cacheRead, cacheWrite, session, note },
    { name: 'goal:mc/cx', kind: 'build-goal', exit: '0', pr: '-', turns: '-', input: '1200', output: '340', cacheRead: '900', cacheWrite: '-', session: 'codex-thread-42', note: 'success,no-log' },
  );
  assert.match(seconds, /^\d+$/u);
  assert.deepEqual(cells.slice(14), ['gpt-6-luna', 'fast', 'codex', 'high', 'plan']);

  // The launch, in runner.log where a night is read back from.
  const log = readFileSync(join(work, 'runner', 'log', 'runner.log'), 'utf8');
  assert.match(log, /goal:mc\/cx: build starting \(codex gpt-6-luna · effort high, no check-in, no stall guard\) · class fast: known \(codex has 80 % headroom\)/u);
  assert.match(log, /goal:mc\/cx: build done rc=0 \d+s turns=- note=success,no-log/u);

  // The argument list the process was actually started with.
  const argv = readFileSync(argvFile, 'utf8').split(ARG_SEP).slice(0, -1);
  assert.deepEqual(argv.slice(0, 8), ['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=high']);
  assert.equal(argv.includes('--effort'), false);
  assert.equal(argv.includes('--advisor'), false);
  // The shared text and the role overlay ride on codex's own instructions
  // channel, and the prompt is the last positional.
  // `-c project_doc_max_bytes=0` comes first: the session loads no AGENTS.md.
  const at = argv.indexOf('project_doc_max_bytes=0');
  assert.equal(argv[at - 1], '-c');
  const delegation = argv.indexOf('features.multi_agent=true');
  assert.ok(delegation > at);
  assert.equal(argv[delegation - 1], '-c');
  const instructions = argv.find((arg, i) => argv[i - 1] === '-c' && arg.startsWith('instructions='));
  assert.ok(at < argv.indexOf(instructions), 'the switch rides before the instructions');
  assert.match(instructions, /^instructions="/u);
  assert.match(instructions, /A turn is the unit of cost/u);
  assert.ok(argv.at(-1).startsWith(`You are a session on the goal mc/cx. Its directory is \`${join(work, 'programs', 'mc', 'goals', 'cx')}\``), argv.at(-1));
  assert.ok(argv.at(-1).includes(`your worktree is \`${worktree}\`, on branch \`goal/cx\``));
});
