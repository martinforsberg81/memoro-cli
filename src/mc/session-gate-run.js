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
import { fileOutcomes, readTestTimes, outputCut, progressTracker, sessionFiles, slowTests, touchedTests } from './test-times.js';
import { captureWorktree, findResumable, gateReceipt, persistGateReceipt, recordReceiptGreen, sameContent } from './session-gate-evidence.js';
import { commandIdentity } from './gate-greens.js';
import { settleRed } from './gate-settle.js';

export const quote = (word) => `'${String(word).replace(/'/gu, "'\\''")}'`;

// A stop invalidates successful progress metadata, not the evidence collected.
const stoppedResult = (result, stopped_at) => ({ ...result, stopped_at,
  ok: false, code: 1, process_ok: false, complete: false, verdict: 'red' });

export function selectorCommand(command, { base = 'origin/main', changed = [] } = {}) {
  // Both repositories' selectors accept explicit changed paths. This includes
  // unstaged and untracked changes and both sides of a rename.
  const withoutBase = command.replace(/\s+--base-ref(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/gu, '');
  return `${withoutBase} --base-ref ${quote(base)}${changed.map((path) => ` --changed-path ${quote(path)}`).join('')}`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export async function runSessionGate(request, {
  snapshot = captureWorktree, persist = persistGateReceipt, record = recordReceiptGreen,
  now = () => new Date().toISOString(), ...deps
} = {}) {
  // What earlier attempts on this content proved passing (`findResumable`):
  // only a measured request, and never with --fresh.
  let prior = { files: new Map(), commands: new Map() };
  // The tracker, and what it said when a ceiling or an interrupt stopped the
  // run: the run's times files are gone once its process closes.
  let tracker = null;
  let stopped = null;
  const execute = async () => {
    const controller = new AbortController();
    const external = deps.signal;
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const timeoutMs = Number(request.round_timeout_ms) > 0 ? Number(request.round_timeout_ms) : 60 * 60_000;
    // The runs' times files, tracked as the runs start (`runProgress`).
    tracker = progressTracker();
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
      stopped = { progress, outcomes: tracker.outcomes() };
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
        const stop = () => {
          if (!stopped) stopped = { progress: tracker.read(), outcomes: tracker.outcomes() };
          resolve(null);
        };
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      });
      const result = await Promise.race([
        executeSessionGate(request, { ...deps, prior, signal, track: tracker.track, complete: tracker.complete, read: tracker.read, outcomes: tracker.outcomes,
          onPhase: (next, active, files = []) => {
            if (active) activePhases.add(next); else activePhases.delete(next);
            if (files.length) pendingFiles = files;
          }, onProgress: (next) => { live = next; } }), cut,
      ]);
      if (!timedOut) return result ?? stoppedResult(live, 'interrupted');
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
      return stoppedResult({ ...timedOutSnapshot, reason, red_files: unfinished, slowest_files: slowest,
        timeout_phase: phase, pending_commands: pendingCommands, running_commands: runningCommands }, 'timeout');
    } finally { clearTimeout(timeout); }
  };
  if (!request.measurement) return execute();
  // Each member as this attempt ran or reused it, for the receipt: what a later
  // attempt on the same content may resume from (`findResumable`).
  const withMembers = (result) => {
    if (!Array.isArray(result?.coverage?.files) || !tracker) return result;
    const reused = result.resumed?.files || {};
    const timed = request.timed || {};
    const kept = (file, tests) => (Object.hasOwn(timed, file) ? tests.map(({ name, line, seconds }) => ({ name, line, seconds })) : []);
    const ran = fileOutcomes(result.coverage.files.filter((file) => !reused[file]),
      stopped || { progress: tracker.read(), outcomes: tracker.outcomes() });
    const outcome = new Map(ran.map((one) => [one.file, one]));
    const files = result.coverage.files.map((file) => {
      if (reused[file]) {
        const source = prior.files.get(file);
        return { file, how: 'reused', from: reused[file], outcome: 'passed', seconds: source?.seconds ?? null, tests: kept(file, source?.tests || []) };
      }
      const one = outcome.get(file);
      // Red in the round and green run alone in this attempt (`gate-settle.js`): it passed here.
      const passedAlone = result.settled?.alone?.includes(file);
      return { file, how: 'ran', from: null, outcome: passedAlone ? 'passed' : one.outcome, seconds: one.seconds, tests: kept(file, one.tests) };
    });
    const commands = (result.execution?.commands || []).map((command) => ({
      packageScript: command.packageScript, how: command.state === 'reused' ? 'reused' : 'ran', from: command.from ?? null,
      outcome: command.state === 'reused' ? 'passed'
        : command.state === 'completed' && command.exit === 0 && command.ok === true && !command.unavailable && !command.error ? 'passed'
          : command.state === 'completed' ? 'failed' : command.state,
    }));
    return { ...result, members: { files, commands } };
  };
  if (!request.fresh) {
    try { prior = findResumable({ root: request.gate?.root, measurement: request.measurement, flags: request.flags || [], pattern: request.pattern ?? null }); }
    catch { /* nothing to resume from: the whole selection runs */ }
  }
  const started = now();
  let before = null;
  let after = null;
  let result = stoppedResult(null, 'content-changed');
  try {
    before = snapshot(request.cwd);
    if (sameContent(request.measurement.candidate, before)) result = withMembers(await execute());
    after = snapshot(request.cwd);
  } catch (error) {
    result = stoppedResult({ ...result, error: error.message }, 'evidence');
  }
  if (!sameContent(request.measurement.candidate, before) || !sameContent(before, after)) {
    (deps.write || ((text) => process.stdout.write(text)))('Error: worktree content changed or could not be fingerprinted — measurement invalid\n');
    result = stoppedResult(result, 'content-changed');
  }
  if (deps.signal?.aborted) result = stoppedResult(result, 'interrupted');
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
  write = (text) => process.stdout.write(text), signal, track = null, complete = null, read = null, outcomes = null, onPhase = () => {}, onProgress = () => {},
  prior = null, settle = settleRed,
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
  // A selected file an earlier attempt on this content saw pass is not run again.
  const reusedFiles = Object.fromEntries(selected.filter((file) => prior?.files?.has(file)).map((file) => [file, prior.files.get(file).from]));
  const remaining = selected.filter((file) => !reusedFiles[file]);
  // Named files are what was asked for, and a goal's measurement must be whole.
  const { run: files, deferred } = request.defer
    ? sessionFiles(remaining, { times: readTestTimes(request.gate), keep: request.addedTests })
    : { run: remaining, deferred: [] };
  const covered = selected.filter((file) => reusedFiles[file] || files.includes(file));
  onPhase('selection', false);
  if (deferred.length) write(`deferred, too costly for this partial gate (${deferred.length}; unmeasured): ${deferred.join(' ')}\n`);
  if (!covered.length && !selection.commands?.length) {
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
  // Whose red the test half's red was (`gate-settle.js`): null when nothing was settled.
  let settled = null;
  const testFlags = [...flags, ...(request.pattern == null ? [] : [`--test-name-pattern=${request.pattern}`])];
  const commands = selectedCommands.map((command) => {
    const source = prior?.commands?.get(commandIdentity(command));
    return { id: command.id || command.packageScript, packageScript: command.packageScript,
      command: `npm run ${quote(command.packageScript)}${command.passBaseRef ? ` -- --base-ref ${quote(base)}` : ''}`,
      ...(source ? { exit: 0, ok: true, state: 'reused', from: source.from } : { exit: null, ok: false, state: 'pending' }) };
  });
  const reusedCommands = commands.filter((command) => command.state === 'reused');
  const sources = [...new Set([...Object.values(reusedFiles), ...reusedCommands.map((command) => command.from)])];
  const resumed = sources.length ? { from: sources, files: reusedFiles,
    commands: reusedCommands.map((command) => ({ packageScript: command.packageScript, from: command.from })) } : null;
  if (resumed) {
    write(`reused ${plural(Object.keys(reusedFiles).length, 'file')} and ${plural(reusedCommands.length, 'command')} from ${sources.join(', ')}; running ${files.length + commands.length - reusedCommands.length}\n`);
  }
  // The reused files' touched tests are timed from their source run, and say so.
  const reusedTimed = touchedTests(Object.keys(reusedFiles).flatMap((file) => (prior.files.get(file).tests || [])
    .map((test) => ({ ...test, file }))), request.timed || {}).map((test) => ({ ...test, reused: reusedFiles[test.file] }));
  let timed = reusedTimed;
  // Every passed test over the slow-test indicator (`slowTests`): named in the verdict, never its red.
  const reusedSlow = Object.keys(reusedFiles).flatMap((file) => (prior.files.get(file).tests || []).map((test) => ({ ...test, file })));
  let slow = slowTests(reusedSlow);
  const coverage = { kind: request.files ? 'named' : deferred.length ? 'partial' : 'affected', files: covered, commands: selectedCommands,
    flags: [...flags], pattern: request.pattern ?? null, selector: request.select ?? null };
  const snapshot = () => {
    const unavailable = commands.filter((command) => command.unavailable === true).map(({ id, packageScript, command: invocation, exit }) => ({
      id, packageScript, command: invocation, exit,
    }));
    return { ok: code === 0 && unavailable.length === 0, process_ok: code === 0, complete: code === 0 && unavailable.length === 0,
      verdict: code !== 0 ? 'red' : unavailable.length ? 'incomplete' : 'green', code, files, deferred, commands,
      ...(unavailable.length ? { unavailable_commands: unavailable } : {}), red_tests: details, timed_tests: timed, slow_tests: slow,
      coverage, execution: { tests: testResult, commands }, resumed,
      ...(settled && (settled.alone.length || settled.main.length) ? { settled: { alone: settled.alone, main: settled.main, base: settled.base, red: settled.red } } : {}) };
  };
  const progress = () => onProgress(snapshot());
  progress();

  const runTests = async () => {
    if (!files.length) return;
    onPhase('tests', true, files);
    testResult = { exit: null, finished: false, totals: {} };
    progress();
    try {
      const run = await tests({ cwd, files, flags: testFlags, classes: selection.classes || {}, env, signal, times: request.gate ? { ...request.gate, track, complete } : undefined });
      write(`${run.tap || ''}\n${run.stderr || ''}`);
      timed = [...touchedTests(run.tests || [], request.timed || {}), ...reusedTimed];
      slow = slowTests([...(run.tests || []), ...reusedSlow]);
      details = redTests(run.tap, files, { cwd });
      const totals = tapTotals(run.tap);
      for (const key of ['tests', 'pass', 'fail', 'skipped', 'cancelled']) if (Number.isFinite(totals[key])) write(`ℹ ${key} ${totals[key]}\n`);
      // What the tracker saw of the files asked for, read now the run is over: a file
      // never started, or with a top-level test that never ended, was cut short
      // whatever the exit code and the summary say (`outputCut`).
      const cut = request.gate && read ? outputCut(files, { progress: read() }) : [];
      testResult = { exit: run.code ?? null, finished: totals.finished && !run.error && !run.timedOut && !run.aborted && !cut.length, totals,
        ...(cut.length ? { cut } : {}) };
      if (run.error || run.timedOut || run.aborted || !totals.finished || cut.length || !totals.tests || !totals.pass || run.code !== 0 || totals.fail > 0 || totals.cancelled > 0) {
        const reason = run.error || (run.timedOut ? 'tests exceeded their time limit' : run.aborted ? 'tests interrupted'
          : !totals.finished ? 'tests did not finish' : cut.length ? `output cut: ${cut.join(', ')}` : !totals.tests || !totals.pass ? 'no passing tests executed'
            : run.code == null ? 'test exit is unknown' : null);
        if (reason) write(`Error: ${reason}\n`);
        // Only failed files, every one of them finished: whose red it is is
        // asked before it is called the change's (`gate-settle.js`).
        const seen = !reason && read && outcomes ? fileOutcomes(files, { progress: read(), outcomes: outcomes() }) : null;
        const failed = seen?.filter((one) => one.outcome !== 'passed') || [];
        if (seen && failed.length && failed.every((one) => one.outcome === 'failed') && !signal?.aborted) {
          try {
            settled = await settle({ cwd, base: request.measurement?.base || base, red: failed.map((one) => one.file), failing: details,
              flags: testFlags, classes: selection.classes || {}, env, signal, tests,
              times: request.gate ? { ...request.gate, track, complete } : undefined });
          } catch (error) {
            settled = { alone: [], main: [], red: failed.map((one) => one.file), base: null, notes: [`could not settle the red: ${error.message}`] };
          }
          for (const note of settled.notes) write(`${note}\n`);
          details = details.filter((test) => settled.red.includes(test.file));
          testResult = { ...testResult, settled: { alone: settled.alone, main: settled.main, base: settled.base } };
        }
        if (!settled || settled.red.length) code = 1;
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
      if (evidence.state === 'reused') continue;
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
