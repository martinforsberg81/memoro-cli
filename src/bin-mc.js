#!/usr/bin/env node
/**
 * mc — capability dispatch.
 *
 * `src/mc-cli.js` owns the session verbs. Everything else — auth, vault,
 * connections, GitHub, dev services — routes through here.
 *
 * This file used to be the whole product: it wrapped a coding tool in a PTY
 * this process owned, registered the session in a global registry, and talked
 * to a global broker. That path is gone. A session is created with `mc new`
 * and entered with `mc open`, both of which own their own runtime, and
 * neither is gated on being inside a Git repository — mc manages sessions on
 * a machine, and a repository is one thing a session's workspace may happen
 * to be.
 */

import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELP_TEXT } from './mc/help-text.js';
import { readConfig, getApiUrl } from './lib/config.js';
import { needsDeviceAuth, runDeviceFlow } from './lib/device-flow.js';
import {
  requireLocalAuthMode,
  resolveLocalAuthModeFromArgv,
} from './mc/local-auth-mode.js';

// Capability subcommands, lazy-loaded so cold start stays cheap.
const CAPABILITIES = {
  'install-shell': () => import('./cli/install-shell.js'),
  auth:          () => import('./cli/auth.js'),
  connections:   () => import('./cli/connections.js'),
  github:        () => import('./cli/github.js'),
  setup:         () => import('./cli/setup.js'),
  vault:         () => import('./cli/vault.js'),
  'tool-auth':   () => import('./cli/tool-auth.js'),
  'coding-profile': () => import('./cli/coding-profile.js'),
  dev:           () => import('./cli/dev.js'),
  deps:          () => import('./cli/deps.js'),
  migrate:       () => import('./mc/commands/migrate.js'),
  restart:       () => import('./cli/restart.js'),
  'cloud-session': () => import('./cli/cloud-session.js'),
  'cloud-runtime': () => import('./cli/cloud-runtime.js'),
  security:      () => import('./cli/security.js'),
};

export async function main() {
  // The shell wrapper installed by `mc install-shell` appends
  // --emit-shell-directives to every invocation. Strip it once here so
  // individual commands don't need to know about it; expose the enabled state
  // via MC_EMIT_SHELL_DIRECTIVES so shell-directives.emitCd picks it up.
  const rawArgv = process.argv.slice(2);
  const stripped = [];
  let directivesEnabled = false;
  for (const a of rawArgv) {
    if (a === '--emit-shell-directives') { directivesEnabled = true; continue; }
    stripped.push(a);
  }
  if (directivesEnabled) process.env.MC_EMIT_SHELL_DIRECTIVES = '1';
  const argv = stripped;

  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(HELP_TEXT);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(await packageVersion());
    return 0;
  }

  const earlyAuthMode = requireLocalAuthMode(resolveLocalAuthModeFromArgv(argv));
  if (!earlyAuthMode.ok) {
    console.error(`mc: ${earlyAuthMode.error}`);
    return 1;
  }

  // Fresh-install path: with no Memoro token stored and a real TTY, run the
  // OAuth device flow before dispatching. The device code is opaque to the
  // rest of mc, so the user re-runs their command afterwards.
  if (await needsDeviceAuth({ argv })) {
    const apiUrl = getApiUrl(argv) || (await readConfig()).apiUrl;
    return runDeviceFlow({ apiUrl });
  }

  if (Object.hasOwn(CAPABILITIES, argv[0])) {
    const mod = await CAPABILITIES[argv[0]]();
    return mod.run(argv.slice(1));
  }

  const word = argv[0];
  const vaultVerbs = [
    'unlock', 'lock', 'devices', 'revoke-device', 'adopt', 'hydrate',
    'recovery', 'recover', 'import', 'bind', 'bindings',
  ];
  const suggestion = word && vaultVerbs.includes(word)
    ? ` Did you mean \`mc vault ${word}\`?`
    : '';
  console.error(
    `mc: unknown command "${word ?? ''}".${suggestion} Run \`mc --help\` for the command list.`,
  );
  return 2;
}

async function packageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
}

// Only run main() when invoked as a script — not when imported.
// Compare via realpath because npm installs the bin as a symlink.
if (isEntryScript()) {
  main()
    .then(code => { process.exitCode = code ?? 0; })
    .catch((err) => {
      const advice = missingDependencyAdvice(err);
      console.error(advice ? `mc: ${advice}` : (err?.stack || err?.message || String(err)));
      process.exitCode = 1;
    });
}

function isEntryScript() {
  try {
    const here = fileURLToPath(import.meta.url);
    const argv1 = realpathSync(process.argv[1]);
    return here === argv1;
  } catch {
    return false;
  }
}

/**
 * mc's own runtime dependencies are loaded lazily, deep inside a command, so
 * a missing one used to surface as a raw `ERR_MODULE_NOT_FOUND` stack after
 * the command had already reported success — `mc new` printed "created local
 * session", then a Node trace about `@xterm/addon-serialize`. The remedy was
 * `npm ci` in mc's own directory, which the stack never mentioned.
 *
 * This is a real state, not a corrupt install: mc runs from a checkout that
 * `git pull` can move ahead of its `node_modules`.
 */
export function missingDependencyAdvice(error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') return null;
  const match = /Cannot find package '([^']+)'/u.exec(error.message || '');
  if (!match) return null;
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  return `mc's own dependencies are not installed — missing '${match[1]}'\n`
    + `    run: npm ci --prefix ${packageRoot.replace(/\/$/u, '')}`;
}
