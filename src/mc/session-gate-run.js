#!/usr/bin/env node
/** The local gate's detached worker. Selection and test execution use the
 * merge gate's implementations. It takes no lane and waits for nobody but a
 * build (await-deploy.js): it runs at low priority. Ordinary requests may
 * defer costly selected files; --whole-selection runs the full affected scope. */
import { readFileSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShell } from './child-async.js';
import { realTests, selectFiles, suiteEnv, suiteTimeoutMs } from './repo-gate.js';
import { redTests, tapTotals } from './tap-red.js';
import { awaitDeploy, deployHolding } from './await-deploy.js';
import { BUILD_LANE } from './gate-lock.js';
import { readTestTimes, progressTracker, sessionFiles, touchedTests } from './test-times.js';
import { captureWorktree, gateReceipt, persistGateReceipt, recordReceiptGreen, sameContent } from './session-gate-evidence.js';

export const quote = (word) => `'${String(word).replace(/'/gu, "'\\''")}'`;

export function selectorCommand(command, { base = 'origin/main', changed = [] } = {}) {
  // Both repositories' selectors accept explicit changed paths. This includes
  // unstaged and untracked changes and both sides of a rename.
  const withoutBase = command.replace(/\s+--base-ref(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/gu, '');
  return `${withoutBase} --base-ref ${quote(base)}${changed.map((path) => ` --changed-path ${quote(path)}`).join('')}`;
}

export async function runSessionGate(request, {
  snapshot = captureWorktree, persist = persistGateReceipt, record = recordReceiptGreen,
  now = () => new Date().toISOString(), ...deps
} = {}) {
  const execute = async () => {
    const controller = new AbortController();
    const external = deps.signal;
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const timeoutMs = Number(request.round_timeout_ms) > 0 ? Number(request.round_timeout_ms) : 60 * 60_000;
    // The runs' times files, tracked as the runs start (`runProgress`).
    const tracker = progressTracker();
    const activePhases = new Set(['selection']);
    let pendingFiles = request.files || [];
    let live = null;
    let timedOut = false;
    let progress = { unfinished: [], finished: [] };
    let ceilingLive = null;
    let ceilingPhases = [];
    let ceilingFiles = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      // Read before the abort: the run's files are gone once its process closes.
      progress = tracker.read();
      ceilingLive = live ? JSON.parse(JSON.stringify(live)) : null;
      ceilingPhases = [...activePhases];
      ceilingFiles = [...pendingFiles];
      controller.abort(new Error(`repository gate ceiling reached after ${Math.ceil(timeoutMs / 1000)} s`));
    }, timeoutMs);
    timeout.unref?.();
    try {
      // Cut when the signal comes, as well as stopped by it: a child that ignores
      // its signal must not hold the gate past the ceiling (repo-gate.js's `untilCeiling`).
      const cut = new Promise((resolve) => {
        if (signal.aborted) resolve(null);
        else signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      const result = await Promise.race([
        executeSessionGate(request, { ...deps, signal, track: tracker.track, complete: tracker.complete,
          onPhase: (next, active, files = []) => {
            if (active) activePhases.add(next); else activePhases.delete(next);
            if (files.length) pendingFiles = files;
          }, onProgress: (next) => { live = next; } }), cut,
      ]);
      if (!timedOut) return result ?? { ...live, ok: false, code: 1, stopped_at: 'interrupted' };
      // What did not finish is the red, and is named; the slowest files that did
      // finish are for the reader. Asked files that never started are unfinished too.
      const prefix = `${request.cwd}/`;
      const rel = (file) => (file.startsWith(prefix) ? file.slice(prefix.length) : file);
      const asked = ceilingFiles || pendingFiles;
      const done = new Set(progress.finished.map((one) => rel(one.file)));
      const unfinished = [...new Set([...progress.unfinished.map(rel), ...asked.filter((file) => !done.has(file))])];
      const slowest = progress.finished.slice(0, 5).map((one) => ({ file: rel(one.file), seconds: one.seconds }));
      const reached = slowest.length ? `; slowest finished: ${slowest.map((one) => `${one.file} (${one.seconds} s)`).join(', ')}` : '';
      const named = unfinished.length ? `; unfinished: ${unfinished.join(', ')}` : '';
      const phases = ceilingPhases;
      const phase = phases.join(', ') || 'settling';
      const timedOutSnapshot = ceilingLive || live;
      const commands = timedOutSnapshot?.execution?.commands || [];
      const pendingCommands = commands.filter((entry) => entry.state === 'pending').map((entry) => entry.command);
      const runningCommands = commands.filter((entry) => entry.state === 'running').map((entry) => entry.command);
      const commandProgress = [...(runningCommands.length ? [`running commands: ${runningCommands.join(', ')}`] : []),
        ...(pendingCommands.length ? [`pending commands: ${pendingCommands.join(', ')}`] : [])];
      const reason = `repository gate ceiling reached after ${Math.ceil(timeoutMs / 1000)} s; phase: ${phase}${named}${reached}${commandProgress.length ? `; ${commandProgress.join('; ')}` : ''}`;
      (deps.write || ((text) => process.stdout.write(text)))(`RED — gate round reached its ${Math.ceil(timeoutMs / 1000)} s ceiling; phase: ${phase}${named}${reached}${commandProgress.length ? `; ${commandProgress.join('; ')}` : ''}\n`);
      return { ...timedOutSnapshot, ok: false, code: 1, stopped_at: 'timeout', reason, red_files: unfinished, slowest_files: slowest,
        timeout_phase: phase, pending_commands: pendingCommands, running_commands: runningCommands };
    } finally { clearTimeout(timeout); }
  };
  if (!request.measurement) return execute();
  const started = now();
  let before = null;
  let after = null;
  let result = { ok: false, code: 1, stopped_at: 'content-changed' };
  try {
    before = snapshot(request.cwd);
    if (sameContent(request.measurement.candidate, before)) result = await execute();
    after = snapshot(request.cwd);
  } catch (error) {
    result = { ok: false, code: 1, stopped_at: 'evidence', error: error.message };
  }
  if (!sameContent(request.measurement.candidate, before) || !sameContent(before, after)) {
    (deps.write || ((text) => process.stdout.write(text)))('Error: worktree content changed or could not be fingerprinted — measurement invalid\n');
    result = { ...result, ok: false, code: 1, stopped_at: 'content-changed' };
  }
  if (deps.signal?.aborted) result = { ...result, ok: false, code: 1, stopped_at: 'interrupted' };
  const receipt = gateReceipt({ measurement: request.measurement, before, after, result, started, ended: now() });
  const path = persist({ root: request.gate.root, receipt });
  try { record({ root: request.gate.root, receipt, path }); }
  catch (error) {
    // Cache failure cannot turn a durable completed measurement into a red
    // attempt. The merger simply measures again when the cache is absent.
    (deps.write || ((text) => process.stdout.write(text)))(`Warning: gate reuse cache not updated: ${error.message}\n`);
  }
  return { ...result, evidence: { path, outcome: receipt.outcome } };
}

async function executeSessionGate(request, {
  env = process.env, select = selectFiles, tests = realTests, shell = runShell,
  write = (text) => process.stdout.write(text), signal, track = null, complete = null, onPhase = () => {}, onProgress = () => {},
} = {}) {
  const { cwd, flags = [], base = 'origin/main' } = request;
  let selection = { files: request.files || [], commands: [], classes: {} };
  if (request.select) {
    const selected = await select({ command: request.select, cwd, env, signal, say: (line) => write(`${line}\n`), mainOnly: request.mainOnly });
    if (!selected.ok) {
      write(`Error: selection failed — ${selected.reason}\n`);
      return { ok: false, code: 1, stopped_at: 'selection', deferred: [], coverage: {
        kind: request.files ? 'named' : 'affected', files: [], commands: [], pattern: request.pattern ?? null, selector: request.select ?? null,
      } };
    }
    selection = request.files ? { ...selection, classes: selected.classes || {} } : selected;
  }
  const selected = [...new Set([...(selection.files || []), ...(request.addedTests || [])])];
  if (selected.some((file) => !/\.test\.[cm]?[jt]s$/u.test(file) || resolve(cwd, file) === resolve(cwd) || !resolve(cwd, file).startsWith(`${resolve(cwd)}/`))) {
    write('Error: selector named a test outside the worktree or a non-test file\n');
    return { ok: false, code: 1, stopped_at: 'selection' };
  }
  // Named files are what was asked for, and a goal's measurement must be whole.
  const { run: files, deferred } = request.defer
    ? sessionFiles(selected, { times: readTestTimes(request.gate), keep: request.addedTests })
    : { run: selected, deferred: [] };
  onPhase('selection', false);
  if (deferred.length) write(`deferred, too costly for this partial gate (${deferred.length}; unmeasured): ${deferred.join(' ')}\n`);
  if (!files.length && !selection.commands?.length) {
    write('NOTHING RUN — the repository selector selected no checks\n');
    return { ok: false, code: 2, stopped_at: 'no-checks', files, deferred, coverage: {
      kind: request.files ? 'named' : deferred.length ? 'partial' : 'affected', files, commands: selection.commands || [],
      flags: [...flags], pattern: request.pattern ?? null, selector: request.select ?? null,
    } };
  }
  const selectedCommands = selection.commands || [];
  let code = 0;
  let details = [];
  let testResult = null;
  let timed = [];
  const commands = selectedCommands.map((command) => ({
    id: command.id || command.packageScript, packageScript: command.packageScript,
    command: `npm run ${quote(command.packageScript)}${command.passBaseRef ? ` -- --base-ref ${quote(base)}` : ''}`,
    exit: null, ok: false, state: 'pending',
  }));
  const coverage = { kind: request.files ? 'named' : deferred.length ? 'partial' : 'affected', files, commands: selectedCommands,
    flags: [...flags], pattern: request.pattern ?? null, selector: request.select ?? null };
  const snapshot = () => {
    const unavailable = commands.filter((command) => command.unavailable === true).map(({ id, packageScript, command: invocation, exit }) => ({
      id, packageScript, command: invocation, exit,
    }));
    return { ok: code === 0 && unavailable.length === 0, process_ok: code === 0, complete: code === 0 && unavailable.length === 0,
      verdict: code !== 0 ? 'red' : unavailable.length ? 'incomplete' : 'green', code, files, deferred, commands,
      ...(unavailable.length ? { unavailable_commands: unavailable } : {}), red_tests: details, timed_tests: timed,
      coverage, execution: { tests: testResult, commands } };
  };
  const progress = () => onProgress(snapshot());
  progress();

  const runTests = async () => {
    if (!files.length) return;
    onPhase('tests', true, files);
    testResult = { exit: null, finished: false, totals: {} };
    progress();
    try {
      const run = await tests({ cwd, files, flags: [...flags, ...(request.pattern == null ? [] : [`--test-name-pattern=${request.pattern}`])], classes: selection.classes || {}, env, signal, times: request.gate ? { ...request.gate, track, complete } : undefined });
      write(`${run.tap || ''}\n${run.stderr || ''}`);
      timed = touchedTests(run.tests || [], request.timed || {});
      details = redTests(run.tap, files, { cwd });
      const totals = tapTotals(run.tap);
      for (const key of ['tests', 'pass', 'fail', 'skipped']) if (Number.isFinite(totals[key])) write(`ℹ ${key} ${totals[key]}\n`);
      testResult = { exit: run.code ?? null, finished: totals.finished && !run.error && !run.timedOut && !run.aborted, totals };
      if (run.error || run.timedOut || run.aborted || !totals.finished || !totals.tests || !totals.pass || run.code !== 0 || totals.fail > 0 || totals.cancelled > 0) {
        code = 1;
        const reason = run.error || (run.timedOut ? 'tests exceeded their time limit' : run.aborted ? 'tests interrupted'
          : !totals.finished ? 'tests did not finish' : !totals.tests || !totals.pass ? 'no passing tests executed'
            : run.code == null ? 'test exit is unknown' : null);
        if (reason) write(`Error: ${reason}\n`);
      }
      for (const test of details) write(`✖ ${test.name}\n${test.at ? `    at ${test.at}\n` : ''}${test.error.map((line) => `    ${line}\n`).join('')}`);
    } catch (error) {
      code = 1;
      testResult = { exit: null, finished: false, totals: {}, error: error.message };
      write(`Error: tests threw: ${error.message}\n`);
    } finally {
      onPhase('tests', false, files);
      progress();
    }
  };
  const runCommands = async () => {
    for (let index = 0; index < selectedCommands.length; index++) {
      const command = selectedCommands[index];
      const evidence = commands[index];
      if (signal?.aborted) { code = 1; break; }
      evidence.state = 'running';
      const phase = `command ${command.packageScript}`;
      onPhase(phase, true);
      progress();
      try {
        const result = await shell(evidence.command, { cwd, env: suiteEnv(env), timeoutMs: suiteTimeoutMs(env), signal });
        write(`${result.stdout || ''}${result.stderr || ''}`);
        const unavailable = !result.error && !result.signal && command.unavailableExitCode != null && result.status === command.unavailableExitCode;
        const ok = !result.error && !result.signal && result.status === 0;
        Object.assign(evidence, { exit: result.status ?? null, ok, state: unavailable ? 'unavailable' : 'completed',
          ...(unavailable ? { unavailable: true } : {}), ...(result.error ? { error: result.error.code || result.error.message } : {}) });
        write(`command ${command.id || command.packageScript}: ${unavailable ? `unavailable (exit ${result.status})` : ok ? 'pass' : 'fail'}\n`);
        if (!ok && !unavailable) code = 1;
      } catch (error) {
        Object.assign(evidence, { exit: null, ok: false, state: 'completed', error: error.message });
        code = 1;
        write(`command ${command.id || command.packageScript}: fail (${error.message})\n`);
      } finally {
        onPhase(phase, false);
        progress();
      }
    }
  };
  await Promise.all([runTests(), runCommands()]);
  if (signal?.aborted) { code = 1; write('Error: gate interrupted\n'); }
  return snapshot();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort());
  let request;
  let result = { ok: false, code: 1 };
  try {
    request = JSON.parse(readFileSync(path, 'utf8'));
    try { setPriority(10); } catch { /* the gate still runs */ }
    if (request.gate.repo === BUILD_LANE) await awaitDeploy({ holding: () => deployHolding({ root: request.gate.root }) });
    result = await runSessionGate(request, { signal: controller.signal });
  } catch (error) { process.stderr.write(`Error: ${error.message}\n`); }
  finally {
    writeFileSync(`${path}.result`, JSON.stringify(result));
    if (request?.log) writeFileSync(`${request.log}.exit`, `${result.code}\n`);
    process.exitCode = result.code;
  }
}
