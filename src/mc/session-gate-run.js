#!/usr/bin/env node
/** The local gate's detached worker. It holds the repository lane.
 * Selection and test execution use the merge gate's implementations. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShell } from './child-async.js';
import { realTests, selectFiles, suiteEnv, suiteTimeoutMs } from './repo-gate.js';
import { redTests, tapTotals } from './tap-red.js';
import { takeLane } from './gate-lane-wait.js';
import { releaseGateLock } from './gate-lock.js';

export const quote = (word) => `'${String(word).replace(/'/gu, "'\\''")}'`;

export function selectorCommand(command, { base = 'origin/main', changed = [] } = {}) {
  // Both repositories' selectors accept explicit changed paths. This includes
  // unstaged and untracked changes and both sides of a rename.
  const withoutBase = command.replace(/\s+--base-ref(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/gu, '');
  return `${withoutBase} --base-ref ${quote(base)}${changed.map((path) => ` --changed-path ${quote(path)}`).join('')}`;
}

export async function runSessionGate(request, {
  env = process.env, select = selectFiles, tests = realTests, shell = runShell,
  write = (text) => process.stdout.write(text), signal,
} = {}) {
  const { cwd, flags = [], base = 'origin/main' } = request;
  let selection = { files: request.files || [], commands: [], classes: {} };
  if (request.select) {
    const selected = await select({ command: request.select, cwd, env, signal, say: (line) => write(`${line}\n`) });
    if (!selected.ok) { write(`Error: selection failed — ${selected.reason}\n`); return { ok: false, code: 1, stopped_at: 'selection' }; }
    selection = request.files ? { ...selection, classes: selected.classes || {} } : selected;
  }
  const files = [...new Set([...(selection.files || []), ...(request.addedTests || [])])];
  if (files.some((file) => !/\.test\.[cm]?[jt]s$/u.test(file) || resolve(cwd, file) === resolve(cwd) || !resolve(cwd, file).startsWith(`${resolve(cwd)}/`))) {
    write('Error: selector named a test outside the worktree or a non-test file\n');
    return { ok: false, code: 1, stopped_at: 'selection' };
  }
  if (!files.length && !selection.commands?.length) {
    write('NOTHING RUN — the repository selector selected no checks\n');
    return { ok: false, code: 2, stopped_at: 'no-checks', files };
  }
  let code = 0;
  let details = [];
  if (files.length) {
    const run = await tests({ cwd, files, flags: [...flags, ...(request.pattern == null ? [] : [`--test-name-pattern=${request.pattern}`])], classes: selection.classes || {}, env, signal });
    write(`${run.tap || ''}\n${run.stderr || ''}`);
    details = redTests(run.tap, files, { cwd });
    const totals = tapTotals(run.tap);
    for (const key of ['tests', 'pass', 'fail', 'skipped']) if (Number.isFinite(totals[key])) write(`ℹ ${key} ${totals[key]}\n`);
    if (run.error || run.timedOut || run.aborted || !totals.finished || (run.code != null && run.code !== 0) || totals.fail > 0) {
      code = 1;
      if (run.error || run.timedOut || run.aborted || !totals.finished) write(`Error: ${run.error || (run.timedOut ? 'tests exceeded their time limit' : run.aborted ? 'tests interrupted' : 'tests did not finish')}\n`);
    }
    for (const test of details) {
      write(`✖ ${test.name}\n${test.at ? `    at ${test.at}\n` : ''}${test.error.map((line) => `    ${line}\n`).join('')}`);
    }
  }
  const commands = [];
  for (const command of selection.commands || []) {
    if (signal?.aborted) { code = 1; break; }
    const invocation = `npm run ${quote(command.packageScript)}${command.passBaseRef ? ` -- --base-ref ${quote(base)}` : ''}`;
    const result = await shell(invocation, { cwd, env: suiteEnv(env), timeoutMs: suiteTimeoutMs(env), signal });
    write(`${result.stdout || ''}${result.stderr || ''}`);
    const ok = result.status === 0 || (command.unavailableExitCode != null && result.status === command.unavailableExitCode);
    commands.push({ command: invocation, exit: result.status, ok });
    write(`command ${command.id || command.packageScript}: ${ok ? 'pass' : 'fail'}\n`);
    if (!ok) code = 1;
  }
  if (signal?.aborted) { code = 1; write('Error: gate interrupted\n'); }
  return { ok: code === 0, code, files, commands, red_tests: details };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort());
  let holding = false;
  let request;
  let result = { ok: false, code: 1 };
  try {
    request = JSON.parse(readFileSync(path, 'utf8'));
    await takeLane({ ...request.reservation, signal: controller.signal });
    holding = true;
    result = await runSessionGate(request, { signal: controller.signal });
  } catch (error) { process.stderr.write(`Error: ${error.message}\n`); }
  finally {
    if (holding) releaseGateLock(request.reservation);
    writeFileSync(`${path}.result`, JSON.stringify(result));
    if (request?.log) writeFileSync(`${request.log}.exit`, `${result.code}\n`);
    process.exitCode = result.code;
  }
}
