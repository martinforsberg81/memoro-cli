/**
 * The guard's one exception, and its bound.
 *
 * The guard never knocks PM. It appends to the notices ledger and the round
 * delivers on its next pass — that is what keeps exactly one component in
 * charge of the wake channel (design note §5).
 *
 * Except for two patterns. A session that has died will not produce another
 * byte to be noticed by, and one that is out of quota is burning calendar time
 * for nothing; neither can afford to wait for the round. `URGENT_PATTERNS`
 * lives in the ledger, where the round reads it too, so the exception is one
 * constant rather than a rule two programs each remember their own way.
 *
 * Both halves are here: the knock, and the `delivered` line the guard writes
 * itself so the round never carries the same flag a second time.
 */
import { markDelivered } from './watch-notices.js';
import { mcHome } from './paths.js';
import { sendToArea } from './work-send.js';

/**
 * Who the knock is from. Fixed, as the round's is: the guard runs detached
 * from wherever it was started, and `currentHolder()` signed a knock from a
 * guard started in a worktree with that worktree's name (measured
 * 2026-08-23: `from: mc-repo` on a guard's flag in PM's inbox).
 */
const SENDER = Object.freeze({ name: 'mc watch sessions', kind: 'watcher' });

/**
 * Knock, then record it.
 *
 * The file lands in PM's inbox whether or not anybody is awake to be knocked,
 * so `delivered` is written on the strength of the file — the wake is latency,
 * never the delivery. A wake refused because somebody is attached to that pane
 * is the client guard doing its job, and is normal.
 *
 * A channel that throws — no tmux, a read-only home, an area that vanished —
 * is a knock that did not happen, never a round that stopped. The notice stays
 * undelivered in the ledger, so the round carries it on its next pass and the
 * flag is not lost with the knock.
 */
export function knock(notices, {
  root = mcHome(), send = null, recipient = 'pm', now = new Date(),
} = {}) {
  const items = [...notices];
  if (items.length === 0) return { ok: true, sent: false, delivered: [] };
  const deliver = send || ((message) => sendToArea(message));
  let result = null;
  try {
    result = deliver({ name: recipient, message: knockText(items), sender: SENDER, wake: true });
  } catch (error) {
    return { ok: false, reason: error?.message || String(error), delivered: [] };
  }
  if (!result?.ok) return { ok: false, reason: result?.reason || 'send-failed', delivered: [] };
  const delivered = items.map((notice) => {
    markDelivered(notice.id, { root, now });
    return notice.id;
  });
  return {
    ok: true, sent: true, woke: Boolean(result.woke), reason: result.reason || null, delivered,
  };
}

/**
 * What the knock says.
 *
 * English, because it is product surface (D-0084), and flat, because a list
 * with an order somebody could read as a ranking is a ranking. It names the
 * session and the pattern and stops: no advice, no summary of what the session
 * was working on, and nothing about which of them matters most.
 */
export function knockText(notices) {
  const lines = notices.map((notice) => `- ${notice.session}: ${notice.pattern}`
    + (notice.detail ? ` — ${notice.detail}` : ''));
  return [
    `mc watch sessions flagged ${notices.length} thing${notices.length === 1 ? '' : 's'} — look here:`,
    '',
    ...lines,
    '',
    'The guard flags; it does not decide, and this list is in the order it saw them, not in any order of importance.',
  ].join('\n');
}
