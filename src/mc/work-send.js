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
 *
 * And waking types into somebody else's input box, which is why it now looks
 * before it types and asks first. Two things seen in real use: a notice left
 * behind by an earlier failed wake and a new one were pasted together and went
 * in as a single sentence; and the pane a person was attached to took a wake
 * while a half-written question of theirs was sitting in the box — where the
 * cleanup keystroke would have deleted it. So: a pane with a client attached is
 * never woken, a pane whose box is not visibly empty is never woken, the
 * cleanup only ever touches text mc can prove it typed itself, and waking at
 * all is something the sender asks for rather than something that happens.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { inspectWorkArea } from './work-area.js';
import { currentHolder } from './work-identity.js';
import { backgroundTarget } from './work-open.js';

/**
 * How long the TUI gets to draw the text before Enter is pressed — and how
 * many times mc is willing to ask again.
 *
 * A single quarter-second was too mean. Under load — the first live smoke
 * caught it — the text was in the prompt but had not been painted yet when mc
 * looked, so it gave up without ever pressing Enter: a wake abandoned because
 * a redraw was slow. Waiting longer by default would slow every send instead,
 * so it asks repeatedly and stops the moment the text appears. A pane that
 * draws promptly still costs one look.
 */
const DRAW_MS = 300;
const DRAW_ATTEMPTS = 5;

/** How long a submission gets to leave the prompt before it is checked. */
const SUBMIT_MS = 400;

/**
 * How the input box is recognised.
 *
 * A drawn rule — a run of dashes with nothing readable on the row — is the
 * border, matched by shape rather than by which characters a particular TUI
 * draws with. The box is the two lowest rules in the pane and everything
 * between them, and its first row carries the prompt mark. Finding it by its
 * borders rather than by that mark is what makes a wrapped line work: the
 * continuation rows have no mark of their own, and looking for the mark alone
 * finds the last row of a wrap instead of the whole of it.
 *
 * `BOX_ROWS` and `BELOW_BOX` keep the search near the foot of the pane, so a
 * box drawn earlier in the conversation and scrolled up can never be read as
 * the one somebody is typing into. They are generous enough for a notice that
 * wrapped a few times and a TUI with a second row of hints under its box.
 */
const RULE = /^[^A-Za-z0-9]*[-─═+]{3,}[^A-Za-z0-9]*$/u;
const PROMPT_ROW = /^\s*(?:[|│]\s*)?[>❯»]\s?/u;
const BOX_EDGE = /^\s*[|│]\s?/u;
const BOX_ROWS = 8;
const BELOW_BOX = 3;

/**
 * The pane is mid-answer, and that is not the same as unresponsive.
 *
 * A TUI that is streaming does not repaint its input box until the streaming
 * pauses, so a notice typed into a busy conversation is genuinely there and
 * genuinely invisible. Giving up on it after five looks abandons a wake that
 * was going to work — and the recipient is exactly the sort of session that is
 * busy, because it is doing the work somebody is writing to it about.
 *
 * So the looks are not a fixed budget: while the pane says it is working, mc
 * keeps waiting, up to a bound. The bound exists because a pane can stay busy
 * for minutes and the sender is holding a terminal.
 */
const BUSY_MARKER = 'esc to interrupt';
const BUSY_ATTEMPTS = 40;

export function inboxPath(areaPath) {
  return join(areaPath, 'inbox');
}

/**
 * Deliver a message, and knock only if asked to.
 *
 * The one failure that loses a message is an area that does not exist, and
 * that is reported as an error. Everything else — no conversation running, a
 * conversation that will not take the keystroke, no tmux on the machine at
 * all — leaves the file where the recipient's boot sequence will read it, and
 * says which of those happened.
 *
 * `wake` is off by default, and that is the point rather than a default worth
 * arguing about. Typing into a pane is the one thing in here that can damage
 * something outside mc, so it happens when a sender says it should and not as
 * a free extra on every send. The file is the delivery; the knock is latency.
 */
export function sendToArea({
  name,
  message,
  sender = currentHolder(),
  env = process.env,
  now = new Date(),
  run = null,
  sleep = null,
  wake = false,
} = {}) {
  const area = inspectWorkArea(name, env, { conversations: false, git: false });
  if (!area.exists) return { ok: false, reason: 'no-such-area' };

  const file = writeMessage({ areaPath: area.path, message, sender, now });

  if (!wake) return { ok: true, file, woke: false, reason: 'not-asked' };
  const target = backgroundTarget(name, { run: run ? (args) => run(args) : null });
  if (!target) return { ok: true, file, woke: false, reason: 'no-live-conversation' };

  const woken = wakeConversation({ target, sender: sender.name, run, sleep });
  return {
    ok: true,
    file,
    target,
    woke: woken.ok,
    reason: woken.ok ? null : woken.reason,
    guard: Boolean(woken.guard),
    // Only meaningful once something was typed: false says the notice is still
    // sitting in the recipient's box, because mc would not take it back out.
    left: woken.left ?? false,
  };
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
 * The notice — ASCII, on purpose, and short.
 *
 * Short so it does not wrap in an ordinary pane. ASCII because everything
 * below turns on comparing what is in the box against this string exactly:
 * that is what lets mc say "this text is mine" before it deletes anything. A
 * pane that re-encodes `ä` or an em dash — one did, in the first live test —
 * would turn every such comparison into "not mine", so the notice is written
 * out of characters no terminal has an opinion about.
 */
function noticeFrom(sender) {
  return `mc: new in inbox/ from ${sender} - read it now`;
}

/**
 * Wake a conversation, and know whether it woke.
 *
 * It asks two questions before it types a character, because the input box it
 * is about to type into belongs to somebody else:
 *
 *  1. is anybody attached? `tmux list-clients` answers it. A pane a person is
 *     sitting at is never woken — they are already here, the notice is noise,
 *     and the cleanup keystroke would land on their half-written sentence.
 *  2. is the box empty, and can mc see that it is? Anything already in there —
 *     someone's draft, a notice an earlier wake gave up on — makes this wake
 *     refuse, because typing after it produces one pasted-together sentence.
 *     A pane whose box mc cannot find at all counts as "not empty": not seeing
 *     it is not the same as it being clear.
 *
 * Then the three steps that were always here. The text goes in literally
 * (`send-keys -l`), so a message containing words tmux reads as key names —
 * Enter, Escape, C-c — cannot turn into keystrokes. The pane is watched until
 * the box holds the notice and nothing else, because a busy TUI can take a
 * second to paint and "not yet" must not be mistaken for "never". Enter
 * follows as its own call, and the pane is read back to see the box go empty.
 *
 * Every exit that is not a submission has to decide what to do with the notice
 * it left behind, and the rule is narrow: `C-u` clears the whole line, so it is
 * pressed only when the last thing mc read out of that box was its own notice
 * and nothing else. Otherwise the line is left exactly as it is and the sender
 * is told it was. Litter is a nuisance — and the next wake refuses on it rather
 * than pasting onto it — while deleting a sentence somebody was writing is not.
 */
export function wakeConversation({ target, sender, run = null, sleep = null }) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  const wait = sleep || ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  const notice = noticeFrom(sender);

  // Refused before anything was typed: nothing was touched, so there is
  // nothing to take back and nothing for the sender to worry about.
  const refuse = (reason) => ({ ok: false, guard: true, reason });

  const clients = tmux(['list-clients', '-t', target, '-F', '#{client_name}']);
  if (clients?.status !== 0) return refuse('could not tell whether anybody is attached to it');
  if (String(clients.stdout || '').trim() !== '') return refuse('somebody is attached to it');

  // Read last, immediately before typing: whatever gap remains between looking
  // and typing is the gap, and there is no reason to make it any wider.
  const before = readPane(tmux, target);
  if (before === null) return refuse('could not read the conversation');
  const box = promptText(before);
  if (box === null) return refuse('could not find its prompt to check it was empty');
  if (box !== '') return refuse('there is already something in its prompt');

  const typed = tmux(['send-keys', '-t', target, '-l', notice]);
  if (typed?.status !== 0) return { ok: false, reason: 'could not type into the conversation' };

  // From here the notice is in somebody's input box. `proof` is the last thing
  // mc actually read out of that box; the line is cleared only when that is the
  // notice by itself, and `left` says which of the two happened.
  const giveUp = (reason, proof) => {
    const mine = proof !== null && isNotice(proof, notice);
    if (mine) tmux(['send-keys', '-t', target, 'C-u']);
    return { ok: false, reason, left: !mine };
  };

  // `seen` is the last thing mc actually read out of that box, and the only
  // warrant it has for clearing the line. A look that fails, or a box that
  // cannot be found, puts it back to null: not knowing what is in there is
  // itself the reason to leave it alone.
  let seen = null;

  // Did the text land, and is it still alone in there? A pane that is not a
  // prompt takes the keystrokes and shows nothing, and pressing Enter at that
  // would report a wake that never was.
  //
  // Asked several times, because "not drawn yet" and "never arrived" look
  // identical in a single glance and only one of them is worth giving up on.
  // A pane that says it is working does not spend its looks: the budget is
  // DRAW_ATTEMPTS *quiet* looks, and streaming resets it.
  let landed = false;
  let quiet = 0;
  for (let attempt = 0; attempt < BUSY_ATTEMPTS && !landed; attempt += 1) {
    wait(DRAW_MS);
    const pane = readPane(tmux, target);
    if (pane === null) return giveUp('could not read the conversation back', null);
    seen = promptText(pane);
    if (seen === null) return giveUp('lost sight of its prompt', null);
    if (isNotice(seen, notice)) { landed = true; break; }
    // Anything other than the notice or an empty box means somebody is typing
    // in there — the box was checked empty a moment ago, so the extra words are
    // theirs. Their line is not mc's to submit and not mc's to clear.
    if (seen !== '') return giveUp('somebody started typing', seen);
    quiet = busy(pane) ? 0 : quiet + 1;
    if (quiet >= DRAW_ATTEMPTS) break;
  }
  if (!landed) return giveUp('the text never reached the prompt', null);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pressed = tmux(['send-keys', '-t', target, 'Enter']);
    if (pressed?.status !== 0) return giveUp('could not press Enter', seen);
    wait(SUBMIT_MS);
    // A look that failed puts the warrant back to nothing. The box was mc's
    // notice a moment ago and an Enter has gone in since; whether it is still
    // there, gone, or somebody else's now is exactly what could not be read.
    const pane = readPane(tmux, target);
    if (pane === null) return giveUp('could not read the conversation back', null);
    const box = readBox(pane);
    if (box === null) return giveUp('lost sight of its prompt', null);

    // Still in the box: either nothing happened and Enter is worth pressing
    // again, or somebody has written after it and the line stopped being mc's.
    if (holdsNotice(box.text, notice)) {
      seen = box.text;
      if (!isNotice(box.text, notice)) return giveUp('somebody started typing', box.text);
      continue;
    }

    // Out of the box. An empty box is the plain case; a box showing something
    // else — the TUI's own placeholder once a busy pane has queued the turn —
    // is the same answer, and is believed only because the notice can be seen
    // above the box as a turn the conversation took.
    if (box.text === '' || submittedAbove(pane, box.top, notice)) {
      return { ok: true, attempts: attempt + 1 };
    }
    return giveUp('the notice left the prompt without becoming a turn', null);
  }
  return giveUp('it stayed in the prompt', seen);
}

/**
 * The pane as rows of text, or `null` if it could not be read at all.
 *
 * Read once, asked several times: what is in the box and whether the pane is
 * busy come from the same capture, so a look costs one tmux call.
 */
function readPane(tmux, target) {
  const pane = tmux(['capture-pane', '-t', target, '-p']);
  if (pane?.status !== 0) return null;
  // The capture is padded with blank rows to the height of the pane; the
  // conversation ends where the text does.
  return String(pane.stdout || '').replace(/\s+$/u, '').split('\n');
}

/**
 * The input box: what is in it, and where it starts — or `null` for "no box mc
 * can find", which is not the same answer and must never be treated as one.
 *
 * Found from the bottom by its two borders, and everything between them is
 * what is in it — including the rows a wrapped line spilled onto, which is why
 * a notice too long for the pane reads back as one string rather than as its
 * last fragment. A turn that was already submitted sits above the whole box,
 * so it is never what this finds; a pane with no box at all — a shell, a tool
 * that has exited — answers `null`, and so does one drawn in a shape mc does
 * not recognise. Refusing to wake on that is the point: a box mc cannot read
 * is a box it cannot promise is empty.
 *
 * `top` is where the box's upper border sits, which is the line between what is
 * still being typed and what has already been said.
 */
function readBox(lines) {
  const bottom = lines.findLastIndex((line) => RULE.test(line));
  if (bottom === -1 || lines.length - 1 - bottom > BELOW_BOX) return null;
  const top = lines.slice(0, bottom).findLastIndex((line) => RULE.test(line));
  if (top === -1 || bottom - top - 1 > BOX_ROWS) return null;

  const [first, ...rest] = lines.slice(top + 1, bottom);
  if (first === undefined || !PROMPT_ROW.test(first)) return null;
  const text = [first.replace(PROMPT_ROW, ''), ...rest.map((line) => line.replace(BOX_EDGE, ''))]
    .join(' ')
    .trim();
  return { text, top };
}

function promptText(lines) {
  return readBox(lines)?.text ?? null;
}

/**
 * Did the notice go in — asked of the conversation, not of the input box.
 *
 * The obvious test is "the box is empty now", and it was wrong. A pane that is
 * mid-answer does not send a turn typed into it, it *queues* it, and once it
 * has, the box shows a placeholder of the TUI's own — `Press up to edit queued
 * messages` — which is neither empty nor mc's notice. Read as "somebody else is
 * typing", that turned every wake of a busy conversation into a reported
 * failure of a wake that had plainly worked, and the recipient of a message is
 * exactly the session likeliest to be busy. Captured from a real pane, 140ms
 * after Enter, while writing this.
 *
 * So the question is asked the other way round and positively: is the notice
 * visible above the box, as a turn the conversation has taken or queued? What
 * the box happens to say afterwards is the TUI's business.
 */
function submittedAbove(lines, top, notice) {
  return lines.slice(0, top).some((line) => bare(line).includes(bare(notice)));
}

/**
 * Is what is in the box mc's own notice, and only that?
 *
 * Whitespace is ignored on both sides, because a box narrower than the notice
 * wraps it and a wrap is a line break mc did not type. Everything else has to
 * match: a notice with one more word after it is somebody's sentence now.
 */
function isNotice(text, notice) {
  return bare(text) === bare(notice);
}

/** Does the box still hold the notice — alone, or with somebody's words after it? */
function holdsNotice(text, notice) {
  return bare(text).includes(bare(notice));
}

function bare(value) {
  return String(value).replace(/\s+/gu, '');
}

/** Is it mid-answer? Leans toward yes: the cost of waiting is only waiting. */
function busy(lines) {
  return lines.some((line) => line.includes(BUSY_MARKER));
}
