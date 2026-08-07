/**
 * memoro-cli hook install / uninstall [--tool <id>]
 *
 * Wires legacy raw-tool hooks where an adapter still supports them.
 * The normal Memoro entrypoint is `mc`; adapters may return a skipped
 * result when raw-tool mutation is intentionally disabled.
 */

import { readConfig, updateConfig } from '../lib/config.js';
import { getAdapter, detectInstalled } from '../adapters/index.js';

export async function hookInstall(argv) {
  const flags = parseFlags(argv);
  const targets = resolveTargets(flags);
  if (targets.length === 0) {
    console.error('No coding tools detected. Specify --tool explicitly.');
    return 1;
  }

  const config = await readConfig();
  const installed = { ...(config.installedHooks || {}) };
  let changed = false;

  for (const adapter of targets) {
    console.error(`Installing hooks for ${adapter.LABEL}…`);
    try {
      const result = await adapter.installHooks({ memoroCliBin: flags.bin });
      if (result?.skipped) {
        console.error(`  - skipped: ${result.reason}`);
        if (result.legacyCleanupHint) console.error(`  - ${result.legacyCleanupHint}`);
        continue;
      }
      const configPath = result?.configPath || result?.path || result;
      installed[adapter.ID] = {
        installedAt: new Date().toISOString(),
        configPath,
      };
      changed = true;
      console.error(`  ✓ ${configPath}`);

      if (typeof adapter.installUpdateCommand === 'function') {
        try {
          await adapter.installUpdateCommand({ memoroCliBin: flags.bin });
          console.error('  ✓ /memoro-update slash command installed');
        } catch { /* best effort — non-fatal if the update command fails */ }
      }
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }
  }

  if (changed) await updateConfig({ installedHooks: installed });
  return 0;
}

function dirOf(filePath) {
  const idx = filePath.lastIndexOf('/');
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

export async function hookUninstall(argv) {
  const flags = parseFlags(argv);
  const targets = resolveTargets(flags, { installedOnly: true });
  if (targets.length === 0) {
    console.error('No installed hooks found.');
    return 0;
  }

  const config = await readConfig();
  const installed = { ...(config.installedHooks || {}) };
  let changed = false;

  for (const adapter of targets) {
    console.error(`Removing hooks for ${adapter.LABEL}…`);
    try {
      const result = await adapter.uninstallHooks();
      if (Array.isArray(result?.removed) && result.removed.length > 0) {
        console.error(`  ✓ ${result.removed.length} legacy file${result.removed.length === 1 ? '' : 's'} removed`);
      }
      if (!flags.hooksOnly && typeof adapter.uninstallCommands === 'function') {
        const removed = await adapter.uninstallCommands();
        if (removed.length > 0) {
          console.error(`  ✓ ${removed.length} slash command${removed.length === 1 ? '' : 's'} removed`);
        }
      }
      if (adapter.ID in installed) {
        delete installed[adapter.ID];
        changed = true;
      }
      console.error(`  ✓ removed`);
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }
  }

  if (changed) await updateConfig({ installedHooks: installed });
  return 0;
}

function parseFlags(argv) {
  const flags = { tool: null, bin: 'memoro-cli', hooksOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tool' && argv[i + 1]) { flags.tool = argv[++i]; continue; }
    if (a === '--bin' && argv[i + 1])  { flags.bin = argv[++i]; continue; }
    if (a === '--hooks-only')           { flags.hooksOnly = true; continue; }
  }
  return flags;
}

function resolveTargets(flags, { installedOnly = false } = {}) {
  if (flags.tool) {
    return [getAdapter(flags.tool)];
  }
  if (installedOnly) {
    // Don't have a full config map here in the sync path — caller reads it
    // separately. Fall back to detecting installed tools on disk.
    return detectInstalled();
  }
  return detectInstalled();
}
