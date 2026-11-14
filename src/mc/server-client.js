/** Interactive routing before any local programme or desk is read or created. */
import { interactive, select, ask } from './prompt.js';
import { readServer } from './server-settings.js';

const ENTRANCES = new Set(['plan', 'manager', 'brief', 'martin', 'helper']);

export async function routeServerEntrance(entrance, args, {
  env = process.env, isInteractive = interactive, read = readServer, link,
  stdout = process.stdout, stderr = process.stderr, choose = select, question = ask,
} = {}) {
  if (!ENTRANCES.has(entrance) || args.includes('--local') || env.MC_HEADLESS === '1' || !isInteractive(env)
    || args.some(arg => ['--headless', '--intake', '--collect', '--archive', '--help', '-h'].includes(arg))
    || (entrance === 'martin' && args[0] === 'get')) return null;
  try {
    const destination = read(env);
    if (!destination) return null;
    const createLink = link || (await import('./server-link.js')).serverLink;
    return await remoteEntrance(entrance, args, createLink(destination, { env }), { stdout, stderr, choose, question });
  }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}

export async function remoteEntrance(entrance, args, link, { stdout = process.stdout, stderr = process.stderr,
  choose = select, question = ask } = {}) {
  const { prepareSessionEntrance } = await import('./session-entrance.js');
  const answers = [];
  let snapshot;
  for (;;) {
    snapshot = await link.request('list', entrance, args, answers);
    if (snapshot.kind !== 'question') break;
    const answer = snapshot.items ? choose(snapshot.title, snapshot.items, { stdout }) : question(snapshot.title, { stdout });
    if (answer === null || answer === undefined || answer === '') return 0;
    answers.push(answer);
  }
  if (snapshot.kind !== 'snapshot') throw new Error(`on ${link.destination}: expected a session list, got ${snapshot.kind}`);
  let rows = snapshot.sessions;
  let pending = null;
  const driver = {
    // The server has already checked the desk's register and provider process.
    discover: true,
    list: async () => rows,
    start: async () => {
      if (snapshot.provider === 'claude-code') return { ok: true, session: { id: 'remote-start', name: `on ${link.destination}` } };
      pending = await link.connect('start', entrance, args, answers);
      return { ok: true, session: pending.session };
    },
    join: async (_options, session) => {
      const starting = Boolean(pending) || session.id === 'remote-start';
      const forwarded = [...args, ...(!starting ? ['--session', session.id] : [])];
      const result = snapshot.provider === 'claude-code'
        ? link.passthrough(starting ? 'start' : 'join', entrance, forwarded, answers)
        : await link.codexClient(pending || await link.connect('join', entrance, forwarded, answers));
      pending = null;
      const refreshed = await link.request('list', entrance, args, answers);
      if (refreshed.kind !== 'snapshot') throw new Error(`on ${link.destination}: expected a session list after attach`);
      rows = refreshed.sessions;
      return result;
    },
  };
  const { scanArgs } = await import('./commands/flags.js');
  const { flags, positional } = scanArgs(args, { booleans: ['--new', '--resume'], strictValues: ['--model'], toolSugar: true });
  const options = { verb: entrance, programme: entrance === 'plan' ? positional[0] || null : null,
    launch: { id: snapshot.provider }, pick: args.includes('--new') ? 'new' : null,
    chosen: snapshot.chosen ? { id: snapshot.chosen } : null, model: flags.model,
    resumeTool: flags.tool, stdout, stderr };
  const prepared = await prepareSessionEntrance(options, driver, { lock: () => () => {}, alive: () => true, choose });
  try {
    const result = prepared.result || await prepared.start({ chosen: options.chosen });
    if (!result.ok) { stderr.write(`mc: on ${link.destination}: ${result.reason}\n`); return 1; }
    return result.code ?? 0;
  } finally { await prepared.release?.(); }
}
