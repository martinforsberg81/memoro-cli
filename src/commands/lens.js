/**
 * memoro-cli lens pull [--tool <id>] [--repo <name>]
 *
 * Legacy helper: fetches the old coding lens from Memoro and writes it as a
 * managed section into the target tool's config file. Normal mc startup uses
 * User Profile + Coding Profile context through /api/mc/context.
 */

import { getSecret } from '../lib/keychain.js';
import { readConfig, updateConfig, getApiUrl } from '../lib/config.js';
import { ACCOUNTS } from './auth.js';
import { memoroFetch } from '../lib/api.js';
import { getAdapter } from '../adapters/index.js';
import { getPackageVersion } from '../lib/version.js';
import { detectStaleness, formatStaleLensBanner } from '../lib/staleness.js';

export async function pullLens(argv) {
  const flags = parseFlags(argv);
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('Not logged in. Run `memoro-cli login` first.');
    return 1;
  }

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;
  const adapter = getAdapter(flags.tool);

  const qs = flags.repo ? `?repo=${encodeURIComponent(flags.repo)}` : '';
  const result = await memoroFetch(apiUrl, `/api/lens/portrait-coding${qs}`, { token });

  if (!result?.markdown) {
    console.error('No legacy lens content available yet — Memoro needs more observation data.');
    // Still bust any stale managed block so it doesn't go stale silently.
    await adapter.removeLens({ cwd: process.cwd() });
    return 0;
  }

  // Prepend a staleness banner if the running binary is newer than the
  // hook stamp, or if npm has a newer release than what's installed. Banner
  // lives inside the managed lens block, so it lands in Claude Code's
  // standing context on the next session — no TTY required.
  const markdown = await maybePrependStalenessBanner(result.markdown, adapter, config);

  const target = await adapter.writeLens(markdown, { cwd: process.cwd() });
  await updateConfig({ lastLensPullAt: new Date().toISOString() });
  console.error(`✓ Legacy lens written to ${target}`);
  console.error(`  Version: ${result.version || 'unknown'} · Generated: ${result.generatedAt || 'now'}`);
  return 0;
}

async function maybePrependStalenessBanner(markdown, adapter, config) {
  if (typeof adapter.readInstalledHookVersion !== 'function') return markdown;
  let hookVersion = null;
  try {
    hookVersion = await adapter.readInstalledHookVersion();
  } catch { /* best effort — never block the lens write on this */ }

  const installedVersion = await getPackageVersion();
  const latestVersion = config.latestVersion || null;
  const status = detectStaleness({ installedVersion, hookVersion, latestVersion });
  if (!status.stale) return markdown;

  const banner = formatStaleLensBanner({
    installedVersion,
    hookVersion,
    latestVersion,
    reasons: status.reasons,
  });
  return `${banner}\n\n${markdown}`;
}

function parseFlags(argv) {
  const flags = { tool: 'claude-code', repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tool' && argv[i + 1]) { flags.tool = argv[++i]; continue; }
    if (a === '--repo' && argv[i + 1]) { flags.repo = argv[++i]; continue; }
  }
  return flags;
}
