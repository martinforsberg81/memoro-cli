/**
 * Managed-section round-trip for tool config files.
 *
 * Every adapter writes a section delimited by a distinctive pair of comment
 * markers so we can find + replace + remove our block without touching
 * anything the user has hand-edited around it.
 *
 * Default markers use HTML comments (work in markdown and most config
 * formats we care about). Per-adapter overrides are possible (e.g. `//`
 * for .cursorrules if preferred) but HTML comments are the safest default
 * since markdown renders them as whitespace.
 */

const DEFAULT_BEGIN = '<!-- memoro:managed:portrait-coding:begin -->';
const DEFAULT_END   = '<!-- memoro:managed:portrait-coding:end -->';

/**
 * Replace (or insert at end) a managed block in `existingContent`.
 *
 * @param {string} existingContent
 * @param {string} blockContent  — the body to place between the markers (no markers)
 * @param {Object} [opts]
 * @param {string} [opts.beginMarker]
 * @param {string} [opts.endMarker]
 * @returns {string} new file contents
 */
export function upsertManagedBlock(existingContent, blockContent, opts = {}) {
  const begin = opts.beginMarker || DEFAULT_BEGIN;
  const end = opts.endMarker || DEFAULT_END;
  const body = blockContent.trim();
  const block = `${begin}\n${body}\n${end}`;

  if (!existingContent) return block + '\n';

  const pattern = new RegExp(
    `${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`,
    'g',
  );
  if (pattern.test(existingContent)) {
    return existingContent.replace(pattern, block);
  }
  // No existing block → append with a preceding blank line if file is non-empty.
  const separator = existingContent.endsWith('\n\n') ? '' : existingContent.endsWith('\n') ? '\n' : '\n\n';
  return existingContent + separator + block + '\n';
}

/**
 * Remove a managed block entirely. If no block is present, returns the
 * original content unchanged.
 */
export function removeManagedBlock(existingContent, opts = {}) {
  const begin = opts.beginMarker || DEFAULT_BEGIN;
  const end = opts.endMarker || DEFAULT_END;
  if (!existingContent) return '';
  const pattern = new RegExp(
    `\\n?${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}\\n?`,
    'g',
  );
  return existingContent.replace(pattern, '');
}

/**
 * Extract the body of a managed block (without markers). Returns null if
 * no block is present.
 */
export function readManagedBlock(existingContent, opts = {}) {
  const begin = opts.beginMarker || DEFAULT_BEGIN;
  const end = opts.endMarker || DEFAULT_END;
  if (!existingContent) return null;
  const pattern = new RegExp(
    `${escapeRegex(begin)}\\n([\\s\\S]*?)\\n${escapeRegex(end)}`,
  );
  const match = existingContent.match(pattern);
  return match ? match[1] : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { DEFAULT_BEGIN, DEFAULT_END };
