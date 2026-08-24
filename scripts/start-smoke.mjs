#!/usr/bin/env node
/**
 * The start smoke: a session starts and reaches its prompt — for both tools.
 *
 * PM's condition on cutting the old surface (2026-08-24): the tool start is
 * ~103 starts a week and the one point where a fault stops everything, so it
 * is measured before the first slice and after every one. Under the cut the
 * gate cannot measure (its suite is the flaky dead surface being removed), so
 * this is the only real safety net — and Martin's ruling that night is that
 * it prove BOTH tools, claude and codex.
 *
 * Real tmux, real tool, real hooks: a throwaway directory, a background start
 * exactly as `mc work` does it, the folder-trust dialog answered as `mc work`
 * answers it, and the prompt waited for. Then the tool is asked to leave and
 * the session killed.
 *
 *   node scripts/start-smoke.mjs [--tool claude|codex|both]
 *
 * Exit 0 only if every requested tool reached its prompt; exit 1 with the
 * pane's last lines for the first that did not. A tool that is not installed
 * is reported and skipped, never a silent pass.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { askToolToLeave } from '../src/mc/work-stop.js';
import { clearTrustDialog, startInBackground } from '../src/mc/work-open.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] || fallback);
};
const which = arg('--tool', 'both');
const tools = which === 'both' ? ['claude', 'codex'] : [which];
const tmux = (args) => spawnSync('tmux', args, { encoding: 'utf8' });

function smokeOne(tool) {
  if (!spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0) { /* fallthrough to start's own error */ }
  const name = `smoke-${tool}-${Date.now().toString(36)}`;
  const areaRoot = mkdtempSync(join(tmpdir(), `mc-start-smoke-${tool}-`));
  const began = Date.now();
  const started = startInBackground({ name, areaRoot, worktree: { repo: null, path: areaRoot, is_git: false }, tool });
  if (!started.ok) {
    rmSync(areaRoot, { recursive: true, force: true });
    return { tool, ok: false, reason: `could not start — ${started.reason}${started.hint ? ` (${started.hint})` : ''}` };
  }
  const settled = clearTrustDialog(started.target, { attempts: 45 });
  let pane = '';
  let prompt = false;
  for (let look = 0; look < 30 && !prompt; look += 1) {
    pane = tmux(['capture-pane', '-t', started.target, '-p']).stdout || '';
    prompt = /❯|›|>_|Ctrl|esc to/u.test(pane) && !/trust this folder/iu.test(pane);
    if (!prompt) spawnSync('sleep', ['1']);
  }
  const seconds = ((Date.now() - began) / 1000).toFixed(1);
  askToolToLeave(started.target);
  tmux(['kill-session', '-t', started.target]);
  rmSync(areaRoot, { recursive: true, force: true });
  return prompt
    ? { tool, ok: true, seconds, answered: settled.answered }
    : { tool, ok: false, reason: `no prompt after ${seconds}s (${settled.reason || 'unknown'})`, tail: pane.trim().split('\n').slice(-12) };
}

let failed = false;
for (const tool of tools) {
  const r = smokeOne(tool);
  if (r.ok) {
    process.stdout.write(`start-smoke [${tool}]: OK — reached its prompt in ${r.seconds}s${r.answered ? ' (trust dialog answered)' : ''}\n`);
  } else {
    failed = true;
    process.stderr.write(`start-smoke [${tool}]: FAILED — ${r.reason}\n`);
    for (const line of r.tail || []) process.stderr.write(`  ${line}\n`);
  }
}
process.exit(failed ? 1 : 0);
