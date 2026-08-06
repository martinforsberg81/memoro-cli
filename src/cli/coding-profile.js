/**
 * `mc coding-profile read|diff|write|sync`
 *
 * Explicit LLM-callable surface for the server-owned Coding Profile.
 * `read`, `diff` and `write` never touch a file on this machine: they read an
 * approved profile, compare a candidate, or write a full replacement with
 * revision protection.
 *
 * `sync` is the one that does, and only ever the two instruction files the
 * tools keep in their own homes — never a repository's. It is explicit
 * because the alternative, fetching at launch, puts a server between the user
 * and their session. See `../mc/portrait.js` for why that is the whole point.
 */

import { readFile } from 'node:fs/promises';
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from 'node:process';

import { getSecret as defaultGetSecret } from '../lib/keychain.js';
import { memoroFetch as defaultMemoroFetch } from '../lib/api.js';
import { ACCOUNTS } from '../commands/auth.js';
import { readConfig as defaultReadConfig, getApiUrl as defaultGetApiUrl } from '../lib/config.js';
import { syncPortrait } from '../mc/portrait.js';

const PROFILE_PATH = '/api/mc/coding-profile';
const DEFAULT_API_URL = 'https://meetmemoro.app';

export const DEFAULT_CODING_PROFILE_TEMPLATE = `# Coding Profile

## Language

- Preferred collaboration language:

## Planning

- When agents should propose a plan first:
- How agents should handle uncertainty or multiple options:

## Autonomy

- Changes agents may make without asking:
- Changes agents must ask before:

## Git And GitHub

- Branch, commit, PR, and merge preferences:
- Force-push or history rewrite rules:

## Rules

- Checks expected before handoff:
- Rules that should survive across coding sessions:
`;

export async function run(argv, deps = {}) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    (deps.stdout || defaultStdout).write(renderHelp());
    return sub ? 0 : 2;
  }
  if (sub === 'read') return runRead(rest, deps);
  if (sub === 'diff') return runDiff(rest, deps);
  if (sub === 'write') return runWrite(rest, deps);
  if (sub === 'sync') return runSync(rest, deps);

  (deps.stderr || defaultStderr).write(`mc: unknown coding-profile subcommand "${sub}". Try \`mc coding-profile --help\`.\n`);
  return 2;
}

export async function runRead(argv, deps = {}) {
  const opts = parseReadArgs(argv);
  if (opts.error) return usageError(opts.error, deps, readUsage());
  if (opts.help) {
    (deps.stdout || defaultStdout).write(readUsage());
    return 0;
  }
  const ctx = await resolveContext(argv, deps);
  if (!ctx.ok) return ctx.code;

  let res;
  try {
    res = await ctx.memoroFetch(ctx.apiUrl, PROFILE_PATH, { token: ctx.token });
  } catch (err) {
    return requestError('read Coding Profile', err, opts.json, ctx);
  }

  const profile = res?.profile || null;
  if (opts.json) {
    ctx.stdout.write(JSON.stringify(formatReadJson(profile), null, 2) + '\n');
    return 0;
  }
  if (profile?.markdown) ctx.stdout.write(ensureTrailingNewline(profile.markdown));
  return 0;
}

/**
 * Put the approved profile in front of both tools.
 *
 * The dry run is the default of nothing here — `sync` is not destructive: it
 * replaces a block mc wrote and leaves every other line in the file alone. But
 * it does write to files outside mc's own home, so it says which and what it
 * did to each.
 */
export async function runSync(argv, deps = {}) {
  const stdout = deps.stdout || defaultStdout;
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(syncUsage());
    return 0;
  }
  const ctx = await resolveContext(argv, deps);
  if (!ctx.ok) return ctx.code;

  let res;
  try {
    res = await ctx.memoroFetch(ctx.apiUrl, PROFILE_PATH, { token: ctx.token });
  } catch (err) {
    return requestError('read Coding Profile', err, json, ctx);
  }
  const profile = res?.profile || null;
  if (!profile?.markdown) {
    ctx.stderr.write('mc: no approved Coding Profile yet — nothing to deliver\n');
    return 1;
  }

  const results = syncPortrait({ markdown: profile.markdown, dryRun });
  if (json) {
    stdout.write(`${JSON.stringify({ ok: true, revision: profile.revision ?? null, dry_run: dryRun, targets: results }, null, 2)}\n`);
    return results.some((item) => item.status === 'failed') ? 1 : 0;
  }
  stdout.write(`Coding Profile revision ${profile.revision ?? '?'}${dryRun ? ' — dry run' : ''}\n`);
  for (const item of results) {
    const verb = { created: 'created', updated: 'updated', unchanged: 'already current', failed: 'FAILED' }[item.status];
    stdout.write(`  ${item.tool.padEnd(12)} ${verb.padEnd(15)} ${item.path}${item.reason ? ` (${item.reason})` : ''}\n`);
  }
  stdout.write('\nRead by both tools in every directory. Only the managed block is mc\'s;\n');
  stdout.write('anything else in those files is left exactly as you wrote it.\n');
  return results.some((item) => item.status === 'failed') ? 1 : 0;
}

export async function runDiff(argv, deps = {}) {
  const opts = parseCandidateArgs(argv, { requireBaseRevision: false });
  if (opts.error) return usageError(opts.error, deps, diffUsage());
  if (opts.help) {
    (deps.stdout || defaultStdout).write(diffUsage());
    return 0;
  }
  const ctx = await resolveContext(argv, deps);
  if (!ctx.ok) return ctx.code;

  let candidate;
  try {
    candidate = await readCandidateMarkdown(opts, deps);
  } catch (err) {
    ctx.stderr.write(`mc: failed to read candidate profile: ${err.message}\n`);
    return 1;
  }

  let res;
  try {
    res = await ctx.memoroFetch(ctx.apiUrl, PROFILE_PATH, { token: ctx.token });
  } catch (err) {
    return requestError('read Coding Profile', err, opts.json, ctx);
  }

  const profile = res?.profile || null;
  const baseRevision = profile?.revision || 0;
  const current = profile?.markdown || '';
  const diff = createUnifiedDiff(current, normalizeMarkdown(candidate), {
    from: `server revision ${baseRevision}`,
    to: 'candidate',
  });
  const changed = diff.length > 0;

  if (opts.json) {
    ctx.stdout.write(JSON.stringify({
      ok: true,
      base_revision: baseRevision,
      changed,
      diff,
    }, null, 2) + '\n');
    return 0;
  }
  if (changed) ctx.stdout.write(diff);
  return changed ? 1 : 0;
}

export async function runWrite(argv, deps = {}) {
  const opts = parseCandidateArgs(argv, { requireBaseRevision: true });
  if (opts.error) return usageError(opts.error, deps, writeUsage());
  if (opts.help) {
    (deps.stdout || defaultStdout).write(writeUsage());
    return 0;
  }
  const ctx = await resolveContext(argv, deps);
  if (!ctx.ok) return ctx.code;

  let markdown;
  try {
    markdown = await readCandidateMarkdown(opts, deps);
  } catch (err) {
    ctx.stderr.write(`mc: failed to read candidate profile: ${err.message}\n`);
    return 1;
  }

  let res;
  try {
    res = await ctx.memoroFetch(ctx.apiUrl, PROFILE_PATH, {
      token: ctx.token,
      method: 'PUT',
      body: {
        markdown: normalizeMarkdown(markdown),
        baseRevision: opts.baseRevision,
        changeSummary: opts.summary,
        sourceSessionId: opts.sourceSessionId || process.env.MC_CODING_SESSION_ID || null,
      },
    });
  } catch (err) {
    return requestError('write Coding Profile', err, opts.json, ctx);
  }

  const profile = res?.profile || null;
  if (opts.json) {
    ctx.stdout.write(JSON.stringify({ ok: true, profile }, null, 2) + '\n');
    return 0;
  }
  ctx.stdout.write(`Coding Profile written: revision ${profile?.revision ?? '?'}\n`);
  return 0;
}

export function parseReadArgs(argv = []) {
  const opts = { json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--api') {
      if (!argv[i + 1]) return { ...opts, error: '--api requires a URL' };
      i += 1;
      continue;
    }
    return { ...opts, error: `unknown flag: ${a}` };
  }
  return opts;
}

export function parseCandidateArgs(argv = [], { requireBaseRevision = false } = {}) {
  const opts = {
    file: null,
    stdin: false,
    baseRevision: null,
    summary: null,
    sourceSessionId: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--stdin') {
      if (opts.file || opts.stdin) return { ...opts, error: 'choose exactly one input source' };
      opts.stdin = true;
      continue;
    }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--api') {
      if (!argv[i + 1]) return { ...opts, error: '--api requires a URL' };
      i += 1;
      continue;
    }
    if (a === '--file') {
      const value = argv[++i];
      if (!value) return { ...opts, error: '--file requires a path' };
      if (opts.file || opts.stdin) return { ...opts, error: 'choose exactly one input source' };
      opts.file = value;
      continue;
    }
    if (a === '--base-revision' || a === '--base') {
      const value = argv[++i];
      if (!value) return { ...opts, error: `${a} requires a revision number` };
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ...opts, error: `${a} must be a non-negative integer` };
      }
      opts.baseRevision = parsed;
      continue;
    }
    if (a === '--summary' || a === '--message') {
      const value = argv[++i];
      if (!value) return { ...opts, error: `${a} requires text` };
      opts.summary = value;
      continue;
    }
    if (a === '--source-session') {
      const value = argv[++i];
      if (!value) return { ...opts, error: '--source-session requires an id' };
      opts.sourceSessionId = value;
      continue;
    }
    if (a === '-') {
      if (opts.file || opts.stdin) return { ...opts, error: 'choose exactly one input source' };
      opts.stdin = true;
      continue;
    }
    if (a.startsWith('--')) return { ...opts, error: `unknown flag: ${a}` };
    if (opts.file || opts.stdin) return { ...opts, error: `unexpected positional arg: ${a}` };
    opts.file = a;
  }

  if (opts.help) return opts;
  if (!opts.file && !opts.stdin) {
    return { ...opts, error: 'candidate profile input is required: pass --file <path>, --stdin, or -' };
  }
  if (requireBaseRevision && opts.baseRevision == null) {
    return { ...opts, error: 'write requires --base-revision <n> from `mc coding-profile read --json`' };
  }
  return opts;
}

export function createUnifiedDiff(oldText, newText, { from = 'server', to = 'candidate' } = {}) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length === newLines.length && oldLines.every((line, idx) => line === newLines[idx])) {
    return '';
  }
  const ops = diffOps(oldLines, newLines);
  const out = [
    `--- ${from}`,
    `+++ ${to}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  for (const op of ops) {
    const prefix = op.type === 'equal' ? ' ' : (op.type === 'delete' ? '-' : '+');
    out.push(`${prefix}${op.line}`);
  }
  return `${out.join('\n')}\n`;
}

export function formatReadJson(profile) {
  const normalized = normalizeProfile(profile);
  if (!normalized.exists) {
    return {
      ok: true,
      exists: false,
      profile: null,
      revision: 0,
      base_revision: 0,
      markdown: '',
      updated_at: null,
      last_update: null,
      template_markdown: DEFAULT_CODING_PROFILE_TEMPLATE,
      workflow: profileWorkflow(0),
    };
  }
  return {
    ok: true,
    exists: true,
    profile,
    revision: normalized.revision,
    base_revision: normalized.revision,
    markdown: normalized.markdown,
    updated_at: normalized.updated_at,
    last_update: normalized.last_update,
    workflow: profileWorkflow(normalized.revision),
  };
}

function profileWorkflow(baseRevision) {
  return [
    'Discuss the desired work-method changes with the user.',
    'Draft a full replacement Coding Profile from the template or current markdown.',
    'Run mc coding-profile diff --stdin to review the candidate.',
    `After user approval, run mc coding-profile write --stdin --base-revision ${baseRevision} --summary "<summary>".`,
  ];
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return { exists: false };
  }
  const revision = Number.isInteger(profile.revision) ? profile.revision : 0;
  const markdown = normalizeMarkdown(profile.markdown || '');
  const updated_at =
    profile.updated_at ||
    profile.updatedAt ||
    profile.modified_at ||
    profile.modifiedAt ||
    null;
  const created_at = profile.created_at || profile.createdAt || null;
  const version_id = profile.version_id || profile.versionId || null;
  const version_created_at = profile.version_created_at || profile.versionCreatedAt || null;
  const updated_by = profile.updated_by || profile.updatedBy || null;
  const change_summary =
    profile.change_summary ||
    profile.changeSummary ||
    profile.summary ||
    null;
  const source_session_id =
    profile.source_session_id ||
    profile.sourceSessionId ||
    null;
  return {
    exists: true,
    revision,
    markdown,
    updated_at,
    last_update: {
      updated_at,
      created_at,
      version_id,
      version_created_at,
      updated_by,
      change_summary,
      source_session_id,
    },
  };
}

function diffOps(oldLines, newLines) {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal', line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', line: newLines[j] });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    ops.push({ type: 'delete', line: oldLines[i] });
    i += 1;
  }
  while (j < newLines.length) {
    ops.push({ type: 'add', line: newLines[j] });
    j += 1;
  }
  return ops;
}

async function readCandidateMarkdown(opts, deps = {}) {
  if (opts.file) {
    const readFileImpl = deps.readFile || readFile;
    return readFileImpl(opts.file, 'utf8');
  }
  const stdin = deps.stdin || defaultStdin;
  return readStdinText(stdin);
}

async function readStdinText(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveContext(argv, deps = {}) {
  const stdout = deps.stdout || defaultStdout;
  const stderr = deps.stderr || defaultStderr;
  const memoroFetch = deps.memoroFetch || defaultMemoroFetch;
  const getSecret = deps.getSecret || defaultGetSecret;
  const getApiUrl = deps.getApiUrl || defaultGetApiUrl;
  const readConfig = deps.readConfig || defaultReadConfig;

  let apiUrl = deps.apiUrl || getApiUrl(argv);
  if (!apiUrl) {
    try {
      const config = await readConfig();
      apiUrl = config.apiUrl;
    } catch {
      apiUrl = null;
    }
  }
  if (!apiUrl) apiUrl = DEFAULT_API_URL;

  let token = deps.token;
  if (!token) {
    try {
      token = await getSecret(ACCOUNTS.TOKEN);
    } catch {
      token = null;
    }
  }
  if (!token) {
    stderr.write('mc: no Memoro token. Run `mc` to start the device-flow, or `memoro-cli login` for CI.\n');
    return { ok: false, code: 1 };
  }
  return { ok: true, apiUrl, token, memoroFetch, stdout, stderr };
}

function requestError(action, err, json, ctx) {
  if (json) {
    ctx.stdout.write(JSON.stringify({
      ok: false,
      error: err?.data?.error || err?.message || `failed to ${action}`,
      code: err?.data?.code || null,
      status: err?.status || null,
      ...(err?.data?.details ? { details: err.data.details } : {}),
      ...(Number.isInteger(err?.data?.currentRevision) ? { currentRevision: err.data.currentRevision } : {}),
      ...(Number.isInteger(err?.data?.baseRevision) ? { baseRevision: err.data.baseRevision } : {}),
    }, null, 2) + '\n');
  } else {
    const revision = Number.isInteger(err?.data?.currentRevision)
      ? ` Current revision: ${err.data.currentRevision}.`
      : '';
    ctx.stderr.write(`mc: failed to ${action}: ${err?.data?.error || err?.message || 'unknown error'}.${revision}\n`);
  }
  return err?.status === 409 ? 3 : 1;
}

function usageError(message, deps, usage) {
  const stderr = deps.stderr || defaultStderr;
  stderr.write(`mc: ${message}\n`);
  stderr.write(usage);
  return 2;
}

function normalizeMarkdown(markdown) {
  return String(markdown || '').replace(/\r\n?/g, '\n');
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function splitLines(text) {
  const normalized = normalizeMarkdown(text);
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function renderHelp() {
  return `mc coding-profile — read, diff, and write your Coding Profile

USAGE
  mc coding-profile read [--json]
  mc coding-profile diff --file <path> [--json]
  mc coding-profile diff --stdin [--json]
  mc coding-profile write --file <path> --base-revision <n> [--summary <text>] [--json]
  mc coding-profile write --stdin --base-revision <n> [--summary <text>] [--json]
  mc coding-profile sync [--dry-run] [--json]

CONTRACT
  read    Prints approved Markdown to stdout by default.
  diff    Compares a candidate profile against the approved server revision.
  write   Replaces the full profile and requires the base revision from read.
  sync    Delivers the approved profile to ~/.claude/CLAUDE.md and
          ~/.codex/AGENTS.md, inside a managed block. Never touches a
          repository's own CLAUDE.md or AGENTS.md — those belong to the
          project and are handled by mc adapter sync.

WORKFLOW
  1. Run read --json to get revision, markdown, update metadata, and a first-profile template when empty.
  2. Discuss the intended durable work-method changes with the user.
  3. Draft the full replacement profile.
  4. Run diff on the candidate and show the user the result.
  5. After approval, run write with the base revision and a short summary.

OPTIONS
  --file <path>          Candidate Markdown file.
  --stdin, -             Read candidate Markdown from stdin.
  --base-revision <n>    Required for write; use 0 for initial creation.
  --summary <text>       Optional revision summary.
  --source-session <id>  Optional source coding session id.
  --json                 Machine-readable output.
  --api <url>            Override Memoro API base URL.
`;
}

function readUsage() {
  return 'Usage: mc coding-profile read [--json] [--api <url>]\n';
}

function diffUsage() {
  return 'Usage: mc coding-profile diff (--file <path>|--stdin|-) [--json] [--api <url>]\n';
}

function syncUsage() {
  return 'Usage: mc coding-profile sync [--dry-run] [--json] [--api <url>]\n';
}

function writeUsage() {
  return 'Usage: mc coding-profile write (--file <path>|--stdin|-) --base-revision <n> [--summary <text>] [--json] [--api <url>]\n';
}
