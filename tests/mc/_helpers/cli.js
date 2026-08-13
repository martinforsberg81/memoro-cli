/**
 * Helpers for invoking the `mc` CLI as a subprocess in tests.
 *
 * Why subprocess (not in-process import)? The §2 / §9 lifecycle commands
 * touch real git repos and a worktree registry; the cleanest contract is
 * "run the binary, observe exit code + stdout + stderr + side effects on
 * disk". Importing internals would couple the spec to implementation
 * shape we haven't designed yet.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = join(here, '..', '..', '..', 'src', 'mc-cli.js');

/**
 * Run `node bin-mc.js <args>` synchronously and capture output.
 *
 * `env` is merged onto the parent env. Set `MC_HOME` to point the CLI at
 * a tmpdir registry so tests never touch the real `~/.mc/`.
 *
 * `cwd` defaults to the repo root; pass a temp-repo path for commands
 * that introspect the current working tree.
 */
/**
 * Minimal PATH that contains common tools the CLI itself shells out to
 * (git, node) but DELIBERATELY excludes `claude` / `codex` / `gemini`.
 *
 * Why: the current CLI's `runWrap` (the wrap-claude mode) preflights
 * `which claude` and exits non-zero if missing. Until the new
 * subcommands exist, an unrecognised arg falls through to runWrap; with
 * `claude` missing from PATH the fallthrough fails fast instead of
 * spawning a real Claude TUI and hanging the test runner.
 *
 * Once the subcommands are implemented, they should never invoke a tool
 * binary in test mode (use `--no-launch` or honour `MC_TEST_MODE=1`).
 */
function safePathForTests() {
  return '/usr/bin:/bin:/usr/sbin:/sbin';
}

/**
 * Strip mc-relevant env vars that leak from a parent shell that is itself
 * running under `mc`. Without this scrub, tests inherit
 * MC_EMIT_SHELL_DIRECTIVES=1 (or MEMORO_MC_PARENT=1) and behave as if
 * the user opted into wrapper mode — which silently flips the expected
 * stdout/fd3 routing of commands under test.
 */
function scrubMcEnv(env) {
  const out = { ...env };
  for (const k of ['MC_EMIT_SHELL_DIRECTIVES', 'MEMORO_MC_PARENT', 'MC_ORPHAN_PID_DIR']) {
    delete out[k];
  }
  return out;
}

// Spawning a full `mc` process competes with whatever else the machine is
// running. At 10 s, a loaded developer machine (a fleet of coding sessions
// is the normal case here) killed dozens of subprocesses mid-run and
// reported them as assertion failures — `status: null`, empty output —
// which made a red suite indistinguishable from a real regression. The
// budget is generous on purpose: a genuinely hung CLI still fails, just
// later, while ordinary scheduling delay no longer forges failures.
const DEFAULT_CLI_TIMEOUT_MS = 60_000;

export function runMc(args, { cwd, env = {}, timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: cwd ?? process.cwd(),
    env: {
      ...scrubMcEnv(process.env),
      // Belt-and-braces: tests must never hit the real API or keychain.
      MC_TEST_MODE: '1',
      MEMORO_API_URL: 'http://127.0.0.1:1',
      PATH: safePathForTests(),
      ...env,
    },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

/**
 * Run `mc` with fd 3 piped, so we can capture shell-directive emission
 * (§2b). Returns once the child exits.
 */
export function runMcCaptureFd3(args, { cwd, env = {}, timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: cwd ?? process.cwd(),
      env: {
        ...scrubMcEnv(process.env),
        MC_TEST_MODE: '1',
        MEMORO_API_URL: 'http://127.0.0.1:1',
        PATH: safePathForTests(),
        ...env,
      },
      // fd 0: ignore stdin; 1: stdout; 2: stderr; 3: extra pipe.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', fd3 = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.stdio[3].on('data', (b) => { fd3 += b.toString('utf8'); });

    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mc timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);

    child.on('error', (err) => { clearTimeout(t); reject(err); });
    // `close` (not `exit`) fires after stdio streams have flushed — using
    // `exit` lost the "tip" the cd command writes to stdout because the
    // write buffer hadn't drained yet when the child terminated.
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ status: code, stdout, stderr, fd3 });
    });
  });
}

/** Best-effort JSON parse, returns null on failure. Tests assert on the
 * parsed value (not the raw text) so changes to whitespace / order don't
 * break the spec.
 */
export function parseJsonOrNull(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}
