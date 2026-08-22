/**
 * The alarm clock a session set for itself.
 *
 * A Claude conversation can schedule its own next turn — `ScheduleWakeup`,
 * with a prompt and a delay — and the harness re-invokes it when the delay
 * runs out. Nothing outside the transcript knows. One session ran the full
 * contract suite eleven times that way, on an eight-gigabyte machine, with the
 * suite right held by another area the whole time (D-0155): the pane looked
 * idle, the orders in its inbox were unread, and the clock kept ringing.
 *
 * The board can see which panes are alive; this is how it sees which have a
 * clock set, and what the clock will run. Read from the transcript's tail,
 * where a session waiting on its own wakeup has written nothing since.
 *
 * It is a reading of the tool calls, not of the harness's own state, which
 * mc cannot see. What the transcript shows:
 *
 *   - a `tool_use` named ScheduleWakeup with `{prompt, delaySeconds}` sets it;
 *   - one with `{stop: true}` clears it;
 *   - when it rings, the prompt arrives as a user turn with that exact text.
 *
 * So the last ScheduleWakeup decides, a later user turn carrying its prompt
 * means it rang, and a clock that rang and was not set again is no clock.
 */

export const WAKEUP_TOOL = 'ScheduleWakeup';

/**
 * `{ prompt, delay_s, set_at, due_at, reason }` for a clock that is set, or
 * `null`. `set_at`/`due_at` are ISO strings when the entry carried a
 * timestamp, null otherwise.
 */
export function scheduledWakeup(entries) {
  let found = null;
  for (const entry of entries) {
    if (entry.type === 'assistant') {
      const call = lastCall(entry);
      if (!call) continue;
      found = call.input?.stop === true ? null : fromCall(call, entry.timestamp);
      continue;
    }
    // The clock ringing is a user turn whose whole text is the prompt. A
    // human typing the same words is indistinguishable, and the answer is
    // the same: the session has its next turn, and no clock is pending.
    if (found && entry.type === 'user' && userText(entry) === found.prompt) found = null;
  }
  return found;
}

function lastCall(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  let call = null;
  for (const part of content) {
    if (part && part.type === 'tool_use' && part.name === WAKEUP_TOOL) call = part;
  }
  return call;
}

function fromCall(call, timestamp) {
  const input = call.input || {};
  const delay = Number(input.delaySeconds);
  const setAt = timestamp ? Date.parse(timestamp) : NaN;
  return {
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    delay_s: Number.isFinite(delay) ? delay : null,
    set_at: Number.isFinite(setAt) ? new Date(setAt).toISOString() : null,
    due_at: Number.isFinite(setAt) && Number.isFinite(delay) ? new Date(setAt + delay * 1000).toISOString() : null,
    reason: typeof input.reason === 'string' ? input.reason : null,
  };
}

function userText(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part) => part && part.type === 'text' && typeof part.text === 'string');
  return texts.length === content.length && texts.length > 0 ? texts.map((part) => part.text).join('') : null;
}

/** `in 9m` / `overdue 3m` / `due now`, for the board. */
export function dueIn(wakeup, now) {
  if (!wakeup?.due_at) return null;
  const minutes = Math.round((Date.parse(wakeup.due_at) - now) / 60000);
  if (minutes > 0) return `in ${minutes}m`;
  if (minutes < 0) return `overdue ${-minutes}m`;
  return 'due now';
}
