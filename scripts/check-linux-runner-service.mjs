#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scratch' || argv[i] === '--output') out[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.scratch || !out.output || !isAbsolute(out.scratch) || !isAbsolute(out.output)) {
    throw new Error('usage: check-linux-runner-service.mjs --scratch <unused-absolute-dir> --output <absolute-report.json>');
  }
  return out;
}

const args = options(process.argv.slice(2));
if (process.platform !== 'linux') throw new Error('this integration check requires Linux and a running user systemd manager');
const scratch = resolve(args.scratch);
const output = resolve(args.output);
const priorWorkRoot = process.env.MC_WORK_ROOT || join(process.env.HOME || '', '.memoro', 'mc');
if (existsSync(scratch)) throw new Error(`scratch path already exists: ${scratch}`);
if (scratch === resolve(priorWorkRoot) || scratch === resolve(tmpdir())) throw new Error('refusing a default or unsafe scratch root');
if (output.startsWith(`${scratch}/`)) throw new Error('report output must be outside the scratch tree that is removed after the check');
if (existsSync(output)) throw new Error(`report output already exists: ${output}`);
mkdirSync(scratch, { recursive: false, mode: 0o700 });
const roots = { home: join(scratch, 'home'), work: join(scratch, 'work'), repos: join(scratch, 'repos'), scratch: join(scratch, 'sessions') };
for (const path of Object.values(roots)) mkdirSync(path, { recursive: true, mode: 0o700 });
Object.assign(process.env, { MC_HOME: roots.home, MC_WORK_ROOT: roots.work, MC_REPOS_HOME: roots.repos, MC_SCRATCH: roots.scratch, MC_RUN_SYSTEMD_CONTEXT: 'scope' });

const report = {
  schema: 1, source: { sha: null, shaKind: null, manifest: null }, versions: {}, roots,
  commands: [], units: [], owners: [], assertions: [], cleanup: { complete: false, errors: [] },
  proofBoundary: 'real systemd unit/scope, flock gate, process identity and lifecycle control; session-loop decisions remain deterministic fixture proof, not a provider turn',
};
const unitNames = new Set();
const scopeNames = new Set();
const pids = new Set();
function assertThat(name, ok, detail = '') {
  report.assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`assertion failed: ${name}${detail ? ` — ${detail}` : ''}`);
}
function command(bin, argv, { allowFailure = false } = {}) {
  report.commands.push([bin, ...argv]);
  const result = spawnSync(bin, argv, { encoding: 'utf8', timeout: 30_000 });
  if (!allowFailure && result.status !== 0) throw new Error(`${bin} ${argv.join(' ')} failed: ${result.stderr || result.error || result.status}`);
  return result;
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitUntil(test, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return true; sleep(50); }
  return Boolean(test());
}
function manifest(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (name.isFile()) files.push(path);
    }
  };
  for (const path of ['src', 'scripts']) if (existsSync(join(root, path))) walk(join(root, path));
  for (const path of ['package.json', 'package-lock.json']) if (existsSync(join(root, path))) files.push(join(root, path));
  const entries = files.sort().map((path) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${path.slice(root.length + 1)}`);
  return { sha256: createHash('sha256').update(entries.join('\n')).digest('hex'), files: entries };
}
function workerFile() {
  const path = join(scratch, 'worker.mjs');
  writeFileSync(path, `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nconst pidFile = args.find((x) => x.startsWith('--pid-file='))?.slice(11);\nif (pidFile) { const child = spawn('/bin/sleep', ['600'], { detached: true, stdio: 'ignore' }); child.unref(); writeFileSync(pidFile, String(child.pid)); }\nif (!pidFile) setInterval(() => {}, 60000);\n`, { mode: 0o600 });
  return path;
}

let servicePath = null;
let serviceUnit = null;
try {
  report.versions.node = process.version;
  report.source.manifest = manifest(process.cwd());
  try { report.source.sha = process.env.MC_LINUX_SOURCE_SHA || command('git', ['rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim() || null; } catch { report.source.sha = process.env.MC_LINUX_SOURCE_SHA || null; }
  if (!report.source.sha) report.source.sha = report.source.manifest.sha256;
  report.source.shaKind = process.env.MC_LINUX_SOURCE_SHA ? 'exported git revision' : report.source.sha === report.source.manifest.sha256 ? 'source manifest sha256' : 'git revision';
  report.versions.systemd = command('systemctl', ['--version']).stdout.split('\n')[0];
  command('systemctl', ['--user', 'show-environment']);
  command('flock', ['--version']);
  const { bootUnit, installBootAdapter, scopeCommand, withLifecycleLock, readLinuxIdentity } = await import(pathToFileURL(join(process.cwd(), 'src/mc/linux-runner-service.js')));
  const { startRunner, stopRunner, controlPaths, handOver, IF_WAS_RUNNING } = await import(pathToFileURL(join(process.cwd(), 'src/mc/run-control.js')));
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, MC_HOME: roots.home, MC_WORK_ROOT: roots.work, MC_REPOS_HOME: roots.repos, MC_RUN_SYSTEMD_CONTEXT: 'scope' };
  const unit = bootUnit({ root: roots.work, execPath: process.execPath, entry: workerFile(), env });
  serviceUnit = unit.unit;
  servicePath = join(process.env.HOME, '.config/systemd/user', serviceUnit);
  const installed = installBootAdapter({ root: roots.work, execPath: process.execPath, entry: workerFile() });
  unitNames.add(serviceUnit);
  report.units.push({ name: serviceUnit, path: servicePath, ready: installed.ready, install: installed.lines });
  assertThat('boot unit installed and enabled without manager restart', installed.ok && existsSync(servicePath), installed.lines.join('; '));
  assertThat('Linger=no is reported as not boot ready with an interactive remedy', installed.ready || installed.lines.some((line) => /Linger=no.*loginctl enable-linger/u.test(line)), installed.lines.join('; '));
  command('systemd-analyze', ['--user', 'verify', servicePath]);
  assertThat('systemd-analyze --user verify accepts the delivered unit', true, servicePath);

  let entered = 0;
  const lockPath = join(roots.work, 'runner', 'gate-check');
  mkdirSync(join(roots.work, 'runner'), { recursive: true });
  const eventsPath = join(scratch, 'gate-events');
  writeFileSync(eventsPath, '');
  const transition = (label) => withLifecycleLock(roots.work, () => {
    const active = join(scratch, 'gate-active');
    let overlap = existsSync(active);
    if (!overlap) writeFileSync(active, label, { flag: 'wx' });
    sleep(100);
    if (!overlap) rmSync(active, { force: true });
    writeFileSync(eventsPath, `${readFileSync(eventsPath, 'utf8') || ''}${label}:${overlap ? 'overlap' : 'entered'}\n`);
    entered += 1;
    return overlap;
  });
  const gates = await Promise.all([transition('a'), transition('b')]);
  assertThat('real flock lifecycle gate excludes concurrent transitions', entered === 2 && gates.every((value) => value === false), readFileSync(eventsPath, 'utf8'));
  assertThat('gate uses the separate lifecycle lock path', join(roots.work, 'runner', 'lifecycle.lock') !== join(roots.work, 'runner', 'register.lock'), lockPath);

  const worker = workerFile();
  const scopeRoot = join(scratch, 'scope-root');
  mkdirSync(scopeRoot);
  const pidFile = join(scratch, 'scope-child.pid');
  const scopeArgs = scopeCommand({ root: scopeRoot, execPath: process.execPath, entry: worker, argv: [`--pid-file=${pidFile}`] });
  const scopeName = scopeArgs.find((item) => item.startsWith('--unit='))?.slice(7);
  scopeNames.add(scopeName);
  command('systemd-run', scopeArgs);
  assertThat('scope start returns with its detached child alive', waitUntil(() => existsSync(pidFile)) && existsSync(pidFile), pidFile);
  const childPid = Number(readFileSync(pidFile, 'utf8'));
  pids.add(childPid);
  assertThat('scope child survives its command parent', childPid > 1 && command('kill', ['-0', String(childPid)], { allowFailure: true }).status === 0, String(childPid));
  const scopeCgroup = command('systemctl', ['--user', 'show', scopeName, '--property=ControlGroup', '--value']).stdout.trim();
  const childCgroup = readFileSync(`/proc/${childPid}/cgroup`, 'utf8');
  assertThat('detached successor remains in its managed systemd cgroup', Boolean(scopeCgroup) && childCgroup.includes(scopeCgroup), `${scopeCgroup}\n${childCgroup}`);

  const paths = controlPaths(roots.work);
  const controller = join(scratch, 'runner-controller.mjs');
  const resultFile = join(scratch, 'runner-controller-result.json');
  const controlUrl = pathToFileURL(join(process.cwd(), 'src/mc/run-control.js')).href;
  writeFileSync(controller, `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst { realControlDeps, startRunner, handOver, controlPaths } = await import(${JSON.stringify(controlUrl)});\nconst root = process.env.MC_WORK_ROOT;\nconst worker = ${JSON.stringify(worker)};\nconst deps = realControlDeps(process.env);\ndeps.entry = worker;\nconst started = await startRunner({ root, deps });\nif (!started.ok) throw new Error(started.lines.join('; '));\nconst paths = controlPaths(root);\nconst owner = JSON.parse(deps.read(paths.runner));\ndeps.respawn = ({ env = {} } = {}) => { const child = spawn(process.execPath, [worker, 'run', 'start'], { detached: true, stdio: 'ignore', env: { ...process.env, ...env } }); child.unref(); return child.pid; };\nconst handed = await handOver({ paths, deps, say: () => {}, predecessor: owner.pid, predecessorGeneration: owner.generation });\nif (!handed.ok) throw new Error(handed.why || 'update handover failed');\nwriteFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ predecessor: owner.pid, successor: handed.pid }));\n`, { mode: 0o600 });
  const runnerScopeArgs = scopeCommand({ root: roots.work, execPath: process.execPath, entry: controller, argv: [] });
  const runnerScope = runnerScopeArgs.find((item) => item.startsWith('--unit='))?.slice(7);
  scopeNames.add(runnerScope);
  command('systemd-run', runnerScopeArgs);
  assertThat('scoped mc start and update publish two real owners', waitUntil(() => existsSync(resultFile)) && existsSync(paths.runner), resultFile);
  const controllerResult = JSON.parse(readFileSync(resultFile, 'utf8'));
  let current = JSON.parse(readFileSync(paths.runner, 'utf8'));
  const predecessorPid = controllerResult.predecessor;
  const successorPid = controllerResult.successor;
  pids.add(predecessorPid); pids.add(successorPid);
  assertThat('real successor update publishes predecessor and complete drainer identity', current.pid === successorPid && current.predecessor.pid === predecessorPid && current.drainers.some((item) => item.pid === predecessorPid && item.generation), JSON.stringify(current.drainers));
  const runnerCgroup = command('systemctl', ['--user', 'show', runnerScope, '--property=ControlGroup', '--value']).stdout.trim();
  const predecessorCgroup = readFileSync(`/proc/${predecessorPid}/cgroup`, 'utf8');
  const successorCgroup = readFileSync(`/proc/${successorPid}/cgroup`, 'utf8');
  assertThat('successor inherited the managed cgroup before predecessor exit', predecessorCgroup.includes(runnerCgroup) && successorCgroup.includes(runnerCgroup), `${runnerCgroup}\n${predecessorCgroup}\n${successorCgroup}`);
  try { process.kill(predecessorPid, 'SIGTERM'); } catch {}
  assertThat('successor remains alive in the same scope after predecessor exit', waitUntil(() => command('kill', ['-0', String(predecessorPid)], { allowFailure: true }).status !== 0) && command('kill', ['-0', String(successorPid)], { allowFailure: true }).status === 0 && readFileSync(`/proc/${successorPid}/cgroup`, 'utf8').includes(runnerCgroup), String(successorPid));
  report.owners.push({ pid: predecessorPid, generation: current.predecessor.generation, unit: runnerScope }, { pid: successorPid, generation: current.generation, predecessor: predecessorPid, drainers: current.drainers.map((item) => item.pid), unit: runnerScope });
  const workerDeps = {
    platform: 'linux', env, now: () => new Date(), sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exists: existsSync, read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    write: (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); },
    writeAtomic: (path, text) => { const temp = `${path}.${randomUUID()}.tmp`; mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(temp, text); renameSync(temp, path); },
    remove: (path) => { try { rmSync(path, { force: true }); } catch {} }, list: (path) => { try { return (awaitDir(path)); } catch { return []; } },
    alive: (pid) => command('kill', ['-0', String(pid)], { allowFailure: true }).status === 0,
    identity: (pid) => readLinuxIdentity(pid),
    kill: (pid, signal) => { try { process.kill(pid, signal); } catch {} },
    ps: (args) => command('ps', args, { allowFailure: true }).stdout,
    openLog: (path) => { mkdirSync(join(path, '..'), { recursive: true }); return 2; },
    spawn: ({ bin, args, stdio, env: extra = {} }) => { const child = spawn(bin, args, { detached: true, stdio, env: { ...process.env, ...extra } }); child.unref(); return child.pid; },
    execPath: process.execPath, entry: worker, generation: () => randomUUID(),
    lifecycleLock: (root, transition) => withLifecycleLock(root, transition),
    systemdRun: (args) => command('systemd-run', args, { allowFailure: true }),
    linuxService: undefined, installBoot: (options) => installBootAdapter(options),
    respawn: ({ env: extra = {} } = {}) => { const child = spawn(process.execPath, [worker, 'run', 'start'], { detached: true, stdio: 'ignore', env: { ...process.env, ...extra } }); child.unref(); return child.pid; },
  };
  const competingStarts = await Promise.all([startRunner({ root: roots.work, deps: workerDeps }), startRunner({ root: roots.work, deps: workerDeps })]);
  assertThat('competing real starts admit one owner', competingStarts.filter((result) => result.ok).length === 0 && JSON.parse(readFileSync(paths.runner, 'utf8')).pid === successorPid, competingStarts.map((result) => `${result.ok}:${result.lines.join(' ')}`).join(' | '));
  current = JSON.parse(readFileSync(paths.runner, 'utf8'));
  const stopped = await stopRunner({ force: true, root: roots.work, deps: workerDeps });
  assertThat('forced stop ends the remaining verified owner without requiring the dead predecessor', stopped.ok && !workerDeps.alive(successorPid) && !workerDeps.alive(predecessorPid), stopped.lines.join('; '));
  const conditionalRoot = join(scratch, 'conditional-work');
  mkdirSync(conditionalRoot);
  const conditionalPaths = controlPaths(conditionalRoot);
  const noHistory = await startRunner({ argv: [IF_WAS_RUNNING], root: conditionalRoot, deps: workerDeps });
  assertThat('boot recovery with no prior owner starts nothing', noHistory.ok && !existsSync(conditionalPaths.runner), noHistory.lines.join('; '));
  workerDeps.write(conditionalPaths.stop, 'planned stop\n');
  const stoppedBoot = await startRunner({ argv: [IF_WAS_RUNNING], root: conditionalRoot, deps: workerDeps });
  assertThat('boot recovery never consumes deliberate STOP', stoppedBoot.ok && !existsSync(conditionalPaths.runner) && existsSync(conditionalPaths.stop), stoppedBoot.lines.join('; '));
  workerDeps.remove(conditionalPaths.stop);
  workerDeps.write(conditionalPaths.runner, `${JSON.stringify({ pid: 2147483647, args: ['--no-merge'] })}\n`);
  const resumed = await startRunner({ argv: [IF_WAS_RUNNING], root: conditionalRoot, deps: workerDeps });
  const resumedOwner = JSON.parse(readFileSync(conditionalPaths.runner, 'utf8'));
  pids.add(resumedOwner.pid);
  assertThat('boot recovery restores saved runner flags only for previously-running state', resumed.ok && resumedOwner.args.join(' ') === '--no-merge', resumed.lines.join('; '));
  await stopRunner({ force: true, root: conditionalRoot, deps: workerDeps });
  assertThat('a second root has independent ownership paths and unit identity', controlPaths(join(scratch, 'other-work')).runner !== paths.runner && bootUnit({ root: join(scratch, 'other-work'), execPath: process.execPath, entry: worker, env }).unit !== serviceUnit);
} catch (error) {
  report.error = error.stack || String(error);
} finally {
  for (const unit of scopeNames) command('systemctl', ['--user', 'stop', unit], { allowFailure: true });
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  if (serviceUnit) command('systemctl', ['--user', 'disable', serviceUnit], { allowFailure: true });
  if (servicePath) rmSync(servicePath, { force: true });
  command('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
  const leftovers = [...pids].filter((pid) => command('kill', ['-0', String(pid)], { allowFailure: true }).status === 0);
  const enabledLink = serviceUnit ? join(process.env.HOME, '.config/systemd/user/default.target.wants', serviceUnit) : null;
  const activeScopes = [...scopeNames].filter((unit) => command('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value'], { allowFailure: true }).stdout.trim() === 'active');
  report.cleanup = { complete: leftovers.length === 0 && (!servicePath || !existsSync(servicePath)) && (!enabledLink || !existsSync(enabledLink)) && activeScopes.length === 0, errors: [...leftovers.map((pid) => `process ${pid} remains`), ...(enabledLink && existsSync(enabledLink) ? [`enabled link remains: ${enabledLink}`] : []), ...activeScopes.map((unit) => `scope remains active: ${unit}`)] };
  mkdirSync(join(output, '..'), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  rmSync(scratch, { recursive: true, force: true });
}
if (report.error || !report.cleanup.complete || report.assertions.some((item) => !item.ok)) {
  process.stderr.write(`${report.error || 'Linux runner service check failed'}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Linux runner service check passed — ${report.assertions.length} assertions; report ${output}\n`);

function awaitDir(path) { return readdirSync(path); }
