#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

const opts = parseArgs(process.argv.slice(2));
if (opts.error) {
  console.error(`mc smoke: ${opts.error}`);
  printUsage();
  process.exit(2);
}
if (opts.help) {
  printUsage();
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'mc-release-smoke-'));
const home = join(root, 'home');
const mcHome = join(root, 'mc-home');
const repo = join(root, 'repo');
const pidDir = join(root, 'pids');
const mc = resolveMcCommand(opts.mc || process.env.MC_SMOKE_MC || 'mc');

try {
  mkdirSync(home, { recursive: true });
  mkdirSync(mcHome, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(mcHome, '.setup-done-v1'), 'release-smoke\n');
  initRepo(repo);

  const env = {
    ...scrubEnv(process.env),
    HOME: home,
    MC_HOME: mcHome,
    MC_ORPHAN_PID_DIR: pidDir,
    MC_TEST_MODE: '1',
    MEMORO_API_URL: 'http://127.0.0.1:1',
    TERM: 'dumb',
    NO_COLOR: '1',
    CLICOLOR: '0',
  };

  const version = run(mc, ['--version'], { cwd: repo, env });
  assertText(version.stdout.trim(), /^.+$/, 'mc --version printed a version');
  ok(`version ${version.stdout.trim()}`);

  const help = run(mc, ['--help'], { cwd: repo, env });
  assertIncludes(help.stdout, 'Start the default grounded coding tool here', 'help describes default tool startup');
  assertIncludes(help.stdout, 'Install Codex CLI for the default path', 'help is Codex-default aware');
  assertNotIncludes(help.stdout, 'wrap `claude`', 'help does not expose old Claude-default wording');
  ok('help surface');

  const auth = run(mc, ['auth', 'status', '--json'], { cwd: repo, env, allowFailure: true });
  const authJson = parseJson(auth.stdout, 'mc auth status --json');
  assertEqual(authJson?.policy?.default_tool, 'codex', 'auth policy default tool is codex');
  assertEqual(authJson?.policy?.effective_config?.defaultTool?.value, 'codex', 'effective defaultTool is codex');
  ok('auth status default policy');

  const toolSwitch = run(mc, ['tool-switch', 'codex', '--dry-run', '--json'], {
    cwd: repo,
    env,
    allowFailure: true,
  });
  const switchJson = parseJson(toolSwitch.stdout, 'mc tool-switch codex --dry-run --json');
  assertEqual(switchJson?.ok, false, 'tool-switch fails closed without a managed artifact');
  assertEqual(switchJson?.tool, 'codex', 'tool-switch target is codex');
  assertEqual(
    switchJson?.reason,
    'managed-codex-artifact-unavailable',
    'tool-switch reports the missing fixed managed artifact',
  );
  ok('tool-switch codex managed boundary');

  const created = run(mc, ['new', 'smoke-codex', '--no-launch', '--json'], { cwd: repo, env });
  const newJson = parseJson(created.stdout, 'mc new smoke-codex --no-launch --json');
  assertEqual(newJson?.tool, 'codex', 'mc new defaults to codex');
  assertIncludes(String(newJson?.worktree_path || ''), 'smoke-codex', 'mc new returns the created worktree');
  ok('mc new default tool');

  const claudeResume = run(mc, ['resume', 'smoke-codex', '--claude', '--no-launch', '--json'], { cwd: repo, env });
  const claudeJson = parseJson(claudeResume.stdout, 'mc resume smoke-codex --claude --no-launch --json');
  assertEqual(claudeJson?.tool, 'claude', 'mc resume can still select Claude explicitly');
  ok('explicit Claude relaunch path');

  const planPath = join(repo, 'smoke-plan.md');
  writeFileSync(planPath, '## Phase 1: Verify\nCheck release smoke behavior.\n');
  const fanout = run(mc, ['fanout', planPath, '--dry-run', '--json'], { cwd: repo, env });
  const fanoutJson = parseJson(fanout.stdout, 'mc fanout --dry-run --json');
  assertEqual(fanoutJson?.phases?.[0]?.tool, 'codex', 'mc fanout defaults to codex');
  ok('fanout default tool');

  console.log(`mc release smoke passed (${describeMc(mc)})`);
} catch (err) {
  console.error(`mc smoke failed: ${err.message}`);
  process.exit(1);
} finally {
  if (!opts.keep) rmSync(root, { recursive: true, force: true });
  else console.error(`mc smoke kept temp dir: ${root}`);
}

function parseArgs(argv) {
  const out = { mc: null, keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mc') {
      const value = argv[++i];
      if (!value) return { error: '--mc requires a path or command name' };
      out.mc = value;
      continue;
    }
    if (arg === '--keep') {
      out.keep = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    return { error: `unknown arg: ${arg}` };
  }
  return out;
}

function printUsage() {
  console.error(`Usage: npm run smoke:mc -- [--mc mc|/path/to/mc|src/bin-mc.js] [--keep]

Runs the release smoke gate against the selected mc binary in an isolated
HOME/MC_HOME and a throwaway git repo. Defaults to the global "mc" on PATH.
Set MC_SMOKE_MC to choose a binary without passing --mc.`);
}

function resolveMcCommand(value) {
  if (value.endsWith('.js')) {
    const path = isAbsolute(value) ? value : resolve(process.cwd(), value);
    return { bin: process.execPath, prefixArgs: [path], label: path };
  }
  return { bin: value, prefixArgs: [], label: value };
}

function run(mc, args, { cwd, env, allowFailure = false } = {}) {
  const res = spawnSync(mc.bin, [...mc.prefixArgs, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  if (!allowFailure && res.status !== 0) {
    throw new Error(`${describeCommand(mc, args)} exited ${res.status}\nstdout:\n${res.stdout || ''}\nstderr:\n${res.stderr || ''}`);
  }
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function initRepo(cwd) {
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'release-smoke@example.invalid']);
  git(cwd, ['config', 'user.name', 'mc release smoke']);
  // This fixture is intentionally local-only. Once `mc new` adds a second
  // branch Git has no remote HEAD from which to recover the default, so record
  // the fixture's explicit repository metadata instead of relying on a name
  // convention.
  git(cwd, ['config', '--local', 'mc.defaultBranch', 'main']);
  writeFileSync(join(cwd, 'README.md'), '# smoke\n');
  git(cwd, ['add', 'README.md']);
  git(cwd, ['commit', '-q', '-m', 'Initial commit']);
}

function git(cwd, args) {
  const res = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'mc release smoke',
      GIT_AUTHOR_EMAIL: 'release-smoke@example.invalid',
      GIT_COMMITTER_NAME: 'mc release smoke',
      GIT_COMMITTER_EMAIL: 'release-smoke@example.invalid',
    },
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${res.status}: ${res.stderr || res.stdout || ''}`);
  }
}

function scrubEnv(env) {
  const out = { ...env };
  for (const key of [
    'MC_EMIT_SHELL_DIRECTIVES',
    'MEMORO_MC_PARENT',
    'MEMORO_MC_BROKER',
    'MC_SESSION_NAME',
    'MC_GROUNDING_TOOL',
    'MC_GROUNDING_FOCUS',
  ]) {
    delete out[key];
  }
  return out;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} did not return JSON: ${err.message}\n${text}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`${label}: missing ${JSON.stringify(needle)}`);
  }
}

function assertNotIncludes(text, needle, label) {
  if (text.includes(needle)) {
    throw new Error(`${label}: unexpectedly found ${JSON.stringify(needle)}`);
  }
}

function assertText(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`${label}: ${JSON.stringify(text)} did not match ${pattern}`);
  }
}

function ok(label) {
  console.log(`ok - ${label}`);
}

function describeMc(mc) {
  return mc.label === 'mc' ? 'global mc on PATH' : mc.label;
}

function describeCommand(mc, args) {
  const shown = [basename(mc.label), ...args].join(' ');
  return existsSync(mc.label) ? shown : [mc.label, ...args].join(' ');
}
