/** Inspect and verify a locally held programme backup archive. */
import { backupStatus, resumeBackup as resumeBackupLifecycle, transitionBackup } from '../programme-lifecycle.js';
import { inspectArchive, restoreArchive, verifyArchive } from '../backup-archive.js';
import { createProgrammeBackup } from '../backup-capture.js';
import { commandUsage } from '../command-help.js';
import { scanArgs } from './flags.js';

const archiveRoute = { booleans: ['--json'], strictValues: ['--archive'], check: ({ flags, positional }) => positional.length ? `takes no ${positional[0]}` : (flags.archive ? null : 'needs --archive <path>') };
const idRoute = { booleans: ['--json'], strictValues: ['--id'], check: ({ flags, positional }) => positional.length ? `takes no ${positional[0]}` : (flags.id ? null : 'needs --id <id>') };
const restoreRoute = { booleans: ['--json'], strictValues: ['--archive', '--output'], check: ({ flags, positional }) => positional.length ? `takes no ${positional[0]}` : (!flags.archive ? 'needs --archive <path>' : (!flags.output ? 'needs --output <inactive-root>' : null)) };
const createRoute = { booleans: ['--json', '--all-programmes'], repeatable: ['--programme'], strictValues: ['--output'], check: ({ flags, positional }) => positional.length ? `takes no ${positional[0]}` : (!flags.output ? 'needs --output <absolute-path>' : (Boolean(flags['all-programmes']) === Boolean(flags.programme?.length) ? 'choose --programme <name> or --all-programmes' : null)) };
export const ROUTES = {
  create: createRoute,
  inspect: archiveRoute,
  verify: archiveRoute,
  restore: restoreRoute,
  status: idRoute,
  resume: idRoute,
  release: idRoute,
  '*': { check: ({ positional }) => `no backup action ${positional[0] || ''}`.trim() },
};

export function usage() { return commandUsage('backup'); }

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const [action, ...rest] = argv;
  if (!Object.hasOwn(ROUTES, action || '')) return refusal(stderr, `unknown mc backup action: ${action || '(missing)'}`);
  const booleans = ['--json'];
  const values = action === 'status' || action === 'resume' || action === 'release' ? ['--id'] : action === 'restore' ? ['--archive', '--output'] : action === 'create' ? ['--output'] : ['--archive'];
  const scanned = scanArgs(rest, { booleans: action === 'create' ? createRoute.booleans : booleans, repeatable: action === 'create' ? createRoute.repeatable : [], strictValues: values });
  if (scanned.error) return refusal(stderr, scanned.error);
  if (scanned.positional.length) return refusal(stderr, `mc backup ${action || ''} takes no ${scanned.positional[0]}`.trim());
  try {
    if (action === 'create') {
      if (!scanned.flags.output) return refusal(stderr, 'mc backup create needs --output <absolute-path>');
      if (scanned.flags['all-programmes'] && scanned.flags.programme?.length) return refusal(stderr, 'choose --programme <name> or --all-programmes, not both');
      const selection = scanned.flags['all-programmes'] ? (deps.listProgrammes || listProgrammeDirectories)(env) : scanned.flags.programme || [];
      if (!selection.length) return refusal(stderr, 'mc backup create found no programmes to capture');
      const result = (deps.create || createProgrammeBackup)(selection, scanned.flags.output, { env, id: deps.id, inventory: deps.inventory });
      print(stdout, result, scanned.flags.json);
      return result.state === 'draining' ? 1 : 0;
    }
    if (action === 'inspect' || action === 'verify') {
      if (!scanned.flags.archive) return refusal(stderr, `mc backup ${action} needs --archive <path>`);
      const result = action === 'inspect' ? (deps.inspect || inspectArchive)(scanned.flags.archive) : summarizeVerified((deps.verify || verifyArchive)(scanned.flags.archive));
      print(stdout, result, scanned.flags.json);
      return 0;
    }
    if (action === 'restore') {
      if (!scanned.flags.archive || !scanned.flags.output) return refusal(stderr, 'mc backup restore needs --archive <path> and --output <inactive-root>');
      const result = (deps.restore || restoreArchive)(scanned.flags.archive, scanned.flags.output, { env });
      print(stdout, result, scanned.flags.json);
      return 0;
    }
    if (action === 'status' || action === 'resume' || action === 'release') {
      if (!scanned.flags.id) return refusal(stderr, `mc backup ${action} needs --id <id>`);
      if (action === 'resume') {
        const resumed = (deps.resumeBackup || resumeBackupLifecycle)(scanned.flags.id, { env });
        print(stdout, { transaction: resumed, pending_writers: [] }, scanned.flags.json);
        return 0;
      }
      const status = (deps.status || backupStatus)(scanned.flags.id, { env });
      if (action === 'release') {
        if (status.transaction.state !== 'held') return refusal(stderr, `backup ${scanned.flags.id} is ${status.transaction.state}; release requires a held backup`);
        const released = (deps.transition || transitionBackup)(scanned.flags.id, status.transaction.generation, 'released', { env });
        print(stdout, { transaction: released, pending_writers: [] }, scanned.flags.json);
      } else print(stdout, status, scanned.flags.json);
      return 0;
    }
    return refusal(stderr, `unknown mc backup action: ${action || '(missing)'}`);
  } catch (error) {
    stderr.write(`mc: backup ${action || ''} failed: ${error.message}\n`.replace('backup  failed', 'backup failed'));
    return 1;
  }
}

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { programsHome } from '../paths.js';

function listProgrammeDirectories(env) {
  try { return readdirSync(programsHome(env), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function summarizeVerified({ manifest, manifest_sha256, bytes }) {
  return { verified: true, schema: manifest.schema, version: manifest.version, programmes: manifest.programmes,
    members: manifest.members.length, bundles: manifest.bundles.length, manifest_sha256, bytes };
}

function print(stdout, value, json) {
  if (json) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); return; }
  if (value.state === 'inactive') {
    stdout.write(`restored inactive content to ${value.path}\n`);
    stdout.write(`programmes: ${value.programmes.join(', ')}\n`);
    stdout.write(`completeness: ${value.completeness}\n`);
    return;
  }
  if (value.transaction) {
    stdout.write(`backup ${value.transaction.id}: ${value.transaction.state}\n`);
    if (value.pending_writers?.length) stdout.write(`pending writers: ${value.pending_writers.length}\n`);
    else stdout.write('pending writers: none\n');
  } else if (value.verified !== undefined) {
    stdout.write(`archive verified: ${value.verified ? 'yes' : 'no'}\n`);
    stdout.write(`${value.programmes.length} programme(s), ${value.members} member(s), ${value.bundles} bundle(s)\n`);
  } else if (value.archive) stdout.write(`backup ${value.transaction.id}: ${value.archive.path}\n`);
  else stdout.write(`${value.programmes.join(', ')}: ${value.members} member(s), ${value.bundles} bundle(s) — ${value.manifest_sha256}\n`);
}

function refusal(stderr, message) { stderr.write(`mc: ${message}\n${usage()}`); return 2; }
