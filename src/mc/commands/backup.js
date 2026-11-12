/** Inspect and verify a locally held programme backup archive. */
import { backupStatus, resumeBackup as resumeBackupLifecycle, transitionBackup } from '../programme-lifecycle.js';
import { inspectArchive, verifyArchive } from '../backup-archive.js';
import { commandUsage } from '../command-help.js';
import { scanArgs } from './flags.js';

const archiveRoute = { booleans: ['--json'], strictValues: ['--archive'], check: ({ flags, positional }) => positional.length ? `takes no ${positional[0]}` : (flags.archive ? null : 'needs --archive <path>') };
const idRoute = { booleans: ['--json'], strictValues: ['--id'], check: ({ flags, positional }) => positional.length ? `takes no ${positional[0]}` : (flags.id ? null : 'needs --id <id>') };
export const ROUTES = {
  inspect: archiveRoute,
  verify: archiveRoute,
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
  const values = action === 'status' || action === 'resume' || action === 'release' ? ['--id'] : ['--archive'];
  const scanned = scanArgs(rest, { booleans, strictValues: values });
  if (scanned.error) return refusal(stderr, scanned.error);
  if (scanned.positional.length) return refusal(stderr, `mc backup ${action || ''} takes no ${scanned.positional[0]}`.trim());
  try {
    if (action === 'inspect' || action === 'verify') {
      if (!scanned.flags.archive) return refusal(stderr, `mc backup ${action} needs --archive <path>`);
      const result = action === 'inspect' ? (deps.inspect || inspectArchive)(scanned.flags.archive) : summarizeVerified((deps.verify || verifyArchive)(scanned.flags.archive));
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

function summarizeVerified({ manifest, manifest_sha256, bytes }) {
  return { verified: true, schema: manifest.schema, version: manifest.version, programmes: manifest.programmes,
    members: manifest.members.length, bundles: manifest.bundles.length, manifest_sha256, bytes };
}

function print(stdout, value, json) {
  if (json) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); return; }
  if (value.transaction) {
    stdout.write(`backup ${value.transaction.id}: ${value.transaction.state}\n`);
    if (value.pending_writers?.length) stdout.write(`pending writers: ${value.pending_writers.length}\n`);
    else stdout.write('pending writers: none\n');
  } else if (value.verified !== undefined) {
    stdout.write(`archive verified: ${value.verified ? 'yes' : 'no'}\n`);
    stdout.write(`${value.programmes.length} programme(s), ${value.members} member(s), ${value.bundles} bundle(s)\n`);
  } else stdout.write(`${value.programmes.join(', ')}: ${value.members} member(s), ${value.bundles} bundle(s) — ${value.manifest_sha256}\n`);
}

function refusal(stderr, message) { stderr.write(`mc: ${message}\n${usage()}`); return 2; }
