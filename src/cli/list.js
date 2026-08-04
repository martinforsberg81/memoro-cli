import { checkAndPrintFreshInstall } from '../mc/first-run.js';
import { fetchCloudSessionProjections } from '../mc/cloud-session-v1-client.js';
import { listLocalSessionProjectionsSync } from '../mc/session-v1.js';
import {
  buildV1SessionListView,
  projectV1SessionJson,
  renderV1SessionList,
} from '../mc/session-v1-list.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }
  await (deps.checkAndPrintFreshInstall || checkAndPrintFreshInstall)();

  let local = { sessions: [], issues: [] };
  try {
    if (!opts.cloudOnly) {
      local = (deps.listLocalSessions || listLocalSessionProjectionsSync)({
        mcHomeDir: deps.mcHomeDir,
      });
    }
  } catch (error) {
    stderr.write(`mc: local session catalog unavailable (${error?.reason || error?.message || 'unknown'})\n`);
    return 1;
  }

  const cloud = opts.localOnly
    ? { ok: true, sessions: [], warning: null }
    : await (deps.fetchCloudSessions || fetchCloudSessionProjections)({ argv, deps });
  const localSessions = opts.all
    ? local.sessions
    : local.sessions.filter((session) => session.lifecycle !== 'archived');
  const cloudSessions = opts.all
    ? cloud.sessions
    : cloud.sessions.filter((session) => session.lifecycle !== 'archived');
  const view = buildV1SessionListView({ localSessions, cloudSessions });

  if (opts.names) {
    for (const session of view.entries) {
      const prefix = session.source_kind === 'cloud' ? 'cloud:' : '';
      stdout.write(`${prefix}${session.name}\n`);
    }
    return 0;
  }
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      schema: 1,
      entries: view.entries.map(projectV1SessionJson),
      local_issues: local.issues,
      cloud_warning: cloud.warning || null,
    }, null, 2)}\n`);
    return 0;
  }

  stdout.write(renderV1SessionList({
    view,
    terminalWidth: stdout.columns || 120,
    useColor: Boolean(stdout.isTTY && deps.env?.NO_COLOR !== '1' && process.env.NO_COLOR !== '1'),
    cloudWarning: cloud.warning,
    issues: local.issues,
  }));
  return 0;
}

export function parseArgs(argv) {
  const opts = {
    all: false,
    json: false,
    names: false,
    localOnly: false,
    cloudOnly: false,
  };
  for (const arg of argv) {
    if (arg === '--all') { opts.all = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--names') { opts.names = true; continue; }
    if (arg === '--local') { opts.localOnly = true; continue; }
    if (arg === '--cloud') { opts.cloudOnly = true; continue; }
    if (arg === '--rich') continue;
    return { ...opts, error: `unknown flag: ${arg}` };
  }
  if (opts.localOnly && opts.cloudOnly) {
    return { ...opts, error: '--local and --cloud cannot be combined' };
  }
  if (opts.json && opts.names) return { ...opts, error: '--json and --names cannot be combined' };
  return opts;
}

export function parseDurationMinutes(spec) {
  if (spec == null) return null;
  const match = String(spec).trim().match(/^(\d+)([smhd])?$/iu);
  if (!match) return null;
  const value = Number(match[1]);
  return value * ({ s: 1 / 60, m: 1, h: 60, d: 1440 }[(match[2] || 'm').toLowerCase()]);
}
