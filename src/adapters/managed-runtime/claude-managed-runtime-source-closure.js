/**
 * Fixed transitive source closure for the credential-bearing managed Claude
 * runtime host. The host pins this bootstrap file before calling it.
 */
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const MANAGED_CLAUDE_RUNTIME_SOURCE_SHA256 = Object.freeze({
  'package.json': '364f4d63becdbd984a17fc66b7887a99c8f70f3336423c91f7472ad1324c4a83',
  'src/lib/api.js': '3d0ac5d550aea6ff5a8e337f1521c4066e528bc45474bad8b7ab3983e9e0cb0a',
  'src/lib/auth-accounts.js': '43cbc941038365733759222bc461bc843f0816535c882c5381a18879bfef4cb7',
  'src/lib/config.js': '3afa21f33613baf1838314a35b67e642ed286d55c7acbd5ee45cba4f5347c0cb',
  'src/lib/keychain.js': 'b6445625a9142c60d8915e34255155e277422050f02f3a26eebba7ee69f506e6',
  'src/runtime/broker/c1-artifacts.js': '27433c19fd05573ab99636f802d4f96b652ebc0c0b22d78f74077c90e2b5200a',
  'src/runtime/broker/c1-source-closure.js': 'f34c76470e805acf679d53aa5205539689a7fbbe2a046504b031dad679137422',
  'src/mc/paths.js': 'f736475313471606f5d5bce11a3453295f27540ea1c7ca10db97e463ad72772f',
  'src/adapters/managed-runtime/claude-managed-certification.js': '5c0267435f63e558b94210946d6423d7b801f78b40d115d14c6b1f233a144ab1',
  'src/adapters/managed-runtime/claude-managed-custody.js': 'c4994e6b8e47fbdc594e68b6c41fee9345c06b26a339674f74a8ac281ac2efa0',
  'src/adapters/managed-runtime/claude-managed-policy.js': '432352bff556ea7d26820d880e95e9be8fffabd73e02113537e1f7349a82daa7',
  'src/adapters/managed-runtime/claude-managed-refresh-owner.js': '0e664560c27ea5ce4f36d70f2ab13236ae0d5663a914a64b493d57d44c928964',
  'src/adapters/managed-runtime/claude-managed-refresh.js': '403b9f23d33a1e0657f82d38466194c59d728d2ee58ee6b4778854525d7496da',
  'src/adapters/managed-runtime/claude-managed-runtime.js': '91f4e264479930e3630e9b3cf588dd977f98ba6e97fb42ee550d26ccddf581a1',
  'src/adapters/managed-runtime/claude-managed.js': 'bb6172441ab925adf0418ba1d99cb1df58be5bac3adafccd464182a3439a0bc9',
  'src/vault/engine/api.js': 'c1d88a10e2c2bdcc742f0e98a204d5e23e1e5a8266c4e84c9387aa647addb896',
  'src/vault/engine/client-crypto.js': 'e0b67cd8915232d95aee815f967cb5e104399d4ffdcbf1276bdebe92cde71831',
  'src/vault/engine/custody-crypto.js': '020b2b2287e9d748f897d451f2472b111b4012a56243111decfc517004376f3f',
  'src/vault/engine/custody-session.js': '0855d4032c586930fe122426f8f602c9dcd49be823b21987cbc421dab0e4b5ec',
  'src/vault/engine/key-cache.js': 'b773ff1013acd7458b4f57ab235ba379cc3233f3690fceacd6b4706a1e1be2ec',
  'src/vault/engine/trusted-portal.js': '2ad71ce782ab7d6a2feb421ccf0bc4f72548e27908b480763dda8b0773d17308',
  'src/vault/engine/types.js': 'a7d97fa065943d8b41246c05163c41d8baf25ddaaa926a70a6b8953376d368db',
});

export function verifyInstalledManagedClaudeRuntimeSourceClosure() {
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  try {
    const root = realpathSync(PACKAGE_ROOT);
    if (root !== resolve(PACKAGE_ROOT)
      || !trustedDirectoryChain(root, expectedUid)) {
      return failure('managed-claude-runtime-source-root-untrusted');
    }
    for (const [relativePath, expectedDigest] of Object.entries(
      MANAGED_CLAUDE_RUNTIME_SOURCE_SHA256,
    )) {
      if (!safeRelativePath(relativePath)
        || !/^[a-f0-9]{64}$/u.test(expectedDigest)) {
        return failure('managed-claude-runtime-source-manifest-invalid');
      }
      const path = join(root, relativePath);
      const info = lstatSync(path);
      if (!info.isFile()
        || info.isSymbolicLink()
        || (info.mode & 0o022) !== 0
        || (Number.isInteger(expectedUid) && info.uid !== expectedUid)
        || realpathSync(path) !== path
        || !trustedProjectDirectory(dirname(path), root, expectedUid)
        || sha256(readFileSync(path)) !== expectedDigest) {
        return failure('managed-claude-runtime-source-mismatch');
      }
    }
    return {
      ok: true,
      code: 'managed-claude-runtime-source-verified',
    };
  } catch {
    return failure('managed-claude-runtime-source-mismatch');
  }
}

function trustedProjectDirectory(path, root, expectedUid) {
  let current = path;
  for (;;) {
    if (!trustedDirectory(current, expectedUid, false)) return false;
    if (current === root) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function trustedDirectoryChain(path, expectedUid) {
  let current = path;
  for (;;) {
    if (!trustedDirectory(current, expectedUid, current !== path)) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function trustedDirectory(path, expectedUid, allowRootOwnedSticky) {
  const info = lstatSync(path);
  if (!info.isDirectory()
    || info.isSymbolicLink()
    || realpathSync(path) !== path
    || (Number.isInteger(expectedUid)
      && info.uid !== expectedUid
      && info.uid !== 0)) return false;
  if ((info.mode & 0o022) === 0) return true;
  return allowRootOwnedSticky
    && info.uid === 0
    && (info.mode & 0o1000) !== 0;
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value
    && !value.startsWith('/')
    && !value.split('/').includes('..');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function failure(code) {
  return { ok: false, code };
}
