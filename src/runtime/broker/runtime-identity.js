/**
 * Process-bound identity for the broker runtime closure.
 *
 * Session hosts can outlive the CLI process that started them. Protocol
 * compatibility alone is therefore insufficient while running directly from
 * a mutable worktree: a daemon may keep executing previously loaded provider
 * and custody code after those files change on disk. Compute this identity
 * once at module load in each process and require an exact match before reuse.
 */
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROOT_ENTRIES = Object.freeze([
  'mc-cli.js',
  'package.json',
  'package-lock.json',
  'src',
]);
const MAX_FILES = 4_096;
const MAX_BYTES = 64 * 1024 * 1024;
const IDENTITY_SCHEMA = 'mc-broker-runtime-identity-v1';

export const BROKER_RUNTIME_IDENTITY = computeBrokerRuntimeIdentity();

export function computeBrokerRuntimeIdentity({
  packageRoot = PACKAGE_ROOT,
  runtime = {
    node: process.version,
    modules: process.versions.modules,
    platform: platform(),
    arch: arch(),
  },
  deps = {},
} = {}) {
  const root = resolve(packageRoot);
  const fs = {
    lstatSync: deps.lstatSync || lstatSync,
    readFileSync: deps.readFileSync || readFileSync,
    readdirSync: deps.readdirSync || readdirSync,
  };
  const files = [];
  for (const entry of ROOT_ENTRIES) {
    collectFiles(join(root, entry), { root, files, fs });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new Error('broker runtime source closure is unavailable');
  }

  const hash = createHash('sha256');
  hash.update(`${IDENTITY_SCHEMA}\0`);
  hash.update(`${JSON.stringify(runtime)}\0`);
  let totalBytes = 0;
  for (const file of files) {
    const body = fs.readFileSync(file.path);
    totalBytes += body.length;
    if (totalBytes > MAX_BYTES) {
      throw new Error('broker runtime source closure exceeds the bounded size');
    }
    hash.update(`${file.relativePath}\0${body.length}\0`);
    hash.update(body);
    hash.update('\0');
  }
  return `${IDENTITY_SCHEMA}:${hash.digest('hex')}`;
}

function collectFiles(path, { root, files, fs }) {
  let info;
  try {
    info = fs.lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error('broker runtime source closure contains a symbolic link');
  }
  if (info.isDirectory()) {
    const entries = fs.readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      collectFiles(join(path, entry.name), { root, files, fs });
    }
    return;
  }
  if (!info.isFile()) return;
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith('..')) {
    throw new Error('broker runtime source closure escaped its package root');
  }
  files.push({ path, relativePath });
  if (files.length > MAX_FILES) {
    throw new Error('broker runtime source closure contains too many files');
  }
}
