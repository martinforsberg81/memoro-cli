/**
 * `mc install-shell` — append the shell-wrapper function to the user's
 * ~/.zshrc (or ~/.bashrc) inside a managed block.
 *
 * The wrapper runs the CLI with `--emit-shell-directives` and eval's fd
 * 3 so `mc cd <name>` / post-`mc end` cd-back actually change the
 * caller's shell cwd. See §2b in the plan.
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
  # Capture only fd 3 (shell directives) into $out. stdout is routed
  # to the terminal via fd 2 so the user sees normal command output;
  # stderr is left untouched on fd 2 so warnings and tips reach the
  # terminal as well. An earlier version of this wrapper also
  # redirected stderr into fd 3, which leaked stderr into the eval
  # buffer and broke any command whose stderr contained shell
  # metacharacters (e.g. "<branch>" in a hint).
  local out rc
  out=$(command memoro-cli "$@" --emit-shell-directives 3>&1 1>&2)
  rc=$?
  [ -n "$out" ] && eval "$out"
  return $rc
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
