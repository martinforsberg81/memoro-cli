/** Last observed deploy step, bound to one attempt; never an estimated percentage. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { writeJsonAtomic } from './atomic-write.js';
import { workRoot } from './paths.js';

const STAGES = {
  prepare: ['Deploy source preflight', 'Dependency preflight', 'Wrangler auth/API preflight',
    'Pending migrations preflight', 'Container image pins',
    'Container deploy mode', 'Avatar motion image pin', 'Preflight container runtime'],
  build: ['Build Ajv validators', 'Build CSS bundle', 'Build assistant 3D avatar runtime',
    'Pre-render public pages', 'Build the app bundle and shell', 'Keep the previous generation'],
  publish: ['Post-build git preflight', 'Stamp src/version.js', 'Stamp public/sw.js CACHE_VERSION',
    'Check reviewed language grammar', 'wrangler deploy', 'Apply migrations after the build', 'wrangler deploy (tail-worker)'],
  verify: ['Verify live version'],
};
const stageOf = (step) => Object.entries(STAGES).find(([, steps]) => steps.includes(step))?.[0] || null;
const progressPath = (root) => join(root, 'runner', 'log', 'deploy-progress.json');

export function readDeployProgress(attempt, env = process.env) {
  if (!attempt?.started || !attempt.pid) return null;
  try {
    const value = JSON.parse(readFileSync(progressPath(workRoot(env)), 'utf8'));
    if (value.started !== attempt.started || value.pid !== Number(attempt.pid)
      || typeof value.step !== 'string' || !value.step || value.step.length > 4096) return null;
    if (value.stage !== null && !['waiting', ...Object.keys(STAGES)].includes(value.stage)) return null;
    return value;
  } catch { return null; }
}

export function deployProgress(job, { env = process.env, pid = process.pid } = {}) {
  const path = progressPath(job.root || workRoot(env));
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let last = '';
  const report = (stage, step) => {
    if (last === `${stage}:${step}`) return;
    last = `${stage}:${step}`;
    try {
      writeJsonAtomic(path, { started: job.key.started, pid, stage, step });
    } catch { /* Progress is optional evidence; a failed write never stops a deploy. */ }
  };
  return {
    report,
    output(chunk) {
      pending += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const match = /^▸\s+(.+)$/u.exec(stripVTControlCharacters(line).trim());
        if (match) report(stageOf(match[1]), match[1].slice(0, 4096));
      }
      // A child may print an arbitrarily long line without a newline. Keep
      // memory bounded and prevent its suffix being mistaken for a new step.
      if (pending.length > 8192) pending = `…${pending.slice(-4096)}`;
    },
  };
}

export function deployBar(stage, outcome) {
  if (outcome === 'deployed') return '[━━━━]';
  const index = ['prepare', 'build', 'publish', 'verify'].indexOf(stage);
  return index < 0 ? '[····]' : `[${'━'.repeat(index)}●${'·'.repeat(3 - index)}]`;
}
