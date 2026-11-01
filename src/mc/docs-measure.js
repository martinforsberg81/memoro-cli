/**
 * The tests a documents-only pull request is measured by, on a candidate.
 *
 * The docs form (`runDocsMerge`) used to land a pull request that touches
 * nothing outside `docs/` with no test at all, and four such landings turned
 * memoro's `main` red between 2026-10-20 and 10-24 (#13980, #13995, #14138,
 * #14188): `tests/docs/doc-links.test.js` found dead relative links that a
 * document it had not read introduced. A document is not code, but the
 * repository's own selector knows which tests read documents, and those are
 * the ones to run.
 *
 * So the same selection the gate round makes is made here, in a candidate of
 * the pull request's head with its base merged in, and whatever it draws is run
 * with the same flags and the same command gates. A red, or a failed command,
 * stops the merge; a green is what lets the squash happen. The selector's
 * answer is reused (`selectFiles` from repo-gate.js), not copied, so the two
 * cannot disagree about what a selection is.
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { runShell, runTool } from './child-async.js';
import { declarationFor } from './repo-gate-table.js';
import { realTests, selectFiles } from './repo-gate.js';
import { prepareCacheDir, prepareCandidate } from './prepare-cache.js';
import { mcHome, workGatePath } from './paths.js';
import { takeLane } from './gate-lane-wait.js';
import { releaseGateLock } from './gate-lock.js';
import { gateLaneOf } from './repo-gate-table.js';
import { repoFileSlug } from './repo-snapshot.js';
import { redFiles, redNames, redTests, tapTotals } from './tap-red.js';

const PREFIX = "documents' tests: ";

/** What a failed git or shell call says, three lines at most — as the gate round reads it. */
function trim(value) {
  return String(value || '').trim().split('\n').slice(0, 3).join(' ');
}

/**
 * Measure the tests the repository's selector draws for `headSha` (with `base`
 * merged in) and say whether they are green.
 *
 * Resolves `{ ok, stopped_at, reason, files, red, commands, seconds }`. `stopped_at`
 * names the step that said no: `declaration`, `candidate`, `merge`, `prepare`,
 * `selection`, `suite` (the run did not finish) or `red`. Every `say` line
 * starts with `documents' tests: `.
 */
export async function measureDocs({
  repoPath, pr, headSha, headRef, base, env = process.env, say = () => {}, deps = {},
}) {
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  const io = {
    git: deps.git ?? ((args, { cwd }) => runTool('git', args, { cwd, env })),
    shell: deps.shell ?? ((command, { cwd }) => runShell(command, { cwd, env, signal: controller.signal, timeoutMs: 60 * 60_000 })),
    declaration: deps.declaration ?? declarationFor,
    select: deps.select ?? selectFiles,
    tests: deps.tests ?? realTests,
    prepare: deps.prepare ?? prepareCandidate,
    cacheDir: deps.cacheDir ?? prepareCacheDir({ repoPath, env }),
    gateDir: deps.gateDir ?? workGatePath(env),
    clock: deps.clock ?? Date.now,
    takeLane: deps.takeLane ?? takeLane,
    releaseLane: deps.releaseLane ?? releaseGateLock,
    outputDir: deps.outputDir ?? join(mcHome(env), 'gate-output'),
  };
  const started = io.clock();
  const note = (line) => say(`${PREFIX}${line}`);

  const declared = io.declaration(repoPath, { env });
  if (!declared.ok) return finish({ ok: false, stopped_at: 'declaration', reason: declared.reason });
  if (!declared.declaration.select) {
    return finish({ ok: true, stopped_at: null, reason: 'no select declared — nothing to measure', files: 0, red: [], commands: [] });
  }

  const dir = join(io.gateDir, repoFileSlug(repoPath), `docs-${pr}`);
  const lane = gateLaneOf(repoPath);
  const reservation = { root: mcHome(env), lane, repo: repoFileSlug(repoPath), mode: 'docs-gate' };
  const logPath = join(io.outputDir, `docs-${repoFileSlug(repoPath)}-${pr}-${randomUUID()}.log`);
  let holding = false;
  const save = (text) => { mkdirSync(io.outputDir, { recursive: true }); appendFileSync(logPath, String(text || '')); };
  const removeWorktree = async () => {
    try { await io.git(['worktree', 'remove', '--force', dir], { cwd: repoPath }); } catch { /* not there to remove */ }
  };

  let result;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, interrupted);
  try {
    await io.takeLane({ ...reservation, signal: controller.signal, write: (line) => note(line.trimEnd()) });
    holding = true;
    result = await measure();
  } catch (error) {
    result = { ok: false, stopped_at: holding ? 'measurement' : 'reservation', reason: error.message };
  } finally {
    try {
      if (holding) {
        try { await removeWorktree(); rmSync(dir, { recursive: true, force: true }); }
        finally { io.releaseLane(reservation); }
      }
    } finally { for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, interrupted); }
  }
  if (controller.signal.aborted) result = { ...result, ok: false, stopped_at: 'interrupted', reason: 'documents test measurement interrupted' };
  return finish({ ...result, log: logPath });

  /** The candidate's life: made, prepared, selected, run. Cleaned up by the caller. */
  async function measure() {
    await removeWorktree();
    rmSync(dir, { recursive: true, force: true });

    for (const args of [['fetch', 'origin', '--prune'], ['fetch', 'origin', headRef], ['worktree', 'add', '--detach', dir, headSha]]) {
      const run = await io.git(args, { cwd: repoPath });
      if (run.status !== 0) return { ok: false, stopped_at: 'candidate', reason: trim(run.stderr) || `git ${args[0]} exited ${run.status}` };
    }

    const merged = await io.git(['merge', '--no-edit', `origin/${base}`], { cwd: dir });
    if (merged.status !== 0) {
      return { ok: false, stopped_at: 'merge', reason: `#${pr} does not merge cleanly with ${base} — merge ${base} in and push` };
    }

    const { prepare, select, pr_tests_flags: flags = [] } = declared.declaration;
    if (prepare) {
      const ready = await io.prepare({ prepare, headDir: dir, cacheDir: io.cacheDir, shell: io.shell, say: note });
      if (ready.status !== 0) {
        return { ok: false, stopped_at: 'prepare', reason: `${prepare} failed in the candidate — ${trim(ready.stderr) || `exit ${ready.status}`}` };
      }
    }

    const sel = await io.select({ command: select, cwd: dir, env, signal: controller.signal, say: note });
    if (!sel.ok) return { ok: false, stopped_at: 'selection', reason: sel.reason };
    note(`${sel.files.length} test file(s) and ${(sel.commands || []).length} command gate(s) drawn for #${pr}`);

    const failed = [];
    const commandResults = [];
    for (const command of sel.commands || []) {
      const invocation = `npm run ${command.packageScript}${command.passBaseRef ? ` -- --base-ref origin/${base}` : ''}`;
      const run = await io.shell(invocation, { cwd: dir });
      save(`$ ${invocation}\n${run.stdout || ''}${run.stderr || ''}\n`);
      const ok = run.status === 0 || (command.unavailableExitCode != null && run.status === command.unavailableExitCode);
      commandResults.push({ command: invocation, exit: run.status, ok });
      if (!ok) failed.push(command.id || command.packageScript);
    }

    let red = [];
    let details = [];
    let failingFiles = [];
    if (sel.files.length) {
      const run = await io.tests({ cwd: dir, files: sel.files, flags, env, signal: controller.signal, classes: sel.classes || {} });
      save(`${run.tap || ''}\n${run.stderr || ''}`);
      if (run.timedOut) return { ok: false, stopped_at: 'suite', reason: "the documents' tests ran past their time" };
      if (!tapTotals(run.tap).finished) {
        return { ok: false, stopped_at: 'suite', reason: "the documents' tests never reached their summary" };
      }
      red = redNames(run.tap);
      details = redTests(run.tap, sel.files, { cwd: dir });
      failingFiles = redFiles(run.tap, sel.files);
      if (run.error || (run.code != null && run.code !== 0 && !red.length)) return { ok: false, stopped_at: 'suite', reason: run.error || `the documents' tests exited ${run.code}`, command_results: commandResults };
    }

    if (red.length || failed.length) {
      const parts = [];
      if (red.length) parts.push(`${red.length} test(s) red: ${red.slice(0, 5).join(', ')}`);
      if (failed.length) parts.push(`command gate(s) failed: ${failed.join(', ')}`);
      return { ok: false, stopped_at: 'red', reason: parts.join('; '), files: sel.files.length, red, commands: failed, red_tests: details, red_files: failingFiles, command_results: commandResults };
    }
    return { ok: true, stopped_at: null, reason: null, files: sel.files.length, red: [], commands: [] };
  }

  /** The result with its `seconds`, read after the candidate is gone. */
  function finish(result) {
    const seconds = Math.round((io.clock() - started) / 1000);
    return { ok: false, stopped_at: null, reason: null, files: 0, red: [], commands: [], ...result, seconds };
  }
}
