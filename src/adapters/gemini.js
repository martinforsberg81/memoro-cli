/**
 * Gemini CLI adapter — stub.
 *
 * Full adapter coverage (getStatus probe, token vault, launch contract) is
 * not in scope here; this exists so the tool is named rather than silently
 * absent.
 *
 * Deliberately NOT registered in `src/adapters/index.js` — the registry
 * gates `mc auth status` + the get-status contract test, and this stub
 * doesn't satisfy either contract yet.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ID = 'gemini-cli';
export const LABEL = 'Gemini CLI';

/**
 * Detect whether the user has Gemini CLI artefacts on this machine.
 * Soft signal; ~/.gemini/ is what the CLI creates today per the install
 * docs. Not load-bearing for sync (sync runs whether detected or not),
 * but kept consistent with the other adapters.
 */
export function detect() {
  return existsSync(join(homedir(), '.gemini'));
}
