/**
 * Staleness detection for memoro-cli installs.
 *
 * Two flavours of stale:
 *   1. `hooks` — a legacy raw-tool hook entry in ~/.claude/settings.json was
 *      stamped by an older memoro-cli than the one currently installed.
 *   2. `npm` — the cached `latestVersion` from registry.npmjs.org is newer
 *      than the installed binary. Plain "your CLI is out of date" case.
 *
 * Pure function — every input is explicit, no I/O — so the tests can drive
 * the full matrix without sandboxing HOME.
 */

import { isSemverGreaterThan } from './update-check.js';

/**
 * @param {Object} input
 * @param {string|null} input.installedVersion  - this binary's version
 * @param {string|null} input.hookVersion       - version stamped in settings.json (null if missing/never installed)
 * @param {string|null} input.latestVersion     - latest from npm cache (null if never checked)
 * @returns {{stale: boolean, reasons: string[], latestVersion: string|null, hookVersion: string|null}}
 *
 * `reasons` is a stable-ordered array containing zero or more of
 * 'hooks' and 'npm'. Callers can render different copy per reason.
 */
export function detectStaleness({ installedVersion, hookVersion, latestVersion }) {
  const reasons = [];

  if (hookVersion && installedVersion && isSemverGreaterThan(installedVersion, hookVersion)) {
    reasons.push('hooks');
  }
  if (latestVersion && installedVersion && isSemverGreaterThan(latestVersion, installedVersion)) {
    reasons.push('npm');
  }

  return {
    stale: reasons.length > 0,
    reasons,
    latestVersion: latestVersion || null,
    hookVersion: hookVersion || null,
  };
}

/**
 * Render the staleness banner that prepends the lens markdown block.
 *
 * The banner lives inside the managed lens block, so it surfaces in Claude
 * Code's standing context on the next session — the user (and the LLM) see
 * it without needing a TTY notice. Plain markdown blockquote, no emoji-only
 * line; the warning emoji is fine here because this is user-facing rendered
 * markdown, not source code.
 */
export function formatStaleLensBanner({ installedVersion, hookVersion, latestVersion, reasons }) {
  const lines = ['> ⚠️  memoro-cli update available.'];

  if (reasons.includes('npm') && latestVersion) {
    lines.push(`> Installed: ${installedVersion || 'unknown'} · Latest on npm: ${latestVersion}`);
  } else if (reasons.includes('hooks') && hookVersion) {
    lines.push(`> Installed: ${installedVersion || 'unknown'} · Hooks last installed for: ${hookVersion}`);
  }

  lines.push('>');
  lines.push('> To update the CLI, run from your shell:');
  lines.push('> `npm install -g memoro-cli`');
  lines.push('>');
  lines.push('> Then start Memoro-aware sessions with `mc`.');

  return lines.join('\n');
}

/**
 * One-line copy for `memoro-cli status`.
 */
export function formatStaleStatusLine({ installedVersion, hookVersion, latestVersion, reasons }) {
  if (reasons.length === 0) return null;
  const bits = [];
  if (reasons.includes('npm') && latestVersion) {
    bits.push(`npm has ${latestVersion} (you have ${installedVersion || 'unknown'})`);
  }
  if (reasons.includes('hooks') && hookVersion) {
    bits.push(`legacy hooks stamped ${hookVersion}, binary is ${installedVersion || 'unknown'} — use \`mc\` for Memoro sessions`);
  }
  return bits.join('; ');
}
