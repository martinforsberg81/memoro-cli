/** Autonomous headless observations. Transport events are observations, never
 * measured progress or authority to choose budgets. v1 sessionStanding is intact. */
import { createHash } from 'node:crypto';
import { canonicalToolId, sessionTransport } from '../adapters/index.js';

const count = n => Number.isSafeInteger(n) && n >= 0;
const jobId = raw => `tool-${createHash('sha256').update(String(raw)).digest('hex').slice(0, 24)}`;
const model = () => ({ kind: 'model', id: null });

export function createSessionObservation(tool, { contextWindow = null } = {}) {
  const id = canonicalToolId(tool); const transport = sessionTransport(tool);
  if (contextWindow !== null && (!count(contextWindow) || contextWindow === 0)) throw new Error('invalid context window');
  const jobs = new Map();
  let context = null; let usage = null; let completed = false;
  const setJob = (raw, active) => {
    if (typeof raw !== 'string' || !raw) return;
    if (active && !jobs.has(raw) && jobs.size >= 256) throw new Error('transport job history exhausted');
    if (active) jobs.set(raw, { kind: 'tool', id: jobId(raw) }); else jobs.delete(raw);
  };
  return {
    transport,
    event(event, at_ms) {
      if (!event || typeof event !== 'object' || !count(at_ms)) return;
      if (id === 'codex') {
        if (['turn.started', 'item.started'].includes(event.type)) completed = false;
        if (['item.started', 'item.updated', 'item.completed'].includes(event.type)
          && ['command_execution', 'mcp_tool_call'].includes(event.item?.type)) {
          setJob(event.item.id, event.type !== 'item.completed');
        }
        if (event.type === 'turn.completed') {
          completed = true;
          if (count(event.usage?.input_tokens) && count(event.usage?.output_tokens)) {
            // This is cumulative usage. It is deliberately NOT current context.
            usage = { ...event.usage, source: 'codex.exec.turn.completed.usage', at_ms, quality: 'measured' };
          }
        }
        if (['turn.failed', 'error'].includes(event.type)) completed = false;
        return;
      }
      if (event.parent_tool_use_id) return; // subagents do not describe the builder
      if (event.type === 'assistant' && event.message?.model !== '<synthetic>') {
        completed = false;
        const u = event.message?.usage;
        if (u && ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(key => count(u[key] ?? 0))) {
          const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          // Last request input is only an estimate of current context, and only
          // with a trusted configured window. No guessed model-window default.
          if (count(u.input_tokens)) context = { tokens, at_ms, source: 'claude.stream-json.assistant.usage', quality: 'estimated' };
        }
        for (const block of Array.isArray(event.message?.content) ? event.message.content : []) if (block?.type === 'tool_use') setJob(block.id, true);
      }
      if (event.type === 'user') {
        for (const block of Array.isArray(event.message?.content) ? event.message.content : []) if (block?.type === 'tool_result') setJob(block.tool_use_id, false);
      }
      if (event.subtype === 'background_tasks_changed') {
        for (const raw of jobs.keys()) if (raw.startsWith('background:')) jobs.delete(raw);
        for (const task of Array.isArray(event.tasks) ? event.tasks : []) if (typeof task?.task_id === 'string') setJob(`background:${task.task_id}`, true);
      }
      if (event.type === 'result') {
        completed = event.is_error !== true && event.subtype === 'success' && event.num_turns !== 0 && !jobs.size;
        if (event.usage) usage = { ...event.usage, source: 'claude.stream-json.result.usage', at_ms, quality: 'measured' };
      }
    },
    sample({ sequence, at_ms, awake_ms, activity = null, progress = null, failure = null }) {
      return { sequence, at_ms, awake_ms, activity: activity || jobs.values().next().value || model(),
        context: context && contextWindow ? { fraction: Math.min(1, context.tokens / contextWindow),
          at_ms: context.at_ms, source: context.source, quality: context.quality } : null, progress, failure };
    },
    // This is a historical request reading. Only the policy's context response
    // describes whether it is still current (or unknown/stale).
    get telemetry() { return structuredClone({ last_request_context: context, cumulative_usage: usage, active_jobs: [...jobs.values()] }); },
    get completed() { return completed && !jobs.size; },
  };
}
