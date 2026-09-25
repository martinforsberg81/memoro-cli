/**
 * `mc gate` — run this worktree's own gate, and read only the verdict.
 *
 *   mc gate                   the repository's gate on the tree you stand in
 *   mc gate --base <ref>      measured against another base than origin/main
 *   mc gate --json            the summary as one object
 *
 * What runs is the repository's, read from its `package.json` (`gate-local.js`):
 * `npm run ci -- --base-ref origin/main` where there is a `ci` script, else
 * `npm test`. The whole output goes to a file — under `$MC_SCRATCH` in a
 * runner session, the system temp directory otherwise — and what is printed
 * is at most 2 KB: GREEN or RED, the counts, the failing lines with their
 * locations, and the file's path. A session that wants more reads the file
 * with `Grep`, which costs a match list, not a suite's worth of context.
 *
 * It is a meter, not a door: `mc merge` measures again in its own tree and
 * decides. This one answers "is my tree red?" before the push.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gateCommand, gateLines, summarizeGate } from '../gate-local.js';
import { tryGit } from '../git.js';
import { scanArgs } from './flags.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--base'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  if (scanned.positional.length) { stderr.write(`mc: mc gate takes no positional (${scanned.positional.join(' ')})\n${usage()}`); return 2; }

  const root = (deps.git || tryGit)(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) { stderr.write('mc: not inside a git worktree — mc gate runs the gate of the tree you stand in\n'); return 2; }
  let manifest = null;
  try { manifest = JSON.parse((deps.read || readFileSync)(join(root, 'package.json'), 'utf8')); } catch { manifest = null; }
  const base = scanned.flags.base || 'origin/main';
  const command = gateCommand(manifest, { base });
  if (!command) { stderr.write(`mc: ${root} has no ci or test script in package.json — nothing to run\n`); return 2; }

  const stamp = (deps.now ? deps.now() : new Date()).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const dir = env.MC_SCRATCH || join(tmpdir(), 'mc-gate');
  const logPath = join(dir, `gate-${stamp}.log`);
  const started = Date.now();
  const result = (deps.shell || shell)(command.run, { cwd: root, env });
  const seconds = Math.round((Date.now() - started) / 1000);
  const output = `${result.stdout || ''}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`;
  try {
    (deps.mkdir || ((p) => mkdirSync(p, { recursive: true })))(dir);
    (deps.write || writeFileSync)(logPath, output);
  } catch (error) {
    stderr.write(`mc: could not write the whole output to ${logPath}: ${error.message}\n`);
  }
  const summary = summarizeGate(output, { exitCode: result.status });
  if (scanned.flags.json) {
    stdout.write(`${JSON.stringify({ ...summary, command: command.run, script: command.script, base, seconds, log: logPath, exit: result.status }, null, 2)}\n`);
  } else {
    stdout.write(`${gateLines(summary, { command: command.run, seconds, logPath })}\n`);
  }
  return summary.ok ? 0 : 1;
}

/** The command through the user's shell, output collected whole; the gate's own exit code is the verdict. */
function shell(command, { cwd, env }) {
  const r = spawnSync('sh', ['-c', command], { cwd, env: { ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, encoding: 'utf8', maxBuffer: 256 << 20 });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function usage() {
  return [
    'usage — mc gate                       this worktree\'s own gate: npm run ci -- --base-ref origin/main, or npm test\n',
    '        mc gate --base <ref>          measured against another base\n',
    '        mc gate --json                the summary as one object\n',
    '\n',
    'Prints at most 2 KB — GREEN/RED, counts, the failing lines and their locations, and the path of the whole output.\n',
    'Exit 0 green, 1 red, 2 nothing to run.\n',
  ].join('');
}
