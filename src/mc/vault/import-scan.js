import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export const DEFAULT_DOTENV_CANDIDATES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production.local',
  '.dev.vars',
];

const SECRET_KEY_RE = /(TOKEN|SECRET|PASSWORD|PRIVATE|API_?KEY|ACCESS_?KEY|CLIENT_?SECRET|AUTH)/i;
const PUBLIC_KEY_RE = /^(PUBLIC_|NEXT_PUBLIC_|VITE_)/i;
const CONFIG_KEY_RE = /(URL|HOST|PORT|MODE|ENV|DEBUG|PUBLIC|REGION|ZONE|NAME)$/i;
const TOKEN_PREFIX_RE = /^(sk-|sk_live_|sk_test_|sk-ant-|ghp_|github_pat_|npm_|xox[baprs]-|ya29\.|eyJ[A-Za-z0-9_-]*\.)/;

export function parseDotenv(content) {
  const entries = [];
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const parsed = parseDotenvLine(raw);
    if (!parsed) continue;
    entries.push({ ...parsed, line: i + 1 });
  }

  return entries;
}

export function scanDotenvContent(content, { file = null } = {}) {
  return parseDotenv(content).map((entry) => {
    const classified = classifyEnvEntry(entry);
    return {
      file,
      line: entry.line,
      name: entry.key,
      exported: entry.exported,
      classification: classified.classification,
      confidence: classified.confidence,
      reason: classified.reason,
    };
  });
}

export function scanVaultImportFiles(paths = [], { cwd = process.cwd() } = {}) {
  const requested = paths.length
    ? paths
    : DEFAULT_DOTENV_CANDIDATES.filter((p) => existsSync(resolveInputPath(p, cwd)));
  const files = [];

  for (const inputPath of requested) {
    const diskPath = resolveInputPath(inputPath, cwd);
    if (!existsSync(diskPath)) {
      files.push({
        file: inputPath,
        format: formatForPath(inputPath),
        ok: false,
        error: 'file not found',
        keys: [],
      });
      continue;
    }

    const content = readFileSync(diskPath, 'utf8');
    files.push({
      file: inputPath,
      format: formatForPath(inputPath),
      ok: true,
      keys: scanDotenvContent(content, { file: inputPath }).map(({ file: _file, ...k }) => k),
    });
  }

  return {
    ok: true,
    cwd,
    files,
  };
}

export function buildVaultImportDryRun(file, { cwd = process.cwd(), repoName = null } = {}) {
  const scan = scanVaultImportFiles([file], { cwd });
  const scanned = scan.files[0];
  if (!scanned?.ok) {
    return {
      ok: false,
      dry_run: true,
      error: scanned?.error || 'scan failed',
      file,
      writes: [],
    };
  }

  const repo = normaliseRepoName(repoName || basename(cwd) || 'repo');
  const provider = providerForFormat(scanned.format);
  const candidates = scanned.keys.map((k) => {
    const selected = k.classification === 'secret' && k.confidence === 'high';
    return {
      ...k,
      selected,
      label: selected ? `${provider}:${repo}:${k.name}` : null,
    };
  });
  const selected = candidates.filter((k) => k.selected);

  return {
    ok: true,
    dry_run: true,
    file: scanned.file,
    format: scanned.format,
    repo,
    candidates,
    binding: buildBindingPreview(scanned, selected),
    writes: [],
  };
}

export function classifyEnvEntry({ key, value }) {
  const k = String(key || '');
  const v = String(value || '').trim();

  if (PUBLIC_KEY_RE.test(k)) {
    return { classification: 'config', confidence: 'high', reason: 'public key prefix' };
  }

  if (SECRET_KEY_RE.test(k)) {
    return { classification: 'secret', confidence: 'high', reason: 'secret-like key name' };
  }

  if (hasUrlCredentials(v)) {
    return { classification: 'secret', confidence: 'high', reason: 'url contains credentials' };
  }

  if (TOKEN_PREFIX_RE.test(v)) {
    return { classification: 'secret', confidence: 'medium', reason: 'token-like value shape' };
  }

  if (looksLikePlainConfig(k, v)) {
    return { classification: 'config', confidence: 'medium', reason: 'config-like key/value' };
  }

  return { classification: 'unknown', confidence: 'low', reason: 'no strong signal' };
}

function parseDotenvLine(rawLine) {
  let s = String(rawLine || '').trim();
  if (!s || s.startsWith('#')) return null;

  let exported = false;
  if (s.startsWith('export ')) {
    exported = true;
    s = s.slice('export '.length).trimStart();
  }

  const eq = s.indexOf('=');
  if (eq <= 0) return null;

  const key = s.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  const rhs = s.slice(eq + 1).trimStart();
  return {
    key,
    value: parseDotenvValue(rhs),
    exported,
  };
}

function parseDotenvValue(rhs) {
  if (!rhs) return '';
  const quote = rhs[0];
  if (quote === '"' || quote === "'") {
    return parseQuotedValue(rhs, quote);
  }
  return stripInlineComment(rhs).trimEnd();
}

function parseQuotedValue(rhs, quote) {
  let out = '';
  let escaped = false;
  for (let i = 1; i < rhs.length; i++) {
    const ch = rhs[i];
    if (escaped) {
      out += quote === '"' ? unescapeDoubleQuoted(ch) : ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
  }
  return out;
}

function unescapeDoubleQuoted(ch) {
  if (ch === 'n') return '\n';
  if (ch === 'r') return '\r';
  if (ch === 't') return '\t';
  return ch;
}

function stripInlineComment(value) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function hasUrlCredentials(value) {
  try {
    const u = new URL(value);
    return Boolean(u.username || u.password);
  } catch {
    return false;
  }
}

function looksLikePlainConfig(key, value) {
  if (/^(true|false|yes|no|on|off)$/i.test(value)) return true;
  if (/^\d+$/.test(value) && (CONFIG_KEY_RE.test(key) || /PORT$/i.test(key))) return true;
  if (CONFIG_KEY_RE.test(key) && isUrlWithoutCredentials(value)) return true;
  if (/(HOST|DOMAIN)$/i.test(key) && /^[A-Za-z0-9.-]+$/.test(value)) return true;
  if (/(MODE|ENV|DEBUG)$/i.test(key)) return true;
  return false;
}

function isUrlWithoutCredentials(value) {
  try {
    const u = new URL(value);
    return Boolean(u.protocol && !u.username && !u.password);
  } catch {
    return false;
  }
}

function formatForPath(file) {
  return basename(file) === '.dev.vars' ? 'wrangler-dotenv' : 'dotenv';
}

function resolveInputPath(file, cwd) {
  return isAbsolute(file) ? file : join(cwd, file);
}

function providerForFormat(format) {
  return format === 'wrangler-dotenv' ? 'wrangler' : 'env';
}

function buildBindingPreview(scanned, selected) {
  return {
    version: 1,
    sources: [
      {
        file: scanned.file,
        format: 'dotenv',
        materialise: 'file',
        keys: Object.fromEntries(selected.map((k) => [k.name, k.label])),
      },
    ],
  };
}

function normaliseRepoName(name) {
  const s = String(name || 'repo').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'repo';
}
