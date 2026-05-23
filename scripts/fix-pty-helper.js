#!/usr/bin/env node
/**
 * Postinstall: ensure node-pty's spawn-helper binary is executable.
 *
 * node-pty ships prebuilt binaries per platform. The `spawn-helper`
 * inside each prebuild needs the execute bit set to function — but
 * npm's tar extraction strips it on some installs, leaving fresh
 * `npm install -g memoro-cli` users with a `posix_spawnp failed`
 * runtime error the moment they invoke `mc`. We chmod it back on
 * postinstall as belt-and-suspenders.
 *
 * Silent unless something unexpected happens. Best-effort per platform.
 */

import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
];

const ptyPrebuilds = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');

for (const platform of PLATFORMS) {
  const helper = join(ptyPrebuilds, platform, 'spawn-helper');
  if (existsSync(helper)) {
    try {
      chmodSync(helper, 0o755);
    } catch { /* best effort */ }
  }
}
