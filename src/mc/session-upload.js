import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_DIR } from '../lib/config.js';
import { findLatestClaudeSession } from '../lib/claude.js';
import { findLatestCodexSession } from '../lib/codex.js';
import { scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';

export async function findLatestTranscriptForTool({
  source,
  cwd,
  newerThanMs = 0,
  deps = {},
} = {}) {
  if (source === 'codex') {
    return (deps.findLatestCodexSession || findLatestCodexSession)({ cwd, newerThanMs });
  }
  if (source === 'claude-code') {
    return (deps.findLatestClaudeSession || findLatestClaudeSession)({ cwd, newerThanMs });
  }
  return null;
}

export async function scheduleSessionUpload({
  source,
  cwd,
  repoHint = null,
  newerThanMs = 0,
  transcriptPath = null,
  toolVersion = null,
  deps = {},
} = {}) {
  const transcript = transcriptPath
    ? { path: transcriptPath, cwd, toolVersion }
    : await findLatestTranscriptForTool({ source, cwd, newerThanMs, deps });

  if (!transcript?.path) {
    return { ok: false, reason: 'no-transcript' };
  }

  const binJs = deps.binJs || defaultMemoroCliBinJs();
  const args = buildSessionUploadArgs({
    binJs,
    transcriptPath: transcript.path,
    source,
    repoHint,
    toolVersion: transcript.toolVersion || toolVersion,
  });
  const logPath = deps.logPath || join(CONFIG_DIR, 'hook.log');
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const out = (deps.openSync || openSync)(logPath, 'a');
  const err = (deps.openSync || openSync)(logPath, 'a');
  const child = (deps.spawn || spawn)(process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: transcript.cwd || cwd || process.cwd(),
    env: {
      ...scrubRuntimeSecretsFromEnv(process.env),
      MEMORO_NO_UPDATE_CHECK: '1',
    },
  });
  if (typeof child?.unref === 'function') child.unref();

  return {
    ok: true,
    transcriptPath: transcript.path,
    pid: child?.pid ?? null,
  };
}

export function buildSessionUploadArgs({
  binJs,
  transcriptPath,
  source,
  repoHint = null,
  toolVersion = null,
} = {}) {
  const args = [binJs, 'session', 'upload', transcriptPath, '--tool', source, '--yes'];
  if (repoHint) args.push('--repo', repoHint);
  if (toolVersion) args.push('--tool-version', toolVersion);
  return args;
}

function defaultMemoroCliBinJs() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'bin.js');
}
