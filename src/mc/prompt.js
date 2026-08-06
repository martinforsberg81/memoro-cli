/**
 * Asking, rather than requiring the user to know.
 *
 * mc's verbs grew into a grammar — `mc work add <name> <repo> [branch]` — and a
 * grammar is something you either remember or get wrong. Typing a branch name
 * where a session name belonged silently made a second session, and nothing in
 * the command could have told the difference.
 *
 * So mc asks. Two rules keep that from becoming its own burden:
 *
 *   Never ask a question with one answer. One conversation in a piece of work
 *   is opened, not offered. One repository is used, not listed.
 *
 *   Never ask when told. Every prompt here has a flag or an argument that skips
 *   it, and nothing prompts unless a person is actually at the terminal — a
 *   pipe, a script and `--json` behave exactly as they did before.
 *
 * The reading is done on a private handle to the terminal rather than through
 * `process.stdin`. Node's readline takes that stream over — raw mode, its own
 * reader, its own idea of when input ends — and the tool mc launches next
 * inherits the same terminal. Handing it back turned out not to be something
 * readline can do: the questions were answered, the tool started, and then it
 * sat there receiving nothing. Opening `/dev/tty`, reading one line and closing
 * it borrows the terminal for exactly as long as the question takes.
 */
import { closeSync, openSync, readSync } from 'node:fs';

export function interactive(env = process.env) {
  if (env.MC_NO_PROMPT === '1') return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * One question, a numbered list, one keystroke and Enter.
 *
 * Returns the chosen item's `value`, or null if the user pressed Enter on
 * nothing, typed something that was not on offer, or closed the input. A
 * refusal to choose is not an error to report back at them.
 */
export function select(title, items, { stdout = process.stdout } = {}) {
  const offered = items.filter(Boolean);
  if (offered.length === 0) return null;
  if (title) stdout.write(`${title}\n`);
  for (const item of offered) {
    stdout.write(`  ${String(item.key).padStart(2)}  ${item.label}\n`);
  }
  stdout.write('\n');
  const answer = question('> ', stdout);
  if (answer === null) return null;
  const typed = answer.trim();
  const chosen = offered.find((item) => String(item.key) === typed)
    // A name typed in full is as clear as its number, and quicker for someone
    // who already knows what they want.
    || offered.find((item) => item.name && item.name === typed);
  return chosen ? chosen.value : null;
}

export function ask(prompt, { stdout = process.stdout, fallback = null } = {}) {
  const answer = question(`${prompt} `, stdout);
  if (answer === null) return fallback;
  return answer.trim() || fallback;
}

/**
 * The terminal is in its ordinary line-editing mode, so it does the echoing and
 * the backspaces itself and returns the whole line at once. mc adds nothing to
 * that, which is why nothing is left behind to clean up.
 */
function question(prompt, stdout) {
  stdout.write(prompt);
  let fd = null;
  try {
    fd = openSync('/dev/tty', 'r');
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, null);
    if (read === 0) return null;
    return buffer.toString('utf8', 0, read).replace(/\r?\n$/u, '');
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}
