#!/usr/bin/env node

// Preserve the existing node-pty repair, then mint a value-free C1 install
// generation. Receipt failure is fail-closed for C1 but must not make ordinary
// mc installation or provider use unavailable.
await import('./fix-pty-helper.js');

const {
  shouldWriteInstalledC1Receipt,
  writeInstalledC1Receipt,
} = await import('../src/mc/broker/c1-install-receipt.js');
const {
  baselineInstalledC1Epoch,
} = await import('../src/mc/broker/c1-global-interlock.js');
if (shouldWriteInstalledC1Receipt()) {
  const receipt = writeInstalledC1Receipt();
  const baseline = receipt.ok ? baselineInstalledC1Epoch() : null;
  if (!receipt.ok) {
    process.stderr.write('memoro-cli: C1 install receipt unavailable; Claude C1 stays disabled until reinstall.\n');
  } else if (!baseline?.ok) {
    process.stderr.write('memoro-cli: C1 install baseline unavailable; Claude C1 stays disabled until reinstall.\n');
  }
}
