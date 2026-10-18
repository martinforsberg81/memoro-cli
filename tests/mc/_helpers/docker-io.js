/**
 * The machine the container-runtime tests run against. `orbctl` and `docker`
 * answer from a table keyed by the command line; the clock moves only when
 * `sleep` is called; and the Docker config names `context`.
 *
 * A call with no answer is status 1 with a stderr line that names it, so a
 * test that forgets an answer fails on that line rather than on a guess.
 */
export const INFO = 'docker info --format {{.ServerVersion}}';

export function fakeIo({ answers = {}, live = [], context = 'orbstack' } = {}) {
  const calls = [];
  const logged = [];
  const used = new Map();
  let clock = Date.parse('2026-10-18T12:00:00Z');
  const io = {
    run: async (tool, args, opts = {}) => {
      calls.push({ argv: [tool, ...args], timeoutMs: opts.timeoutMs });
      const key = [tool, ...args].join(' ');
      const answer = answers[key];
      if (!Array.isArray(answer)) return answer ?? { status: 1, stderr: `no answer for ${key}\n` };
      const index = used.get(key) ?? 0;
      used.set(key, index + 1);
      return answer[Math.min(index, answer.length - 1)];
    },
    readFile: (path) => {
      if (path === '/home/u/.docker/config.json') return JSON.stringify({ currentContext: context });
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    },
    home: '/home/u',
    alive: (pid) => live.includes(pid),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    platform: 'darwin',
    log: (event, fields) => { logged.push({ event, ...fields }); },
  };
  return { io, calls, logged };
}
