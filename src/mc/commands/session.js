/** Internal server half. Original entrances own all local work, launch and identity decisions. */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { openInWorkArea } from '../work-open.js';
import { deskSessions, readRegister } from '../session-entrance.js';
import { codexSessionDriver } from '../codex-sessions.js';
import { claudeBackgroundDriver } from '../claude-background.js';
import { descriptor, sessionDescriptor, ENTRANCES } from '../server-protocol.js';
import { pidAlive } from '../status-collect.js';
import { chooseProgramme } from './plan.js';

export const usage = () => 'usage — mc session version|list|start|join <entrance> [--json]\nInternal server protocol; use mc server on the client.\n';
export const ROUTES = Object.fromEntries(['version', 'list', 'start', 'join'].map(key => [key, { booleans: ['--json'], check: () => null }]));
class Question extends Error {
  constructor(value) { super('interactive answer required'); this.value = value; }
}

function parse(argv) {
  const [operation, entrance, ...rest] = argv;
  const input = operation === 'version' ? argv.slice(1) : rest;
  const args = []; let json = false; let answers = []; let session = null; let host = null;
  const seen = new Set();
  for (let i = 0; i < input.length; i++) {
    const flag = input[i];
    if (['--json', '--answers', '--session', '--host'].includes(flag)) {
      if (seen.has(flag)) throw new Error(`duplicate ${flag}`);
      seen.add(flag);
      if (flag === '--json') json = true;
      else {
        const value = input[++i];
        if (value === undefined) throw new Error(`${flag} needs a value`);
        if (flag === '--answers') answers = JSON.parse(value); else if (flag === '--host') host = value; else session = value;
      }
    } else args.push(flag);
  }
  if (!Array.isArray(answers) || answers.some(value => typeof value !== 'string')) throw new Error('answers must be strings');
  if (!['version', 'list', 'start', 'join'].includes(operation) || (operation !== 'version' && !ENTRANCES.has(entrance))) throw new Error('unknown session operation or entrance');
  if (args.some(arg => ['--headless', '--intake', '--collect', '--archive', '--local'].includes(arg)) || (entrance === 'martin' && args[0] === 'get')) throw new Error('session accepts interactive entrance flags only');
  if (operation === 'join' && !session) throw new Error('join needs a listed --session id');
  return { operation, entrance, args, json, answers, session, host };
}

export async function run(argv, {
  stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env,
  run = spawnSync, load = name => import(`./${name}.js`),
  open = openInWorkArea, records = readRegister, alive = pidAlive, realpath = realpathSync,
  drivers = { codex: codexSessionDriver, 'claude-code': claudeBackgroundDriver },
} = {}) {
  let request;
  const emit = value => stdout.write(`${JSON.stringify(value)}\n`);
  const messages = [];
  const capture = { write: text => messages.push(text) };
  try {
    request = parse(argv);
    if (request.operation === 'version') { emit(descriptor('handshake')); return 0; }
    let answerIndex = 0;
    const choose = (title, items = null) => {
      const publicItems = items?.map(item => ({ key: item.key, value: typeof item.value === 'symbol' ? '__new_programme__' : item.value,
        name: item.name || item.label, label: item.label || item.name })) ?? null;
      if (answerIndex >= request.answers.length) throw new Question(descriptor('question', { title, items: publicItems }));
      const answer = request.answers[answerIndex++];
      if (!items) return answer;
      const index = publicItems.findIndex(item => item.value === answer);
      if (index < 0) throw new Error('the selected answer was not listed');
      return items[index].value;
    };
    const module = await load(request.entrance);
    let emitted = false;
    const opened = async options => {
      const settings = { ...options, env, isInteractive: () => true, choose, stdout: capture, stderr: capture };
      const mechanics = launch => {
        const provider = launch.id;
        const measured = run(launch.spec.bin, ['--version'], { encoding: 'utf8', env });
        if (measured.status !== 0 || !measured.stdout?.trim()) throw new Error(`${launch.spec.bin} --version: ${measured.error?.message || measured.stderr?.trim() || `exit ${measured.status}`}`);
        const providerVersion = measured.stdout.trim();
        const describe = session => sessionDescriptor({ ...session, ...(provider === 'codex' ? { socket: realpath(session.socket) } : {}) }, provider, providerVersion);
        return { provider, providerVersion, describe };
      };
      return open({ ...settings, platform: 'linux', env: { ...env, SSH_CONNECTION: 'mc-session-protocol' },
        // Only the internal entrance forces persistent mechanics on the server.
        background: async resolved => {
          const { prepareSessionEntrance } = await import('../session-entrance.js');
          const { provider, providerVersion, describe } = mechanics(resolved.launch);
          if (request.operation === 'list') {
            const rows = await drivers[provider]().list(resolved);
            const sessions = deskSessions(resolved, rows, records(env), alive).map(describe);
            emit(descriptor('snapshot', { provider, providerVersion, chosen: resolved.chosen?.id || null, sessions }));
            emitted = true;
            return { result: { ok: true, code: 0 } };
          }
          let attaching;
          const attach = async (_bin, _args) => {
            if (!request.json) return run(_bin, _args, { stdio: 'inherit', env });
            emit(describe(attaching)); emitted = true;
            // EOF is a lost connection. Only an explicit end message authorizes
            // the existing driver's clean-idle end rule and client accounting.
            let clean = false;
            const lines = createInterface({ input: stdin });
            for await (const line of lines) { if (line === 'end') clean = true; }
            return { status: clean ? 0 : 1, signal: null };
          };
          const driver = drivers[provider](provider === 'codex' ? { run: attach } : {});
          const join = driver.join;
          driver.join = async (opts, row) => {
            attaching = row;
            if (request.json && provider !== 'codex') throw new Error('Claude requires ssh -t, not a local Claude client');
            return join(opts, row);
          };
          if (request.operation === 'join') {
            const rows = await driver.list(resolved);
            const row = deskSessions(resolved, rows, records(env), alive).find(item => item.id === request.session);
            if (!row) return { result: { ok: false, reason: `session ${request.session} is not running for this desk` } };
            if (resolved.chosen && row.sessionId !== resolved.chosen.id) return { result: { ok: false, reason: 'listed session does not hold the selected conversation' } };
            return prepareSessionEntrance({ ...resolved, pick: null, chosen: null }, driver, { choose: () => row.id });
          }
          const prepared = await prepareSessionEntrance({ ...resolved, pick: 'new' }, driver);
          if (provider === 'codex' && prepared.start) {
            const start = prepared.start;
            prepared.start = plan => {
              if (plan.args.at(-1) && !plan.chosen && options.prompt) return { ok: false, reason: 'remote Codex opening-prompt delivery has no approved wire contract; no session was started' };
              return start(plan);
            };
          }
          return prepared;
        } });
    };
    const status = await module.run(request.args, { env, stdout: capture, stderr: capture, interactive: () => true,
      choose: options => chooseProgramme({ ...options, choose, question: title => choose(title) }), open: opened });
    if (!emitted) {
      if (status !== 0) throw new Error(messages.join('').trim().replace(/^mc: /u, '') || `entrance exited ${status}`);
      if (request.json) emit(descriptor('result', { status: 0, signal: null }));
    }
    return status;
  } catch (error) {
    if (error instanceof Question) { emit(error.value); return 0; }
    if (request?.json || argv.includes('--json')) emit(descriptor('refusal', { reason: error.message }));
    else stderr.write(`mc: ${request?.host ? `on ${request.host}: ` : ''}${error.message}\n`);
    return 1;
  }
}
