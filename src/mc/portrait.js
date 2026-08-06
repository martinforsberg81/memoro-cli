/**
 * The Coding Profile, handed to a tool as a new conversation begins.
 *
 * The profile is the user's, not mc's: it lives in Memoro as part of their
 * profile and `mc coding-profile read|diff|write` is how it is edited. All
 * that is needed here is to put it in front of the tool once, at the moment a
 * conversation starts.
 *
 * mc has been wrong about the "where" three times, each time by writing to a
 * file it did not own. It put the profile in the repository's `CLAUDE.md` and
 * `AGENTS.md`, which are tracked project state, and left a dirty worktree
 * after every launch. It then moved to a startup message, which is why 1010 of
 * 1393 conversations on this machine open with `# Session grounding` instead
 * of with something their author said. It then wrote the tools' own
 * `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, which is tidier and still
 * mc leaving state in someone else's file.
 *
 * There is a channel that needs no file at all. Both tools take instructions
 * as a launch argument:
 *
 *   claude  --append-system-prompt <markdown>
 *   codex   -c instructions=<markdown>
 *
 * Verified rather than assumed: `codex exec -c instructions="…begin every
 * reply with QX7"` answered `QX7 Hej på dig.`, and a second run with a shell
 * task still listed the directory, so the base instructions are layered
 * rather than replaced.
 *
 * Only a new conversation gets it. A resumed one already has it in its own
 * history, and handing it over again would say the same thing twice.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from './logger.js';
import { mcHome } from './paths.js';

const PROFILE_PATH = '/api/mc/coding-profile';
const DEFAULT_API_URL = 'https://meetmemoro.app';

/**
 * Opening a piece of work must not wait on a server. The profile is read
 * once, quickly, and kept — so a slow network costs a moment and an
 * unreachable one costs nothing at all, because the last answer is still on
 * disk. Nothing here throws: a conversation without the profile is worse than
 * one with it, and far better than one that would not start.
 */
const FETCH_TIMEOUT_MS = 2500;

export function cachePath() {
  return join(mcHome(), 'coding-profile.md');
}

export function readCached() {
  try {
    const text = readFileSync(cachePath(), 'utf8').trim();
    return text || null;
  } catch { return null; }
}

function writeCache(markdown) {
  try {
    mkdirSync(dirname(cachePath()), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(), `${markdown.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    log('portrait.cache-write-failed', { error: String(error?.message || error) });
  }
}

/**
 * The one read. Returns the profile markdown, or null.
 */
export async function loadProfile({ env = process.env, deps = {} } = {}) {
  const cached = readCached();
  try {
    const { getSecret } = deps.keychain || await import('../lib/keychain.js');
    const { ACCOUNTS } = deps.auth || await import('../commands/auth.js');
    const { readConfig, getApiUrl } = deps.config || await import('../lib/config.js');
    const { memoroFetch } = deps.api || await import('../lib/api.js');

    const token = await getSecret(ACCOUNTS.TOKEN);
    if (!token) return cached;
    const apiUrl = getApiUrl([]) || (await readConfig().catch(() => ({}))).apiUrl || DEFAULT_API_URL;

    const response = await memoroFetch(apiUrl, PROFILE_PATH, { token, timeoutMs: FETCH_TIMEOUT_MS });
    const markdown = response?.profile?.markdown;
    if (typeof markdown !== 'string' || !markdown.trim()) return cached;
    if (markdown.trim() !== cached) writeCache(markdown);
    return markdown.trim();
  } catch (error) {
    log('portrait.unavailable', { cached: Boolean(cached), error: String(error?.message || error) });
    return cached;
  }
}

/**
 * How each tool takes it. A tool mc has no channel for simply gets nothing —
 * silently, because the profile is enrichment and its absence is not a fault
 * the user can act on at the moment they are trying to start work.
 */
export function profileArgs(toolId, markdown) {
  if (!markdown) return [];
  if (toolId === 'claude-code') return ['--append-system-prompt', markdown];
  if (toolId === 'codex') return ['-c', `instructions=${JSON.stringify(markdown)}`];
  return [];
}

export function cacheExists() {
  return existsSync(cachePath());
}
