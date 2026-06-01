/**
 * Gemini CLI adapter — phase-2 stub.
 *
 * Full adapter coverage (getStatus probe, token vault, hook install) is
 * not in scope here. This stub exists so `mc adapter sync` (§13c) can
 * surface "what would gemini get?" even before a full adapter lands —
 * see plan §13f phase 2 ("gemini gets a stub").
 *
 * Per agents.md convention, Gemini CLI is expected to read project-level
 * `AGENTS.md`. We can't fully verify Gemini's instruction-file lookup
 * from the brief alone, so `instructionsFile()` returns null today and
 * the question is logged as a §13 follow-up. When verified, flip the
 * return to `{ path: 'AGENTS.md', renderer: 'markdown-wrapper' }`.
 *
 * Deliberately NOT registered in `src/adapters/index.js` — the registry
 * gates `mc auth status` + the get-status contract test, and this stub
 * doesn't satisfy either contract yet. The adapter-sync command discovers
 * adapters from its own known-list, not the registry.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ID = 'gemini-cli';
export const LABEL = 'Gemini CLI';

/**
 * Per §13a — every adapter optionally exposes `instructionsFile()` so
 * `mc adapter sync` can materialise a tool-native instruction file from
 * the canonical protocol.
 *
 * Returns null today: we don't have a verified source confirming Gemini
 * CLI reads `AGENTS.md` (vs. some other path). Sync skips null and the
 * coordinator can flip this in a follow-up once verified.
 */
export function instructionsFile() {
  return null;
}

/**
 * Detect whether the user has Gemini CLI artefacts on this machine.
 * Soft signal; ~/.gemini/ is what the CLI creates today per the install
 * docs. Not load-bearing for sync (sync runs whether detected or not),
 * but kept consistent with the other adapters.
 */
export function detect() {
  return existsSync(join(homedir(), '.gemini'));
}
