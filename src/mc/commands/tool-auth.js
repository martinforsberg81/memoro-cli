import {
  hydrateToolAuth,
  persistToolAuth,
  publicToolAuthResult,
} from '../tool-auth.js';

export async function run(argv) {
  const opts = parseArgs(argv);
  return runToolAuthWith(opts, {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
}

export async function runToolAuthWith(opts, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    printUsage(stderr);
    return 2;
  }
  if (opts.help || !opts.verb) {
    printUsage(stdout);
    return opts.help ? 0 : 2;
  }
  if (!opts.tool) {
    stderr.write('mc: --tool is required\n');
    if (opts.json) writeJson(stdout, { ok: false, error: '--tool is required' });
    return 2;
  }

  const call = {
    tool: opts.tool,
    cloudSessionId: opts.cloudSessionId,
    env: deps.env || process.env,
    portal: deps.portal || null,
    deps,
  };
  let result;
  if (opts.verb === 'hydrate') {
    result = await hydrateToolAuth(call);
  } else if (opts.verb === 'persist') {
    result = await persistToolAuth(call);
  } else {
    stderr.write(`mc: unknown tool-auth verb: ${opts.verb}\n`);
    printUsage(stderr);
    return 2;
  }

  const publicResult = publicToolAuthResult(result);
  if (opts.json) {
    writeJson(stdout, publicResult);
  } else {
    stdout.write(formatHuman(publicResult, opts.verb));
  }
  return publicResult.ok ? 0 : 1;
}

export function parseArgs(argv) {
  const opts = {
    verb: null,
    help: false,
    json: false,
    tool: null,
    cloudSessionId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--tool') {
      opts.tool = valueAfter(argv, ++i);
      if (isMissing(opts.tool)) return missingValue(opts, a);
      continue;
    }
    if (a === '--cloud-session-id') {
      opts.cloudSessionId = valueAfter(argv, ++i);
      if (isMissing(opts.cloudSessionId)) return missingValue(opts, a);
      continue;
    }
    if (a.startsWith('--')) return { ...opts, error: `unknown flag: ${a}` };
    if (opts.verb) return { ...opts, error: `unexpected arg: ${a}` };
    opts.verb = a;
  }
  return opts;
}

function formatHuman(result, verb) {
  const parts = [`mc tool-auth ${verb}: ${result.tool || 'unknown'}`];
  if (result.hydrated) parts.push('hydrated');
  else if (result.persisted && result.changed) parts.push(result.action || 'persisted');
  else if (result.persisted) parts.push('unchanged');
  else if (result.repair_required) parts.push(`repair required: ${result.repair_action || result.reason || 'repair'}`);
  else parts.push(result.reason || 'no auth artifact');
  return `${parts.join(' - ')}\n`;
}

function writeJson(stdout, payload) {
  stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function valueAfter(argv, index) {
  return argv[index];
}

function isMissing(value) {
  return !value || value.startsWith('--');
}

function missingValue(opts, flag) {
  return { ...opts, error: `${flag} requires a value` };
}

function printUsage(stream = process.stdout) {
  stream.write(`mc tool-auth — cloud tool login hydration and persistence

USAGE
  mc tool-auth hydrate --tool <codex|claude> [--cloud-session-id <cld_id>] [--json]
  mc tool-auth persist --tool <codex|claude> [--cloud-session-id <cld_id>] [--json]

The command reports only readiness metadata. It never prints provider auth JSON,
tokens, refresh tokens, or decrypted vault payloads.
`);
}
