/**
 * The channel between pieces of work: the file first, the waking second.
 *
 * The old world had `mc sessions send`, and it went straight at the running
 * terminal: if the conversation was busy, mid-turn, or simply not there, the
 * message was gone. A report that only exists while somebody is listening is
 * not a report, and a PM that has to poll to be sure is a PM paying a turn
 * for every silence.
 *
 * So a message is a file. It is written atomically into the recipient's
 * `inbox/`, and once it is on disk the send has succeeded — everything after
 * that is best effort. Then, if the recipient has a live conversation, it is
 * woken with a short notice so it reads the inbox now rather than at its next
 * boot. A failed wake costs latency, never the message.
 *
 * Waking is the part that has to be done carefully, and this is where it gets
 * done once for everybody: text and Enter are separate keystrokes, and the
 * submission is verified against the pane instead of assumed. Sending them
 * together lands the text in the prompt without submitting it often enough
 * that people had learned to press Enter twice — a habit, in every sender's
 * fingers, standing in for a fix.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { inspectWorkArea } from './work-area.js';
import { currentHolder } from './work-identity.js';
import { backgroundTarget } from './work-open.js';

/** How long the TUI gets to draw the text before Enter is pressed. */
const DRAW_MS = 250;

/** How long a submission gets to leave the prompt before it is checked. */
const SUBMIT_MS = 400;

/**
 * How many rows sit below the line being typed while it is still in the box.
 *
 * The box is a border, the line, a border, and a hint — so text still waiting
 * to be sent has two or three rows under it (one more if it wrapped), and
 * text that has been sent has the whole box under it instead. That difference
 * is how a submission is recognised, and it does not depend on guessing how
 * tall a pane is.
 *
 * Set to lean the safe way. Read a sent notice as still-waiting and mc presses
 * Enter once more (an empty line, harmless) and reports that it could not
 * wake; read a waiting one as sent and mc claims a wake that never happened,
 * which is the one outcome this whole function exists to prevent.
 */
const BOX_DEPTH = 4;

/**
 * What to look for in the pane — ASCII on purpose.
 *
 * The notice is Swedish, and against a real tmux the first version of this
 * matched on its tail: `läs det nu`. A pane that renders or re-encodes those
 * letters differently — and one did, in the first live test — turns a wake
 * that plainly worked into a reported failure. The path in the notice is the
 * one part of it that no encoding can bend.
 */
const MARKER = 'inbox/';

export function inboxPath(areaPath) {
  return join(areaPath, 'inbox');
}

/**
 * Deliver a message, then try to wake the recipient.
 *
 * The one failure that loses a message is an area that does not exist, and
 * that is reported as an error. Everything else — no conversation running, a
 * conversation that will not take the keystroke, no tmux on the machine at
 * all — leaves the file where the recipient's boot sequence will read it, and
 * says which of those happened.
 */
export function sendToArea({
  name,
  message,
  sender = currentHolder(),
  env = process.env,
  now = new Date(),
  run = null,
  sleep = null,
  wake = true,
} = {}) {
  const area = inspectWorkArea(name, env, { conversations: false, git: false });
  if (!area.exists) return { ok: false, reason: 'no-such-area' };

  const file = writeMessage({ areaPath: area.path, message, sender, now });

  if (!wake) return { ok: true, file, woke: false, reason: 'not-asked' };
  const target = backgroundTarget(name, { run: run ? (args) => run(args) : null });
  if (!target) return { ok: true, file, woke: false, reason: 'no-live-conversation' };

  const woken = wakeConversation({ target, sender: sender.name, run, sleep });
  return { ok: true, file, woke: woken.ok, reason: woken.ok ? null : woken.reason, target };
}

/**
 * The message on disk: one file, named for when it arrived and who sent it.
 *
 * Two lines of frontmatter and the body. It is read by a person as often as
 * by a model — the inbox is a directory you can `cat` — so it is markdown,
 * not JSON, and the sender and the time are the only things mc adds.
 */
export function writeMessage({ areaPath, message, sender, now = new Date() }) {
  const at = now.toISOString();
  const body = String(message ?? '').replace(/\s+$/u, '');
  const contents = `---\nfrom: ${sender.name}\nat: ${at}\n---\n\n${body}\n`;
  return writeFileAtomic(freePath(inboxPath(areaPath), at, sender.name), contents);
}

/**
 * A name that sorts by arrival and says who it came from.
 *
 * Colons are legal in a filename and a menace in one — the Finder shows them
 * as slashes and half the shell one-liners people write about an inbox choke
 * on them — so the timestamp keeps its shape and loses its punctuation. Two
 * messages within the same millisecond from the same sender get a counter
 * rather than one overwriting the other.
 */
function freePath(directory, at, sender) {
  const stamp = at.replace(/:/gu, '-');
  const from = String(sender).replace(/[^A-Za-z0-9._@-]/gu, '-');
  const base = join(directory, `${stamp}-${from}`);
  if (!existsSync(`${base}.md`)) return `${base}.md`;
  for (let index = 2; index < 1000; index += 1) {
    if (!existsSync(`${base}-${index}.md`)) return `${base}-${index}.md`;
  }
  return `${base}-${process.pid}.md`;
}

/**
 * Wake a conversation, and know whether it woke.
 *
 * Three deliberate steps. The text goes in literally (`send-keys -l`), so a
 * message containing words tmux reads as key names — Enter, Escape, C-c —
 * cannot turn into keystrokes. Enter follows as its own call, after the TUI
 * has had a moment to draw. Then the pane is read back: if the notice is
 * still sitting at the foot of the screen it was never submitted, so Enter is
 * pressed once more and the pane read again.
 *
 * If it still has not gone in, that is reported rather than assumed. A
 * message stuck unsent in somebody's prompt looks exactly like a delivered
 * one to the sender, and that is the failure this whole function exists to
 * make impossible.
 */
export function wakeConversation({ target, sender, run = null, sleep = null }) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  const wait = sleep || ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  // Kept short so it does not wrap in an ordinary 80-column pane: a wrapped
  // notice pushes the row mc looks for further from the bottom.
  const notice = `mc: nytt i inbox/ från ${sender} — läs nu`;

  const typed = tmux(['send-keys', '-t', target, '-l', notice]);
  if (typed?.status !== 0) return { ok: false, reason: 'could not type into the conversation' };

  // Did the text land at all? A pane that is not a prompt — a tool that has
  // exited, a shell running something — takes the keystrokes and shows
  // nothing, and pressing Enter at that would report a wake that never was.
  wait(DRAW_MS);
  const landed = inPrompt(tmux, target);
  if (landed === null) return { ok: false, reason: 'could not read the conversation back' };
  if (!landed) return { ok: false, reason: 'the text never reached the prompt' };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pressed = tmux(['send-keys', '-t', target, 'Enter']);
    if (pressed?.status !== 0) return { ok: false, reason: 'could not press Enter' };
    wait(SUBMIT_MS);
    const still = inPrompt(tmux, target);
    if (still === null) return { ok: false, reason: 'could not read the conversation back' };
    if (!still) return { ok: true, attempts: attempt + 1 };
  }
  return { ok: false, reason: 'it stayed in the prompt' };
}

/**
 * Is the notice still sitting in the input box, rather than sent?
 *
 * Told apart by how far off the bottom it is. Waiting to be sent, it has the
 * rest of the box under it — two or three rows. Sent, it is a turn with the
 * whole empty box beneath it, and further up still as the conversation goes
 * on. Reading a fixed number of lines instead got this wrong in both
 * directions: too few and a wrapped line disappears, too many and the turn it
 * became is mistaken for a line never sent.
 *
 * `null` means the pane could not be read at all, which is neither answer.
 */
function inPrompt(tmux, target) {
  const pane = tmux(['capture-pane', '-t', target, '-p']);
  if (pane?.status !== 0) return null;
  // The capture is padded with blank rows to the height of the pane; the
  // conversation ends where the text does.
  const lines = String(pane.stdout || '').replace(/\s+$/u, '').split('\n');
  const last = lines.findLastIndex((line) => line.includes(MARKER));
  if (last === -1) return false;
  return lines.length - 1 - last < BOX_DEPTH;
}
