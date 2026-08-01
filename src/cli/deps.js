/** `mc deps` — inspect or explicitly hydrate worktree-local dependencies. */
import { dependencyStatus, hydrateDependencies } from '../mc/dependencies.js';
import { resolveDevPlan } from '../mc/dev-definition.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }

  try {
    const resolvePlan = deps.resolveDevPlan || resolveDevPlan;
    const plan = await resolvePlan({
      cwd: deps.cwd || process.cwd(),
      serviceName: opts.service,
      profileName: opts.profile,
    });
    if (opts.verb === 'status') {
      const inspect = deps.dependencyStatus || dependencyStatus;
      const status = await inspect(plan, deps.dependencyOptions || {});
      if (opts.json) stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else printStatus(status, stdout);
      return 0;
    }

    const hydrate = deps.hydrateDependencies || hydrateDependencies;
    const result = await hydrate(plan, {
      replace: opts.replace,
      ...(deps.dependencyOptions || {}),
      deps: {
        ...(deps.dependencyOptions?.deps || {}),
        onOutput: (_stream, chunk) => stderr.write(chunk),
      },
    });
    if (opts.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printHydrate(result, stdout, stderr);
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`mc: ${error?.message || String(error)}\n`);
    return 1;
  }
}

export function parseArgs(argv) {
  const opts = {
    verb: null,
    service: null,
    profile: null,
    json: false,
    replace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--replace') { opts.replace = true; continue; }
    if (arg === '--profile') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: '--profile requires a name' };
      opts.profile = value;
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown flag: ${arg}` };
    if (!opts.verb) { opts.verb = arg; continue; }
    if (!opts.service) { opts.service = arg; continue; }
    return { error: `unexpected arg: ${arg}` };
  }
  if (!['status', 'hydrate'].includes(opts.verb)) {
    return { error: `unknown or missing deps verb: ${opts.verb || '<missing>'}` };
  }
  if (opts.verb !== 'hydrate' && opts.replace) {
    return { error: '--replace is only valid with mc deps hydrate' };
  }
  return opts;
}

function printStatus(status, stdout) {
  stdout.write(`mc deps — ${status.service.name}/${status.profile.name} (${status.mode.name})\n`);
  stdout.write(`  fingerprint  ${status.fingerprint.value}\n`);
  stdout.write(`  worktree     ${status.worktree.state}  ${status.worktree.path}\n`);
  stdout.write(`  snapshot     ${status.snapshot.state}  ${status.snapshot.path}\n`);
  stdout.write(`  next          ${status.recommended_action}\n`);
}

function printHydrate(result, stdout, stderr) {
  if (!result.ok) {
    stderr.write(`mc: dependency hydrate refused (${result.reason || 'unknown'})\n`);
    if (result.hint) stderr.write(`mc: ${result.hint}\n`);
    return;
  }
  stdout.write(`mc deps — ${result.changed ? 'hydrated' : 'already ready'} from ${result.source}\n`);
  stdout.write(`  worktree     ${result.status.worktree.path}\n`);
  stdout.write(`  fingerprint  ${result.status.fingerprint.value}\n`);
  if (result.clone_method || result.snapshot_method) {
    stdout.write(`  copy          ${result.clone_method || result.snapshot_method}\n`);
  }
  for (const warning of result.warnings || []) {
    stderr.write(`mc: warning: ${warning.code}: ${warning.message}\n`);
  }
}
