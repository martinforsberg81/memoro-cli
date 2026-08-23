/**
 * A refused claim is told to the one who holds the lease.
 *
 * Until now a refusal was printed to the one refused, and only there. The
 * holder — the one person who can end the wait — learned nothing unless the
 * refused party wrote to them. On 2026-08-23 that cost a track twenty minutes
 * of waiting, two asks, and a letter, against a suite right its holder had
 * forgotten was still held after their own round was killed (D-0141 family).
 *
 * So a refusal goes two ways: the sentence to the asker as before, and a file
 * to the holder's inbox with a wake (`mc work send`), saying who asked, for
 * what, how long the lease has been held and whether anything is running
 * under it. The holder decides; the message only makes sure the decision is
 * theirs to make rather than one they never knew was pending.
 *
 * Only a work area has an inbox. A shell holder (`user@host`) cannot be told,
 * and that is reported as such rather than pretended.
 */
import { sendToArea } from './work-send.js';
import { orphanLine } from './lease-owner.js';

/** Tell the holder. Returns what happened so the caller can say it in one line. */
export function tellHolder({
  lease, asker, what, errand, running = [], send = sendToArea, now = new Date(),
} = {}) {
  if (!lease?.held) return { told: false, reason: 'nobody holds it' };
  if (lease.holder === asker?.name) return { told: false, reason: 'the asker is the holder' };
  if (lease.holder_kind !== 'work-area') return { told: false, reason: `${lease.holder} is a shell, not a work area with an inbox` };
  const message = refusalText({ lease, asker, what, errand, running, now });
  let result = null;
  try {
    result = send({ name: lease.holder, message, sender: asker, wake: true, now });
  } catch (error) {
    return { told: false, reason: error?.message || String(error) };
  }
  if (!result?.ok) return { told: false, reason: result?.reason || 'send failed' };
  return { told: true, woke: Boolean(result.woke), reason: result.reason || null, file: result.file || null };
}

/** The message, English, saying the facts and the one command that ends the wait. */
export function refusalText({ lease, asker, what, errand, running = [], now = new Date() }) {
  const held = minutes(Number.isFinite(lease.age_ms) ? lease.age_ms : now.getTime() - Date.parse(lease.since));
  const runs = running.length
    ? running.map((run) => `running: ${run.command || 'a suite'} in ${run.area || run.directory || '?'} (pid ${run.pid}, ${run.elapsed})`).join('; ')
    : 'nothing running under it';
  const orphan = orphanLine(lease);
  const release = what === 'the suite right' ? 'mc suite release' : `mc repo release ${lease.repo || ''}`.trim();
  return [
    `CLAIM REFUSED on your account — ${asker?.name || 'somebody'} asked for ${what}${errand ? ` for “${errand}”` : ''} and was refused because you hold it.`,
    `You have held it for ${held}${lease.errand ? ` for “${lease.errand}”` : ''}; ${runs}.${orphan ? ` ${orphan}.` : ''}`,
    `If your run is over: ${release}. If it is not, nothing to do — they wait.`,
  ].join('\n');
}

function minutes(ms) {
  const m = Math.round(Math.max(0, ms) / 60000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
