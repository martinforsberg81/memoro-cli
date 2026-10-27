/** Atomic process-owned reservations. A prepared, nonempty directory is
 * renamed into place: rename cannot replace another nonempty reservation.
 * Reaping removes only the dead generation's uniquely named marker, then
 * rmdir (never recursive removal). A concurrent new owner is never removed.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function readClaim(path) {
  try {
    const marker = readdirSync(path).find((name) => /^owner-.*\.json$/u.test(name));
    if (!marker) return null;
    return { ...JSON.parse(readFileSync(join(path, marker), 'utf8')), marker };
  } catch { return null; }
}

export function releaseClaim(path, marker) {
  if (!marker || !/^owner-[\w-]+\.json$/u.test(marker)) return false;
  try { unlinkSync(join(path, marker)); } catch { return false; }
  try { rmdirSync(path); } catch { /* another nonempty generation already took its place */ }
  return true;
}

export function takeClaim(path, owner, { alive = processAlive } = {}) {
  const marker = `owner-${randomUUID()}.json`;
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(pending, { mode: 0o700 });
    writeFileSync(join(pending, marker), JSON.stringify(owner), { mode: 0o600 });
    for (let tries = 0; tries < 8; tries++) {
      try {
        renameSync(pending, path);
        return { ok: true, marker, owner };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
      const held = readClaim(path);
      if (held && alive(held.pid)) return { ok: false, running: held };
      if (!held) return { ok: false, error: `cannot read resource reservation ${path}` };
      releaseClaim(path, held.marker);
    }
    return { ok: false, error: `resource reservation changed repeatedly: ${path}` };
  } catch (error) {
    return { ok: false, error: `cannot reserve ${path}: ${error.message}` };
  } finally {
    try { unlinkSync(join(pending, marker)); } catch { /* published or absent */ }
    try { rmdirSync(pending); } catch { /* published or absent */ }
  }
}
