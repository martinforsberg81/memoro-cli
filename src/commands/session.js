/**
 * memoro-cli session upload <transcript>
 *
 * Reads a Claude Code transcript file, distills locally, POSTs to Memoro.
 * Raw transcript never leaves the machine.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { getSecret } from '../lib/keychain.js';
import { readConfig, updateConfig, getApiUrl, CONFIG_DIR } from '../lib/config.js';
import { ACCOUNTS } from './auth.js';
import { parseTranscript, distill } from '../lib/distill.js';
import { memoroFetch } from '../lib/api.js';
import { confirm } from '../lib/prompt.js';
import { readHookEvent, parseHookEvent } from '../lib/hook-event.js';

export async function uploadSession(argv) {
  const { flags, positional } = parseFlags(argv);
  let transcriptPath = positional[0];

  // --background: fork a detached child that does the real work, so Claude
  // Code's SessionEnd hook returns immediately and the upload survives
  // session teardown (Claude otherwise kills the hook child mid-distill).
  if (flags.background) {
    return await forkDetachedUpload(argv);
  }

  // --from-event-file: read the hook event JSON from a file (populated by
  // the --background parent). Used only by the detached child.
  if (flags.fromEventFile) {
    try {
      const raw = await readFile(flags.fromEventFile, 'utf8');
      const event = parseHookEvent(raw);
      if (event?.transcript_path) transcriptPath = event.transcript_path;
    } finally {
      await rm(flags.fromEventFile, { force: true });
    }
  } else if (!transcriptPath) {
    // When invoked from a SessionEnd hook, the tool pipes a JSON event on
    // stdin (e.g. Claude Code: { transcript_path, session_id, ... }).
    const event = await readHookEvent();
    if (event?.transcript_path) transcriptPath = event.transcript_path;
  }

  if (!transcriptPath) {
    console.error('Usage: memoro-cli session upload <transcript-path> [--repo <name>] [--tool-version <v>] [--dry-run] [--background]');
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
  const hasUser      = parsed.messages.some(m => m.role === 'user');
  const hasAssistant = parsed.messages.some(m => m.role === 'assistant');
  if (!hasUser || !hasAssistant) {
    console.error('Transcript has no real conversation turns — skipping upload.');
    return 0;
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
  const flags = {
    repo: null,
    tool: null,
    toolVersion: null,
    dryRun: false,
    yes: false,
    background: false,
    fromEventFile: null,
  };
  const positional = [];
  const valueFlags = new Set(['--repo', '--tool', '--tool-version', '--api-url', '--api']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' && argv[i + 1])            { flags.repo = argv[++i]; continue; }
    if (a === '--tool' && argv[i + 1])            { flags.tool = argv[++i]; continue; }
    if (a === '--tool-version' && argv[i + 1])    { flags.toolVersion = argv[++i]; continue; }
    if (a === '--dry-run')                        { flags.dryRun = true; continue; }
    if (a === '--yes' || a === '-y')              { flags.yes = true; continue; }
    if (a === '--background' || a === '-b')       { flags.background = true; continue; }
    if (a === '--from-event-file' && argv[i + 1]) { flags.fromEventFile = argv[++i]; continue; }
    // Consume value for any recognized-but-unhandled flag (e.g. --api,
    // handled via getApiUrl(argv) elsewhere) so its value isn't misread as
    // a positional arg.
    if (valueFlags.has(a) && argv[i + 1])         { i++; continue; }
    if (a.startsWith('--')) continue;
    positional.push(a);
  }
  return { flags, positional };
}

/**
 * Spawn a detached grandchild that will outlive us — used to keep the
 * upload running after Claude Code reaps the SessionEnd hook's process
 * tree. We drain stdin into a temp file, then re-exec the same CLI with
 * --from-event-file pointing at it; the parent returns ~instantly so the
 * host tool's hook is done.
 */
async function forkDetachedUpload(argv) {
  // Drain stdin synchronously before we detach — it won't be available
  // to the grandchild.
  let rawStdin = '';
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawStdin = Buffer.concat(chunks).toString('utf8');
  }

  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  const eventFile = join(tmpdir(), `memoro-cli-hook-${Date.now()}-${process.pid}.json`);
  await writeFile(eventFile, rawStdin, { mode: 0o600 });

  // Rebuild argv without --background, and add --from-event-file. This
  // is what the grandchild will receive under `session upload`.
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--background' || a === '-b') continue;
    passthrough.push(a);
  }

  const binJs = process.argv[1];
  const childArgs = [binJs, 'session', 'upload', ...passthrough, '--from-event-file', eventFile];

  // Stream child output to ~/.memoro/hook.log so failures are debuggable
  // without pinning a terminal.
  const logPath = join(CONFIG_DIR, 'hook.log');
  const logFd = openSync(logPath, 'a');

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  return 0;
}
