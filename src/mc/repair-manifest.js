/** The programme-local inputs that a repair reader sees and a release binds. */
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

export const repairDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 64 * 1024 * 1024;
const localPath = path => typeof path === 'string' && !isAbsolute(path) && !/[\p{Cc}\\]/u.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));

function artifactNames(page) {
  const names = new Set();
  for (const match of page.matchAll(/`([^`\r\n]+)`|!?\[[^\]\r\n]*\]\(<?([^)>\r\n]+)>?\)/gu)) {
    const raw = match[1] ?? match[2].split('#', 1)[0];
    const path = raw.replace(/^\.\//u, '');
    if (/^(?:evidence|designs?)\//u.test(path)) names.add(path);
  }
  for (const match of page.matchAll(/^Binding (?:design|evidence): `([^`\r\n]+)`\s*$/gmu)) {
    names.add(match[1].replace(/^\.\//u, ''));
  }
  return [...names].sort();
}

function readInput(dir, path, left) {
  if (!localPath(path)) throw new Error(`not a programme-local binding path: ${path}`);
  const segments = path.split('/');
  let absolute = dir;
  for (const segment of segments.slice(0, -1)) {
    absolute = join(absolute, segment);
    if (!lstatSync(absolute).isDirectory()) throw new Error(`${path}: binding directory is not a real directory`);
  }
  absolute = join(absolute, segments.at(-1));
  const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const before = lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.size > left) throw new Error(`${path}: binding input is not a regular file within the snapshot size limit`);
  const bytes = readFileSync(absolute);
  if (stamp(lstatSync(absolute, { bigint: true })) !== stamp(before)) throw new Error(`${path}: binding input changed while reading`);
  return { path, bytes, stamp: stamp(before) };
}

const manifestOf = files => {
  const inputs = files.map(({ path, bytes }) => [path, repairDigest(bytes)]);
  return { revision: repairDigest(JSON.stringify(inputs)), inputs };
};

export function validRepairManifest(manifest) {
  return Boolean(manifest && Array.isArray(manifest.inputs) && manifest.inputs[0]?.[0] === 'README.md'
    && manifest.inputs.every(row => Array.isArray(row) && row.length === 2 && localPath(row[0])
      && typeof row[1] === 'string' && DIGEST.test(row[1]))
    && new Set(manifest.inputs.map(([path]) => path)).size === manifest.inputs.length
    && manifest.revision === repairDigest(JSON.stringify(manifest.inputs)));
}

export function repairSnapshot(dir) {
  const page = readInput(dir, 'README.md', MAX_BYTES);
  const text = page.bytes.toString('utf8');
  const paths = artifactNames(text).filter(path => path !== page.path);
  let left = MAX_BYTES - page.bytes.length;
  const files = [page, ...paths.map(path => {
    const file = readInput(dir, path, left);
    left -= file.bytes.length;
    return file;
  })];
  return { text, files, manifest: manifestOf(files) };
}

export function sameRepairSnapshot(before, after) {
  return before.manifest.revision === after.manifest.revision
    && before.files.every((file, i) => file.stamp === after.files[i].stamp);
}
