/**
 * `mc install-shell` — append the shell-wrapper function to the user's
 * ~/.zshrc (or ~/.bashrc) inside a managed block.
 *
 * The wrapper runs the CLI with `--emit-shell-directives` and eval's fd
 * 3 so `mc cd <name>` / post-`mc end` cd-back actually change the
 * caller's shell cwd — without disturbing stdout or stderr, which belong
 * to whatever is reading the command.
 *
 * Idempotent — re-running replaces the managed block in place.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MARK_BEGIN = '# >>> memoro mc shell wrapper >>>';
const MARK_END = '# <<< memoro mc shell wrapper <<<';

const WRAPPER_BODY = String.raw`
mc() {
  # Shell directives travel on fd 3 and are eval'd here, so "mc cd" and the
  # cd-back after "mc end" can change the caller's shell.
  #
  # They go through a temp file rather than a command substitution. The
  # obvious form — out=$(command mc "$@" 3>&1 1>&2) — moves fd 3 onto the
  # capture pipe and stdout onto stderr. On a terminal that is invisible,
  # because both land on the screen. Anywhere else it is fatal: "mc
  # coding-profile read > profile.md" wrote 0 bytes, and every pipe into jq,
  # grep or a file got nothing. Assistants and scripts read this CLI, so
  # stdout has to stay stdout.
  local __mc_fd3 __mc_out __mc_rc
  __mc_fd3=$(mktemp -t mc-directives) || { command mc "$@"; return $?; }
  # "command mc" bypasses this very function and resolves to the mc binary on
  # PATH (src/bin-mc.js, where the LIFECYCLE dispatch lives). "command
  # memoro-cli" would hit src/bin.js — the OTHER binary in this package,
  # which does not know about the lifecycle subcommands.
  command mc "$@" --emit-shell-directives 3>"$__mc_fd3"
  __mc_rc=$?
  __mc_out=$(cat "$__mc_fd3" 2>/dev/null)
  rm -f "$__mc_fd3"
  [ -n "$__mc_out" ] && eval "$__mc_out"
  return $__mc_rc
}
`;

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(`mc: ${opts.error}`); return 2; }

  const shell = opts.shell || detectShell();
  const rc = rcPathFor(shell);
  if (!rc) {
    console.error(`mc: unsupported shell "${shell}" — pass --shell zsh|bash`);
    return 2;
  }

  const existing = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
  const block = `${MARK_BEGIN}\n${WRAPPER_BODY.trim()}\n${MARK_END}\n`;

  let next;
  if (existing.includes(MARK_BEGIN) && existing.includes(MARK_END)) {
    const pattern = new RegExp(`${escapeRegex(MARK_BEGIN)}[\\s\\S]*?${escapeRegex(MARK_END)}\\n?`);
    next = existing.replace(pattern, block);
  } else {
    next = existing + (existing.endsWith('\n') || !existing ? '' : '\n') + '\n' + block;
  }

  if (opts.dryRun) {
    console.log(`mc: would write the wrapper block to ${rc}`);
    return 0;
  }

  writeFileSync(rc, next);
  console.log(`mc: installed shell wrapper into ${rc}`);
  console.log(`mc: restart your shell or \`source ${rc}\` to activate.`);
  return 0;
}

function detectShell() {
  const s = process.env.SHELL || '';
  if (s.endsWith('/zsh')) return 'zsh';
  if (s.endsWith('/bash')) return 'bash';
  return 'zsh';
}

function rcPathFor(shell) {
  if (shell === 'zsh') return join(homedir(), '.zshrc');
  if (shell === 'bash') return join(homedir(), '.bashrc');
  return null;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseArgs(argv) {
  const opts = { shell: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shell') { opts.shell = argv[++i]; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
}
