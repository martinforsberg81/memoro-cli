import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  compileManagedBoundaryProbe,
  renderManagedCodexConfig,
  validateBoundaryReport,
} from '../../src/vault/credential-domain/local-codex.js';
import { MANAGED_CODEX_PROFILE } from '../../src/adapters/managed-runtime/codex-managed.js';
import {
  verifyInstalledManagedCodexArtifact,
} from '../../src/adapters/managed-runtime/codex-managed-artifacts.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const hostMcTarget = resolveHostMcTarget();
const hostMcRoot = hostMcTarget?.entryPath
  ? resolve(dirname(hostMcTarget.entryPath), '..')
  : null;
const probeTempBase = process.platform === 'win32' ? tmpdir() : homedir();
const GENERATION_COUNT = 2;

export async function runCredentialBoundaryProbe({
  generationCount = GENERATION_COUNT,
  deps = {},
} = {}) {
  const runGenerationFn = deps.runGeneration || runGeneration;
  const generations = [];
  let previous = null;
  for (let index = 0; index < generationCount; index += 1) {
    const replacement = verifyPreviousGeneration(previous);
    const generation = await runGenerationFn({
      generation: index + 1,
      replacement,
      deps,
    });
    generations.push(generation);
    previous = generation.teardown;
  }
  const codexVersion = deps.codexVersion === undefined
    ? readCodexVersion()
    : deps.codexVersion;
  return buildProbeReport({
    host: process.platform,
    codexVersion,
    generations,
  });
}

export function buildProbeReport({
  host = process.platform,
  codexVersion = null,
  generations = [],
} = {}) {
  const normalized = Array.isArray(generations) ? generations : [];
  return {
    schema: 2,
    tool: 'codex',
    host,
    codex_version: codexVersion || null,
    generation_count: normalized.length,
    generations: normalized,
    pass: normalized.length === GENERATION_COUNT && normalized.every((generation) => generation.pass === true),
  };
}

async function runGeneration({ generation, replacement, deps = {} }) {
  const fs = {
    exists: deps.existsSync || existsSync,
    makeTemp: deps.mkdtempSync || mkdtempSync,
    makeDir: deps.mkdirSync || mkdirSync,
    writeFile: deps.writeFileSync || writeFileSync,
    open: deps.openSync || openSync,
    close: deps.closeSync || closeSync,
    remove: deps.rmSync || rmSync,
  };
  const tempRoot = fs.makeTemp(join(probeTempBase, 'mccb-'));
  const workspaceDir = join(tempRoot, 'workspace');
  const isolatedChild = join(workspaceDir, 'credential-boundary-child');
  const credentialDir = join(tempRoot, 'credential-domain');
  const canaryPath = join(credentialDir, 'canary');
  const socketPath = join(credentialDir, 'broker.sock');
  const codexHome = join(tempRoot, 'codex-home');
  const executorHome = join(workspaceDir, '.executor-home');
  const executorTmp = join(workspaceDir, '.executor-tmp');
  const canary = `mc_canary_${randomBytes(24).toString('hex')}`;
  let openCanaryFd = null;
  let server = null;
  let setupCode = 'generation_ready';
  let negative = emptyRunResult();
  let isolated = emptyRunResult();

  try {
    fs.makeDir(credentialDir, { recursive: true, mode: 0o700 });
    fs.makeDir(codexHome, { recursive: true, mode: 0o700 });
    fs.makeDir(workspaceDir, { recursive: true, mode: 0o700 });
    fs.makeDir(executorHome, { recursive: true, mode: 0o700 });
    fs.makeDir(executorTmp, { recursive: true, mode: 0o700 });
    const compiled = (deps.compileBoundaryProbe || compileManagedBoundaryProbe)({
      outputPath: isolatedChild,
      deps: deps.compilerDeps || {},
    });
    if (!compiled?.ok) setupCode = 'boundary_probe_compile_failed';
    fs.writeFile(canaryPath, canary, { mode: 0o600 });
    openCanaryFd = fs.open(canaryPath, 'r');
    writeManagedConfig({
      codexHome,
      credentialDir,
      executorRoot: workspaceDir,
      workspaceRoot: workspaceDir,
      executorHome,
      executorTmp,
      forbiddenPaths: [
        homedir(),
        repoRoot,
        hostMcRoot,
        hostMcTarget?.binPath,
        hostMcTarget?.entryPath,
      ].filter(Boolean),
      deniedUnixSocketPaths: [socketPath],
    });

    const baseEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: tempRoot,
      TMPDIR: tempRoot,
      LANG: process.env.LANG || 'C',
      MC_HOME: credentialDir,
      MC_BOUNDARY_CANARY: canary,
    };
    const childArgs = [
      isolatedChild,
      canaryPath,
      socketPath,
      hostMcTarget?.binPath || '',
      hostMcTarget?.nodePath || '',
      hostMcTarget?.entryPath || '',
    ];
    // Keep the negative control before sandbox setup: every generation must
    // prove that the canary would have been visible without containment.
    negative = run(isolatedChild, childArgs.slice(1), baseEnv, { canary, deps });

    try {
      server = await listenCredentialSocket(socketPath, deps);
    } catch {
      setupCode = 'credential_socket_bind_failed';
    }

    const managedCodexBinary = resolveManagedCodexBinary(deps);
    if (!managedCodexBinary && setupCode === 'generation_ready') {
      setupCode = 'managed_codex_artifact_unavailable';
    }
    if (server && compiled?.ok && managedCodexBinary) {
      isolated = run(managedCodexBinary, [
        '--profile',
        MANAGED_CODEX_PROFILE,
        'sandbox',
        '--include-managed-config',
        '--permission-profile',
        MANAGED_CODEX_PROFILE,
        '--cd',
        workspaceDir,
        isolatedChild,
        ...childArgs.slice(1),
      ], {
        ...baseEnv,
        CODEX_HOME: codexHome,
      }, { canary, cwd: workspaceDir, deps });
    }
  } finally {
    if (openCanaryFd !== null) {
      try { fs.close(openCanaryFd); } catch {}
    }
    if (server) await closeServer(server);
    try { fs.remove(tempRoot, { recursive: true, force: true }); } catch {}
  }

  const teardown = verifyTeardown({ tempRoot, credentialDir, socketPath, exists: fs.exists });
  const negativeControlDetected = negative.ok
    && validateBoundaryReport(negative.value)
    && negative.value.file_readable === true
    && negative.value.canary_in_environment === true
    && negative.value.vault_admin_via_bin_callable === true
    && negative.value.vault_admin_via_node_callable === true;
  const isolatedReportValid = isolated.ok && validateBoundaryReport(isolated.value);
  const expectedIsolated = {
    file_readable: false,
    canary_in_environment: false,
    canary_in_argv: false,
    parent_process_exposes_canary: false,
    detached_boundary_reachable: false,
    credential_socket_reachable: false,
    external_network_reachable: true,
    workspace_write_blocked: false,
    vault_admin_via_bin_callable: false,
    vault_admin_via_node_callable: false,
  };
  const isolatedViolations = isolatedReportValid
    ? Object.entries(expectedIsolated)
      .filter(([key, value]) => isolated.value[key] !== value)
      .map(([key]) => key)
    : [setupCode === 'generation_ready' ? 'probe_execution_failed' : setupCode];
  const outputContainsCanary = negative.outputContainsCanary || isolated.outputContainsCanary;
  const isolatedDiagnostic = isolated.ok
    ? null
    : sanitizeDiagnostic(`${isolated.stdout}\n${isolated.stderr}`, {
        canary,
        privatePaths: [tempRoot, credentialDir, socketPath, repoRoot],
      });
  const pass = replacement.verified
    && negativeControlDetected
    && isolatedReportValid
    && isolatedViolations.length === 0
    && !outputContainsCanary
    && teardown.removed;

  return {
    generation,
    replacement,
    setup: { code: setupCode },
    negative_control: {
      detected: negativeControlDetected,
      code: negativeControlDetected ? 'negative_control_detected' : 'negative_control_missing',
    },
    isolated_probe: isolated.value,
    isolated_violations: isolatedViolations,
    isolated_status: isolated.status,
    isolated_diagnostic: isolatedDiagnostic,
    output_contains_canary: outputContainsCanary,
    teardown,
    pass,
  };
}

function sanitizeDiagnostic(value, { canary = '', privatePaths = [] } = {}) {
  let out = String(value || '');
  for (const secret of [canary, ...privatePaths]) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out.trim().slice(0, 4_000) || null;
}

function writeManagedConfig({
  codexHome,
  credentialDir,
  executorRoot,
  workspaceRoot,
  executorHome,
  executorTmp,
  forbiddenPaths,
  deniedUnixSocketPaths,
}) {
  writeFileSync(join(codexHome, 'config.toml'), '', { mode: 0o600 });
  writeFileSync(
    join(codexHome, `${MANAGED_CODEX_PROFILE}.config.toml`),
    renderManagedCodexConfig({
    domainPath: credentialDir,
    executorRoot,
    workspaceRoot,
    executorHome,
    executorTmp,
    safePath: process.env.PATH || '/usr/bin:/bin',
    forbiddenPaths,
    deniedUnixSocketPaths,
    }),
    { mode: 0o600 },
  );
}

function resolveHostMcTarget() {
  for (const binPath of ['/opt/homebrew/bin/mc', '/usr/local/bin/mc']) {
    try {
      const nodePath = join(dirname(binPath), 'node');
      if (existsSync(binPath) && existsSync(nodePath)) {
        return {
          binPath,
          nodePath: realpathSync(nodePath),
          entryPath: realpathSync(binPath),
        };
      }
    } catch {}
  }
  return null;
}

function listenCredentialSocket(socketPath, deps = {}) {
  const createServerImpl = deps.createServer || createServer;
  const server = createServerImpl((socket) => socket.destroy());
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(socketPath, () => resolveListen(server));
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    try { server.close(resolveClose); } catch { resolveClose(); }
  });
}

function verifyPreviousGeneration(previous) {
  if (!previous) {
    return {
      verified: true,
      code: 'initial_generation_no_predecessor',
    };
  }
  // Re-inspect immediately before allocating the next generation. The paths
  // stay in this closure and are deliberately not serialised into the report.
  const inspected = typeof previous.verify === 'function' ? previous.verify() : previous;
  const verified = inspected.removed === true
    && inspected.credential_domain_removed === true
    && inspected.socket_removed === true
    && inspected.temp_domain_removed === true;
  return {
    verified,
    previous_credential_domain_removed: inspected.credential_domain_removed === true,
    previous_socket_removed: inspected.socket_removed === true,
    previous_temp_domain_removed: inspected.temp_domain_removed === true,
    code: verified ? 'previous_generation_removed' : 'previous_generation_not_removed',
  };
}

function verifyTeardown({ tempRoot, credentialDir, socketPath, exists }) {
  const credentialDomainRemoved = !exists(credentialDir);
  const socketRemoved = !exists(socketPath);
  const tempDomainRemoved = !exists(tempRoot);
  const removed = credentialDomainRemoved && socketRemoved && tempDomainRemoved;
  const result = {
    removed,
    credential_domain_removed: credentialDomainRemoved,
    socket_removed: socketRemoved,
    temp_domain_removed: tempDomainRemoved,
    code: removed ? 'generation_domain_removed' : 'generation_domain_removal_failed',
  };
  Object.defineProperty(result, 'verify', {
    value: () => verifyTeardown({ tempRoot, credentialDir, socketPath, exists }),
    enumerable: false,
  });
  return result;
}

function readCodexVersion() {
  const binary = resolveManagedCodexBinary({});
  if (!binary) return null;
  const result = run(binary, ['--version'], {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: tmpdir(),
  }, { parseJson: false });
  return result.ok ? result.stdout.trim() || null : null;
}

function resolveManagedCodexBinary(deps) {
  if (typeof deps?.codexBinary === 'string' && deps.codexBinary.startsWith('/')) {
    return deps.codexBinary;
  }
  const artifact = (deps?.verifyManagedCodexArtifact
    || verifyInstalledManagedCodexArtifact)();
  return artifact?.ok ? artifact.nativeBinary : null;
}

function run(command, args, env, {
  parseJson = true,
  canary = '',
  cwd = repoRoot,
  deps = {},
} = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const result = spawn(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  let value = null;
  if (parseJson && result.status === 0) {
    try { value = JSON.parse(stdout); } catch { value = null; }
  }
  return {
    ok: result.status === 0 && (!parseJson || value !== null),
    status: result.status,
    stdout,
    stderr,
    value,
    outputContainsCanary: canary.length > 0 && (stdout.includes(canary) || stderr.includes(canary)),
  };
}

function emptyRunResult() {
  return { ok: false, status: null, stdout: '', stderr: '', value: null, outputContainsCanary: false };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runCredentialBoundaryProbe();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 1;
}
