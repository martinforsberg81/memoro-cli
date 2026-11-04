#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScriptWithKeys } from './mc/keys-run.js';

const CHILD = fileURLToPath(new URL('../scripts/admin-dashboard.js', import.meta.url));
export const HELP = `mc-admin — read-only Memoro production admin snapshot\n\nUsage: mc-admin [--json]\n\nReads service health, operations, account usage and costs once; rerun to refresh. No writes, polling, or interactive session. Credentials are supplied only to the fixed trusted child by mc keys run.\n\nExit codes: 0 all four sources accepted (warnings may be present); 1 usage, missing credentials, refused headless access, runner failure, or unavailable source.`;

export async function run(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { stdout.write(`${HELP}\n`); return 0; }
  if (argv.some((arg) => arg !== '--json') || argv.filter((arg) => arg === '--json').length > 1) {
    stderr.write(`${HELP}\n`); return 1;
  }
  const env = deps.env || process.env;
  if (env.MC_HEADLESS === '1') { stderr.write('mc-admin: live reads are refused in MC_HEADLESS=1\n'); return 1; }
  const invoke = deps.runScriptWithKeys || runScriptWithKeys;
  const script = deps.child || CHILD;
  try {
    const code = await invoke(script, argv.includes('--json') ? ['--json'] : [], {
      cwd: deps.cwd || process.cwd(), env, stdout, stderr, home: deps.home,
    });
    return code === 0 ? 0 : 1;
  } catch { stderr.write('mc-admin: trusted keys runner failed\n'); return 1; }
}

function isEntry(path) {
  try { return Boolean(path) && realpathSync(path) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntry(process.argv[1])) {
  process.exitCode = await run();
}
