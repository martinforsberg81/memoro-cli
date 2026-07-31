import { validate as validateClaude } from '../provider-artifact-adapters/claude-code.js';
import { validate as validateCodex } from '../provider-artifact-adapters/codex.js';

// Compatibility exports for callers that validate one provider directly.
// Broker routing itself goes through provider-artifact-adapters/index.js.
export function validateClaudeProviderArtifact(evidence, deps) {
  return validateClaude({ evidence, context: {} }, deps);
}

export function validateCodexProviderArtifact(evidence, deps) {
  return validateCodex({ evidence, context: {} }, deps);
}
