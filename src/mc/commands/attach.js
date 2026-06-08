import { attachBrokerSession } from '../broker/attach-client.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    printUsage();
    return 2;
  }
  if (opts.help || !opts.id) {
    printUsage();
    return opts.help ? 0 : 2;
  }
  return attachBrokerSession({ id: opts.id });
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
