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
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';
import { menuReason, readMenu } from './menu-read.js';
import { reservedRoleName } from './roles.js';
import { dropWake, enqueueWake, flushWakeQueue } from './wake-queue.js';
import { inspectWorkArea } from './work-area.js';
import { currentHolder } from './work-identity.js';
import { backgroundTarget } from './work-open.js';
import { toolProcesses } from './work-status.js';

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

/**
 * How long a submission gets to leave the prompt — per look, and how many.
 *
 * One look at 400ms was the rule, and it was measured wrong on 2026-08-23:
 * on PM's idle pane the notice was still drawn in the box 600ms after Enter
 * and had become a turn by the next look. A wake that looks once reads
 * "still in the box", presses again, reads it again, and clears with C-u a
 * line that was on its way — reported as "it stayed in the prompt", which
 * is what three panes said that evening. So a key gets several looks, and
 * the next key is pressed only when the line has had its time.
 */
const SUBMIT_MS = 400;
const SUBMIT_LOOKS = 6;

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
 * wrapped a few times and a TUI with several rows under its box: the status
 * line, a `/rc active` row, a ledger row and a row per running agent were
 * measured on PM's pane, where a tolerance of three rows read as "could not
 * find its prompt" and refused every knock.
 */
// A rule may carry one short label inside it: PM's box is drawn with its
// upper border reading `──── PM ─`, and a rule that allowed no letters at all
// missed that border, found the one above it, and answered "could not find
// its prompt" to every knock on PM (measured 2026-08-22).
const RULE = /^[^A-Za-z0-9]*[-─═+]{3,}(?:\s+\S{1,24}\s+[-─═+]+)?[^A-Za-z0-9]*$/u;
const PROMPT_ROW = /^\s*(?:[|│]\s*)?[>❯»]\s?/u;
const BOX_EDGE = /^\s*[|│]\s?/u;
const BOX_ROWS = 8;
const BELOW_BOX = 10;

/**
 * The drawing is not the input (D-0151).
 *
 * A pane can show text after the prompt mark that is not in the input at all:
 * an order already carried out, redrawn from an old frame, and redrawn again
 * after `C-u` clears nothing. Three panes measured, all three; the guard read
 * that ghost as somebody's draft and refused for a day, and the fleet was
 * booked as waiting on a person who had typed nothing.
 *
 * So text in the box is a question, not an answer, and the question is put to
 * the input itself: one character typed, the row read back, the character
 * deleted. If the row became the character alone, the input was empty and the
 * text was a drawing. If the character landed after the text, the text is
 * real, and it is left exactly as it was. Measured by hand on the three panes
 * and again before this was written: `x` replaces the ghost, `BSpace` removes
 * the `x`, and the ghost is drawn back within half a second.
 */
const PROBE = 'x';
const PROBE_ATTEMPTS = 5;

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

/**
 * A notice mc left behind is mc's, whoever typed it.
 *
 * Measured 2026-08-23 on PM's pane: a wake typed its notice into a busy pane,
 * gave up before Enter, and left it. Every wake after that read the box,
 * probed it, found real text, and queued itself behind a "draft" — for an
 * hour and a quarter, while four tracks stood still. The draft was mc's own
 * sentence. So text shaped like a notice is not somebody's draft: it is a
 * knock that stopped halfway, and the right thing to do with it is to finish
 * it — press Enter — rather than to wait for a person to notice it and do the
 * same. The shape is matched loosely (any path, any sender, spaces as a wrap
 * left them) because the stranded one may be older than the current wording.
 */
const NOTICE_SHAPE = /^mc: new in \S+ from \S+ - read it now$/u;

/**
 * What the TUI draws in an empty box while a turn it took is waiting its go.
 *
 * A busy conversation does not run a submitted line at once; it queues it,
 * and says so in the box. Seen on a pane that is mid-answer, that is the
 * turn's receipt — the one the pane gives before it can show the turn itself.
 */
const QUEUED_MARKER = 'Press up to edit queued messages';

/** Is this text an mc wake notice — this wording or an earlier one? */
export function isMcNotice(text) {
  return NOTICE_SHAPE.test(String(text ?? '').replace(/\s+/gu, ' ').trim());
}

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
  processes = null,
} = {}) {
  const area = inspectWorkArea(name, env, { conversations: false, git: false });
  if (!area.exists) return { ok: false, reason: 'no-such-area' };

  const file = writeMessage({ areaPath: area.path, message, sender, now });

  if (!wake) return { ok: true, file, woke: false, reason: 'not-asked' };
  const target = backgroundTarget(name, { run: run ? (args) => run(args) : null, env });
  if (!target) {
    // "Nothing is running" was the one sentence in the chain a person reads,
    // and for nine sessions it pointed away from the fault: they were running,
    // in panes mc could not address (D-0136). Now a pane is found by where it
    // stands; what is left is a tool with no pane at all — started from a
    // plain terminal — and that is said as what it is.
    const standing = (processes || toolProcesses)([area.path, ...area.worktrees.map((item) => item.path)]);
    if (standing.length > 0) {
      return { ok: true, file, woke: false, reason: 'not-addressable', processes: standing };
    }
    return { ok: true, file, woke: false, reason: 'no-live-conversation' };
  }

  // A singleton role's pane is the one pane somebody is *meant* to be sitting
  // at — PM is the door to the person (K1.2), so a client on it is the normal
  // state, not a sign that a knock would be noise. Rule 1 refused every knock
  // on it for good (D-0013; measured on every round as "delivered, but did
  // not knock: somebody is attached to it"). The exception is the role, never
  // the sender, and rule 2 still guards whatever the person has typed.
  const inbox = inboxPath(area.path);
  const woken = wakeConversation({
    target, sender: sender.name, inbox, run, sleep, attachedOk: reservedRoleName(name),
  });
  // A draft in the prompt is the one refusal that is not the sender's to
  // argue with and not the recipient's to notice: the file is in the inbox
  // and nothing will say so until the draft goes. So the wake is queued, the
  // guard's round tries it again, and the board shows the session as
  // unreachable meanwhile. Nothing types over the draft, ever.
  if (!woken.ok && woken.guard && woken.reason === DRAFT_REASON) {
    const queued = enqueueWake({
      name, target, sender: sender.name, inbox, reason: woken.reason, root: queueRoot(env), now,
    });
    return {
      ok: true,
      file,
      target,
      woke: false,
      reason: 'queued',
      guard: true,
      queued: true,
      since: queued.entry.since,
      left: false,
    };
  }
  // A knock that landed is all a queued one was waiting to do.
  if (woken.ok) dropWake({ name, root: queueRoot(env) });
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

/** The one refusal that is queued rather than reported and dropped. */
const DRAFT_REASON = 'there is already something in its prompt';

function queueRoot(env) {
  return env?.MC_HOME || mcHome();
}

/**
 * Try every queued wake once — called by the session guard's round.
 *
 * A wake lands when the prompt has cleared, and the entry goes. A target that
 * no longer runs is dropped too: there is nothing to knock on, and the file
 * is still in the inbox for the session's next boot. Everything else stays
 * queued with one more attempt counted, including a draft still there.
 */
export function flushPendingWakes({ root = mcHome(), run = null, sleep = null, now = new Date(), log = () => {} } = {}) {
  const outcomes = flushWakeQueue({
    root,
    now,
    attempt: (entry) => {
      const target = backgroundTarget(entry.name, { run: run ? (args) => run(args) : null });
      if (!target) return { ok: false, gone: true, reason: 'nothing is running there any more' };
      // An entry queued before the notice carried a path has none; the area
      // still knows where its inbox is.
      const area = entry.inbox ? null : inspectWorkArea(entry.name, process.env, { conversations: false, git: false });
      const inbox = entry.inbox || (area?.path ? inboxPath(area.path) : null);
      const woken = wakeConversation({
        target, sender: entry.sender || 'mc', inbox, run, sleep, attachedOk: reservedRoleName(entry.name),
      });
      return { ok: woken.ok, reason: woken.ok ? null : woken.reason };
    },
  });
  for (const outcome of outcomes) {
    if (outcome.outcome === 'woke') log(`queued wake landed in ${outcome.name} (queued since ${outcome.since})`);
    else if (outcome.outcome === 'gone') log(`queued wake for ${outcome.name} dropped — ${outcome.reason}`);
  }
  return outcomes;
}

/** The queued wake for an area is forgotten once something else woke it. */
export function forgetPendingWake(name, { root = mcHome() } = {}) {
  return dropWake({ name, root });
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
function noticeFrom(sender, inbox = null) {
  return `mc: new in ${noticePath(inbox)} from ${sender} - read it now`;
}

/**
 * The place the notice names — a path, not a word (D-0163).
 *
 * "Read your inbox" was unambiguous for every session until one came up with
 * Gmail attached: it read the word, asked for /mcp, and sat for twenty
 * minutes on the morning's most important order. Reading the wrong inbox
 * looks exactly like reading the right one — the session reads *something* —
 * so no guard catches it; only the sentence can. The path is what `mc work
 * send` already prints when it delivers, shortened to `~` so it fits a pane
 * and stays ASCII (the comparisons below depend on that). With no area known,
 * the old `inbox/` stands.
 */
function noticePath(inbox) {
  if (!inbox) return 'inbox/';
  const home = homedir();
  const shown = home && inbox.startsWith(home) ? `~${inbox.slice(home.length)}` : inbox;
  return shown.endsWith('/') ? shown : `${shown}/`;
}

/**
 * Would a wake be allowed to type into this pane right now?
 *
 * The two questions `wakeConversation` asks before it touches a keyboard,
 * pulled out so somebody can ask them without typing: is a person attached,
 * and is the input box visibly empty. Both are reads.
 *
 * The guard (`mc watch sessions`) needs exactly this and nothing after it. A
 * session with mail it has not read, sitting in a pane no wake can reach, is a
 * delivery that arrived and will not be seen — and it is a fact about the pane
 * rather than an opinion about it, so it is answered here rather than by a
 * model looking at a screenshot. Two implementations of "can this pane be
 * woken" would be two answers the day they disagree, so there is one.
 *
 * `pane` and `box` come back with the verdict because the wake needs both and
 * reading them twice would widen the gap between looking and typing.
 */
export function paneWillTakeText({ target, run = null, attachedOk = false, probe = null } = {}) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  if (!attachedOk) {
    const clients = tmux(['list-clients', '-t', target, '-F', '#{client_name}']);
    if (clients?.status !== 0) return { ok: false, reason: 'could not tell whether anybody is attached to it' };
    if (String(clients.stdout || '').trim() !== '') return { ok: false, reason: 'somebody is attached to it' };
  }

  const pane = readPane(tmux, target);
  if (pane === null) return { ok: false, reason: 'could not read the conversation' };
  // A menu first, before any box: the pane is in another mode, waiting on a
  // choice (2026-08-23) — and the live capture showed the menu drawn *below*
  // a prompt box that was still on screen, so a box-first reader would have
  // found the box, probed it, and typed into the menu. A session in a menu
  // is blocked on a person; said as what it is, with the question.
  const menu = readMenu(pane);
  if (menu) return { ok: false, menu, reason: menuReason(menu) };
  const box = readBox(pane);
  if (box === null) return { ok: false, reason: 'could not find its prompt to check it was empty' };
  if (box.text !== '') {
    const litter = isMcNotice(box.text);
    // Text in the drawing is not text in the input (D-0151). A caller that
    // may type asks the input with a probe; a caller that only reads gets
    // the honest answer — a draft or a ghost, and it cannot say which.
    if (!probe) {
      if (litter) return { ok: false, drawn: true, litter: true, reason: 'an mc notice is sitting in its prompt — the next wake submits it' };
      return { ok: false, drawn: true, reason: 'something is drawn in its prompt — a draft, or a ghost only a wake can tell apart (D-0151)' };
    }
    const verdict = probe();
    if (verdict === 'text') {
      // Real text, and mc's own: a knock that stopped before Enter. Not a
      // refusal — the wake finishes it.
      if (litter) return { ok: true, litter: true, pane, box };
      return { ok: false, reason: 'there is already something in its prompt' };
    }
    if (verdict !== 'empty') return { ok: false, reason: 'could not tell whether its prompt was empty' };
  }
  return { ok: true, pane, box };
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
 *     The one exception is a singleton role's pane (`attachedOk`): PM's pane
 *     is attached by design, and a rule that never knocks it is the rule that
 *     had PM reading its inbox only when somebody asked "status?".
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
export function wakeConversation({
  target, sender, inbox = null, run = null, sleep = null, attachedOk = false,
}) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  const wait = sleep || ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  let notice = noticeFrom(sender, inbox);

  // Refused before anything was typed: nothing was touched, so there is
  // nothing to take back and nothing for the sender to worry about.
  const refuse = (reason) => ({ ok: false, guard: true, reason });

  // Read last, immediately before typing: whatever gap remains between looking
  // and typing is the gap, and there is no reason to make it any wider.
  // `attachedOk` is the role-pane exception (D-0013): rule 1 is skipped for
  // a pane meant to have a person at it. The probe is rule 2's answer to the
  // drawing (D-0151): text drawn in the box is a question put to the input,
  // and only a wake — which is about to type anyway — may ask it that way.
  const clear = paneWillTakeText({
    target, run: tmux, attachedOk, probe: () => probeInput(tmux, target, wait),
  });
  if (!clear.ok) return refuse(clear.reason);
  const before = clear.pane;
  const opening = clear.box;

  // How many times this exact notice is already on screen above the box.
  //
  // The notice is identical for every wake from the same sender, so an earlier
  // one is still sitting up there as an old turn — and "the notice is visible
  // above the box" would find *that* one and call this wake delivered. Counted
  // before, compared after: what proves a wake is the number going up, not the
  // text being present. Otherwise a second wake could claim the first one's
  // turn as its own, which is the exact failure this function exists to
  // prevent, arriving from a new direction.
  // A stranded notice is the knock, already typed: it says what this one
  // would say, so it is submitted as it stands and nothing is typed after
  // it. From here on `notice` is that sentence, so every comparison below
  // — landed, alone, became a turn — is made against the text actually in
  // the box rather than the one mc would have written.
  const stranded = Boolean(clear.litter);
  if (stranded) notice = opening.text.replace(/\s+/gu, ' ').trim();
  const alreadyAbove = noticesAbove(before, opening.top, notice);

  if (!stranded) {
    const typed = tmux(['send-keys', '-t', target, '-l', notice]);
    if (typed?.status !== 0) return { ok: false, reason: 'could not type into the conversation' };
  }

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
  let landed = stranded;
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
  // Never drawn, and the pane was busy the whole time. Measured 2026-08-23
  // 19:02Z on PM's pane: the round typed its notice, looked for twelve
  // seconds at an empty box, gave up without Enter — and the notice was in
  // the input all along, painted minutes later, where it stood as a "draft"
  // that queued every wake after it. The box was probed empty before
  // typing and stayed visibly empty since, so Enter now either submits the
  // notice or lands in an empty box and does nothing; leaving it is the one
  // outcome measured to cost something. A pane that was idle and still did
  // not draw the text is a different case, and is still given up on.
  const blind = !landed && quiet < DRAW_ATTEMPTS;
  if (!landed && !blind) return giveUp('the text never reached the prompt', null);

  // Two tries, two spellings. `Enter` is the key's name; `C-m` is the
  // carriage return it stands for. Measured by PM 2026-08-23 on two idle
  // panes (msr-track-3 after nine minutes cooked, msr-design a minute
  // earlier): `send-keys Enter` left the notice standing, `send-keys C-m`
  // started the session at once — while on a busy pane the same evening
  // `Enter` queued the line as it should. Which spelling a TUI honours in
  // which state is not mc's to know, so the second try is the other one,
  // and the result says which one it was.
  const KEYS = ['Enter', 'C-m'];
  for (let attempt = 0; attempt < KEYS.length; attempt += 1) {
    const key = KEYS[attempt];
    const pressed = tmux(['send-keys', '-t', target, key]);
    if (pressed?.status !== 0) return giveUp(`could not press ${key}`, seen);
    // A look that failed puts the warrant back to nothing. The box was mc's
    // notice a moment ago and an Enter has gone in since; whether it is still
    // there, gone, or somebody else's now is exactly what could not be read.
    let pane = null;
    let box = null;
    let still = true;
    for (let look = 0; look < SUBMIT_LOOKS && still; look += 1) {
      wait(SUBMIT_MS);
      pane = readPane(tmux, target);
      if (pane === null) return giveUp('could not read the conversation back', null);
      box = readBox(pane);
      if (box === null) return giveUp('lost sight of its prompt', null);
      still = holdsNotice(box.text, notice);
      // Somebody has written after it: the line stopped being mc's.
      if (still && !isNotice(box.text, notice)) return giveUp('somebody started typing', box.text);
    }

    // Still in the box after its time: nothing happened, and the other
    // spelling of the key is worth pressing.
    if (still) {
      seen = box.text;
      continue;
    }

    // Out of the box — but that is not the question. The question is whether it
    // became a turn, and the only answer mc will take is one more of the notice
    // above the box than there was before typing: this wake's own turn, and not
    // a previous one's.
    //
    // An empty box used to be accepted on its own, and it was the last way left
    // to claim a wake without evidence: a line cleared by an Escape inside the
    // submit window leaves the box exactly as empty as a line that went in.
    // Measured against a real idle pane before removing it — three runs, the
    // turn appears above the box 480–520ms after the notice lands and stays
    // there for twenty seconds, while mc looks 400ms after Enter. So the
    // evidence is there to be had, and there is no reason to accept less.
    if (noticesAbove(pane, box.top, notice) > alreadyAbove) {
      return { ok: true, attempts: attempt + 1, ...(attempt ? { key } : {}), ...(stranded ? { stranded } : {}) };
    }

    // A busy pane cannot show the turn yet — it shows the receipt instead.
    // Measured 2026-08-23 on PM's pane, mid-answer for seven minutes: Enter
    // put `Press up to edit queued messages` in the box at once, the turn
    // appeared above it when the answer ended, and the inbox was read within
    // the minute. A placeholder on a pane that is *not* busy is still
    // nothing: the line went somewhere, and nowhere mc can point to.
    if (busy(pane) && box.text.includes(QUEUED_MARKER)) {
      return { ok: true, attempts: attempt + 1, queued: true, ...(attempt ? { key } : {}), ...(stranded ? { stranded } : {}) };
    }
    // Typed blind, and still nothing to point to: not claimed as a wake, and
    // not left behind either — whatever was in the input has had its Enter.
    if (blind && !holdsNotice(box.text, notice)) {
      return { ok: false, reason: 'typed into a busy pane that never drew it; Enter was pressed so nothing is left standing', left: false, blind: true };
    }
    return giveUp('the notice left the prompt without becoming a turn', null);
  }
  return giveUp('it stayed in the prompt', seen);
}

/**
 * Is the text drawn in the box in the input, or only in the drawing?
 *
 * Returns `'empty'` (the drawing lied, the input is clear), `'text'` (the text
 * is real), or `'unknown'` (the probe was never seen, so nothing is claimed).
 * The probe character is deleted on every path, including the unknown one: it
 * was typed, and leaving it is the one outcome this must not produce. On a
 * real draft that is one character appended and removed again; on a ghost the
 * ghost comes back on its own.
 */
function probeInput(tmux, target, wait) {
  const typed = tmux(['send-keys', '-t', target, '-l', PROBE]);
  if (typed?.status !== 0) return 'unknown';
  let verdict = 'unknown';
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    wait(DRAW_MS);
    const pane = readPane(tmux, target);
    const text = pane === null ? null : promptText(pane);
    if (text === null) continue;
    if (text === PROBE) { verdict = 'empty'; break; }
    if (text.endsWith(PROBE)) { verdict = 'text'; break; }
  }
  tmux(['send-keys', '-t', target, 'BSpace']);
  return verdict;
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
 * How many times the notice appears above the input box.
 *
 * Used as a before-and-after count, and the counting is the point. The obvious
 * test is "the box is empty now", and it was wrong: a pane that is mid-answer
 * does not send a turn typed into it, it *queues* it, and the box then shows a
 * placeholder of the TUI's own — `Press up to edit queued messages` — which is
 * neither empty nor mc's notice. Captured from a real pane 140ms after Enter.
 *
 * So the question is asked positively instead: did the notice become a turn?
 * But mere presence cannot answer that, because the notice is identical for
 * every wake from the same sender — an earlier one is still on screen, and
 * finding it would let this wake claim that one's turn as its own. The number
 * going up is what only this wake can have caused.
 *
 * The comparison leans the safe way. A pane that scrolled between the two looks
 * can lose an old notice off the top as the new one arrives, leaving the count
 * unchanged and a real wake reported as a failure. That costs the sender a
 * retry and a truthful "could not wake it"; the other direction costs them a
 * message they believe was delivered and was not.
 */
function noticesAbove(lines, top, notice) {
  // Joined before counting, not matched row by row. A turn is drawn as the
  // notice with a mark in front of it, which is four columns wider than the
  // notice — so a pane narrower than that wraps the turn onto a second row and
  // no single row contains it. Since `bare` drops the line breaks along with
  // every other space, joining first makes a wrapped turn count as the one turn
  // it is. Checked against 460 captured frames of a real 80-column pane, where
  // nothing wraps: both ways of counting agree on every one of them, so this is
  // reach rather than a change of answer.
  const haystack = bare(lines.slice(0, top).join(' '));
  const needle = bare(notice);
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
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
