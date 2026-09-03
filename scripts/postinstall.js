#!/usr/bin/env node

// The node-pty repair, and nothing else.
//
// This also minted a value-free C1 install generation until 2026-09-03:
// `src/runtime/broker/c1-install-receipt.js` and `c1-global-interlock.js`
// were the receipt and its baseline, and both went with the broker in
// `mc-cut` step 4. Nothing reads a C1 install generation any more, so
// writing one on every install was a file nobody opened.
await import('./fix-pty-helper.js');
