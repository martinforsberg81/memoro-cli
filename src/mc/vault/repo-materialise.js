import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const REPO_SECRET_TOOL = 'repo';
export const REPO_SECRET_LOCATION_TYPE = 'dotenv-file';

const BEGIN = '# mc vault materialised begin';
const END = '# mc vault materialised end';

export async function materialiseRepoBoundSecrets({
  bindings,
  matches,
  worktreePath,
  sessionId,
  deps = {},
} = {}) {
  if (!bindings || !worktreePath) return { materialised: [], skipped: [] };

  const byLabel = new Map((matches || []).map((m) => [m.label, m]));
  const grouped = groupBindingsByFile(bindings);
  const materialised = [];
  const skipped = [];

  for (const [sourceFile, keys] of grouped) {
    const target = resolveBoundPath(worktreePath, sourceFile);
    if (!target.ok) {
      skipped.push({ tool: REPO_SECRET_TOOL, source: sourceFile, reason: target.reason });
      continue;
    }

    const values = [];
    for (const [key, label] of Object.entries(keys)) {
      const match = byLabel.get(label);
      if (!match?.payload?.token) {
        skipped.push({ tool: REPO_SECRET_TOOL, source: sourceFile, key, label, reason: 'bound-secret-missing' });
        continue;
      }
      values.push({ key, label, value: match.payload.token });
    }
    if (values.length !== Object.keys(keys).length) continue;

    const plan = await planDotenvWrite(target.path, values, { deps });
    if (!plan.ok) {
      skipped.push(...plan.skipped.map((s) => ({ tool: REPO_SECRET_TOOL, source: sourceFile, ...s })));
      continue;
    }
    await writeDotenvPlan(plan, { deps });
    materialised.push({
      tool: REPO_SECRET_TOOL,
      label: `repo:${sourceFile}`,
      location: {
        type: REPO_SECRET_LOCATION_TYPE,
        path: target.path,
        source: sourceFile,
        keys: values.map((v) => v.key),
        labels: values.map((v) => v.label),
      },
      materializedPath: target.path,
    });
  }

  return { materialised, skipped };
}

export async function shredRepoMaterialisation({ location, deps = {} } = {}) {
  if (location?.type !== REPO_SECRET_LOCATION_TYPE || !location.path) {
    return { ok: false, reason: 'not-repo-materialisation' };
  }
  const exists = deps.existsSync || existsSync;
  if (!exists(location.path)) return { ok: true, removed: false };

  const read = deps.readFile || readFile;
  const write = deps.writeFile || writeFile;
  const remove = deps.unlink || unlink;
  const before = await read(location.path, 'utf8');
  const after = removeManagedBlock(before);
  if (after === before) return { ok: true, removed: false };

  if (!after.trim()) {
    await remove(location.path).catch(() => {});
    return { ok: true, removed: true };
  }
  await write(location.path, after.endsWith('\n') ? after : `${after}\n`, { mode: 0o600 });
  return { ok: true, removed: true };
}

function groupBindingsByFile(bindings) {
  const grouped = new Map();
  for (const source of bindings.sources || []) {
    if (source.format !== 'dotenv' || source.materialise !== 'file') continue;
    const current = grouped.get(source.file) || {};
    for (const [key, label] of Object.entries(source.keys || {})) {
      if (current[key] && current[key] !== label) {
        throw new Error(`conflicting binding for ${source.file}:${key}`);
      }
      current[key] = label;
    }
    grouped.set(source.file, current);
  }
  return grouped;
}

function resolveBoundPath(worktreePath, sourceFile) {
  if (!sourceFile || typeof sourceFile !== 'string') return { ok: false, reason: 'invalid-source-file' };
  if (isAbsolute(sourceFile)) return { ok: false, reason: 'absolute-source-file' };
  const root = resolve(worktreePath);
  const target = resolve(join(root, sourceFile));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: 'source-outside-worktree' };
  return { ok: true, path: target };
}

async function planDotenvWrite(path, values, { deps = {} } = {}) {
  const exists = deps.existsSync || existsSync;
  const read = deps.readFile || readFile;
  const before = exists(path) ? await read(path, 'utf8') : '';
  const clean = removeManagedBlock(before);
  const conflicts = [];
  for (const { key } of values) {
    if (dotenvHasKey(clean, key)) conflicts.push({ key, reason: 'key-already-present' });
  }
  if (conflicts.length) return { ok: false, skipped: conflicts };

  const block = renderManagedBlock(values);
  const prefix = clean.trimEnd();
  const next = prefix ? `${prefix}\n\n${block}` : block;
  return { ok: true, path, body: `${next}\n`, skipped: [] };
}

async function writeDotenvPlan(plan, { deps = {} } = {}) {
  const ensureDir = deps.mkdir || mkdir;
  const write = deps.writeFile || writeFile;
  await ensureDir(dirname(plan.path), { recursive: true });
  await write(plan.path, plan.body, { mode: 0o600 });
}

function renderManagedBlock(values) {
  return [
    BEGIN,
    ...values.map(({ key, value }) => `${key}=${formatDotenvValue(value)}`),
    END,
  ].join('\n');
}

function removeManagedBlock(content) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BEGIN) {
      inside = true;
      continue;
    }
    if (inside && line.trim() === END) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function dotenvHasKey(content, key) {
  for (const line of String(content || '').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    if (withoutExport.slice(0, eq).trim() === key) return true;
  }
  return false;
}

function formatDotenvValue(value) {
  const s = String(value ?? '');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}
