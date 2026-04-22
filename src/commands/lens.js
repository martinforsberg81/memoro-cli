/**
 * memoro-cli lens pull [--tool <id>] [--repo <name>]
 *
 * Fetches the coding lens from Memoro and writes it as a managed section
 * into the target tool's config file. Default tool = claude-code.
 */

import { getSecret } from '../lib/keychain.js';
import { readConfig, updateConfig, getApiUrl } from '../lib/config.js';
import { ACCOUNTS } from './auth.js';
import { memoroFetch } from '../lib/api.js';
import { getAdapter } from '../adapters/index.js';

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
    console.error('No lens content available yet — Memoro needs more observation data.');
    // Still bust any stale managed block so it doesn't go stale silently.
    await adapter.removeLens();
    return 0;
  }

  const target = await adapter.writeLens(result.markdown);
  await updateConfig({ lastLensPullAt: new Date().toISOString() });
  console.error(`✓ Lens written to ${target}`);
  console.error(`  Version: ${result.version || 'unknown'} · Generated: ${result.generatedAt || 'now'}`);
  return 0;
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
