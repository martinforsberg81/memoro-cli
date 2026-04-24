/**
 * memoro-cli hook install / uninstall [--tool <id>]
 *
 * Wires the SessionStart (lens pull) + SessionEnd (session upload) hooks
 * into the target tool's config. Default tool = claude-code.
 */

import { readConfig, updateConfig } from '../lib/config.js';
import { getAdapter, detectInstalled } from '../adapters/index.js';
import { listSections } from './show.js';

export async function hookInstall(argv) {
  const flags = parseFlags(argv);
  const targets = resolveTargets(flags);
  if (targets.length === 0) {
    console.error('No coding tools detected. Specify --tool explicitly.');
    return 1;
  }

  const config = await readConfig();
  const installed = { ...(config.installedHooks || {}) };
  const sections = listSections();

  for (const adapter of targets) {
    console.error(`Installing hooks for ${adapter.LABEL}…`);
    try {
      const configPath = await adapter.installHooks({ memoroCliBin: flags.bin });
      installed[adapter.ID] = {
        installedAt: new Date().toISOString(),
        configPath,
      };
      console.error(`  ✓ ${configPath}`);

      if (typeof adapter.installCommands === 'function') {
        const written = await adapter.installCommands({
          memoroCliBin: flags.bin,
          sections,
        });
        if (written.length > 0) {
          console.error(`  ✓ ${written.length} slash command${written.length === 1 ? '' : 's'} in ${dirOf(written[0])}`);
        }
      }
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }
  }

  await updateConfig({ installedHooks: installed });
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

  for (const adapter of targets) {
    console.error(`Removing hooks for ${adapter.LABEL}…`);
    try {
      await adapter.uninstallHooks();
      if (typeof adapter.uninstallCommands === 'function') {
        const removed = await adapter.uninstallCommands();
        if (removed.length > 0) {
          console.error(`  ✓ ${removed.length} slash command${removed.length === 1 ? '' : 's'} removed`);
        }
      }
      delete installed[adapter.ID];
      console.error(`  ✓ removed`);
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }
  }

  await updateConfig({ installedHooks: installed });
  return 0;
}

function parseFlags(argv) {
  const flags = { tool: null, bin: 'memoro-cli' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tool' && argv[i + 1]) { flags.tool = argv[++i]; continue; }
    if (a === '--bin' && argv[i + 1])  { flags.bin = argv[++i]; continue; }
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
