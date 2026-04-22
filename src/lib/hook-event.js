/**
 * Claude Code (and compatible tools) deliver hook context as a JSON object
 * on stdin — e.g. SessionEnd provides { session_id, transcript_path, cwd,
 * hook_event_name, reason }. These helpers let a command accept that
 * payload transparently when invoked from a hook.
 */

export function parseHookEvent(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function readHookEvent({ stdin = process.stdin } = {}) {
  if (stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return parseHookEvent(Buffer.concat(chunks).toString('utf8').trim());
}
