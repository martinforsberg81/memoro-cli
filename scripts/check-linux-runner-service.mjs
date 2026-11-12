#!/usr/bin/env node
/** Opt-in real Linux integration; never runs an agent, Git/network or host chores. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const opts = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--scratch', '--output'].includes(key) || !process.argv[i + 1] || opts[key]) throw new Error('usage: check-linux-runner-service.mjs --scratch <unused-absolute-dir> --output <absolute-report.json>');
  opts[key] = process.argv[i + 1];
}
if (!isAbsolute(opts['--scratch'] || '') || !isAbsolute(opts['--output'] || '')) throw new Error('scratch and output must be absolute paths');
if (process.platform !== 'linux') throw new Error('requires Linux with a running user systemd manager');
const scratch = resolve(opts['--scratch']);
const output = resolve(opts['--output']);
if (existsSync(scratch) || existsSync(output)) throw new Error('scratch and output must be unused paths');
if ([process.env.MC_WORK_ROOT, join(process.env.HOME, 'mc'), join(process.env.HOME, '.memoro/mc'), tmpdir(), '/'].filter(Boolean).map(resolvePath).includes(scratch)) throw new Error('refusing default/unsafe work root');
if (output === scratch || output.startsWith(`${scratch}/`)) throw new Error('output must be outside scratch');
function resolvePath(value) { return resolve(value); }
mkdirSync(scratch, { mode: 0o700 });
const source = process.cwd();
const roots = [];
const scopes = new Set();
const units = new Map();
const owners = new Map();
const children = [];
const start = performance.now();
const report = {
  schema: 2, source: { sha: process.env.MC_LINUX_SOURCE_SHA || null }, versions: { node: process.version },
  roots, commands: [], units: [], owners: [], assertions: [], cleanup: { complete: false, errors: [] },
  proofBoundary: 'Real delivered command dispatch, runLoop admission/reservations, start/update/stop, files/processes/flock and systemd unit/scope/cgroups. Only external coding/Git/network/chores inputs are inert. Held chores keep lane-less drainers alive; held coding-session completion and lane-policy/STOP-claim races are deterministic gate proof, not claimed live workloads. No lingering change, reboot, credentials or provider turn.',
};
function check(name, ok, detail = '') {
  report.assertions.push({ name, ok: Boolean(ok), detail, elapsedMs: performance.now() - start });
  if (!ok) throw new Error(`assertion failed: ${name}: ${detail}`);
}
function command(bin, argv, { env, allowFailure = false } = {}) {
  const t = performance.now();
  const result = spawnSync(bin, argv, { encoding: 'utf8', env, timeout: 30000 });
  report.commands.push({ argv: [bin, ...argv], status: result.status, milliseconds: performance.now() - t, stdout: result.stdout, stderr: result.stderr });
  if (!allowFailure && result.status !== 0) throw new Error(`${bin}: ${result.stderr || result.error || result.status}`);
  return result;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn, ms = 12000) {
  const end = Date.now() + ms;
  do { if (fn()) return true; await sleep(40); } while (Date.now() < end);
  return Boolean(fn());
}
function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function text(path) { try { return readFileSync(path, 'utf8'); } catch { return ''; } }
function alive(pid) {
  // A zombie cannot schedule work; kill(0) alone would call it live forever.
  const stat = text(`/proc/${pid}/stat`);
  return Boolean(stat) && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
}
function track(owner) {
  if (owner?.pid) owners.set(owner.pid, owner);
  for (const item of [...(owner?.drainers || []), ...(owner?.predecessor ? [owner.predecessor] : [])]) owners.set(item.pid, item);
  return owner;
}
function owner(root) { return track(json(join(root.work, 'runner/runner.json'))); }
function manifest() {
  const files = [];
  const walk = (dir) => { for (const item of readdirSync(join(source, dir), { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) walk(path);
    else if (item.isFile()) files.push(path);
  } };
  walk('src'); walk('scripts'); files.push('package.json', 'package-lock.json');
  const entries = files.sort().map((p) => `${createHash('sha256').update(readFileSync(join(source, p))).digest('hex')}  ${p}`);
  return { files: entries, sha256: createHash('sha256').update(entries.join('\n')).digest('hex') };
}
function makeRoot(name) {
  const base = join(scratch, name);
  const root = { base, work: join(base, 'root "$literal%"'), home: join(base, 'mc home'), repos: join(base, 'repos') };
  for (const path of Object.values(root)) mkdirSync(path, { recursive: true });
  root.env = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
    PATH: `/home/martin/.local/bin:/usr/bin:/bin:${base}/tool$path%`,
    MC_HOME: root.home, MC_WORK_ROOT: root.work, MC_REPOS_HOME: root.repos,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`,
  };
  roots.push(root);
  return root;
}
const primary = makeRoot('primary');
// Isolate before importing any mc code, including transitive imports.
Object.assign(process.env, primary.env, { MC_SCRATCH: join(scratch, 'sessions') });
delete process.env.MC_RUN_SYSTEMD_CONTEXT;
delete process.env.MC_RUN_RESERVED_GENERATION;
delete process.env.MC_RUN_SUCCESSOR_OF;
const fixtureEntry = join(scratch, 'entry "$code%".mjs');
const url = (p) => pathToFileURL(join(source, p)).href;
// This entry uses the delivered command router, controller and runLoop. The
// substitutions are external inputs only; no runner/control/gate is replaced.
writeFileSync(fixtureEntry, `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from ${JSON.stringify(url('src/mc/commands/run.js'))};
import { realControlDeps } from ${JSON.stringify(url('src/mc/run-control.js'))};
import { realDeps, runLoop } from ${JSON.stringify(url('src/mc/run.js'))};
const env = process.env;
const root = env.MC_WORK_ROOT;
mkdirSync(join(root, 'observed'), { recursive: true });
writeFileSync(join(root, 'observed', process.pid + '.json'), JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(['HOME','PATH','MC_HOME','MC_WORK_ROOT','MC_REPOS_HOME'].map(k => [k, env[k]])) }));
const deps = realDeps(env);
Object.assign(deps, {
  git: () => ({ ok: true, stdout: '', stderr: '' }), gh: () => ({ ok: true, stdout: '[]' }),
  session: () => { throw new Error('no coding turn authorized'); }, helperTurn: () => { throw new Error('no helper turn authorized'); },
  collect: async () => { writeFileSync(join(root, 'holding-' + process.pid), 'inert chore in flight'); while (!existsSync(join(root, 'release-' + process.pid))) await new Promise(r => setTimeout(r, 40)); return null; },
  nightlyTick: async () => ({ runs: [] }), readDeps: undefined, tidy: undefined,
  reapDevServers: undefined, dockerSweep: undefined, refreshCodex: undefined, refreshClaude: undefined,
  pressureTidy: undefined, pressureDocker: undefined,
  sleep: async ms => new Promise(r => setTimeout(r, Math.min(ms, 40))),
});
process.exitCode = await run(process.argv.slice(3), { control: realControlDeps(env), loop: options => runLoop({ ...options, deps }) });
`, { mode: 0o600 });
function cli(root, argv, allowFailure = false) {
  return command(process.execPath, [fixtureEntry, 'run', ...argv], { env: root.env, allowFailure });
}
function concurrentCli(root, argv) {
  const t = performance.now();
  const child = spawn(process.execPath, [fixtureEntry, 'run', ...argv], { env: root.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  return new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', status => {
      report.commands.push({ argv: [process.execPath, fixtureEntry, 'run', ...argv], status, stdout, stderr, milliseconds: performance.now() - t });
      done({ status, stdout, stderr });
    });
  });
}
let readIdentity;
try {
  report.source.manifest = manifest();
  report.source.shaKind = report.source.sha ? 'exported committed git revision' : 'manifest only';
  report.versions.systemd = command('systemctl', ['--version']).stdout.split('\n')[0];
  report.versions.flock = command('flock', ['--version']).stdout.trim();
  command('systemctl', ['--user', 'show-environment']);
  const service = await import(url('src/mc/linux-runner-service.js'));
  readIdentity = service.readLinuxIdentity;
  const { realControlDeps, stopRunner } = await import(url('src/mc/run-control.js'));
  function registerUnit(root) {
    const generated = service.bootUnit({ root: root.work, execPath: process.execPath, entry: fixtureEntry, env: root.env });
    const path = join(process.env.HOME, '.config/systemd/user', generated.unit);
    if (existsSync(path)) throw new Error(`refusing pre-existing unit ${path}`);
    units.set(generated.unit, path);
    const result = service.installBootAdapter({ root: root.work, execPath: process.execPath, entry: fixtureEntry, deps: service.realLinuxServiceDeps(root.env) });
    report.units.push({ ...result });
    check(`${root.base}: adapter installed and enable-only`, result.ok && existsSync(path) && command('systemctl', ['--user', 'is-enabled', generated.unit]).stdout.trim() === 'enabled', result.lines.join('; '));
    check(`${root.base}: truthful lingering outcome`, result.ready || result.lines.some(l => /Linger=no.*loginctl enable-linger/.test(l)), result.lines.join('; '));
    command('systemd-analyze', ['--user', 'verify', path]);
    return generated.unit;
  }
  const unit = registerUnit(primary);
  async function boot(root, unitName) {
    command('systemctl', ['--user', 'stop', unitName]);
    const before = readdirSync(join(root.work, 'observed'), { recursive: false });
    command('systemctl', ['--user', 'start', unitName]);
    const seen = readdirSync(join(root.work, 'observed')).filter(p => !before.includes(p)).map(p => json(join(root.work, 'observed', p)));
    const received = seen.find(p => p.argv.includes('--if-was-running'));
    check('generated boot entry actually ran with exact literal allowlisted environment', received && Object.entries(received.env).every(([k,v]) => v === root.env[k]), JSON.stringify(received));
  }
  mkdirSync(join(primary.work, 'observed'), { recursive: true });
  await boot(primary, unit);
  check('actual generated boot unit with no history admits no owner', !owner(primary));
  mkdirSync(join(primary.work, 'runner'), { recursive: true });
  writeFileSync(join(primary.work, 'runner/STOP'), 'deliberate stop');
  await boot(primary, unit);
  check('actual generated boot unit never consumes STOP', !owner(primary) && text(join(primary.work, 'runner/STOP')) === 'deliberate stop');
  rmSync(join(primary.work, 'runner/STOP'));
  const flags = ['--no-merge', '--no-caffeinate', '--idle-sleep', '1'];
  writeFileSync(join(primary.work, 'runner/runner.json'), JSON.stringify({ pid: 2147483647, generation: 'prior-boot', bootId: 'old-boot', starttime: '1', args: flags }));
  await boot(primary, unit);
  check('conditional boot restores saved flags through real runLoop admission', await until(() => owner(primary)?.takeover && text(join(primary.work, 'runner/log/runner.log')).includes('runner start')), JSON.stringify(owner(primary)));
  const bootOwner = owner(primary);
  check('saved flags survived child reservation claim', JSON.stringify(bootOwner.args) === JSON.stringify(flags));
  const bootCgroup = command('systemctl', ['--user', 'show', unit, '--property=ControlGroup', '--value']).stdout.trim();
  check('boot child survives oneshot command exit in its cgroup', alive(bootOwner.pid) && Boolean(bootCgroup) && text(`/proc/${bootOwner.pid}/cgroup`).includes(bootCgroup));
  const observedEnv = json(join(primary.work, 'observed', `${bootOwner.pid}.json`));
  check('boot runner receives literal dollar/percent paths unchanged', observedEnv && observedEnv.env.PATH === primary.env.PATH && observedEnv.env.MC_WORK_ROOT === primary.work, JSON.stringify(observedEnv));
  const stopBoot = await stopRunner({ force: true, root: primary.work, deps: realControlDeps(primary.env) });
  check('real force stop ends boot child', stopBoot.ok && !alive(bootOwner.pid), stopBoot.lines.join('; '));
  command('systemctl', ['--user', 'stop', unit]);

  // Interprocess exclusion, not two synchronous callbacks on one event loop.
  const gateClient = join(scratch, 'gate-client.mjs');
  writeFileSync(gateClient, `import { existsSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { withLifecycleLock } from ${JSON.stringify(url('src/mc/linux-runner-service.js'))};
const [root, barrier, label] = process.argv.slice(2);
while (!existsSync(barrier)) await new Promise(r => setTimeout(r, 10));
await withLifecycleLock(root, () => { const active = barrier + '.active'; const overlap = existsSync(active); if (!overlap) writeFileSync(active, label); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,180); appendFileSync(barrier + '.events', label + ':' + overlap + '\\n'); if (!overlap) rmSync(active); });`);
  const barrier = join(scratch, 'gate-go');
  const gateDone = ['a','b','c'].map(label => new Promise((done, reject) => {
    const child = spawn(process.execPath, [gateClient, primary.work, barrier, label], { env: primary.env, stdio: 'pipe' }); children.push(child);
    report.commands.push({ argv: [process.execPath, gateClient, primary.work, barrier, label] });
    child.once('error', reject); child.once('close', status => done(status));
  }));
  writeFileSync(barrier, 'go');
  const statuses = await Promise.all(gateDone);
  const events = text(`${barrier}.events`).trim().split('\n').sort();
  check('delivered flock gate excludes three independent processes', statuses.every(s => s === 0) && JSON.stringify(events) === JSON.stringify(['a:false','b:false','c:false']), JSON.stringify({ statuses, events }));

  const compete = makeRoot('compete');
  registerUnit(compete);
  const results = await Promise.all([concurrentCli(compete, ['start', ...flags]), concurrentCli(compete, ['start', ...flags])]);
  check('competing starts on an available root yield exactly one successful owner', results.filter(r => r.status === 0).length === 1, JSON.stringify(results));
  check('winning parent reservation was claimed by delivered runLoop', await until(() => owner(compete)?.takeover && existsSync(join(compete.work, `holding-${owner(compete).pid}`))));
  const a = owner(compete);
  check('direct --once refuses the live winner rather than admitting new work', cli(compete, ['--once'], true).status === 2);
  const scopesText = command('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', `mc-runner-start-${service.rootIdentity(compete.work).hash}-*.scope`]).stdout;
  for (const line of scopesText.trim().split('\n')) { const name = line.trim().split(/\s+/)[0]; if (name?.endsWith('.scope')) scopes.add(name); }
  const cg = text(`/proc/${a.pid}/cgroup`);
  check('detached admitted child survives its scoped control parent', alive(a.pid) && [...scopes].some(s => cg.includes(s)), cg);
  const independent = makeRoot('independent');
  registerUnit(independent);
  cli(independent, ['start', ...flags]);
  check('second isolated root has a real admitted owner', await until(() => owner(independent)?.takeover));
  const otherBeforeUpdate = owner(independent);
  const independentCgroup = text(`/proc/${otherBeforeUpdate.pid}/cgroup`);
  cli(independent, ['--update', '--force']);
  check('independent-root update admits a real successor beside its predecessor', await until(() => owner(independent)?.pid !== otherBeforeUpdate.pid && owner(independent)?.takeover));
  const other = owner(independent);
  writeFileSync(join(independent.work, `release-${otherBeforeUpdate.pid}`), 'complete');
  check('update successor survives predecessor exit in its inherited cgroup', await until(() => !alive(otherBeforeUpdate.pid)) && alive(other.pid) && text(`/proc/${other.pid}/cgroup`) === independentCgroup);
  const otherBefore = text(join(independent.work, 'runner/runner.json'));
  const otherCg = text(`/proc/${other.pid}/cgroup`);
  for (const line of otherCg.split('\n')) { const scope = line.split('/').find(x => x.startsWith('mc-runner-start-') && x.endsWith('.scope')); if (scope) scopes.add(scope); }

  cli(compete, ['--update', '--force']);
  check('real UPDATE produces admitted B while A is still draining', await until(() => owner(compete)?.pid !== a.pid && owner(compete)?.takeover && alive(a.pid) && existsSync(join(compete.work, `holding-${owner(compete).pid}`))));
  const b = owner(compete);
  cli(compete, ['--update', '--force']);
  check('second real UPDATE produces admitted C with live A and B', await until(() => owner(compete)?.pid !== b.pid && owner(compete)?.takeover && alive(a.pid) && alive(b.pid) && existsSync(join(compete.work, `holding-${owner(compete).pid}`))));
  const c = owner(compete);
  check('A-to-B-to-C retains complete named live drainer identities with no lane file', [a,b].every(p => c.drainers.some(d => d.pid === p.pid && d.generation === p.generation)) && !readdirSync(join(compete.work, 'runner')).some(n => n.startsWith('current-')), JSON.stringify(c));
  check('all admitted successors inherited the original managed cgroup', [a,b,c].every(p => text(`/proc/${p.pid}/cgroup`) === cg), JSON.stringify([a,b,c].map(p => p.pid)));
  const stopping = await stopRunner({ root: compete.work, deps: realControlDeps(compete.env) });
  check('ordinary STOP preserves all live draining work before release', stopping.ok && [a,b,c].every(p => alive(p.pid)), stopping.lines.join('; '));
  const forced = await stopRunner({ force: true, root: compete.work, deps: realControlDeps(compete.env) });
  check('force stop targets every live A/B/C owner in the full chain', forced.ok && [a,b,c].every(p => !alive(p.pid)) && [a,b,c].every(p => forced.lines.some(l => l.includes(`pid ${p.pid} is gone`))), forced.lines.join('; '));
  check('another live root survives all first-root stop/cleanup unchanged', alive(other.pid) && text(join(independent.work, 'runner/runner.json')) === otherBefore && text(`/proc/${other.pid}/cgroup`) === otherCg && !existsSync(join(independent.work, 'runner/STOP')));
  report.owners = [...owners.values()];
} catch (error) {
  report.error = error.stack || String(error);
} finally {
  // Rediscover only these roots' named processes/scopes, including on failure.
  for (const root of roots) {
    owner(root);
    root.runnerLog = text(join(root.work, 'runner/log/runner.log'));
    root.finalOwner = json(join(root.work, 'runner/runner.json'));
    for (const name of (existsSync(join(root.work, 'observed')) ? readdirSync(join(root.work, 'observed')) : [])) {
      const pid = Number(name.replace('.json',''));
      if (!alive(pid)) continue;
      const identity = readIdentity?.(pid);
      if (identity) owners.set(pid, { pid, ...identity });
      for (const part of text(`/proc/${pid}/cgroup`).split('/')) {
        const name = part.trim();
        if (name.startsWith('mc-runner-start-') && name.endsWith('.scope')) scopes.add(name);
      }
    }
  }
  const errors = [];
  for (const [unit, path] of units) {
    const stopped = command('systemctl', ['--user', 'stop', unit], { allowFailure: true });
    const disabled = command('systemctl', ['--user', 'disable', unit], { allowFailure: true });
    if (stopped.status !== 0 || disabled.status !== 0) errors.push(`unit cleanup failed: ${unit}`);
    rmSync(path, { force: true });
  }
  for (const scope of scopes) command('systemctl', ['--user', 'stop', scope], { allowFailure: true });
  for (const record of owners.values()) {
    const identity = readIdentity?.(record.pid);
    if (alive(record.pid) && identity?.bootId === record.bootId && identity?.starttime === record.starttime) {
      try { process.kill(record.pid, 'SIGKILL'); } catch {}
    }
  }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await until(() => [...owners.values()].every(p => !alive(p.pid)), 5000);
  const reload = command('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
  if (reload.status !== 0) errors.push('cleanup daemon-reload failed');
  for (const p of owners.values()) if (alive(p.pid)) errors.push(`process remains: ${p.pid}`);
  for (const [unit, path] of units) {
    if (existsSync(path) || existsSync(join(dirname(path), 'default.target.wants', unit))) errors.push(`unit/link remains: ${unit}`);
    if (command('systemctl', ['--user', 'is-active', unit], { allowFailure: true }).status === 0) errors.push(`unit active: ${unit}`);
  }
  for (const scope of scopes) if (command('systemctl', ['--user', 'is-active', scope], { allowFailure: true }).status === 0) errors.push(`scope active: ${scope}`);
  rmSync(scratch, { recursive: true, force: true });
  if (existsSync(scratch)) errors.push('scratch remains');
  report.cleanup = { complete: errors.length === 0, errors, units: [...units.keys()], scopes: [...scopes], owners: [...owners.values()] };
  report.milliseconds = performance.now() - start;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
if (report.error || !report.cleanup.complete || report.assertions.some(a => !a.ok)) {
  process.stderr.write(`${report.error || JSON.stringify(report.cleanup)}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Linux runner service check passed — ${report.assertions.length} assertions, ${report.milliseconds.toFixed(0)} ms; report ${output}\n`);
