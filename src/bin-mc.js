#!/usr/bin/env node
/**
 * mc — capability dispatch.
 *
 * `src/mc-cli.js` owns the page and the verbs. What is left here is `mc
 * vault` and the two answers a router owes anyone else: the version, and that
 * a word is not a command.
 *
 * This file used to be the whole product: it wrapped a coding tool in a PTY
 * this process owned, registered the session in a global registry, and talked
 * to a global broker. Then it was the capability dispatcher, and fourteen
 * verbs hung off it. Both of those are what `mc-cut` is taking out.
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

// The one capability that is still a verb, lazy-loaded so cold start stays
// cheap.
//
// Thirteen others stood here until 2026-09-03 — `setup`, `install-shell`,
// `auth`, `tool-auth`, `connections`, `github`, `coding-profile`, `dev`,
// `deps`, `cloud-session`, `cloud-runtime`, `security`, `migrate`. Not one of
// them is reached by the page or by any verb that survives it: they are the
// doors into the session manager, the managed providers and the cloud
// runtimes that `mc-cut` removes. `mc vault` stays by the project's contract,
// deliberately and against what reachability says about parts of it.
//
// `dev` came back on 2026-09-05, and not as it was. It is three verbs in
// `mc-cli.js`'s own table — `list`, `register`, `unregister` — because a
// sibling repository calls them on every `npm run dev` and because
// `mc test dev` now reads the index they keep. What `reach.mjs` could not see
// is exactly that: it is a same-repo static import graph, and memoro's
// `execFile('mc', ['dev', …])` is invisible to it by construction. The cut was
// right about this repository and blind past its edge.
const CAPABILITIES = {
  vault: () => import('./cli/vault.js'),
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
