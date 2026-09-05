/**
 * `mc dev` — the three words memoro's dev-server wrapper speaks.
 *
 *   mc dev list [--json]                    what is running, and where
 *   mc dev register <manifest> [--json]     take a copy of a wrapper's manifest
 *   mc dev unregister <manifest> [--json]   forget it
 *
 * Three, and not the thirteen-verb session manager `mc-cut` removed on
 * 2026-09-03. `ensure`, `plan`, `status`, `logs`, `stop` and `restart` are not
 * coming back with them: the month of `mc.log` that decided this recorded ten
 * human invocations of `mc dev` in total, six of them `ensure`, and the verb
 * that starts a server for a session is `mc test dev`, which is a different
 * question with a different answer. mc holds the index; the project's own
 * wrapper stays authoritative for how a server starts, stops and becomes
 * healthy (`docs/dev-server-protocol.md`).
 *
 * `list` is a capability probe as much as a listing, and that is why it is
 * first: `invokeMcDev` runs `mc dev list --json` before every register and
 * unregister to find out whether the installed mc speaks the protocol at all.
 * It replaced a grep of `--help` text, which broke the day the help was
 * rewritten. So this exits 0 and prints JSON on an empty machine — an empty
 * inventory and a missing verb must not look the same to a caller.
 *
 * The reason a verb `mc-cut` deleted is back at all: it has a reader now.
 * See `dev-servers.js`, which carries that argument and the numbers behind it.
 */
import { devServersRoot } from '../paths.js';
import { listServers, registerManifest, unregisterManifest } from '../dev-servers.js';
import { scanArgs } from './flags.js';

const VERBS = ['list', 'register', 'unregister'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const root = deps.root || devServersRoot();

  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }

  if (opts.verb === 'list') return list(opts, { stdout, root });
  if (opts.verb === 'register') return register(opts, { stdout, stderr, root });
  return unregister(opts, { stdout, stderr, root });
}

/**
 * What is running.
 *
 * The sweep happens here rather than on a timer because this is the only verb
 * that reads the whole directory, and a reader is the right moment to notice
 * that a pid is gone. `reaped` is reported rather than done quietly: a caller
 * that asked what was running deserves to know the answer changed while it
 * asked.
 */
function list(opts, { stdout, root }) {
  const { servers, reaped } = listServers({ root });
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      schema_version: 1, root, servers, reaped,
    }, null, 2)}\n`);
    return 0;
  }
  if (!servers.length) {
    stdout.write('mc: no dev server is registered\n');
  }
  for (const server of servers) {
    stdout.write(`${server.instance_id}  ${server.url}  ${server.session_name}  ${server.worktree_path}\n`);
  }
  if (reaped.length) {
    stdout.write(`mc: swept ${reaped.length} registration${reaped.length === 1 ? '' : 's'} whose process is gone\n`);
  }
  return 0;
}

function register(opts, { stdout, stderr, root }) {
  const result = registerManifest(opts.manifest, { root });
  if (opts.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    stderr.write(`mc: ${result.error}\n`);
    return 1;
  }
  stdout.write(`mc: registered ${result.instance_id}\n`);
  return 0;
}

function unregister(opts, { stdout, stderr, root }) {
  const result = unregisterManifest(opts.manifest, { root });
  if (opts.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (!result.ok) {
    stderr.write(`mc: ${result.error}\n`);
    return 1;
  }
  stdout.write(result.removed
    ? `mc: unregistered ${result.instance_id}\n`
    : 'mc: nothing was registered for that manifest\n');
  return 0;
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json'] });
  const opts = { verb: 'list', json: scanned.flags.json, manifest: null };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];
  // Bare `mc dev` is the question the wrapper asks: what is running.
  const word = positional.shift() || 'list';
  if (!VERBS.includes(word)) return { ...opts, error: `mc dev ${word}? — ${VERBS.join(', ')}` };
  opts.verb = word;

  if (word === 'list') {
    if (positional.length) return { ...opts, error: `mc dev list takes no argument (${positional[0]})` };
    return opts;
  }
  const manifest = positional.shift();
  if (!manifest) return { ...opts, error: `mc dev ${word} needs the path of the manifest the wrapper wrote` };
  if (positional.length) return { ...opts, error: `mc dev ${word} takes one manifest (${positional[0]})` };
  opts.manifest = manifest;
  return opts;
}

export function usage() {
  return [
    'usage — mc dev list [--json]                  what is running, and where\n',
    '        mc dev register <manifest> [--json]   take a copy of it\n',
    '        mc dev unregister <manifest> [--json] forget it\n',
  ].join('');
}
