/**
 * memoro-cli show <section> [--repo <name>]
 *
 * Fetches the portrait-coding lens in untrimmed "sections" mode and prints
 * one section's markdown to stdout. Designed to be invoked by slash-command
 * files that drop into tool command dirs (e.g. ~/.claude/commands/) so the
 * user can pull specific context on demand without a roundtrip through the
 * LLM.
 *
 * Exit codes:
 *   0  — section printed (or empty-state note)
 *   1  — error (not logged in, unknown section, network failure)
 */

import { getSecret } from '../lib/keychain.js';
import { readConfig, getApiUrl } from '../lib/config.js';
import { ACCOUNTS } from './auth.js';
import { memoroFetch } from '../lib/api.js';

// Hyphenated CLI names → lens section keys (matches src/lenses/portrait-coding.js).
// Only sections useful as standalone on-demand context are shipped; identity
// is the user's own info and voice is a one-liner that adds nothing to a
// coding prompt.
export const SECTION_MAP = {
  'loose-ends':  'openThreads',
  'decisions':   'recentDecisions',
  'rules':       'rules',
  'stack':       'stack',
  'repos':       'repos',
  'practices':   'practices',
  'tool-use':    'toolUse',
};

export function listSections() {
  return Object.keys(SECTION_MAP);
}

export async function showSection(argv) {
  const flags = parseFlags(argv);

  if (!flags.section) {
    console.error('Usage: memoro-cli show <section> [--repo <name>]');
    console.error(`Sections: ${listSections().join(', ')}`);
    return 1;
  }

  const sectionKey = SECTION_MAP[flags.section];
  if (!sectionKey) {
    console.error(`Unknown section: ${flags.section}`);
    console.error(`Known: ${listSections().join(', ')}`);
    return 1;
  }

  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('Not logged in. Run `memoro-cli login` first.');
    return 1;
  }

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;

  const qs = flags.repo ? `?repo=${encodeURIComponent(flags.repo)}` : '';
  let result;
  try {
    result = await memoroFetch(apiUrl, `/api/lens/portrait-coding/sections${qs}`, { token });
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const body = result?.sections?.[sectionKey];
  if (!body) {
    // Graceful empty state — don't fail the slash command.
    console.log(`_No ${flags.section.replace(/-/g, ' ')} yet — Memoro needs more observation data._`);
    return 0;
  }

  console.log(body);
  return 0;
}

function parseFlags(argv) {
  const flags = { section: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' && argv[i + 1]) { flags.repo = argv[++i]; continue; }
    if (a === '--api' && argv[i + 1])  { i++; continue; } // consumed by getApiUrl
    if (!a.startsWith('-') && !flags.section) { flags.section = a; continue; }
  }
  return flags;
}
