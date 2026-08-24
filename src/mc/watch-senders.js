/**
 * Who the watchers are, and how their mail is told apart from everyone else's.
 *
 * Two daemons write into PM's inbox by name: the round (`mc watch pm`) and
 * the guard (`mc watch sessions`). Neither is a person and neither is a
 * session, and a message from either is a knock — latency on something that
 * already happened — never a report or an order. So a watcher's message is
 * not an item: not counted, not named, never a reason to knock.
 *
 * B3 (#389) said that for the round's own files and it was right; it was
 * also half of a loop. Measured 2026-08-24, PM's archive since 22:00Z: 163
 * files, 104 of them from the two watchers (64 %). The round counted the
 * guard's knocks as unprocessed items and knocked; the guard counted the
 * round's knocks as mail that arrived since PM last moved and flagged PM
 * `unattended`, which knocked — and each knock was the other's next item.
 * Six wakes in a row after the fleet went quiet, none of them carrying a
 * report. At that rate a new file in the inbox stops meaning anything, which
 * is how a ruling sat unread for sixteen minutes while a track stood blocked
 * (D-0170).
 *
 * One registry, so a third watcher is added here once and is excused by both
 * readers the same day. The names are fixed rather than read from the working
 * directory: a daemon runs detached from wherever it was started, and
 * `currentHolder()` once signed a guard's flag with a worktree's name.
 *
 * Recognised by the sender line the channel writes as the first thing in
 * every message, never by the filename — a reader recognising the channel's
 * messages by how they are named would be a second copy of `work-send.js`'s
 * naming rule. Reading two lines of frontmatter is not opening the item: the
 * reader still forms no opinion about what anything is about.
 */
import { readFileSync } from 'node:fs';

export const WATCHERS = Object.freeze({
  pm: Object.freeze({ name: 'mc watch pm', kind: 'watcher' }),
  sessions: Object.freeze({ name: 'mc watch sessions', kind: 'watcher' }),
});

const SENDER_LINES = Object.freeze(Object.values(WATCHERS).map((sender) => `\nfrom: ${sender.name}\n`));

/** Is this inbox file a watcher's knock, whichever watcher wrote it? */
export function isWatcherMessage(path) {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 200);
    return head.startsWith('---\n') && SENDER_LINES.some((line) => head.includes(line));
  } catch { return false; }
}
