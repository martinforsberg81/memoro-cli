/**
 * Test-runner safety net: no suite may ever see the user's real mc home.
 *
 * A bare readRegistry() (or any MC_HOME-defaulting path) that escapes a
 * fixture was a silent no-op for as long as reads never changed anything —
 * until the registry v3 heal-on-read migration ran under a leaked default
 * and rewrote the REAL ~/.memoro/mc/registry.json mid-development. Reads
 * that mutate are legitimate (that is what self-healing means), so the
 * invariant must live here instead: the runner starts with MC_HOME already
 * pointing at a throwaway directory, and a suite that manages its own
 * MC_HOME keeps overriding it exactly as before.
 *
 * Loaded via --import before any test module (see the npm test script).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.MC_HOME) {
  process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-test-isolated-home-'));
}
