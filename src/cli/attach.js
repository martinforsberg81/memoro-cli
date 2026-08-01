import { attachBrokerSession } from '../runtime/broker/attach-client.js';
import { requestBroker } from '../runtime/broker/client.js';
import { ensureBrokerRunning } from '../runtime/broker/supervisor.js';
import {
  resolveSessionControllerCapability,
} from '../mc/session-controller-capability.js';

export async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  const stderr = deps.stderr || process.stderr;
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    printUsage();
    return 2;
  }
  if (opts.help || !opts.id) {
    printUsage();
    return opts.help ? 0 : 2;
  }
  const ensureBroker = deps.ensureBrokerRunning || ensureBrokerRunning;
  const broker = await ensureBroker({
    request: deps.request || requestBroker,
    spawnDaemon: deps.spawnDaemon,
    sleep: deps.sleep,
  });
  if (!broker.ok) {
    stderr.write(`mc: broker start failed (${broker.error || 'unknown'})\n`);
    return 1;
  }
  const attach = deps.attachBrokerSession || attachBrokerSession;
  const authority = await (
    deps.resolveSessionControllerCapability
    || resolveSessionControllerCapability
  )({
    codingSessionId: opts.id,
    deps,
  });
  if (!authority?.ok) {
    stderr.write('mc: session controller authority is unavailable\n');
    return 1;
  }
  return attach({
    id: opts.id,
    controllerCapability: authority.capability,
  });
}

export function parseArgs(argv) {
  const opts = { id: null, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a.startsWith('--')) return { ...opts, error: `unknown flag: ${a}` };
    if (opts.id) return { ...opts, error: `unexpected arg: ${a}` };
    opts.id = a;
  }
  return opts;
}

function printUsage() {
  process.stdout.write(`mc attach — attach to a broker-owned local session

USAGE
  mc attach <session_id>
`);
}
