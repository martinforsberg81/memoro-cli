/** This computer's optional interactive-session destination. */
import { commandUsage } from '../command-help.js';
import { clearServer, readServer, saveServer, serverLink } from '../server-link.js';

export const ROUTES = {
  '': { check: ({ positional }) => positional.length ? 'unexpected argument' : null },
  set: { check: ({ positional }) => positional.length === 1 ? null : 'set needs one SSH destination' },
  clear: { check: ({ positional }) => positional.length ? 'unexpected argument' : null },
};
export const usage = () => commandUsage('server');
export async function run(argv, { env = process.env, io, link = serverLink, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [verb, ...args] = argv;
  if (argv.length && (!['set', 'clear'].includes(verb) || (verb === 'set' ? args.length !== 1 : args.length !== 0))) {
    stderr.write(usage()); return 2;
  }
  try {
    if (verb === 'clear') { clearServer(env, io); stdout.write('mc: server cleared; interactive sessions run here\n'); return 0; }
    const destination = verb === 'set' ? args[0] : readServer(env, io);
    if (!destination) { stdout.write('mc: no server configured; interactive sessions run here\n'); return 0; }
    const measured = await link(destination, { env, io }).handshake();
    if (measured.kind !== 'handshake') throw new Error(`on ${destination}: expected a version handshake, got ${measured.kind}`);
    if (verb === 'set') saveServer(destination, env, io);
    stdout.write(`mc: server ${destination}; mc ${measured.mcVersion}, descriptor v${measured.version}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}
