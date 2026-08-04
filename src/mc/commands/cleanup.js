import {
  applySessionOwnedResourceCleanupSync,
  planSessionOwnedResourceCleanupSync,
} from '../owned-resource-cleanup.js';
import { resolveLocalSessionSync } from '../session-v1.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error || !opts.name || opts.apply === null) {
    stderr.write(`mc: ${opts.error || 'usage — mc cleanup <session> (--dry-run|--apply) [--resource <id>] [--json]'}\n`);
    return 2;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.name, {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) {
    stderr.write(`mc: session "${opts.name}" was not found (${resolved.reason})\n`);
    return 1;
  }
  const cleanup = opts.apply
    ? (deps.applyCleanup || applySessionOwnedResourceCleanupSync)
    : (deps.planCleanup || planSessionOwnedResourceCleanupSync);
  const result = cleanup({
    mcHomeDir: deps.mcHomeDir,
    mcSessionId: resolved.session.mc_session_id,
    resourceId: opts.resourceId,
    deps: deps.cleanupDeps || {},
  });
  const payload = { ...result, applied: opts.apply };
  if (opts.json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else renderHuman(payload, stdout);
  return result.ok ? 0 : 1;
}

export function parseArgs(argv) {
  const opts = { name: null, resourceId: null, apply: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--dry-run' || arg === '--apply') {
      const apply = arg === '--apply';
      if (opts.apply !== null && opts.apply !== apply) return { ...opts, error: 'choose either --dry-run or --apply' };
      opts.apply = apply;
      continue;
    }
    if (arg === '--resource') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) return { ...opts, error: '--resource requires an id' };
      opts.resourceId = value;
      continue;
    }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.name) return { ...opts, error: `unexpected arg: ${arg}` };
    opts.name = arg;
  }
  return opts;
}

function renderHuman(result, stdout) {
  const label = result.applied ? 'cleanup' : 'cleanup plan';
  stdout.write(`mc ${label} — ${result.ok ? 'safe' : 'blocked'}\n`);
  for (const plan of result.plans || []) {
    stdout.write(`  ${plan.resource_id || '—'}  ${plan.resource_kind || '—'}  ${plan.verdict || plan.reason}\n`);
  }
  for (const item of result.results || []) {
    stdout.write(`  ${item.ok ? '✓' : '✗'} ${item.resource_id}  ${item.action || item.reason}\n`);
  }
  for (const issue of result.issues || []) stdout.write(`  ! ${issue.resource_id || issue.entry || 'state'}  ${issue.reason}\n`);
}
