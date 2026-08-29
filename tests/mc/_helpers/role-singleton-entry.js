#!/usr/bin/env node
/**
 * The door `mc pm` and `mc pm-helper` used to be.
 *
 * Both verbs went dormant with decision mc-1 — they answer one line and exit
 * 2 — while the machinery underneath them stays until the wider surface cut.
 * Code that is kept is code that is tested, so the singleton's semantics are
 * still exercised end to end, through the same subprocess shape as before,
 * against `role-singleton.js` directly rather than through a dispatch that
 * no longer routes there.
 */
import { runRoleSingleton } from '../../../src/mc/commands/role-singleton.js';

const [role, ...argv] = process.argv.slice(2);
process.exitCode = (await runRoleSingleton(role, argv)) ?? 0;
