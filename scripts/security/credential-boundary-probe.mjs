import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const childScript = join(scriptDir, 'credential-boundary-child.mjs');
const probeTempBase = process.platform === 'win32' ? tmpdir() : '/tmp';
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
    copyFile: deps.copyFileSync || copyFileSync,
    writeFile: deps.writeFileSync || writeFileSync,
    open: deps.openSync || openSync,
    close: deps.closeSync || closeSync,
    remove: deps.rmSync || rmSync,
  };
  const tempRoot = fs.makeTemp(join(probeTempBase, 'mccb-'));
  const workspaceDir = join(tempRoot, 'workspace');
  const isolatedChildScript = join(workspaceDir, 'credential-boundary-child.mjs');
  const credentialDir = join(tempRoot, 'credential-domain');
  const canaryPath = join(credentialDir, 'canary');
  const socketPath = join(credentialDir, 'broker.sock');
  const codexHome = join(tempRoot, 'codex-home');
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
    fs.copyFile(childScript, isolatedChildScript);
    fs.writeFile(canaryPath, canary, { mode: 0o600 });
    openCanaryFd = fs.open(canaryPath, 'r');
    writeManagedConfig({ codexHome, credentialDir });

    const baseEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: tempRoot,
      TMPDIR: tempRoot,
      LANG: process.env.LANG || 'C',
      MC_HOME: credentialDir,
      MC_BOUNDARY_CANARY: canary,
    };
    const childArgs = [isolatedChildScript, canaryPath, socketPath, repoRoot];
    // Keep the negative control before sandbox setup: every generation must
    // prove that the canary would have been visible without containment.
    negative = run(process.execPath, childArgs, baseEnv, { canary, deps });

    try {
      server = await listenCredentialSocket(socketPath, deps);
    } catch {
      setupCode = 'credential_socket_bind_failed';
    }

    if (server) {
      isolated = run('codex', [
        'sandbox',
        '--include-managed-config',
        '--permission-profile',
        'mc-credential-boundary',
        '--cd',
        workspaceDir,
        process.execPath,
        ...childArgs,
      ], {
        ...baseEnv,
        CODEX_HOME: codexHome,
      }, { canary, deps });
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
    && (negative.value?.file_readable === true || negative.value?.canary_in_environment === true);
  const isolatedViolations = isolated.ok
    ? Object.entries(isolated.value || {})
      .filter(([, value]) => value === true)
      .map(([key]) => key)
    : [setupCode === 'generation_ready' ? 'probe_execution_failed' : setupCode];
  const outputContainsCanary = negative.outputContainsCanary || isolated.outputContainsCanary;
  const pass = replacement.verified
    && negativeControlDetected
    && isolated.ok
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
    output_contains_canary: outputContainsCanary,
    teardown,
    pass,
  };
}

function writeManagedConfig({ codexHome, credentialDir }) {
  writeFileSync(join(codexHome, 'config.toml'), `
approval_policy = "never"
allow_login_shell = false

[shell_environment_policy]
inherit = "core"
exclude = ["MC_BOUNDARY_CANARY", "*TOKEN*", "*SECRET*", "*KEY*"]

[permissions.mc-credential-boundary]
extends = ":workspace"

[permissions.mc-credential-boundary.filesystem]
"${tomlString(credentialDir)}" = "deny"
"${tomlString(repoRoot)}" = "deny"

[permissions.mc-credential-boundary.network]
enabled = false
`, { mode: 0o600 });
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
  const result = run('codex', ['--version'], {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: tmpdir(),
  }, { parseJson: false });
  return result.ok ? result.stdout.trim() || null : null;
}

function run(command, args, env, { parseJson = true, canary = '', deps = {} } = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const result = spawn(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 20_000,
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

function tomlString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runCredentialBoundaryProbe();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 1;
}
