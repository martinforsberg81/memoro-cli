/**
 * `mc setup [--json] [--resource-profile <name>] [--dependency-mode <mode>]` (§11b).
 *
 * Runs every health probe `mc auth status` already exposes, then either:
 *
 *   - all green  → prints a one-line confirmation, writes the
 *                  `${MC_HOME}/.setup-done-v1` sentinel, exits 0.
 *   - otherwise  → prints a numbered checklist of *only* the missing
 *                  steps with the EXACT command to fix each. Each
 *                  command is a real mc entry (`mc`, `mc auth codex`,
 *                  `mc install-shell`) so the user
 *                  just copies the line.
 *
 * On a TTY, setup also offers an optional local heavy-job resource profile.
 * The default is `unlimited`, preserving mc's historical behaviour. JSON and
 * non-TTY runs never prompt; automation can select a profile explicitly with
 * `--resource-profile`.
 *
 * Idempotent. Re-run it whenever — if a step has been completed
 * externally, the next run skips it. The sentinel is for first-run
 * detection (§11d) elsewhere; nothing reads it during setup itself.
 *
 * Decided in §11f: setup never installs Claude Code automatically.
 * npm-installing surprise side effects from a "setup" verb is hostile.
 * We print the install command and let the user run it.
 */
import {
  probeMemoro,
  getToolStatus,
  probeShellWrapper,
  probeWorkspace,
} from './auth.js';
import { createConnectionClient } from '../connections/client.js';
import { promptLine } from '../../lib/prompt.js';
import { readConfig, writeConfig } from '../../lib/config.js';
import {
  sentinelPath as freshInstallSentinelPath,
  ensureSentinel as freshInstallEnsureSentinel,
} from '../first-run.js';
import {
  LOCAL_RESOURCE_PROFILE_NAMES,
  buildLocalResourceProfile,
  customResourceLimits,
  describeLocalResourceProfile,
  recommendLocalResourceProfile,
  resolveLocalResourceProfile,
  withLocalResourceProfile,
} from '../local-resource-profile.js';
import {
  DEPENDENCY_MODES,
  describeDependencyMode,
  resolveDependencyMode,
  withDependencyMode,
} from '../dependency-mode.js';

// Required tools — at least one of these must be ready for setup to consider
// the machine usable. Codex is the default mc tool; its auth probe can be
// unknown headlessly, so installed + not-explicitly-failed is ready enough.
const REQUIRED_TOOLS = ['codex'];
const OPTIONAL_TOOLS = ['claude', 'gemini'];

export async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(`mc: ${opts.error}`); return 2; }

  const readConfigFn = deps.readConfig || readConfig;
  const writeConfigFn = deps.writeConfig || writeConfig;
  let config = await readConfigFn();
  let resourceProfile = resolveLocalResourceProfile(config);
  let dependencyMode = resolveDependencyMode(config);
  const recommendedProfile = recommendLocalResourceProfile({
    totalMemoryBytes: deps.totalMemoryBytes,
  });
  const interactive = !opts.json && (deps.stdinIsTTY ?? process.stdin.isTTY);

  try {
    let configChanged = false;
    if (opts.resourceProfile) {
      resourceProfile = profileFromOptions(opts);
      config = withLocalResourceProfile(config, resourceProfile);
      configChanged = true;
    } else if (interactive) {
      resourceProfile = await promptLocalResourceProfile({
        current: resourceProfile,
        recommended: recommendedProfile,
        ask: deps.promptLine || promptLine,
        stdout: deps.stdout || process.stdout,
      });
      config = withLocalResourceProfile(config, resourceProfile);
      configChanged = true;
    }
    if (opts.dependencyMode) {
      dependencyMode = opts.dependencyMode;
      config = withDependencyMode(config, dependencyMode);
      configChanged = true;
    } else if (interactive) {
      dependencyMode = await promptDependencyMode({
        current: dependencyMode,
        ask: deps.promptLine || promptLine,
        stdout: deps.stdout || process.stdout,
      });
      config = withDependencyMode(config, dependencyMode);
      configChanged = true;
    }
    if (configChanged) {
      await writeConfigFn(config);
    }
  } catch (err) {
    console.error(`mc: ${err.message}`);
    return 2;
  }

  const report = await buildReport(deps);
  const steps = missingSteps(report);
  const resourceReport = {
    ...resourceProfile,
    recommended: recommendedProfile,
  };

  if (opts.json) {
    console.log(JSON.stringify({
      ok: steps.length === 0,
      report,
      resource_profile: resourceReport,
      dependency_mode: dependencyMode,
      missing_steps: steps,
      sentinel_path: sentinelPath(),
    }, null, 2));
  } else if (steps.length === 0) {
    printAllSet(report, resourceReport, dependencyMode);
  } else {
    printChecklist(steps, resourceReport, dependencyMode);
  }

  if (steps.length === 0) writeSentinel();
  return steps.length === 0 ? 0 : 1;
}

async function buildReport(deps = {}) {
  const memoro = await probeMemoro();
  const tools = {};
  for (const t of [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS]) {
    tools[t] = await getToolStatus(t);
  }
  const connectionClient = deps.connectionClient || createConnectionClient(deps);
  const connections = [];
  for (const provider of connectionClient.providers().filter((item) => item.onboarding)) {
    try {
      connections.push(await connectionClient.status(provider.id));
    } catch {
      connections.push({
        schema: 1,
        provider: { id: provider.id, label: provider.label, custody: provider.custody },
        state: 'unavailable',
        repair_action: 'retry',
        account: null,
        resources: [],
        sources: { local: 'unavailable', cloud: 'unavailable' },
        capabilities: [],
      });
    }
  }
  return {
    memoro,
    tools,
    connections,
    shell_wrapper: probeShellWrapper(),
    workspace: probeWorkspace(),
  };
}

/**
 * Build the ordered checklist of *only* the missing steps. Order is
 * deliberate: log in to Memoro before anything else (everything else
 * keys off the account), then primary tool (Codex), then shell
 * wrapper. Each step carries the exact command the user should run.
 */
export function missingSteps(report) {
  const steps = [];
  if (!report.memoro.authenticated) {
    steps.push({
      id: 'memoro-login',
      title: 'Sign in to Memoro',
      command: 'mc',
      note: 'Starts browser device sign-in and stores your token in the OS keychain. Use `mc auth memoro` for CI/headless token login.',
    });
  }

  // Require at least one primary tool to be installed and not explicitly
  // unauthenticated. Codex cannot always verify auth headlessly, so null
  // is accepted the same way `mc tool-switch` accepts it.
  const someRequiredReady = REQUIRED_TOOLS.some((t) => {
    const s = report.tools[t];
    return s?.installed && s.authenticated !== false;
  });
  if (!someRequiredReady) {
    const primary = REQUIRED_TOOLS[0];
    const s = report.tools[primary];
    if (!s?.installed) {
      const installCommand = extractInstallCommand(s?.hint);
      steps.push({
        id: `install-${primary}`,
        title: `Install ${labelFor(primary)}`,
        // The hint from the not-installed branch is already the
        // canonical install command; surface it verbatim.
        command: installCommand || '',
        note: installCommand
          ? 'mc setup will not auto-install — review the command before running.'
          : (s?.hint || 'Install the tool, then re-run setup.'),
      });
      steps.push({
        id: `verify-${primary}`,
        title: `Sign in to ${labelFor(primary)}`,
        command: `mc auth ${primary}`,
        note: `Or run \`${primary}\` directly and complete the sign-in flow.`,
      });
    } else if (s.authenticated === false) {
      steps.push({
        id: `verify-${primary}`,
        title: `Sign in to ${labelFor(primary)}`,
        command: s.hint?.startsWith('Run ') ? extractCommand(s.hint) || `mc auth ${primary}` : `mc auth ${primary}`,
        note: `Re-run \`mc setup\` to confirm.`,
      });
    }
  }

  for (const connection of report.memoro.authenticated ? (report.connections || []) : []) {
    if (connection.state === 'ready') continue;
    const provider = connection.provider;
    const action = connection.repair_action || 'retry';
    const command = ['retry', 'contact_admin'].includes(action)
      ? `mc connections status ${provider.id}`
      : `mc connections repair ${provider.id}`;
    steps.push({
      id: `connection-${provider.id}-${action}`,
      title: `Connect ${provider.label}`,
      command,
      note: `Connection state: ${connection.state}. Repair action: ${action}.`,
    });
  }

  if (!report.shell_wrapper.installed) {
    steps.push({
      id: 'install-shell',
      title: 'Install the shell wrapper',
      command: 'mc install-shell',
      note: 'Lets `mc cd <name>` change your shell\'s cwd.',
    });
  }

  return steps;
}

function labelFor(tool) {
  if (tool === 'claude') return 'Claude Code';
  if (tool === 'codex')  return 'Codex CLI';
  if (tool === 'gemini') return 'Gemini CLI';
  return tool;
}

function extractInstallCommand(hint) {
  if (!hint) return null;
  // Hints follow the pattern "Install with: <command>" — extract the
  // command so the checklist entry is just the runnable line.
  const m = hint.match(/Install with:\s*(.+)$/i);
  return m ? m[1].trim() : null;
}
function extractCommand(hint) {
  if (!hint) return null;
  const m = hint.match(/Run\s+`([^`]+)`/);
  return m ? m[1] : null;
}

function printAllSet(report, resourceReport, dependencyMode) {
  process.stdout.write(`mc setup — all set up.\n`);
  process.stdout.write(`  ✓ Memoro signed in\n`);
  for (const t of REQUIRED_TOOLS) {
    const s = report.tools[t];
    if (s?.installed && s.authenticated !== false) {
      const suffix = s.authenticated === true ? 'installed + authenticated' : 'installed';
      process.stdout.write(`  ✓ ${labelFor(t)} ${suffix}\n`);
    }
  }
  if (report.shell_wrapper.installed) {
    process.stdout.write(`  ✓ Shell wrapper installed (${report.shell_wrapper.rc})\n`);
  }
  for (const connection of report.connections || []) {
    if (connection.state === 'ready') {
      process.stdout.write(`  ✓ ${connection.provider.label} connected\n`);
    }
  }
  // Surface optional tools that ARE installed as a bonus line.
  const optionalReady = OPTIONAL_TOOLS.filter((t) => report.tools[t]?.installed);
  if (optionalReady.length) {
    process.stdout.write(`  ✓ Optional: ${optionalReady.map(labelFor).join(', ')} available\n`);
  }
  printResourceProfile(resourceReport);
  printDependencyMode(dependencyMode);
  process.stdout.write(`\nNext: from a git repo, run \`mc new <name> [focus]\` to start a session.\n`);
}

function printChecklist(steps, resourceReport, dependencyMode) {
  process.stdout.write(`mc setup — ${steps.length} setup step${steps.length === 1 ? '' : 's'} left:\n\n`);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    process.stdout.write(`  ${i + 1}. ${s.title}\n`);
    if (s.command) process.stdout.write(`       run:  ${s.command}\n`);
    if (s.note)    process.stdout.write(`       ${s.note}\n`);
    process.stdout.write(`\n`);
  }
  printResourceProfile(resourceReport);
  printDependencyMode(dependencyMode);
  process.stdout.write(`Re-run \`mc setup\` when done to verify.\n`);
}

function printResourceProfile(resourceReport) {
  process.stdout.write(`  ✓ Local heavy jobs: ${describeLocalResourceProfile(resourceReport)}\n`);
  if (resourceReport.profile !== resourceReport.recommended) {
    process.stdout.write(`    Suggested for this machine: ${resourceReport.recommended} (not selected automatically)\n`);
  }
}

function printDependencyMode(mode) {
  process.stdout.write(`  ✓ Project dependencies: ${describeDependencyMode(mode)}\n`);
}

export async function promptDependencyMode({
  current = 'auto',
  ask = promptLine,
  stdout = process.stdout,
} = {}) {
  const selectedCurrent = DEPENDENCY_MODES.includes(current) ? current : 'auto';
  const choices = [
    ['auto', 'Reuse immutable local snapshots; install on an explicit hydrate cache miss'],
    ['isolated', 'Install only inside each worktree; never read or write snapshots'],
    ['off', 'mc never installs project dependencies'],
  ];
  const defaultIndex = choices.findIndex(([name]) => name === selectedCurrent);
  stdout.write('\nProject dependency mode:\n');
  choices.forEach(([name, description], index) => {
    const selected = name === selectedCurrent ? ' (current)' : '';
    stdout.write(`  ${index + 1}. ${title(name)}${selected}: ${description}\n`);
  });
  const answer = String(await ask(`Choose [${defaultIndex + 1}]: `) || '').trim().toLowerCase();
  const selected = answer
    ? choices[Number(answer) - 1]?.[0] || choices.find(([name]) => name === answer)?.[0]
    : choices[defaultIndex][0];
  if (!selected) throw new Error(`unknown dependency mode choice: ${answer}`);
  return selected;
}

export async function promptLocalResourceProfile({
  current = { profile: 'unlimited' },
  recommended = 'unlimited',
  ask = promptLine,
  stdout = process.stdout,
} = {}) {
  const currentProfile = resolveProfileValue(current);
  const choices = [
    ['unlimited', 'No limits; preserves current mc behaviour'],
    ['balanced', '1 job, 4 compute threads, 4096 MB memory guard'],
    ['conservative', '1 job, 2 compute threads, 2560 MB memory guard'],
    ['custom', 'Choose concurrency, thread and safety thresholds'],
  ];
  const defaultIndex = Math.max(0, choices.findIndex(([name]) => name === currentProfile.profile));

  stdout.write('\nLocal image/motion resource profile:\n');
  choices.forEach(([name, description], index) => {
    const recommendation = name === recommended ? ' — recommended for this machine' : '';
    const selected = name === currentProfile.profile ? ' (current)' : '';
    stdout.write(`  ${index + 1}. ${title(name)}${selected}: ${description}${recommendation}\n`);
  });
  const answer = String(await ask(`Choose [${defaultIndex + 1}]: `) || '').trim().toLowerCase();
  const selected = answer
    ? choices[Number(answer) - 1]?.[0] || choices.find(([name]) => name === answer)?.[0]
    : choices[defaultIndex][0];
  if (!selected) throw new Error(`unknown resource profile choice: ${answer}`);
  if (selected !== 'custom') return buildLocalResourceProfile(selected);

  const defaults = currentProfile.profile === 'custom'
    ? currentProfile
    : buildLocalResourceProfile('conservative');
  const limits = customResourceLimits();
  const custom = {};
  for (const field of Object.keys(limits)) {
    custom[field] = await promptInteger({
      label: customFieldLabel(field),
      current: defaults[field],
      limits: limits[field],
      ask,
    });
  }
  return buildLocalResourceProfile('custom', custom);
}

function profileFromOptions(opts) {
  if (opts.resourceProfile !== 'custom') return buildLocalResourceProfile(opts.resourceProfile);
  return buildLocalResourceProfile('custom', opts.custom);
}

function resolveProfileValue(value) {
  return value?.enabled !== undefined
    ? value
    : buildLocalResourceProfile(value?.profile || value || 'unlimited', value);
}

async function promptInteger({ label, current, limits, ask }) {
  for (;;) {
    const answer = String(await ask(`${label} [${current}]: `) || '').trim();
    const value = answer ? Number(answer) : current;
    if (Number.isInteger(value) && value >= limits.min && value <= limits.max) return value;
  }
}

function customFieldLabel(field) {
  return {
    maxConcurrent: 'Maximum concurrent heavy jobs',
    maxThreads: 'Maximum compute threads per job',
    maxRssMb: 'Stop job above resident memory (MB)',
    maxSwapMb: 'Block/stop when swap exceeds (MB)',
    minFreeDiskGb: 'Require free disk space (GB)',
  }[field] || field;
}

function title(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Sentinel reads/writes live in src/mc/first-run.js so `mc new`,
// `mc list`, and `mc setup` all agree on one location. Re-exported
// under the same names so the existing test imports still resolve.
export const sentinelPath = freshInstallSentinelPath;
export const writeSentinel = freshInstallEnsureSentinel;

export function parseArgs(argv) {
  const opts = { json: false, resourceProfile: null, dependencyMode: null, custom: {} };
  const customFlags = {
    '--heavy-max-concurrent': 'maxConcurrent',
    '--heavy-max-threads': 'maxThreads',
    '--heavy-max-rss-mb': 'maxRssMb',
    '--heavy-max-swap-mb': 'maxSwapMb',
    '--heavy-min-free-disk-gb': 'minFreeDiskGb',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--resource-profile') {
      const value = String(argv[++i] || '').toLowerCase();
      if (!LOCAL_RESOURCE_PROFILE_NAMES.includes(value)) {
        return { error: `--resource-profile must be one of: ${LOCAL_RESOURCE_PROFILE_NAMES.join(', ')}` };
      }
      opts.resourceProfile = value;
      continue;
    }
    if (a === '--dependency-mode') {
      const value = String(argv[++i] || '').toLowerCase();
      if (!DEPENDENCY_MODES.includes(value)) {
        return { error: `--dependency-mode must be one of: ${DEPENDENCY_MODES.join(', ')}` };
      }
      opts.dependencyMode = value;
      continue;
    }
    if (customFlags[a]) {
      const value = argv[++i];
      if (value == null || String(value).startsWith('--')) return { error: `${a} requires a value` };
      opts.custom[customFlags[a]] = Number(value);
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  if (Object.keys(opts.custom).length && opts.resourceProfile !== 'custom') {
    return { error: 'custom heavy-job limits require --resource-profile custom' };
  }
  return opts;
}
