/**
 * The Coding Profile, delivered to the tools' own instruction files.
 *
 * The profile is not mc's. It lives in Memoro as part of the user's profile,
 * and `mc coding-profile read|diff|write` is how it is edited. This module is
 * only the last few centimetres: getting it in front of the tool.
 *
 * Where it goes matters more than it sounds, and mc has already been wrong
 * about it twice.
 *
 * Writing it into the repository's `CLAUDE.md` or `AGENTS.md` left a dirty
 * worktree after every single launch, because those files are tracked project
 * state. So delivery moved to launch time instead — Claude took it through
 * `--append-system-prompt`, which is invisible and correct, and Codex, having
 * no equivalent, took it as the conversation's first message. That is why
 * 1010 of 1393 conversations on this machine open with `# Session grounding`
 * rather than with something their author said.
 *
 * Both mistakes came from treating the profile as per-session state. It is
 * not. It is how the user works: the same in every conversation, in every
 * repository, changing rarely. Static content belongs in a static place, and
 * both tools have exactly the right one — an instruction file in their own
 * home, outside any repository:
 *
 *   ~/.claude/CLAUDE.md      read by Claude in every directory
 *   ~/.codex/AGENTS.md       read by Codex in every directory
 *
 * Verified rather than assumed: a probe file in `~/.codex/AGENTS.md` telling
 * Codex to prefix its reply with a token came back with the token.
 *
 * Nothing here happens at launch. Opening a piece of work does not touch the
 * network — that discipline is what made `mc work` fast, and a profile fetched
 * on every start would put a server between the user and their session.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { upsertManagedBlock, readManagedBlock } from '../lib/managed-block.js';
import { log } from './logger.js';

/**
 * A line for the tool, not for the user.
 *
 * Two instruction files now reach the same conversation, and they answer
 * different questions: this one says how the person works, the repository's
 * says what the project requires. Saying which yields avoids the tool having
 * to guess when they appear to disagree.
 */
const PREAMBLE = 'The following is how this user works, from their own profile.'
  + ' It applies across every repository. Where a project\'s own instructions'
  + ' conflict with it, the project\'s instructions win.';

export function portraitTargets(env = process.env) {
  return [
    {
      tool: 'claude-code',
      path: join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'CLAUDE.md'),
    },
    {
      tool: 'codex',
      path: join(env.CODEX_HOME || join(homedir(), '.codex'), 'AGENTS.md'),
    },
  ];
}

export function renderPortrait(markdown) {
  return `${PREAMBLE}\n\n${String(markdown || '').trim()}`;
}

/** What mc has already put in each file, if anything. */
export function readPortrait(env = process.env) {
  return portraitTargets(env).map((target) => ({
    ...target,
    exists: existsSync(target.path),
    body: existsSync(target.path)
      ? readManagedBlock(safeRead(target.path))
      : null,
  }));
}

/**
 * Put the profile in both files, touching nothing else in them.
 *
 * The managed block is the whole contract: mc owns what is between the
 * markers and never looks outside them, so a file the user has written by
 * hand keeps everything they wrote. A target that is already correct is left
 * alone rather than rewritten, because an unchanged file has an unchanged
 * timestamp and that is one less thing to wonder about.
 */
export function syncPortrait({ markdown, env = process.env, dryRun = false } = {}) {
  const body = renderPortrait(markdown);
  const results = [];
  for (const target of portraitTargets(env)) {
    const before = safeRead(target.path);
    const after = upsertManagedBlock(before, body);
    if (before === after) {
      results.push({ ...target, status: 'unchanged', bytes: after.length });
      continue;
    }
    const status = before ? 'updated' : 'created';
    if (!dryRun) {
      try {
        mkdirSync(dirname(target.path), { recursive: true });
        writeFileSync(target.path, after, { encoding: 'utf8', ...(before ? {} : { mode: 0o600 }) });
      } catch (error) {
        log('portrait.write-failed', { path: target.path, error: String(error?.message || error) });
        results.push({ ...target, status: 'failed', reason: String(error?.message || error) });
        continue;
      }
    }
    results.push({ ...target, status, bytes: after.length, kept: before.length });
  }
  log('portrait.sync', { dry_run: dryRun, results: results.map((r) => `${r.tool}:${r.status}`) });
  return results;
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
