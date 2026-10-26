import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { interactiveWorkspaceDirectories } from '../../src/mc/interactive-workspace.js';
import { launchSpec } from '../../src/adapters/codex.js';
import { openInWorkArea, startInBackground, respawnInBackground } from '../../src/mc/work-open.js';

const ID = '3f9d2c81-0000-4000-8000-000000000001';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-interactive-access-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mc = join(root, 'mc');
  const areaRoot = join(mc, 'programs', 'example');
  const runtime = join(root, 'runtime');
  const codex = join(root, 'codex');
  for (const path of [areaRoot, runtime, codex, join(mc, 'repos', 'memoro.git'), join(mc, 'repos', 'memoro-cli.git')]) mkdirSync(path, { recursive: true });
  const env = { ...process.env, MC_WORK_ROOT: mc, MC_HOME: runtime, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: join(root, 'claude') };
  delete env.MC_REPOS_HOME;
  return { root, mc, areaRoot, runtime, env, worktree: { path: areaRoot, is_git: false } };
}

function granted(args) {
  return args.flatMap((arg, i) => arg === '--add-dir' ? [args[i + 1]] : []);
}

function transcript(f) {
  const dir = join(f.env.CODEX_HOME, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${ID}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: f.areaRoot } }) + '\n');
}

test('a non-git programme receives both repositories and mc operational roots', t => {
  const f = fixture(t);
  const dirs = interactiveWorkspaceDirectories({ ...f, cwd: f.areaRoot });
  for (const path of [f.areaRoot, f.mc, f.runtime, join(f.mc, 'repos', 'memoro.git'), join(f.mc, 'repos', 'memoro-cli.git')]) assert.ok(dirs.includes(path), path);
  assert.ok(!dirs.includes(resolve(f.root, '..')), 'no home-wide or system-wide grant');
  assert.equal(new Set(dirs).size, dirs.length);
});

test('legacy shared metadata and environment overrides are retained, missing roots omitted', t => {
  const f = fixture(t);
  const common = join(f.root, 'legacy', '.git');
  mkdirSync(common, { recursive: true });
  const dirs = interactiveWorkspaceDirectories({ ...f, cwd: f.areaRoot, repos: [{ git: common }, { git: '/missing/repository' }], git: () => ({ status: 0, stdout: common + '\n' }) });
  assert.ok(dirs.includes(common));
  assert.ok(dirs.includes(f.mc));
  assert.ok(dirs.includes(f.runtime));
  assert.equal(dirs.filter(path => path === common).length, 1);
  assert.ok(!dirs.includes('/missing/repository'));
});

test('a real linked worktree outside the configured repositories contributes its common git directory', t => {
  const f = fixture(t);
  const source = join(f.root, 'other');
  const linked = join(f.root, 'linked');
  mkdirSync(source);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main', source);
  git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial fixture');
  git('-C', source, 'worktree', 'add', '--detach', linked);
  const common = git('-C', linked, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const dirs = interactiveWorkspaceDirectories({ ...f, cwd: linked, repos: [] });
  assert.ok(dirs.includes(common));
});

test('the adapter renders grants before the prompt and before a resumed session id without disabling the sandbox', () => {
  const spec = launchSpec({ resolveBinary: () => 'codex' });
  const context = { gitCommonDir: '/git', writableDirectories: ['/mc', '/runtime', '/git'] };
  assert.deepEqual(spec.args(['-m', 'example', 'PROMPT'], context), ['--add-dir', '/git', '--add-dir', '/mc', '--add-dir', '/runtime', '-m', 'example', 'PROMPT']);
  assert.deepEqual(spec.args(['resume', '-m', 'example', ID, 'CONTINUE'], context), ['resume', '--add-dir', '/git', '--add-dir', '/mc', '--add-dir', '/runtime', '-m', 'example', ID, 'CONTINUE']);
  assert.deepEqual(spec.args(['PROMPT']), ['PROMPT']);
  const args = spec.args(['PROMPT'], { ...context, effectivePolicy: { permissions: { workspace: 'read-only' }, explicit_permissions: ['workspace'] } });
  assert.deepEqual(args.slice(0, 2), ['--sandbox', 'read-only']);
  assert.ok(!args.includes('danger-full-access'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

for (const resume of [false, true]) {
  test(`foreground Codex ${resume ? 'resume' : 'new'} launch reaches the adapter with operational roots`, async t => {
    const f = fixture(t);
    if (resume) transcript(f);
    let captured;
    const result = await openInWorkArea({ ...f, tool: 'codex', pick: resume ? ID : 'new', prompt: 'OPEN', resumePrompt: 'CONTINUE', register: () => () => {}, spawn: (bin, args) => { captured = args; return { error: new Error('fixture: no child launched') }; } });
    assert.equal(result.reason, 'fixture: no child launched');
    assert.ok(granted(captured).includes(f.mc));
    assert.ok(granted(captured).includes(f.runtime));
    assert.equal(captured.at(-1), resume ? 'CONTINUE' : 'OPEN');
    if (resume) {
      assert.equal(captured[0], 'resume');
      assert.ok(captured.indexOf('--add-dir') < captured.indexOf(ID));
    }
  });
}

for (const resume of [false, true]) {
  test(`background Codex ${resume ? 'resume' : 'new'} launch gets the same grants`, t => {
    const f = fixture(t);
    let command;
    const result = startInBackground({ ...f, name: 'fixture', tool: 'codex', task: 'TASK', conversation: resume ? { id: ID } : null, run: args => {
      if (args[0] === 'has-session') return { status: 1 };
      if (args[0] === 'new-session') command = args.at(-1);
      return { status: 0 };
    } });
    assert.equal(result.ok, true);
    assert.ok(command.includes(`'--add-dir' '${f.mc}'`));
    assert.ok(command.includes(`'--add-dir' '${f.runtime}'`));
    assert.ok(command.endsWith("'TASK'"));
    if (resume) assert.ok(command.indexOf("'--add-dir'") < command.indexOf(`'${ID}'`));
  });
}

test('replacing a background Codex conversation retains the same grants', t => {
  const f = fixture(t);
  let command;
  const result = respawnInBackground({ ...f, name: 'fixture', tool: 'codex', graceful: false, conversation: { id: ID }, run: args => {
    if (args[0] === 'list-windows') return { status: 0, stdout: '1\n' };
    if (args[0] === 'respawn-window') command = args.at(-1);
    return { status: 0 };
  } });
  assert.equal(result.ok, true);
  assert.ok(command.includes(`'--add-dir' '${f.mc}'`));
  assert.ok(command.includes(`'--add-dir' '${f.runtime}'`));
  assert.ok(command.indexOf("'--add-dir'") < command.indexOf(`'${ID}'`));
});
