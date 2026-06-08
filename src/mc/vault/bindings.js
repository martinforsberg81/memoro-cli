import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SECRET_BINDINGS_RELATIVE_PATH = '.mc/secrets.json';

export function secretBindingsPath(cwd = process.cwd()) {
  return join(cwd, SECRET_BINDINGS_RELATIVE_PATH);
}

export async function readSecretBindings({ cwd = process.cwd(), deps = {} } = {}) {
  const path = secretBindingsPath(cwd);
  const exists = deps.existsSync || existsSync;
  if (!exists(path)) return null;

  const read = deps.readFile || readFile;
  let parsed;
  try {
    parsed = JSON.parse(await read(path, 'utf8'));
  } catch (err) {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} is not valid JSON: ${err.message}`);
  }
  return normaliseSecretBindings(parsed);
}

export function mergeSecretBindings(existing, incoming) {
  const base = existing ? normaliseSecretBindings(existing) : { version: 1, sources: [] };
  const next = {
    ...base,
    version: 1,
    sources: base.sources.map((s) => ({
      ...s,
      keys: { ...s.keys },
    })),
  };

  for (const source of normaliseSecretBindings(incoming).sources) {
    const idx = next.sources.findIndex((s) => sourceIdentity(s) === sourceIdentity(source));
    if (idx >= 0) {
      next.sources[idx] = {
        ...next.sources[idx],
        ...source,
        keys: {
          ...next.sources[idx].keys,
          ...source.keys,
        },
      };
    } else {
      next.sources.push({
        ...source,
        keys: { ...source.keys },
      });
    }
  }

  return next;
}

export async function planSecretBindingPersistence(binding, { cwd = process.cwd(), deps = {} } = {}) {
  const existing = await readSecretBindings({ cwd, deps });
  const merged = mergeSecretBindings(existing, binding);
  const changed = stableJson(existing || { version: 1, sources: [] }) !== stableJson(merged);
  return {
    path: secretBindingsPath(cwd),
    relativePath: SECRET_BINDINGS_RELATIVE_PATH,
    existing: !!existing,
    changed,
    bindings: merged,
  };
}

export async function persistSecretBindingPlan(plan, { deps = {} } = {}) {
  if (!plan?.changed) {
    return {
      path: plan?.relativePath || SECRET_BINDINGS_RELATIVE_PATH,
      diskPath: plan?.path || null,
      action: 'unchanged',
      changed: false,
    };
  }

  const ensureDir = deps.mkdir || mkdir;
  const write = deps.writeFile || writeFile;
  const move = deps.rename || rename;
  await ensureDir(dirname(plan.path), { recursive: true });

  const tmp = `${plan.path}.tmp-${process.pid}-${Date.now()}`;
  await write(tmp, `${stableJson(plan.bindings)}\n`, { mode: 0o644 });
  await move(tmp, plan.path);

  return {
    path: plan.relativePath,
    diskPath: plan.path,
    action: plan.existing ? 'updated' : 'created',
    changed: true,
  };
}

export function collectBoundLabels(bindings) {
  const labels = new Set();
  if (!bindings) return labels;
  for (const source of normaliseSecretBindings(bindings).sources) {
    for (const label of Object.values(source.keys || {})) {
      if (label) labels.add(label);
    }
  }
  return labels;
}

export async function filterMatchesByRepoBindings(matches, { cwd = process.cwd(), deps = {} } = {}) {
  const bindings = await readSecretBindings({ cwd, deps });
  const labels = collectBoundLabels(bindings);
  return (matches || []).filter((match) => labels.has(match?.label));
}

export function bindingForLabels(binding, labels) {
  const allowed = new Set(labels || []);
  const sources = [];
  for (const source of normaliseSecretBindings(binding).sources) {
    const keys = Object.fromEntries(
      Object.entries(source.keys || {}).filter(([, label]) => allowed.has(label)),
    );
    if (Object.keys(keys).length) {
      sources.push({ ...source, keys });
    }
  }
  return { version: 1, sources };
}

export function buildDotenvSecretBinding({ file = '.env', key, label, materialise = 'file' } = {}) {
  if (!key || typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error('--bind must be a valid env key, e.g. OPENAI_API_KEY');
  }
  if (!label || typeof label !== 'string') {
    throw new Error('binding label is required');
  }
  return {
    version: 1,
    sources: [
      {
        file,
        format: 'dotenv',
        materialise,
        keys: {
          [key]: label,
        },
      },
    ],
  };
}

function normaliseSecretBindings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} must contain an object`);
  }
  if (input.version !== 1) {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} has unsupported version ${input.version ?? 'missing'}`);
  }
  if (!Array.isArray(input.sources)) {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} must contain a sources array`);
  }

  return {
    version: 1,
    sources: input.sources.map(normaliseSource),
  };
}

function normaliseSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} sources must be objects`);
  }
  if (!source.file || typeof source.file !== 'string') {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} source.file is required`);
  }
  if (!source.format || typeof source.format !== 'string') {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} source.format is required`);
  }
  if (!source.materialise || typeof source.materialise !== 'string') {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} source.materialise is required`);
  }
  if (!source.keys || typeof source.keys !== 'object' || Array.isArray(source.keys)) {
    throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} source.keys must be an object`);
  }

  const keys = {};
  for (const [key, label] of Object.entries(source.keys)) {
    if (!key || typeof key !== 'string') {
      throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} key names must be strings`);
    }
    if (!label || typeof label !== 'string') {
      throw new Error(`${SECRET_BINDINGS_RELATIVE_PATH} labels must be strings`);
    }
    keys[key] = label;
  }

  return {
    file: source.file,
    format: source.format,
    materialise: source.materialise,
    keys,
  };
}

function sourceIdentity(source) {
  return `${source.file}\0${source.format}\0${source.materialise}`;
}

function stableJson(value) {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}
