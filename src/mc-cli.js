#!/usr/bin/env node
/**
 * Thin `mc` entry. The full CLI (src/bin-mc.js) pulls in a large import
 * graph before a single line of main() runs — ~1s of module loading on a
 * typical machine. Help must not pay that tax, so it is answered here
 * from the isolated help text; everything else delegates to the real CLI.
 *
 * Keep this file dependency-free apart from the dynamic imports below.
 */
const argv = process.argv.slice(2);
const first = argv.find((a) => a !== '--emit-shell-directives');

if (first === '--help' || first === '-h' || first === 'help') {
  const { HELP_TEXT } = await import('./mc/help-text.js');
  console.log(HELP_TEXT);
  process.exitCode = 0;
} else {
  const { main } = await import('./bin-mc.js');
  try {
    process.exitCode = (await main()) ?? 0;
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  }
}
