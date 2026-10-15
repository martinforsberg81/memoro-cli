/**
 * `mc dev open <surface>` and `mc dev surfaces` — the app where the work is,
 * in one call.
 *
 * Both read memoro's `.mc/shot.json`, not the dev-server protocol: the
 * surfaces, their paths and summaries, and the `accounts` table with each
 * account's onboarding states as `/dev/login` paths. mc knows no selector and
 * no account; it chooses the worktree as `mc shot` does (`shotWorktree`),
 * starts or restarts its server through `ensureAppServer`, and builds one URL:
 * the account's sign-in path with `next` set to the surface.
 *
 * Without `--open` the answer is that URL, on one line with the account, its
 * state and the tree served. With `--open` memoro's capture script, in mode
 * `open`, leaves a headed browser on the surface (`runOpen`), and mc returns
 * as soon as the script says the surface is open.
 */
import {
  parseViewport, readShotDeclaration, resolveAccount, resolveTarget, runOpen, shotWorktree,
} from './shot.js';
import { ensureAppServer, readDeclaration } from './test-environment.js';
import { servedTree } from './commands/shot.js';

/** `mc dev surfaces [--json]`: every declared target, then the accounts. No server. */
export function surfaces(opts, { stdout, stderr, deps = {} }) {
  const read = shotDeclaration(opts, deps);
  if (read.error) { stderr.write(`mc: ${read.error}\n`); return 1; }
  const { worktree, declared } = read;
  const targets = declared.targets || [];
  const accounts = Object.fromEntries(Object.entries(declared.accounts || {})
    .map(([name, account]) => [name, Object.keys(account?.onboarding || {})]));
  const defaultAccount = declared.default_account || Object.keys(accounts)[0] || null;

  if (opts.json) {
    stdout.write(`${JSON.stringify({
      schema_version: 1,
      worktree,
      surfaces: targets.map((target) => ({
        name: target.name,
        path: target.path ?? null,
        summary: target.summary ?? null,
        window: target.window ?? null,
        scroller: target.scroller ?? null,
        chrome: target.chrome ?? [],
        measure: Object.keys(target.measure || {}),
        onboarding: target.onboarding ?? null,
      })),
      accounts,
      default_account: defaultAccount,
    }, null, 2)}\n`);
    return 0;
  }

  const nameWidth = Math.max(0, ...targets.map((target) => String(target.name).length));
  const pathWidth = Math.max(0, ...targets.map((target) => String(target.path || '').length));
  for (const target of targets) {
    stdout.write(`${String(target.name).padEnd(nameWidth)}  ${String(target.path || '').padEnd(pathWidth)}  ${target.summary || '-'}\n`);
  }
  // The default first, then the rest as declared.
  const names = Object.keys(accounts).sort((a, b) => (b === defaultAccount) - (a === defaultAccount));
  if (names.length) {
    stdout.write(`\naccounts: ${names.map((name) => `${name} (${accounts[name].join(', ')})`).join(' · ')}\n`);
  }
  return 0;
}

/**
 * `mc dev open <surface>`: the target and the account are resolved before any
 * server, so a wrong word costs nothing; then the server, then the URL.
 */
export async function open(opts, { stdout, stderr, deps = {} }) {
  const env = deps.env || process.env;
  const read = shotDeclaration(opts, deps);
  if (read.error) { stderr.write(`mc: ${read.error}\n`); return 1; }
  const { worktree, declared } = read;

  const target = resolveTarget(opts.surface, declared);
  if (!target.ok) { stderr.write(`mc: ${target.error}\n`); return 2; }
  const entry = target.target.name ? (declared.targets.find((item) => item.name === target.target.name) ?? null) : null;
  const resolved = resolveAccount(declared, { account: opts.account, onboarding: opts.onboarding, entry });
  if (!resolved.ok) { stderr.write(`mc: ${resolved.error}\n`); return 2; }
  let viewport = null;
  if (opts.open) {
    if ((deps.platform || process.platform) === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
      stderr.write('mc: --open needs a display, and this machine has none — drop --open for the URL\n');
      return 2;
    }
    viewport = parseViewport(opts.viewport, declared);
    if (!viewport.ok) { stderr.write(`mc: ${viewport.error}\n`); return 2; }
  }

  const test = readDeclaration(worktree);
  if (!test.ok) { stderr.write(`mc: ${test.error}\n`); return 1; }
  const app = await (deps.ensureAppServer || ensureAppServer)(worktree, test.declaration, { json: opts.json, stdout: stderr, deps });
  if (!app.ok) { stderr.write(`mc: ${app.error}\n`); return 1; }
  const served = (deps.servedTree || servedTree)(worktree, app.server, deps);

  const url = new URL(resolved.path, app.baseUrl);
  url.searchParams.set('next', entry?.path ?? opts.surface);
  const then = (entry?.open || []).map((step) => step.click).filter(Boolean);

  if (opts.open) {
    const request = {
      mode: 'open',
      base_url: app.baseUrl,
      account: resolved.account,
      sign_in: { kind: 'url', url: url.href },
      target: target.target,
      viewport: viewport.viewport,
      theme: opts.theme,
      locale: opts.locale,
      safe_area: opts.safeArea,
      onboarding: resolved.state === 'fresh',
    };
    const ran = await (deps.runOpen || runOpen)({ worktree, declaration: declared, request, env, deps });
    if (!ran.ok) { stderr.write(`mc: ${ran.error}\n`); return 1; }
    if (!ran.result.ok) {
      stderr.write(`mc: ${[ran.result.code, ran.result.error].filter(Boolean).join(': ') || 'the browser did not open'} — ${ran.log}\n`);
      return 1;
    }
    for (const warning of ran.result.warnings || []) stderr.write(`mc: warning — ${warning}\n`);
  }

  if (opts.json) {
    stdout.write(`${JSON.stringify({
      url: url.href, account: resolved.account, onboarding: resolved.state, surface: opts.surface, served, then,
    }, null, 2)}\n`);
  } else {
    stdout.write(`${url.href}  ${resolved.account}/${resolved.state}  ${served.branch} @ ${served.commit}\n`);
    // Clicks a person or a browser tool makes after landing; --open made them.
    if (then.length && !opts.open) stdout.write(`then click: ${then.join(' → ')}\n`);
  }
  if (resolved.state === 'fresh') stderr.write(`mc: opening this URL reseeds ${resolved.account} each time\n`);
  if (opts.open) {
    stderr.write(`mc: a browser is open on ${opts.surface} at ${viewport.label} — close its window when you are done\n`);
  }
  return 0;
}

function shotDeclaration(opts, deps) {
  const chosen = shotWorktree({
    cwd: deps.cwd || process.cwd(), env: deps.env || process.env, here: opts.here, deps,
  });
  if (!chosen.worktree) return { error: chosen.error };
  const shot = readShotDeclaration(chosen.worktree);
  if (!shot.ok) return { error: shot.error };
  return { worktree: chosen.worktree, declared: shot.declaration };
}
