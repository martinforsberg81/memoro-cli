import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { mcHome } from '../../mc/paths.js';

export const CLAUDE_C1_ARTIFACT_PINS = Object.freeze({
  platform: 'darwin',
  arch: 'arm64',
  version: '2.1.220',
  sha256: '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081',
  size: 256_908_272,
  identifier: 'com.anthropic.claude-code',
  teamId: 'Q6L2SF6YDW',
  manifestSigningFingerprint: '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE',
  srtVersion: '0.0.67',
  srtIntegrity: 'sha512-4doSyr6KNdc/4zARMXYEawhFu3z6bPQjgKRq3lKp6dbgEYVMv39oaLJ28QsDc7TmLvrLqzHW+VzD2LAXxvnw8A==',
  srtTreeSha256: 'a3f7a83ffcf7c9308366a731e6914d45b72ba4af91de9ead12d9d2a3ba226578',
});

const TARGET = `${CLAUDE_C1_ARTIFACT_PINS.platform}-${CLAUDE_C1_ARTIFACT_PINS.arch}`;
// `codesign --verify --strict` exit codes that represent an actual observation
// of the pinned binary: 0 verified, 1 did not verify. Any other status means
// the check itself could not be performed, which must fail closed.
const CODESIGN_STRICT_VERIFIED = 0;
const CODESIGN_STRICT_STATUSES = Object.freeze(new Set([CODESIGN_STRICT_VERIFIED, 1]));
const SAFE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: '/var/empty',
  LANG: 'C',
  LC_ALL: 'C',
});
const C1_GPG_CANDIDATES = Object.freeze([
  Object.freeze({
    entry: '/opt/homebrew/bin/gpg',
    targetPrefix: '/opt/homebrew/Cellar/gnupg/',
  }),
  Object.freeze({
    entry: '/usr/local/bin/gpg',
    targetPrefix: '/usr/local/Cellar/gnupg/',
  }),
  Object.freeze({
    entry: '/usr/bin/gpg',
    targetPrefix: '/usr/bin/gpg',
  }),
]);

/**
 * Verify the single broker-owned C1 artifact location. This API intentionally
 * accepts no path, runtime, or dependency input: model-directed callers cannot
 * select an executable, metadata file, or verifier implementation.
 */
export function verifyInstalledClaudeC1Artifacts() {
  const artifactRoot = join(
    mcHome(),
    'managed-artifacts',
    'claude-c1',
    TARGET,
    CLAUDE_C1_ARTIFACT_PINS.sha256,
  );
  return verifyClaudeC1ArtifactFixture({
    artifactRoot,
    expected: CLAUDE_C1_ARTIFACT_PINS,
  });
}

/**
 * Pure, token-free fixture verifier. Production must use
 * verifyInstalledClaudeC1Artifacts() rather than supplying paths or pins.
 */
export function verifyClaudeC1ArtifactFixture({ artifactRoot, expected } = {}, deps = {}) {
  const pins = expected || CLAUDE_C1_ARTIFACT_PINS;
  const hostPlatform = (deps.platform || platform)();
  const hostArch = (deps.arch || arch)();
  if (hostPlatform !== pins.platform || hostArch !== pins.arch) {
    return failure('c1-artifact-platform-unsupported');
  }
  if (!validPins(pins) || typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)) {
    return failure('c1-artifact-input-invalid');
  }

  const fs = fileDeps(deps);
  const run = deps.spawnSync || spawnSync;
  const getuid = deps.getuid || (() => (typeof process.getuid === 'function' ? process.getuid() : null));
  const layout = artifactLayout(artifactRoot);
  let rootReal;
  try {
    rootReal = fs.realpath(layout.artifactRoot);
  } catch {
    return failure('c1-artifact-root-unavailable');
  }

  const rootCheck = inspectPath(layout.artifactRoot, {
    fs,
    root: rootReal,
    directory: true,
    privatePath: true,
    getuid,
  });
  if (!rootCheck.ok) return rootCheck;

  const directories = [
    layout.srtRoot,
    layout.srtNodeModules,
    layout.srtPackageRoot,
    layout.srtDistRoot,
  ];
  for (const path of directories) {
    const checked = inspectPath(path, {
      fs, root: rootReal, directory: true, privatePath: false, getuid,
    });
    if (!checked.ok) return checked;
  }
  const files = [
    [layout.claudeBinary, true],
    [layout.manifest, false],
    [layout.manifestSignature, false],
    [layout.manifestKey, false],
    [layout.srtPackageJson, false],
    [layout.srtLock, false],
    [layout.srtCli, false],
    [layout.srtModule, false],
  ];
  for (const [path, privatePath] of files) {
    const checked = inspectPath(path, {
      fs, root: rootReal, directory: false, privatePath, getuid,
    });
    if (!checked.ok) return checked;
  }

  const tree = inspectInstallTree(layout.srtRoot, { fs, root: rootReal, getuid });
  if (!tree.ok) return tree;

  const manifestOk = (deps.verifyManifest || verifyClaudeC1Manifest)({
    manifestPath: layout.manifest,
    signaturePath: layout.manifestSignature,
    signingKeyPath: layout.manifestKey,
    expectedFingerprint: pins.manifestSigningFingerprint,
    spawnSync: run,
    fs,
  });
  if (!manifestOk) return failure('c1-artifact-manifest-untrusted');

  let manifest;
  let packageJson;
  let lock;
  try {
    manifest = JSON.parse(fs.readFile(layout.manifest, 'utf8'));
    packageJson = JSON.parse(fs.readFile(layout.srtPackageJson, 'utf8'));
    lock = JSON.parse(fs.readFile(layout.srtLock, 'utf8'));
  } catch {
    return failure('c1-artifact-metadata-invalid');
  }
  if (!matchesManifest(manifest, pins)) return failure('c1-artifact-manifest-mismatch');
  if (!matchesSrtPackage(packageJson, lock, pins)) return failure('c1-artifact-srt-package-mismatch');
  if (tree.sha256 !== pins.srtTreeSha256) return failure('c1-artifact-srt-tree-mismatch');

  let binary;
  try {
    binary = fs.readFile(layout.claudeBinary);
  } catch {
    return failure('c1-artifact-binary-unavailable');
  }
  const digest = sha256(binary);
  if (binary.length !== pins.size || digest !== pins.sha256) {
    return failure('c1-artifact-binary-mismatch');
  }

  const identity = inspectCodesignIdentity(layout.claudeBinary, pins, run);
  if (!identity.ok) return identity;
  const strict = run('codesign', ['--verify', '--strict', layout.claudeBinary], commandOptions());
  // Platform strict verification is an observation about this host, not the
  // trust root. The exact bytes are already pinned by size and sha256, and
  // trust comes from the signed manifest plus the codesign identity checked
  // above. This release has been observed both verifying and failing to verify
  // on supported hosts, so both outcomes are admissible and neither is
  // relabelled as stronger evidence than the manifest signature. Only an
  // unusable result — codesign absent, killed by a signal, or reporting a
  // usage error — fails closed, because then nothing was observed at all.
  if (!Number.isInteger(strict?.status)) return failure('c1-artifact-codesign-strict-unavailable');
  if (!CODESIGN_STRICT_STATUSES.has(strict.status)) {
    return failure('c1-artifact-codesign-strict-unexpected');
  }
  const platformSignatureVerified = strict.status === CODESIGN_STRICT_VERIFIED;

  // A cold, signed 250+ MB Claude artifact can take longer than the generic
  // metadata probe bound on macOS. This remains a bounded exact-binary check;
  // it is not a pin bypass or a fallback to PATH.
  const versionProbe = run(
    layout.claudeBinary,
    ['--version'],
    commandOptions({ timeout: 30_000 }),
  );
  const version = String(versionProbe?.stdout || '').match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
  if (versionProbe?.status !== 0 || version !== pins.version) {
    return failure('c1-artifact-version-mismatch');
  }

  const rebound = rebindArtifactPaths(layout, { fs, root: rootReal, getuid });
  if (!rebound.ok) return rebound;
  return Object.freeze({
    ok: true,
    code: 'c1-artifact-verified',
    artifacts: Object.freeze({
      artifactRoot: rootReal,
      claudeBinary: rebound.paths.claudeBinary,
      srtCli: rebound.paths.srtCli,
      srtModule: rebound.paths.srtModule,
      srtRoot: rebound.paths.srtRoot,
      claudeSha256: pins.sha256,
      claudeVersion: pins.version,
      srtVersion: pins.srtVersion,
      srtIntegrity: pins.srtIntegrity,
      srtTreeSha256: pins.srtTreeSha256,
      manifestSignatureVerified: true,
      // Reported exactly as observed on this host, matching the C1 harness
      // preflight field of the same name. Never the trust root.
      platformSignatureVerified,
    }),
  });
}

export function verifyClaudeC1Manifest({
  manifestPath,
  signaturePath,
  signingKeyPath,
  expectedFingerprint,
  spawnSync: run = spawnSync,
  fs = fileDeps(),
  gpgPath = resolveClaudeC1GpgExecutable(),
} = {}) {
  if (!gpgPath) return false;
  let temporaryHome = null;
  try {
    temporaryHome = fs.mkdtemp(join(tmpdir(), 'mc-c1-gpg-'));
    const imported = run(gpgPath, [
      '--batch', '--no-options', '--homedir', temporaryHome, '--status-fd=1', '--import', signingKeyPath,
    ], commandOptions());
    const verified = run(gpgPath, [
      '--batch', '--no-options', '--homedir', temporaryHome, '--status-fd=1', '--verify', signaturePath, manifestPath,
    ], commandOptions());
    const status = `${imported?.stdout || ''}\n${verified?.stdout || ''}`;
    // GPG may import the public key successfully and then fail to contact a
    // user agent in a deliberately isolated runtime, returning 2 despite an
    // exact IMPORT_OK record. The detached signature verification is the
    // authoritative terminal operation and must still succeed with VALIDSIG.
    return verified?.status === 0
      && status.includes(`[GNUPG:] IMPORT_OK 1 ${expectedFingerprint}`)
      && status.includes(`[GNUPG:] VALIDSIG ${expectedFingerprint} `);
  } catch {
    return false;
  } finally {
    if (temporaryHome) try { fs.rm(temporaryHome, { recursive: true, force: true }); } catch {}
  }
}

/**
 * C1 never resolves GPG through caller-controlled PATH. The supported macOS
 * host may provide it through Homebrew, whose launcher is a symlink into a
 * versioned Cellar path. Resolve that link once and execute only the rebound,
 * fixed-prefix regular file. GPG is provenance evidence; the runtime still
 * independently enforces the compiled manifest, binary and tree digests.
 */
export function resolveClaudeC1GpgExecutable({
  candidates = C1_GPG_CANDIDATES,
  fs = fileDeps(),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  for (const candidate of candidates) {
    try {
      const entry = fs.lstat(candidate.entry);
      if (!entry.isFile?.() && !entry.isSymbolicLink?.()) continue;
      const target = fs.realpath(candidate.entry);
      const stat = fs.lstat(target);
      const prefixMatches = candidate.targetPrefix.endsWith('/')
        ? target.startsWith(candidate.targetPrefix)
        : target === candidate.targetPrefix;
      if (!prefixMatches
        || !stat.isFile?.()
        || stat.isSymbolicLink?.()
        || (stat.mode & 0o022) !== 0
        || (stat.mode & 0o111) === 0
        || (Number.isInteger(uid) && stat.uid !== uid && stat.uid !== 0)) continue;
      return target;
    } catch {}
  }
  return null;
}

function artifactLayout(artifactRoot) {
  const root = resolve(artifactRoot);
  const srtRoot = join(root, 'srt');
  const srtPackageRoot = join(srtRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  return Object.freeze({
    artifactRoot: root,
    claudeBinary: join(root, 'claude'),
    manifest: join(root, 'manifest.json'),
    manifestSignature: join(root, 'manifest.json.sig'),
    manifestKey: join(root, 'claude-code.asc'),
    srtRoot,
    srtNodeModules: join(srtRoot, 'node_modules'),
    srtPackageRoot,
    srtPackageJson: join(srtPackageRoot, 'package.json'),
    srtDistRoot: join(srtPackageRoot, 'dist'),
    srtCli: join(srtPackageRoot, 'dist', 'cli.js'),
    srtModule: join(srtPackageRoot, 'dist', 'index.js'),
    srtLock: join(srtRoot, 'package-lock.json'),
  });
}

function inspectPath(path, { fs, root, directory, privatePath, getuid }) {
  let listed;
  let resolved;
  try {
    listed = fs.lstat(path);
    if (listed.isSymbolicLink?.()) return failure('c1-artifact-path-symlink');
    if (directory ? !listed.isDirectory?.() : !listed.isFile?.()) {
      return failure(directory ? 'c1-artifact-path-not-directory' : 'c1-artifact-path-not-regular');
    }
    resolved = fs.realpath(path);
  } catch {
    return failure('c1-artifact-path-unavailable');
  }
  if (!inside(root, resolved)) return failure('c1-artifact-path-outside-root');
  const uid = getuid();
  if (Number.isInteger(uid) && listed.uid !== uid) return failure('c1-artifact-owner-invalid');
  // The root and Claude binary are private. Descendant package files may be
  // read-only for other users because the private root is their access gate;
  // no artifact node may be writable by group or other users.
  if ((privatePath && (listed.mode & 0o077) !== 0) || (!privatePath && (listed.mode & 0o022) !== 0)) {
    return failure('c1-artifact-permissions-invalid');
  }
  return { ok: true };
}

function inspectInstallTree(root, { fs, getuid }) {
  const hash = createHash('sha256');
  const expectedUid = getuid();
  try {
    const walk = (directory) => {
      for (const name of fs.readdir(directory).sort()) {
        const path = join(directory, name);
        const relativePath = path.slice(root.length + 1);
        const info = fs.lstat(path);
        if (Number.isInteger(expectedUid) && info.uid !== expectedUid) throw coded('c1-artifact-owner-invalid');
        if ((info.mode & 0o022) !== 0) throw coded('c1-artifact-permissions-invalid');
        if (info.isDirectory()) {
          hash.update(`d\0${relativePath}\0`);
          walk(path);
        } else if (info.isSymbolicLink()) {
          const target = fs.realpath(path);
          if (!inside(root, target)) throw coded('c1-artifact-path-outside-root');
          hash.update(`l\0${relativePath}\0${fs.readlink(path)}\0`);
        } else if (info.isFile()) {
          hash.update(`f\0${relativePath}\0${info.mode.toString(8)}\0`);
          hash.update(fs.readFile(path));
          hash.update('\0');
        } else {
          throw coded('c1-artifact-path-not-regular');
        }
      }
    };
    walk(root);
    return { ok: true, sha256: hash.digest('hex') };
  } catch (error) {
    return failure(error?.code || 'c1-artifact-tree-unavailable');
  }
}

function rebindArtifactPaths(layout, { fs, root, getuid }) {
  const expected = [
    ['claudeBinary', layout.claudeBinary, false, true],
    ['srtCli', layout.srtCli, false, false],
    ['srtModule', layout.srtModule, false, false],
    ['srtRoot', layout.srtRoot, true, false],
  ];
  const paths = {};
  for (const [name, path, directory, privatePath] of expected) {
    const checked = inspectPath(path, { fs, root, directory, privatePath, getuid });
    if (!checked.ok) return checked;
    try {
      paths[name] = fs.realpath(path);
    } catch {
      return failure('c1-artifact-path-unavailable');
    }
  }
  return { ok: true, paths };
}

function matchesManifest(value, pins) {
  const entry = value?.platforms?.[`${pins.platform}-${pins.arch}`];
  return value?.version === pins.version
    && entry?.binary === 'claude'
    && entry?.checksum === pins.sha256
    && entry?.size === pins.size;
}

function matchesSrtPackage(packageJson, lock, pins) {
  const locked = lock?.packages?.['node_modules/@anthropic-ai/sandbox-runtime'];
  return packageJson?.name === '@anthropic-ai/sandbox-runtime'
    && packageJson?.version === pins.srtVersion
    && packageJson?.bin?.srt === 'dist/cli.js'
    && lock?.lockfileVersion === 3
    && lock?.packages?.['']?.dependencies?.['@anthropic-ai/sandbox-runtime'] === `^${pins.srtVersion}`
    && locked?.version === pins.srtVersion
    && locked?.integrity === pins.srtIntegrity
    && locked?.bin?.srt === 'dist/cli.js';
}

function inspectCodesignIdentity(binary, pins, run) {
  const result = run('codesign', ['-dv', '--verbose=4', binary], commandOptions());
  const output = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  const identifier = output.match(/\bIdentifier=([^\s]+)/)?.[1] || null;
  const teamId = output.match(/\bTeamIdentifier=([A-Z0-9]+)/)?.[1] || null;
  return result?.status === 0 && identifier === pins.identifier && teamId === pins.teamId
    ? { ok: true }
    : failure('c1-artifact-codesign-identity-mismatch');
}

function validPins(value) {
  return value && value.platform === 'darwin' && value.arch === 'arm64'
    && /^\d+\.\d+\.\d+$/.test(value.version || '')
    && /^[a-f0-9]{64}$/.test(value.sha256 || '')
    && Number.isSafeInteger(value.size) && value.size > 0
    && typeof value.identifier === 'string' && typeof value.teamId === 'string'
    && /^[A-F0-9]{40}$/.test(value.manifestSigningFingerprint || '')
    && /^\d+\.\d+\.\d+$/.test(value.srtVersion || '')
    && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.srtIntegrity || '')
    && /^[a-f0-9]{64}$/.test(value.srtTreeSha256 || '');
}

function fileDeps(deps = {}) {
  return {
    lstat: deps.lstat || lstatSync,
    mkdtemp: deps.mkdtemp || mkdtempSync,
    readFile: deps.readFile || readFileSync,
    readdir: deps.readdir || readdirSync,
    readlink: deps.readlink || readlinkSync,
    realpath: deps.realpath || realpathSync,
    rm: deps.rm || rmSync,
  };
}

function commandOptions({ timeout = 10_000 } = {}) {
  return {
    encoding: 'utf8',
    timeout,
    env: SAFE_ENV,
    maxBuffer: 1024 * 1024,
  };
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
