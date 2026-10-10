import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realDeps, runLoop } from '../../src/mc/run.js';

/**
 * A codex step, end to end, with a stub codex.
 *
 * Every other runner test drives `deps` on fakes: nothing is spawned and the
 * launch is a table. This one is the opposite — real `realDeps`, a real git
 * repository with a real origin, a real worktree whose `.git` is a file
 * pointing outside it, and a real process spawned for the session. Only the
 * three binaries on PATH are not real.
 *
 * `codex` is a stub because codex is not installed on this machine, which is
 * the whole reason step 3 of `docs/project/mc/mc-run/PLAN.md` could not be
 * measured against the real CLI. What the stub does prove is everything on
 * mc's side of the boundary: that `tool: codex` in a plan's frontmatter
 * reaches `resolveLaunch`, that the argument list mc builds is the one the
 * process is started with, that the event stream codex answers in is read
 * into the usage columns, and that a `codex` step lands in runs.tsv and in
 * runner.log. What it cannot prove is that the real codex accepts those
 * arguments — that needs codex installed, and is said so in the plan.
 */

// Arguments are recorded one per record and not one per line: the prompt is
// a whole PLAN.json and has newlines of its own.
const ARG_SEP = '<<mc-arg>>\n';

const CODEX_STUB = (argvFile) => `#!/bin/sh
: > "${argvFile}"
for a in "$@"; do printf '%s<<mc-arg>>\\n' "$a" >> "${argvFile}"; done
echo '{"type":"thread.started","thread_id":"codex-thread-42"}'
echo '{"type":"item.completed","item":{"type":"agent_message"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":900,"output_tokens":340}}'
exit 0
`;

const PLAN = {
  "schema": "mc-plan",
  "version": 1,
  "goal": [
    "The one step runs through the codex adapter."
  ],
  "contract": [
    "The step runs on codex."
  ],
  "out_of_scope": [
    "Everything else."
  ],
  "success_criteria": [
    {
      "met": false,
      "criterion": "The step ran.",
      "check": "runs.tsv holds its row."
    }
  ],
  "documents": [],
  "runner": {
    "tool": "codex"
  },
  "steps": [
    {
      "title": "The one step",
      "status": "ready",
      "done_when": "the row is written",
      "instruction": [
        "Do the one step."
      ],
      "pr": null,
      "blocked_by": null
    }
  ]
};

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { encoding: 'utf8' });
}

function stub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/**
 * The world the runner is started in: a stub codex, a repository with one
 * ready plan on its origin/main, and a workarea that is a real worktree of it.
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

  // The three binaries the runner reaches for. `gh` answers nothing, so the
  // step finds no PR and the row's pr column is `-`; `tmux` says no session.
  stub(bin, 'codex', CODEX_STUB(argvFile));
  stub(bin, 'gh', '#!/bin/sh\nexit 0\n');
  stub(bin, 'tmux', '#!/bin/sh\nexit 1\n');

  // A repository with one ready plan on origin/main, and a workarea that is
  // a real worktree of it — so the session's cwd has a `.git` file pointing
  // into `${repo}/.git/worktrees/cx`, exactly as a workarea does.
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  mkdirSync(join(repo, 'docs', 'project', 'mc', 'cx'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'project', 'mc', 'cx', 'PLAN.json'), JSON.stringify(PLAN, null, 2));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'plan');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'worktree', 'add', '-q', '-b', 'cx', join(work, 'cx', 'memoro-cli'), 'origin/main');
  assert.match(readFileSync(join(work, 'cx', 'memoro-cli', '.git'), 'utf8'), /gitdir: .*\/\.git\/worktrees\//u);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MC_WORK_ROOT: work, MC_REPOS_HOME: reposHome };
  // `resolveLaunch` finds codex with `which -a codex`, which reads the
  // process's own PATH and not `deps.env` — so this one has to move too.
  const realPath = process.env.PATH;
  process.env.PATH = env.PATH;
  t.after(() => { process.env.PATH = realPath; });

  return { env, work, repo, argvFile, worktree: join(work, 'cx', 'memoro-cli') };
}

test('a codex step runs through the adapter and lands in runs.tsv', async (t) => {
  const { env, work, argvFile } = codexWorld(t);
  const deps = { ...realDeps(env), log: () => {} };
  const code = await runLoop({ once: true, merge: false, deps });
  assert.equal(code, 0);

  // The row: a codex step, exit 0, the usage the event stream carried.
  const rows = readFileSync(join(work, 'runner', 'log', 'runs.tsv'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 2, rows.join('\n'));
  const [ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note] = rows[1].split('\t');
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(
    { name, kind, exit, pr, turns, input, output, cacheRead, cacheWrite, session, note },
    { name: 'cx', kind: 'step', exit: '0', pr: '-', turns: '-', input: '1200', output: '340', cacheRead: '900', cacheWrite: '-', session: 'codex-thread-42', note: 'success,failed' },
  );
  assert.match(seconds, /^\d+$/u);

  // The launch, in runner.log where a night is read back from.
  const log = readFileSync(join(work, 'runner', 'log', 'runner.log'), 'utf8');
  assert.match(log, /cx: step starting \(codex own default model, no check-in, no stall guard\)/u);
  assert.match(log, /cx: step done rc=0 \d+s pr=- turns=- note=success/u);

  // The argument list the process was actually started with.
  const argv = readFileSync(argvFile, 'utf8').split(ARG_SEP).slice(0, -1);
  assert.deepEqual(argv.slice(0, 4), ['exec', '--json', '--sandbox', 'danger-full-access']);
  // No model: the plan names none, and `opus` is claude's word.
  assert.equal(argv.includes('-m'), false);
  assert.equal(argv.includes('opus'), false);
  // The shared text and the role overlay ride on codex's own instructions
  // channel, and the prompt is the last positional.
  const instructions = argv[argv.indexOf('-c') + 1];
  assert.match(instructions, /^instructions="/u);
  assert.match(instructions, /A turn is the unit of cost/u);
  assert.match(argv.at(-1), /You are working in the `cx` workarea of memoro-cli/u);
  // The prompt names the step by index and repeats its done_when: that
  // sentence is what the session verifies before it stops.
  assert.match(argv.at(-1), /Your step is `steps\[0\]` — 1, "The one step"/u);
  assert.match(argv.at(-1), /Done when: the row is written/u);
});

test('an interrupted codex step is resumed through `codex exec resume`, its workarea untouched', async (t) => {
  const { env, work, repo, argvFile, worktree } = codexWorld(t);
  // Main moves on after the session died: a resume must not merge it in.
  writeFileSync(join(repo, 'later.txt'), 'later\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'later on main');
  git(repo, 'push', '-q', 'origin', 'main');
  // What the dead session left: a modified file and an untracked one.
  writeFileSync(join(worktree, 'docs', 'project', 'mc', 'cx', 'notes.md'), 'half done\n');
  writeFileSync(join(worktree, 'README.md'), 'edited\n');
  const head = git(worktree, 'rev-parse', 'HEAD').trim();
  const status = git(worktree, 'status', '--porcelain');
  mkdirSync(join(work, 'runner', 'projects'), { recursive: true });
  writeFileSync(join(work, 'runner', 'projects', 'cx.json'), JSON.stringify({
    project: 'cx', repo: 'memoro-cli', programme: 'mc', plan: 'docs/project/mc/cx/PLAN.json',
    steps: [{
      status: 'ready', branch: 'cx',
      interrupted: {
        at: '2026-10-10T08:00:00Z', session_id: '019a0c0d-0000-7000-8000-00000000c0de', tool: 'codex', model: null,
        log: null, last_activity: '2026-10-10T07:55:00Z', context_tokens: 4000, branch: 'cx', count: 1,
      },
    }],
  }));

  const lines = [];
  const deps = { ...realDeps(env), log: (line) => lines.push(line) };
  assert.equal(await runLoop({ once: true, merge: false, deps }), 0);

  const argv = readFileSync(argvFile, 'utf8').split(ARG_SEP).slice(0, -1);
  assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', '--json']);
  assert.equal(argv.includes('--sandbox'), false, '`codex exec resume` has no --sandbox');
  assert.equal(argv[argv.indexOf('-c') + 1], 'sandbox_mode="danger-full-access"');
  assert.equal(argv.at(-2), '019a0c0d-0000-7000-8000-00000000c0de');
  assert.match(argv.at(-1), /cut off at 2026-10-10T07:55:00Z/u);
  assert.match(argv.at(-1), /Run `git status` first/u);
  assert.match(lines.join('\n'), /cx: resuming codex session 019a0c0d-0000-7000-8000-00000000c0de \(cold, 4 000 tokens\)/u);

  // The tree as the session left it: same commit, same changes, nothing of main's.
  assert.equal(git(worktree, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(git(worktree, 'status', '--porcelain'), status);
  assert.equal(git(worktree, 'branch', '--show-current').trim(), 'cx');
});
