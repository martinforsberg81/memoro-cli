import { openBrowser } from '../lib/device-flow.js';
import { createConnectionClient } from '../capabilities/connections/client.js';

export async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  if (opts.error) { stderr.write(`mc: ${opts.error}\n`); return 2; }
  const client = deps.connectionClient || createConnectionClient(deps);
  try {
    if (opts.verb === 'list') {
      const connections = [];
      for (const provider of client.providers()) {
        try { connections.push(await client.status(provider.id)); }
        catch { connections.push(unavailable(provider)); }
      }
      return emit({ ok: true, connections }, opts, stdout);
    }
    if (opts.verb === 'status') {
      const descriptor = await client.status(opts.provider);
      emit({ ok: true, connection: descriptor }, opts, stdout);
      return descriptor.state === 'ready' ? 0 : 1;
    }
    if (opts.verb === 'disconnect' && !opts.confirm) {
      const preview = {
        ok: true,
        effect: 'provider_connection_revoke',
        provider: opts.provider,
        requires_confirmation: true,
        command: `mc connections disconnect ${opts.provider} --confirm`,
      };
      if (opts.json) stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      else {
        stdout.write(`Disconnecting ${opts.provider} revokes the provider connection for this Memoro user.\n`);
        stdout.write(`To continue, run: ${preview.command}\n`);
      }
      return 1;
    }
    const result = await client[opts.verb](opts.provider);
    if (opts.verb === 'connect' || (opts.verb === 'repair' && result?.result)) {
      const connect = opts.verb === 'connect' ? result : result.result;
      const interactive = deps.isInteractive
        ?? Boolean((deps.stdin || process.stdin)?.isTTY && stdout?.isTTY);
      if (!opts.json && interactive && connect?.connect_url
          && await (deps.openBrowser || openBrowser)(connect.connect_url)) {
        stdout.write(`Opened the ${opts.provider} connection flow. Re-run \`mc connections status ${opts.provider}\` when complete.\n`);
        return 0;
      }
      if (!opts.json && connect?.connect_url) {
        stdout.write(`Open this URL to connect ${opts.provider} through Memoro:\n${connect.connect_url}\n`);
        return 0;
      }
    }
    return emit({ ok: true, result }, opts, stdout);
  } catch {
    const failure = { ok: false, error: { code: 'unavailable', message: 'Connection operation is unavailable.', repair_action: 'retry' } };
    if (opts.json) stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    else stderr.write(`mc: connection operation is unavailable. Run \`mc connections status ${opts.provider}\`.\n`);
    return 1;
  }
}

export function parseArgs(argv) {
  const values = [...argv];
  let verb = values[0] || 'list';
  if (verb.startsWith('-')) verb = 'list'; else values.shift();
  if (!['list', 'status', 'connect', 'repair', 'disconnect'].includes(verb)) return { error: `unknown connections subcommand "${verb}"` };
  let provider = null;
  if (verb !== 'list') provider = values.shift() || null;
  let json = false;
  let confirm = false;
  for (const value of values) {
    if (value === '--json') json = true;
    else if (value === '--confirm' && verb === 'disconnect') confirm = true;
    else return { error: `unknown flag: ${value}` };
  }
  if (verb !== 'list' && !provider) return { error: `${verb} requires a provider` };
  return { verb, provider, json, confirm };
}

function emit(value, opts, stdout) {
  if (opts.json) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else {
    const rows = value.connections || [value.connection].filter(Boolean);
    for (const item of rows) stdout.write(`${item.provider.label}: ${item.state}${item.repair_action ? ` · repair: mc connections ${item.repair_action === 'retry' ? 'status' : 'repair'} ${item.provider.id}` : ''}\n`);
  }
  return 0;
}

function unavailable(provider) {
  return {
    schema: 1, provider, state: 'unavailable', repair_action: 'retry',
    account: null, resources: [], sources: { local: 'unavailable', cloud: 'unavailable' }, capabilities: [],
  };
}
