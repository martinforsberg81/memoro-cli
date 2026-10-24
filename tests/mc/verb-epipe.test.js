/**
 * A verb whose stdout reader closes early ends quietly.
 *
 * `mc project discard x | grep -q 'would remove'` and `mc … | head -1` close
 * the pipe while the verb is still writing. Before `quietOnClosedReader`, node
 * raised EPIPE as an unhandled `error` event and the stack trace went to
 * stderr. The fixture writes far more than a pipe buffer holds, so the reader
 * is gone while the verb is still going.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const VERBS = pathToFileURL(join(here, '..', '..', 'src', 'mc-verbs.js')).href;
const FIXTURE = pathToFileURL(join(here, '..', 'fixtures', 'many-lines-verb.js')).href;

/**
 * Run `runModule(FIXTURE, argv)` in a child process and resolve with its exit
 * code and stderr. With `closeStdoutEarly`, the parent destroys the child's
 * stdout at the first chunk, the way `| grep -q` and `| head -1` do.
 */
function runFixture(argv, { closeStdoutEarly = false } = {}) {
  const script = `
    import { runModule } from ${JSON.stringify(VERBS)};
    process.exitCode = await runModule(${JSON.stringify(FIXTURE)}, ${JSON.stringify(argv)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
  if (closeStdoutEarly) child.stdout.once('data', () => child.stdout.destroy());
  else child.stdout.resume();
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('a verb whose stdout reader closes early', () => {
  it('ends quietly, with its own exit code and no stack trace on stderr', async () => {
    const { code, stderr } = await runFixture([], { closeStdoutEarly: true });
    assert.equal(code, 3, `stderr:${stderr}`);
    assert.doesNotMatch(stderr, /EPIPE|Error:/u);
  });

  it('still reports an error that is not a closed reader, and exits non-zero', async () => {
    const { code, stderr } = await runFixture(['boom']);
    assert.notEqual(code, 0);
    assert.match(stderr, /boom/u);
  });
});
