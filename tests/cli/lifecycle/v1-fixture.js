import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLocalSessionSync,
  ensureV1SessionStorageSync,
} from '../../../src/mc/session-v1.js';

export function makeV1Fixture(prefix = 'mc-v1-cli-') {
  // Resolved, and that is the whole of a bug that read as five broken verbs.
  //
  // On macOS `tmpdir()` is `/var/folders/…`, a symlink to `/private/var/…`.
  // mc resolves the paths it is given — `mc cd` prints a real directory, not
  // the string it was handed — so a fixture that kept the unresolved form
  // compared `/var/…` against `/private/var/…` and failed. `mc cd`, `mc new`,
  // `mc rename` and `mc open/resume` were all working perfectly; the tests
  // were measuring the symlink.
  //
  // Worth naming because of what it nearly cost: those tests sat in the
  // standing red set, and #410 proposed deleting them as dead weight from an
  // old surface. Every verb they cover is live and correct. The path was
  // wrong, not the code, and the fix is here rather than in ten call sites so
  // it cannot come back one file at a time.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
