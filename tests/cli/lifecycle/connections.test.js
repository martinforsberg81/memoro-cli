import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { run, parseArgs } from '../../../src/cli/connections.js';
import { runMc } from '../../mc/_helpers/cli.js';

function io() {
  let out = ''; let err = '';
  return {
    stdout: { write: (value) => { out += value; } },
    stderr: { write: (value) => { err += value; } },
    get out() { return out; }, get err() { return err; },
  };
}

describe('mc connections', () => {
  test('parses the provider-neutral surface before side effects', () => {
    assert.deepEqual(parseArgs([]), { verb: 'list', provider: null, json: false, confirm: false });
    assert.deepEqual(parseArgs(['status', 'github', '--json']), {
      verb: 'status', provider: 'github', json: true, confirm: false,
    });
    assert.match(parseArgs(['disconnect']).error, /requires a provider/);
  });

  test('is wired through the mc dispatcher and rejects argv before identity access', () => {
    const result = runMc(['connections', 'unknown-subcommand']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown connections subcommand/);
  });

  test('renders a common list envelope', async () => {
    const output = io();
    const descriptor = {
      schema: 1,
      provider: { id: 'fixture', label: 'Fixture', custody: 'control_plane' },
      state: 'ready', repair_action: null, account: null, resources: [],
      sources: { local: 'ready', cloud: 'ready' }, capabilities: [],
    };
    const code = await run(['--json'], {
      ...output,
      connectionClient: {
        providers: () => [{ ...descriptor.provider, onboarding: true }],
        status: async () => descriptor,
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output.out).connections, [descriptor]);
    assert.equal(output.err, '');
  });

  test('previews disconnect before invoking the mutation', async () => {
    const output = io();
    let mutations = 0;
    const code = await run(['disconnect', 'fixture', '--json'], {
      ...output,
      connectionClient: { disconnect: async () => { mutations += 1; } },
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(output.out).requires_confirmation, true);
    assert.equal(mutations, 0);
  });
});
