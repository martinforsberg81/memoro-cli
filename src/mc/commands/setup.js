/**
 * `mc setup [--json]` (§11b).
 *
 * Non-interactive on purpose — runs every health probe `mc auth status`
 * already exposes, then either:
 *
 *   - all green  → prints a one-line confirmation, writes the
 *                  `${MC_HOME}/.setup-done-v1` sentinel, exits 0.
 *   - otherwise  → prints a numbered checklist of *only* the missing
 *                  steps with the EXACT command to fix each. Each
 *                  command is a real mc verb (`mc auth memoro`,
 *                  `mc auth claude`, `mc install-shell`) so the user
 *                  just copies the line.
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
import {
  sentinelPath as freshInstallSentinelPath,
  ensureSentinel as freshInstallEnsureSentinel,
} from '../first-run.js';

// Required tools — at least one of these must be installed AND authed
// for setup to consider the machine "ready". Codex/Gemini are tracked
// as optional; setup never blocks on them.
const REQUIRED_TOOLS = ['claude'];
const OPTIONAL_TOOLS = ['codex', 'gemini'];

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(`mc: ${opts.error}`); return 2; }

  const report = await buildReport();
  const steps = missingSteps(report);

  if (opts.json) {
    console.log(JSON.stringify({
      ok: steps.length === 0,
      report,
      missing_steps: steps,
      sentinel_path: sentinelPath(),
    }, null, 2));
  } else if (steps.length === 0) {
    printAllSet(report);
  } else {
    printChecklist(steps);
  }

  if (steps.length === 0) writeSentinel();
  return steps.length === 0 ? 0 : 1;
}

async function buildReport() {
  const memoro = await probeMemoro();
  const tools = {};
  for (const t of [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS]) {
    tools[t] = await getToolStatus(t);
  }
  return {
    memoro,
    tools,
    shell_wrapper: probeShellWrapper(),
    workspace: probeWorkspace(),
  };
}

/**
 * Build the ordered checklist of *only* the missing steps. Order is
 * deliberate: log in to Memoro before anything else (everything else
 * keys off the account), then primary tool (Claude), then shell
 * wrapper. Each step carries the exact command the user should run.
 */
export function missingSteps(report) {
  const steps = [];
  if (!report.memoro.authenticated) {
    steps.push({
      id: 'memoro-login',
      title: 'Sign in to Memoro',
      command: 'mc auth memoro',
      note: 'Stores your Memoro token in the OS keychain.',
    });
  }

  // Require at least one of the REQUIRED_TOOLS to be installed AND
  // authenticated. If none are, surface install + auth steps for the
  // first required tool (Claude).
  const someRequiredReady = REQUIRED_TOOLS.some((t) => {
    const s = report.tools[t];
    return s?.installed && s.authenticated === true;
  });
  if (!someRequiredReady) {
    const primary = REQUIRED_TOOLS[0];
    const s = report.tools[primary];
    if (!s?.installed) {
      steps.push({
        id: `install-${primary}`,
        title: `Install ${labelFor(primary)}`,
        // The hint from the not-installed branch is already the
        // canonical install command; surface it verbatim.
        command: extractInstallCommand(s?.hint) || s?.hint || '',
        note: 'mc setup will not auto-install — review the command before running.',
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

function printAllSet(report) {
  process.stdout.write(`mc setup — all set up.\n`);
  process.stdout.write(`  ✓ Memoro signed in\n`);
  for (const t of REQUIRED_TOOLS) {
    const s = report.tools[t];
    if (s?.installed && s.authenticated === true) {
      process.stdout.write(`  ✓ ${labelFor(t)} installed + authenticated\n`);
    }
  }
  if (report.shell_wrapper.installed) {
    process.stdout.write(`  ✓ Shell wrapper installed (${report.shell_wrapper.rc})\n`);
  }
  // Surface optional tools that ARE installed as a bonus line.
  const optionalReady = OPTIONAL_TOOLS.filter((t) => report.tools[t]?.installed);
  if (optionalReady.length) {
    process.stdout.write(`  ✓ Optional: ${optionalReady.map(labelFor).join(', ')} available\n`);
  }
  process.stdout.write(`\nRun \`mc new <name>\` to start a session.\n`);
}

function printChecklist(steps) {
  process.stdout.write(`mc setup — ${steps.length} step${steps.length === 1 ? '' : 's'} left:\n\n`);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    process.stdout.write(`  ${i + 1}. ${s.title}\n`);
    if (s.command) process.stdout.write(`       run:  ${s.command}\n`);
    if (s.note)    process.stdout.write(`       ${s.note}\n`);
    process.stdout.write(`\n`);
  }
  process.stdout.write(`Re-run \`mc setup\` when done to verify.\n`);
}

// Sentinel reads/writes live in src/mc/first-run.js so `mc new`,
// `mc list`, and `mc setup` all agree on one location. Re-exported
// under the same names so the existing test imports still resolve.
export const sentinelPath = freshInstallSentinelPath;
export const writeSentinel = freshInstallEnsureSentinel;

function parseArgs(argv) {
  const opts = { json: false };
  for (const a of argv) {
    if (a === '--json') { opts.json = true; continue; }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
}
