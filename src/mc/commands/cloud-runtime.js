import { runCloudRuntimeSupervisor } from '../cloud-runtime/supervisor.js';

export async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  if (opts.error) {
    deps.stderr?.write?.(`mc: ${opts.error}\n`);
    printUsage(deps.stdout || process.stdout);
    return 2;
  }
  if (opts.help || !opts.verb) {
    printUsage(deps.stdout || process.stdout);
    return opts.help ? 0 : 2;
  }
  if (opts.verb !== 'run') {
    (deps.stderr || process.stderr).write(`mc: unknown cloud-runtime verb: ${opts.verb}\n`);
    return 2;
  }
  const result = await runCloudRuntimeSupervisor(opts, deps);
  return result.exitCode ?? (result.ok ? 0 : 1);
}

export function parseArgs(argv = []) {
  const opts = {
    verb: null,
    cloudSessionId: null,
    manifest: null,
    json: false,
    once: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--once') { opts.once = true; continue; }
    if (arg === '--cloud-session-id') { opts.cloudSessionId = argv[++i]; continue; }
    if (arg === '--manifest') { opts.manifest = argv[++i]; continue; }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.verb) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.verb = arg;
  }
  if (opts.verb === 'run' && !opts.help) {
    if (!opts.cloudSessionId) return { ...opts, error: '--cloud-session-id required' };
    if (!opts.manifest) return { ...opts, error: '--manifest required' };
  }
  return opts;
}

function printUsage(stdout = process.stdout) {
  stdout.write(`mc cloud-runtime - hosted coding runtime supervisor

USAGE
  mc cloud-runtime run --cloud-session-id <id> --manifest <path> [--json]

Internal command for Memoro Cloud Coding sandboxes.
`);
}
