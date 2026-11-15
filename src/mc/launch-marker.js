/**
 * The launch marker: one line mc puts at the head of a terminal session's
 * opening message, for a tool that records no id mc could hand it.
 *
 * Claude takes `--session-id`, so its conversation id is known before it runs.
 * agy mints its own id, and the only thing mc can hand it is the opening
 * message. The marker carries a fresh nonce there. Everything that must tell
 * "this conversation is the one this launch started" reads the nonce back from
 * the transcript: attribution at close, launch identity, the cost classifier and
 * the held check. Only a marker at the head of the message counts, so a
 * conversation whose text merely quotes one is never mistaken for a launch.
 */
const PREFIX = '<!-- mc-launch-v1 ';
const SUFFIX = ' -->';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** agy wraps the opening message as `<USER_REQUEST>\n<message>`; nothing else may precede the marker. */
const WRAPPER = '<USER_REQUEST>\n';

export function launchMarker({ launch, role = null, programme = null }) {
  return `${PREFIX}${JSON.stringify({ launch, role: role || null, programme: programme || null })}${SUFFIX}`;
}

/** The marker at the head of an opening message, or null: the wrapper or a bare head, and nothing later. */
export function readLaunchMarker(content) {
  if (typeof content !== 'string') return null;
  const head = content.startsWith(WRAPPER) ? content.slice(WRAPPER.length) : content;
  if (!head.startsWith(PREFIX)) return null;
  const end = head.indexOf(SUFFIX);
  const line = head.indexOf('\n');
  if (end < 0 || (line >= 0 && line < end)) return null;
  let value;
  try { value = JSON.parse(head.slice(PREFIX.length, end)); } catch { return null; }
  if (!value || typeof value !== 'object' || typeof value.launch !== 'string' || !UUID.test(value.launch)) return null;
  return { launch: value.launch, role: typeof value.role === 'string' ? value.role : null,
    programme: typeof value.programme === 'string' ? value.programme : null };
}
