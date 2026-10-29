// A fixture installation that reports every control capability, running the
// operator's `mc programme` verbs as their own process. Test-only: production
// has no switch that supplies this report.
import { run } from '../../../src/mc/commands/programme.js';
import { CONTROL_CAPABILITIES } from '../../../src/mc/programme-control.js';
import { DEFAULT_CATALOG } from '../../../src/mc/model-config.js';

process.exitCode = await run(process.argv.slice(2), {
  capabilities: { supported: [...CONTROL_CAPABILITIES], reason: null },
  catalog: () => DEFAULT_CATALOG,
});
