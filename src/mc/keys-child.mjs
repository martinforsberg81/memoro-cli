/** Trusted preload. FD 3 carries only the already verified, value-free closure. */
import { registerHooks, isBuiltin } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (typeof registerHooks !== 'function') throw new Error('mc keys requires Node 22.15 or later');
const { root, expected } = JSON.parse(readFileSync(3, 'utf8'));
const allowed = new Map(Object.entries(expected).map(([path, digest]) => [join(root, path), digest]));
function verify(url) {
  if (isBuiltin(url)) return;
  if (!url.startsWith('file:')) throw new Error('mc keys: import outside committed source closure');
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) throw new Error('mc keys: module URL variants are not declared');
  const file = fileURLToPath(parsed);
  const digest = allowed.get(file);
  if (!digest || realpathSync(file) !== file
    || createHash('sha256').update(readFileSync(file)).digest('hex') !== digest) {
    throw new Error('mc keys: import outside committed source closure');
  }
}
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    verify(result.url);
    return result;
  },
  load(url, context, next) { verify(url); return next(url, context); },
});
