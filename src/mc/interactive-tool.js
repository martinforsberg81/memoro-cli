/**
 * The one check every interactive entrance makes of the tool it would start.
 *
 * An interactive session needs a persistent mechanism (`PERSISTENT_DRIVER`) the
 * tool's adapter declares; a tool that declares none runs unattended sessions
 * only (agy, in this release). The entrances (`mc plan`, `manager`, `martin`,
 * `helper`, the work-area opener, `mc session` and the server client) ask this
 * before they write a file, make a worktree, register a session or launch, and
 * refuse with the text it returns (exit 2). It reads the registry and compares
 * no tool name; the tools it offers instead are the ones that declare a driver.
 */
import { canonicalToolId, declared, toolShortName, toolsWith } from '../adapters/index.js';

/** The refusal text for `tool`, or null when it can run interactively (or is not a tool this registry knows: another check names that). */
export function interactiveToolRefusal(tool) {
  if (!canonicalToolId(tool) || declared(tool, 'PERSISTENT_DRIVER') !== undefined) return null;
  const offered = toolsWith('PERSISTENT_DRIVER').map((id) => `--${toolShortName(id)}`);
  return `${toolShortName(tool)} runs unattended sessions only; an interactive session takes ${offered.join(' or ')}`;
}
