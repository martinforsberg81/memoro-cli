import { createFetchTranscriptHandler } from '../commands/handlers/fetch-transcript.js';

export function createDispatchMessageHandler({ deliver, now = () => new Date() } = {}) {
  return async function dispatchMessage(args) {
    const message = typeof args?.message === 'string' ? args.message : null;
    if (!message?.trim()) throw new Error('message required');
    if (typeof deliver === 'function') deliver(message);
    return { ok: true, delivered_at: now().toISOString() };
  };
}

export function createWrapWsHandlers({ transcriptPath = null, source, deliver, now } = {}) {
  return {
    fetch_transcript: createFetchTranscriptHandler({
      transcriptPath,
      source,
    }),
    dispatch_message: createDispatchMessageHandler({
      deliver,
      now,
    }),
  };
}
