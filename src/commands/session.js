/**
 * memoro-cli session upload <transcript>
 *
 * Reads a Claude Code transcript file, distills locally, POSTs to Memoro.
 * Raw transcript never leaves the machine.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSecret } from '../lib/keychain.js';
import { readConfig, updateConfig, getApiUrl, CONFIG_DIR } from '../lib/config.js';
import { ACCOUNTS } from './auth.js';
import { parseTranscript, distill } from '../lib/distill.js';
import { memoroFetch } from '../lib/api.js';
import { confirm } from '../lib/prompt.js';

export async function uploadSession(argv) {
  const flags = parseFlags(argv);
  const positional = argv.filter(a => !a.startsWith('--'));
  const transcriptPath = positional[0];

  if (!transcriptPath) {
    console.error('Usage: memoro-cli session upload <transcript-path> [--repo <name>] [--tool-version <v>] [--dry-run]');
    return 2;
  }
  if (!existsSync(transcriptPath)) {
    console.error(`Transcript not found: ${transcriptPath}`);
    return 1;
  }

  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) {
    console.error('Not logged in. Run `memoro-cli login` first.');
    return 1;
  }
  const anthropicKey = await getSecret(ACCOUNTS.ANTHROPIC);
  if (!anthropicKey) {
    console.error('Anthropic API key not set. Run `memoro-cli config set anthropic-api-key sk-ant-...`');
    return 1;
  }

  const config = await readConfig();
  const apiUrl = getApiUrl(argv) || config.apiUrl;

  console.error(`Distilling ${transcriptPath}…`);
  const raw = await readFile(transcriptPath, 'utf8');
  const parsed = parseTranscript(raw);
  if (parsed.messages.length === 0) {
    console.error('Transcript has no usable messages.');
    return 1;
  }

  const payload = await distill({
    parsed,
    anthropicApiKey: anthropicKey,
    repoHint: flags.repo,
    toolVersion: flags.toolVersion,
  });

  // First-session trust moment: dry-run preview + confirmation.
  const isFirst = !config.lastSessionUploadAt;
  if (flags.dryRun || (isFirst && !flags.yes)) {
    const previewPath = join(CONFIG_DIR, 'last-session-preview.json');
    await writeFile(previewPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    console.error('');
    console.error('── Distilled payload ────────────────────────────────────');
    console.error(JSON.stringify(payload, null, 2));
    console.error('─────────────────────────────────────────────────────────');
    console.error(`Preview written to ${previewPath}`);
    if (flags.dryRun) {
      console.error('(dry-run; nothing uploaded)');
      return 0;
    }
    const ok = await confirm('First upload — send this to Memoro?', { defaultYes: true });
    if (!ok) {
      console.error('Cancelled.');
      return 1;
    }
  }

  const result = await memoroFetch(apiUrl, '/api/sessions/external', {
    token,
    method: 'POST',
    body: payload,
  });

  await updateConfig({ lastSessionUploadAt: new Date().toISOString() });

  if (result.duplicate) {
    console.error(`Session already stored as ${result.contentId} (no change).`);
  } else {
    console.error(`✓ Session uploaded as ${result.contentId}.`);
    console.error(`  View: ${apiUrl.replace(/\/$/, '')}/app/library`);
  }
  return 0;
}

function parseFlags(argv) {
  const flags = { repo: null, toolVersion: null, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' && argv[i + 1])          { flags.repo = argv[++i]; continue; }
    if (a === '--tool-version' && argv[i + 1])  { flags.toolVersion = argv[++i]; continue; }
    if (a === '--dry-run')                      { flags.dryRun = true; continue; }
    if (a === '--yes' || a === '-y')            { flags.yes = true; continue; }
  }
  return flags;
}
