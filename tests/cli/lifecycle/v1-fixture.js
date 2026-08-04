import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLocalSessionSync,
  ensureV1SessionStorageSync,
} from '../../../src/mc/session-v1.js';

export function makeV1Fixture(prefix = 'mc-v1-cli-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const mcHomeDir = join(root, 'mc');
  const workspace = join(root, 'workspace');
  mkdirSync(mcHomeDir, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  const source = ensureV1SessionStorageSync({ mcHomeDir });
  return {
    root,
    mcHomeDir,
    workspace,
    source,
    directory(name) {
      const path = join(root, name);
      mkdirSync(path, { mode: 0o700 });
      return path;
    },
    create(name = 'alpha', options = {}) {
      return createLocalSessionSync({
        mcHomeDir,
        sourceId: source.source_id,
        name,
        cwd: workspace,
        ...options,
      });
    },
    cleanup() {
      makeTreeRemovable(root);
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 25,
      });
    },
  };
}

function makeTreeRemovable(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return; }
  if (!stat.isDirectory()) {
    try { chmodSync(path, 0o600); } catch {}
    return;
  }
  try { chmodSync(path, 0o700); } catch {}
  let names = [];
  try { names = readdirSync(path); } catch {}
  for (const name of names) makeTreeRemovable(join(path, name));
}

export function captureStream({ columns = 120, isTTY = false } = {}) {
  const chunks = [];
  return {
    columns,
    rows: 24,
    isTTY,
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    text() { return chunks.join(''); },
  };
}
