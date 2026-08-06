/**
 * `mc coding-profile read|diff|write`
 *
 * Explicit LLM-callable surface for the server-owned Coding Profile. Nothing
 * here touches a file on this machine: it reads an approved profile, compares
 * a candidate, or writes a full replacement with revision protection.
 *
 * Delivery is not here and is not a file. `mc/portrait.js` hands the profile
 * to a tool as a launch argument when a new conversation starts.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from 'node:process';

import { getSecret as defaultGetSecret } from '../lib/keychain.js';
import { memoroFetch as defaultMemoroFetch } from '../lib/api.js';
import { ACCOUNTS } from '../commands/auth.js';
import { readConfig as defaultReadConfig, getApiUrl as defaultGetApiUrl } from '../lib/config.js';
import { ask, interactive } from '../mc/prompt.js';
import { mcHome } from '../mc/paths.js';

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
  if (sub === 'edit') return runEdit(rest, deps);

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
 * The Coding Profile in your editor.
 *
 * `read`, `diff` and `write` are a machine's three steps: fetch the markdown,
 * compare a candidate, submit with the revision you started from. Written out
 * by hand that is a chore, and a chore is why a profile stays as someone left
 * it. This is the same three steps with the file and the revision handled.
 *
 * Nothing is sent until it is shown. The editor closing is not consent — the
 * diff is displayed and answered first, because this text is put in front of
 * every new conversation and a slip of the hand should not be able to change
 * how a tool behaves everywhere.
 */
const STARTER = `Hej!

Write to your tools the way you would write to a colleague who is about to
join you. What you are working on, how you like to work, what you want them
to check with you before doing.

There is no required shape. Any language, any structure, as long as it is
plain text and under 12 kB.
`;

export async function runEdit(argv, deps = {}) {
  const stdout = deps.stdout || defaultStdout;
  const stderr = deps.stderr || defaultStderr;
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(editUsage());
    return 0;
  }
  const ctx = await resolveContext(argv, deps);
  if (!ctx.ok) return ctx.code;

  let res;
  try {
    res = await ctx.memoroFetch(ctx.apiUrl, PROFILE_PATH, { token: ctx.token });
  } catch (err) {
    return requestError('read Coding Profile', err, false, ctx);
  }
  const profile = res?.profile || null;
  const revision = Number(profile?.revision) || 0;
  const before = ensureTrailingNewline(profile?.markdown || STARTER);

  // A stable path rather than a temp name: if the editor dies, the machine
  // sleeps, or the write is refused, the words are still where they were.
  const path = join(mcHome(), 'coding-profile.edit.md');

  // Where the new text comes from. A person opens an editor; an assistant
  // hands over what it drafted. Both then take the same road — the same diff,
  // the same confirmation, the same revision handled for them — because the
  // step worth protecting is agreeing to the change, and that is the same
  // step whoever typed it.
  const supplied = await suppliedMarkdown(argv, deps);
  if (supplied?.error) {
    stderr.write(`mc: ${supplied.error}\n`);
    return 1;
  }

  let after;
  if (supplied) {
    after = ensureTrailingNewline(supplied.markdown);
    stdout.write(`${revision ? `Coding Profile revision ${revision}` : 'No Coding Profile yet — starting one'}\n`);
  } else {
    try {
      mkdirSync(mcHome(), { recursive: true, mode: 0o700 });
      writeFileSync(path, before, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      stderr.write(`mc: could not prepare ${path} (${err?.message || err})\n`);
      return 1;
    }
    const editor = deps.editor || process.env.VISUAL || process.env.EDITOR || 'nano';
    stdout.write(`${revision ? `Coding Profile revision ${revision}` : 'No Coding Profile yet — starting one'} · ${editor}\n`);
    const run = deps.spawn || spawnSync;
    const result = run(editor, [path], { stdio: 'inherit' });
    if (result?.error) {
      stderr.write(`mc: could not open ${editor} (${result.error.message})\n`);
      stderr.write(`mc: edit ${path} yourself, then run mc setup profile --file ${path}\n`);
      return 1;
    }
    try { after = ensureTrailingNewline(readFileSync(path, 'utf8')); } catch { after = null; }
    if (after === null) {
      stderr.write(`mc: ${path} could not be read back\n`);
      return 1;
    }
  }
  if (normalizeMarkdown(after) === normalizeMarkdown(before)) {
    stdout.write('Unchanged — nothing written.\n');
    return 0;
  }

  stdout.write(`\n${createUnifiedDiff(before, after, { from: `revision ${revision}`, to: 'your edit' })}\n`);
  // Shown is not the same as agreed. With no terminal there is nobody to
  // agree, so nothing is sent — an editor that exits is not consent, and this
  // text governs how every new conversation behaves.
  if (!argv.includes('--yes')) {
    if (!interactive()) {
      stdout.write('Not written. Show this to the user; run again with --yes once they agree.\n');
      if (!supplied) stdout.write(`Your edit is kept at ${path}\n`);
      return 0;
    }
    const answer = ask('Write this? [y/N]', { stdout });
    if (!/^y(es)?$/iu.test((answer || '').trim())) {
      stdout.write(supplied ? 'Not written.\n' : `Not written. Your edit is kept at ${path}\n`);
      return 0;
    }
  }

  let written;
  try {
    written = await ctx.memoroFetch(ctx.apiUrl, PROFILE_PATH, {
      token: ctx.token,
      method: 'PUT',
      body: { markdown: normalizeMarkdown(after), baseRevision: revision },
    });
  } catch (err) {
    stderr.write(`mc: ${err?.data?.error || err?.message || 'the write was refused'}\n`);
    if (!supplied) stderr.write(`mc: your edit is kept at ${path}\n`);
    return 1;
  }
  stdout.write(`Coding Profile revision ${written?.profile?.revision ?? revision + 1}. New conversations get it from now on.\n`);
  return 0;
}

/** `--file <path>`, `--stdin` or `-`. Nothing given means open an editor. */
async function suppliedMarkdown(argv, deps = {}) {
  const fileIndex = argv.indexOf('--file');
  if (fileIndex !== -1) {
    const path = argv[fileIndex + 1];
    if (!path || path.startsWith('--')) return { error: '--file needs a path' };
    try {
      return { markdown: await readFile(path, 'utf8') };
    } catch (err) {
      return { error: `could not read ${path} (${err?.message || err})` };
    }
  }
  if (argv.includes('--stdin') || argv.includes('-')) {
    const text = await readStdinText(deps.stdin || defaultStdin);
    if (!text.trim()) return { error: 'nothing arrived on stdin' };
    return { markdown: text };
  }
  return null;
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
  mc coding-profile edit [--file <path>|--stdin] [--yes]
                                              (also: mc setup profile)

CONTRACT
  read    Prints approved Markdown to stdout by default.
  diff    Compares a candidate profile against the approved server revision.
  write   Replaces the full profile and requires the base revision from read.
  edit    Opens it in $EDITOR, or takes --file/--stdin. Prints the diff and
          writes only with --yes. Resolves the base revision itself.

DELIVERY
  A new tool conversation started by mc work receives the approved profile
  as a launch argument. No file on this machine is written for it, and
  resuming an existing conversation does not repeat it.

WORKFLOW
  1. Read the current profile: mc coding-profile read
  2. Discuss the intended durable work-method changes with the user.
  3. Draft the full replacement and save it to a file.
  4. mc setup profile --file <path>        prints the diff, writes nothing.
  5. Show the user that diff. After approval, add --yes.

  The revision is resolved for you, and a change made by someone else in the
  meantime is refused rather than overwritten. Use read/diff/write directly
  only when you need to pin an exact base revision or attach a summary.

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

function editUsage() {
  return [
    'Usage: mc setup profile                       edit it in $EDITOR',
    '       mc setup profile --file <path> [--yes] hand over drafted text',
    '       mc setup profile --stdin [--yes]       the same, from stdin',
    '',
    'Without --yes the diff is printed and nothing is written, so the change',
    'can be shown to the user before it is made. The revision is handled.',
    '',
    'mc coding-profile edit is the same command.',
    '',
  ].join('\n');
}

function writeUsage() {
  return 'Usage: mc coding-profile write (--file <path>|--stdin|-) --base-revision <n> [--summary <text>] [--json] [--api <url>]\n';
}
