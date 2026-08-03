/**
 * Fixed source closure for the Claude C1 custody chain.
 *
 * The globally installed mc package is the trusted bootstrap. Before any
 * custody operation starts, the broker hashes every transitive project module
 * that the lease host, child, harness, or runtime can evaluate. The short-lived
 * hosts repeat the same check before importing custody code or reading FD 3.
 *
 * A concurrent hostile process that can rewrite the installed package as the
 * same OS user remains outside C1's threat model. This check closes the prior
 * model-directed-write and incomplete-dependency-closure gap; it is not a
 * substitute for signed package installation.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const C1_SOURCE_CLOSURE_SHA256 = Object.freeze({
  'package.json': '4801cbbec43087879b8230699a0e73a2f209efd2e85ff20c477532babc76178d',
  'scripts/security/managed-claude-c1-harness.mjs': '5f0368332cc3ae9ae9cf88c3fee3d6661dcb2782ac218c713ecbebe8706ebe3b',
  'scripts/security/managed-claude-c1-probe.c': '7ffc83d795a442b2c867687fe75fe2573e5123e0978ea12bb13b4e44d1fd205d',
  'scripts/security/managed-claude-c1-runtime.mjs': '69a32c075f500b4c5a5eeb901a585d3772da210081a0eafff7aa78b74beae3e3',
  'src/lib/api.js': '3d0ac5d550aea6ff5a8e337f1521c4066e528bc45474bad8b7ab3983e9e0cb0a',
  'src/lib/config.js': '3afa21f33613baf1838314a35b67e642ed286d55c7acbd5ee45cba4f5347c0cb',
  'src/lib/keychain.js': 'b6445625a9142c60d8915e34255155e277422050f02f3a26eebba7ee69f506e6',
  'src/runtime/broker/c1-artifacts.js': '27433c19fd05573ab99636f802d4f96b652ebc0c0b22d78f74077c90e2b5200a',
  'src/runtime/broker/c1-child.js': '3a869dc7c3de2e6ec4e084b763d8bf4ac6486691b02269b6da6d567cd8e2c8bb',
  'src/runtime/broker/c1-lease-host.js': '128126a1a9353ed46c0289d94578cb28cda99ebc22bb222d83abc24380ae6992',
  'src/runtime/broker/c1-process-group.js': 'fdce5abf4749441c3278f192339a226a7bcebe66cdfa7ea15ae2a56a92470357',
  'src/mc/paths.js': 'da90c4df7c8fcc24b61610002bfb65add5043e37790d3e0a900df959f7c57af2',
  'src/adapters/managed-runtime/claude-managed-policy.js': '432352bff556ea7d26820d880e95e9be8fffabd73e02113537e1f7349a82daa7',
  'src/vault/engine/api.js': 'c1d88a10e2c2bdcc742f0e98a204d5e23e1e5a8266c4e84c9387aa647addb896',
  'src/vault/engine/c1-claude-lease.js': 'f0762a6bd0ce22b578ecb5f11b2964cc61054de67d20763621336c54d54f3fcf',
  'src/vault/engine/client-crypto.js': 'e0b67cd8915232d95aee815f967cb5e104399d4ffdcbf1276bdebe92cde71831',
  'src/vault/engine/custody-crypto.js': '020b2b2287e9d748f897d451f2472b111b4012a56243111decfc517004376f3f',
  'src/vault/engine/key-cache.js': 'b773ff1013acd7458b4f57ab235ba379cc3233f3690fceacd6b4706a1e1be2ec',
});

/** Production entrypoint: no caller-selected root or manifest. */
export function verifyInstalledC1SourceClosure() {
  return verifyC1SourceClosureFixture({
    packageRoot: PACKAGE_ROOT,
    expected: C1_SOURCE_CLOSURE_SHA256,
  });
}

/** Token-free fixture used only for deterministic tamper tests. */
export function verifyC1SourceClosureFixture({
  packageRoot,
  expected,
  deps = {},
} = {}) {
  if (typeof packageRoot !== 'string' || !packageRoot
    || !isExactManifest(expected)) return failure('c1-source-closure-input-invalid');
  const readFile = deps.readFileSync || readFileSync;
  const realpath = deps.realpathSync || realpathSync;
  const lstat = deps.lstatSync || lstatSync;
  const getuid = deps.getuid || (() => (
    typeof process.getuid === 'function' ? process.getuid() : null
  ));
  let root;
  try {
    root = realpath(packageRoot);
    if (root !== resolve(packageRoot)
      || !directoryChainTrusted(root, {
        expectedUid: getuid(),
        lstat,
        realpath,
      })) return failure('c1-source-package-root-untrusted');
  } catch {
    return failure('c1-source-package-root-unavailable');
  }

  const expectedUid = getuid();
  for (const [relativePath, digest] of Object.entries(expected)) {
    const path = join(root, relativePath);
    try {
      const info = lstat(path);
      if (!info.isFile() || info.isSymbolicLink()
        || (Number.isInteger(expectedUid) && info.uid !== expectedUid)
        || (info.mode & 0o022) !== 0
        || !projectDirectoryChainTrusted(dirname(path), root, {
          expectedUid,
          lstat,
          realpath,
        })
        || realpath(path) !== path
        || sha256(readFile(path)) !== digest) {
        return failure('c1-source-closure-mismatch');
      }
    } catch {
      return failure('c1-source-closure-mismatch');
    }
  }
  return Object.freeze({ ok: true, code: 'c1-source-closure-verified' });
}

function directoryChainTrusted(packageRoot, deps) {
  let current = packageRoot;
  for (;;) {
    if (!directoryTrusted(current, {
      ...deps,
      allowRootOwnedSticky: current !== packageRoot,
    })) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function projectDirectoryChainTrusted(directory, packageRoot, deps) {
  let current = directory;
  for (;;) {
    if (!directoryTrusted(current, deps)) return false;
    if (current === packageRoot) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function directoryTrusted(path, {
  expectedUid,
  lstat,
  realpath,
  allowRootOwnedSticky = false,
}) {
  const info = lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpath(path) !== path) return false;
  if (Number.isInteger(expectedUid) && info.uid !== expectedUid && info.uid !== 0) return false;
  if ((info.mode & 0o022) === 0) return true;
  return allowRootOwnedSticky
    && info.uid === 0
    && (info.mode & 0o1000) !== 0;
}

function isExactManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([path, digest]) => (
    /^[a-zA-Z0-9_./-]+$/u.test(path)
    && !path.startsWith('/')
    && !path.split('/').includes('..')
    && /^[a-f0-9]{64}$/u.test(digest)
  ));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}
