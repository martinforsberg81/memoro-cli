/**
 * Pure helpers for `mc adapter sync` (plan §13c, phase 2).
 *
 * Sync materialises a thin per-tool instruction file (CLAUDE.md,
 * AGENTS.md, …) from the canonical `docs/coding-agent-protocol.md`,
 * so switching coding tools doesn't strand the user with stale
 * instructions. Each adapter's `instructionsFile()` declares where its
 * wrapper lives + which renderer formats it.
 *
 * This file is pure: no fs, no process. The verb in
 * `src/mc/commands/adapter.js` injects fs deps + the canonical content,
 * then drives these helpers to produce a sync plan.
 *
 * Renderer set: `markdown-wrapper` only. The plan reserves room for
 * `cursor-mdc` etc. in phase 4+/§13f phase 5, but inlining the one
 * renderer we need today avoids a registry premature-abstraction.
 */

import { createHash } from 'node:crypto';

/**
 * 12-char prefix of `sha256(canonicalContent)`. Embedded in the wrapper
 * footer so a re-sync can spot a wrapper that was generated against
 * outdated canonical content (stamp mismatch) vs. a wrapper that was
 * hand-edited (stamp matches but content differs).
 *
 * 12 hex chars ≈ 48 bits, ample to detect any practical change.
 */
export function computeStamp(canonicalContent) {
  if (typeof canonicalContent !== 'string') {
    throw new TypeError('computeStamp: canonicalContent must be a string');
  }
  return createHash('sha256').update(canonicalContent, 'utf8').digest('hex').slice(0, 12);
}

const STAMP_MARKER = 'mc-adapter-sync:version=';
// e.g. "<!-- mc-adapter-sync:version=abc123def456 -->"
const STAMP_REGEX = new RegExp(`<!--\\s*${STAMP_MARKER}([0-9a-f]{12})\\s*-->`);

/**
 * Extract the stamp embedded in an existing wrapper file, or null if no
 * managed stamp is present. Used by drift detection to differentiate
 * "wrapper predates managed sync" from "wrapper was managed but
 * canonical drifted".
 */
export function extractStamp(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(STAMP_REGEX);
  return m ? m[1] : null;
}

/**
 * Build the wrapper file body for `markdown-wrapper`. Thin pointer at
 * the canonical, with a stamp footer for drift detection. Pure +
 * deterministic — same inputs always produce byte-identical output, so
 * "file matches expected" is a strict equality check.
 *
 * @param {object} arg
 * @param {string} arg.canonicalPath    - repo-relative path to canonical
 *   protocol (e.g. `docs/coding-agent-protocol.md`)
 * @param {string} arg.canonicalContent - full text of that file
 * @param {string} arg.toolLabel        - human-readable tool name for
 *   the heading + body ("Claude Code", "Codex / GPT", …)
 * @param {string} arg.wrapperPath      - repo-relative path of the
 *   wrapper itself (e.g. `CLAUDE.md`) — used as the first-line title
 */
export function markdownWrapperFor({
  canonicalPath,
  canonicalContent,
  toolLabel,
  wrapperPath,
}) {
  if (typeof canonicalPath !== 'string' || !canonicalPath) {
    throw new TypeError('markdownWrapperFor: canonicalPath required');
  }
  if (typeof canonicalContent !== 'string') {
    throw new TypeError('markdownWrapperFor: canonicalContent must be a string');
  }
  if (typeof toolLabel !== 'string' || !toolLabel) {
    throw new TypeError('markdownWrapperFor: toolLabel required');
  }
  if (typeof wrapperPath !== 'string' || !wrapperPath) {
    throw new TypeError('markdownWrapperFor: wrapperPath required');
  }
  const stamp = computeStamp(canonicalContent);
  const lines = [
    `# ${wrapperPath}`,
    '',
    `Project instructions for **${toolLabel}**. The full, tool-agnostic`,
    `content lives at [\`${canonicalPath}\`](${canonicalPath}) — **read`,
    `that first**.`,
    '',
    `This wrapper is managed by \`mc adapter sync\`. To update project`,
    `conventions, edit \`${canonicalPath}\` and re-run \`mc adapter sync\`.`,
    `Hand-edits here will be flagged as drift on the next sync.`,
    '',
    `<!-- ${STAMP_MARKER}${stamp} -->`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Compare an existing wrapper file's content against the expected
 * wrapper output. Returns a discriminated state the caller can act on:
 *
 *   - `missing`       — file doesn't exist; sync would create.
 *   - `up-to-date`    — byte-identical to expected; no action.
 *   - `drift-edited`  — file exists, stamp tag matches the current
 *                       canonical hash (so the wrapper *was* generated
 *                       against this canonical), but content differs.
 *                       Almost certainly hand-edited. Refuse without
 *                       --force.
 *   - `drift-stale`   — file exists, stamp tag missing or doesn't match
 *                       the current canonical hash. Wrapper predates
 *                       managed sync OR canonical changed since last
 *                       sync. Refuse without --force.
 *
 * `expectedStamp` is included so a UI can show "wrapper stamp X vs
 * canonical stamp Y" in the drift report.
 */
export function detectDrift({ existing, expected, canonicalContent }) {
  const expectedStamp = computeStamp(canonicalContent);
  if (existing == null) {
    return { state: 'missing', expectedStamp, stamp: null };
  }
  if (existing === expected) {
    return { state: 'up-to-date', expectedStamp, stamp: expectedStamp };
  }
  const stamp = extractStamp(existing);
  if (stamp && stamp === expectedStamp) {
    return { state: 'drift-edited', expectedStamp, stamp };
  }
  return { state: 'drift-stale', expectedStamp, stamp };
}

/**
 * Plan the sync — pure function over a list of adapters + their
 * instructionsFile() returns + on-disk reads. Returns an array of
 * actions; the caller writes (or doesn't, under --dry-run) based on
 * `action` and `--force`.
 *
 * Adapter shape (caller already resolved instructionsFile()):
 *   {
 *     id: 'claude-code',
 *     label: 'Claude Code',
 *     instructions: { path: 'CLAUDE.md', renderer: 'markdown-wrapper' }
 *       | null,
 *   }
 *
 * Filtering by `--tool` happens in the caller (it owns the
 * unknown-tool error path before any fs work).
 *
 * `readWrapper(absPath)` returns the file content as a string, or null
 * if missing. (Throws on permission errors, etc. — caller catches.)
 */
export function planSync({
  adapters,
  canonicalPath,
  canonicalContent,
  resolveWrapperPath,
  readWrapper,
}) {
  if (!Array.isArray(adapters)) {
    throw new TypeError('planSync: adapters must be an array');
  }
  const actions = [];
  for (const adapter of adapters) {
    if (!adapter || !adapter.instructions) {
      actions.push({
        adapterId: adapter?.id ?? '?',
        adapterLabel: adapter?.label ?? '?',
        wrapperPath: null,
        action: 'skip',
        reason: 'no instructionsFile() declared',
      });
      continue;
    }
    const { path: wrapperPath, renderer } = adapter.instructions;
    if (renderer !== 'markdown-wrapper') {
      actions.push({
        adapterId: adapter.id,
        adapterLabel: adapter.label,
        wrapperPath,
        action: 'skip',
        reason: `unsupported renderer: ${renderer}`,
      });
      continue;
    }
    const expected = markdownWrapperFor({
      canonicalPath,
      canonicalContent,
      toolLabel: adapter.label,
      wrapperPath,
    });
    const abs = resolveWrapperPath(wrapperPath);
    const existing = readWrapper(abs);
    const drift = detectDrift({ existing, expected, canonicalContent });
    actions.push({
      adapterId: adapter.id,
      adapterLabel: adapter.label,
      wrapperPath,
      absPath: abs,
      action: driftStateToAction(drift.state),
      driftState: drift.state,
      expectedStamp: drift.expectedStamp,
      currentStamp: drift.stamp,
      expectedContent: expected,
      existingContent: existing,
    });
  }
  return actions;
}

function driftStateToAction(state) {
  switch (state) {
    case 'missing':       return 'create';
    case 'up-to-date':    return 'noop';
    case 'drift-edited':  return 'drift';
    case 'drift-stale':   return 'drift';
    default:              return 'skip';
  }
}

/**
 * Pure helper for the drift-summary blurb in the human-readable output.
 * Returns up to `maxLines` of the diff between existing + expected, as
 * "expected:" / "existing:" pairs of first differing lines. No external
 * diff lib — this is just enough signal to point the user at where the
 * drift lives.
 */
export function summariseDrift({ existing, expected, maxLines = 5 }) {
  if (typeof existing !== 'string') return ['(file missing)'];
  const a = expected.split('\n');
  const b = existing.split('\n');
  const out = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len && out.length < maxLines; i++) {
    if (a[i] !== b[i]) {
      const expLine = a[i] === undefined ? '<EOF>' : a[i];
      const gotLine = b[i] === undefined ? '<EOF>' : b[i];
      out.push(`  line ${i + 1}:`);
      out.push(`    expected: ${truncate(expLine)}`);
      out.push(`    got:      ${truncate(gotLine)}`);
    }
  }
  if (out.length === 0) out.push('  (whitespace-only or trailing-newline difference)');
  return out;
}

function truncate(s, max = 100) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Known adapters for `mc adapter sync`. Owns its own list (rather than
 * pulling from adapters/index.js) because gemini is a phase-2 stub
 * that isn't registered for the full adapter contract; the sync
 * discovery surface is wider than the full-contract surface.
 *
 * Exported as a function so test injection / future "discover from
 * disk" is a one-line swap.
 */
export async function defaultAdapterList() {
  const claudeCode = await import('../adapters/claude-code.js');
  const codex = await import('../adapters/codex.js');
  const gemini = await import('../adapters/gemini.js');
  return [
    asAdapterDescriptor(claudeCode),
    asAdapterDescriptor(codex),
    asAdapterDescriptor(gemini),
  ];
}

function asAdapterDescriptor(mod) {
  const instructions = typeof mod.instructionsFile === 'function'
    ? mod.instructionsFile()
    : null;
  return {
    id: mod.ID,
    label: mod.LABEL,
    instructions,
  };
}

// Names accepted as `--tool <name>`. Centralised so the unknown-tool
// rejection path is testable in isolation.
export const KNOWN_TOOL_NAMES = new Set([
  'claude-code',
  'codex',
  'gemini-cli',
]);
