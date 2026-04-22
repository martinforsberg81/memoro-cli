/**
 * Public API for programmatic use.
 * Most users should go through the CLI; this exists so the same adapters
 * and distiller can be reused from scripts or editor integrations.
 */

export * as adapters from './adapters/index.js';
export { parseTranscript, buildDistillPrompt, distill } from './lib/distill.js';
export {
  upsertManagedBlock,
  removeManagedBlock,
  readManagedBlock,
  DEFAULT_BEGIN,
  DEFAULT_END,
} from './lib/managed-block.js';
