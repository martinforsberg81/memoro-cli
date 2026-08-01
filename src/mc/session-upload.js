import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_DIR } from '../lib/config.js';
import { findClaudeSessionById, findLatestClaudeSession } from '../lib/claude.js';
import { findCodexSessionById, findLatestCodexSession } from '../lib/codex.js';
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

export async function findTranscriptForToolSession({
  source,
  sessionId,
  cwd,
  deps = {},
} = {}) {
  if (source === 'codex') {
    return (deps.findCodexSessionById || findCodexSessionById)({ sessionId, cwd });
  }
  if (source === 'claude-code') {
    return (deps.findClaudeSessionById || findClaudeSessionById)({ sessionId, cwd });
  }
  return null;
}

export async function scheduleSessionUpload({
  source,
  cwd,
  repoHint = null,
  codingSessionId = null,
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
    codingSessionId,
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

/**
 * Run the transcript upload in the foreground and report whether it
 * actually succeeded. `mc end` uses this as its distill gate: the
 * transcript may only be deleted after the knowledge in it has been
 * distilled, and a detached fire-and-forget child cannot carry that
 * guarantee.
 */
export async function runSessionUploadSync({
  source,
  transcriptPath,
  cwd = null,
  repoHint = null,
  codingSessionId = null,
  toolVersion = null,
  timeoutMs = 600_000,
  deps = {},
} = {}) {
  if (!transcriptPath) return { ok: false, reason: 'no-transcript' };
  const binJs = deps.binJs || defaultMemoroCliBinJs();
  const args = buildSessionUploadArgs({
    binJs,
    transcriptPath,
    source,
    repoHint,
    codingSessionId,
    toolVersion,
  });
  const child = (deps.spawn || spawn)(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: cwd || process.cwd(),
    env: {
      ...scrubRuntimeSecretsFromEnv(process.env),
      MEMORO_NO_UPDATE_CHECK: '1',
    },
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, reason: 'upload-timeout', output: output.slice(-2000) });
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message || 'spawn-failed', output: output.slice(-2000) });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0
        ? { ok: true, transcriptPath }
        : { ok: false, reason: `upload-exit-${code}`, output: output.slice(-2000) });
    });
  });
}

export function buildSessionUploadArgs({
  binJs,
  transcriptPath,
  source,
  repoHint = null,
  codingSessionId = null,
  toolVersion = null,
} = {}) {
  const args = [binJs, 'session', 'upload', transcriptPath, '--tool', source, '--yes'];
  if (repoHint) args.push('--repo', repoHint);
  if (codingSessionId) args.push('--coding-session-id', codingSessionId);
  if (toolVersion) args.push('--tool-version', toolVersion);
  return args;
}

function defaultMemoroCliBinJs() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'bin.js');
}
