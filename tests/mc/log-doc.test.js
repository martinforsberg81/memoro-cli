/**
 * `docs/technical/mc-log.md` is the close-out doc for the record mc keeps: it
 * exists so somebody who has never opened `logger.js` can say what is written
 * down, what is deliberately refused, and why a start with no end is the shape
 * that catches a killed round.
 *
 * A doc about a privacy rule is the kind that must not be allowed to drift:
 * prose promising that a message is never recorded, sitting beside code that
 * records it, is worse than no prose. So every constant and every rule the
 * doc states is read back out and compared with the code it describes — the
 * same way `merge-doc.test.js` pins the landing verb and `run-doc.test.js`
 * the runner.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { invocationShape, runId } from '../../src/mc/logger.js';
import { parseArgs } from '../../src/mc/commands/log.js';
import { HELP_TEXT } from '../../src/mc/help-text.js';

const DOC = readFileSync(fileURLToPath(new URL('../../docs/technical/mc-log.md', import.meta.url)), 'utf8');
const LOGGER = readFileSync(fileURLToPath(new URL('../../src/mc/logger.js', import.meta.url)), 'utf8');

describe('docs/technical/mc-log.md says what the code does', () => {
  it('states the file mode and rotation the logger actually uses', () => {
    assert.match(DOC, /append-only JSONL under mc's home, `0600`, rotated at 8 MB/u);
    assert.match(LOGGER, /const MAX_LOG_BYTES = 8 \* 1024 \* 1024;/u);
    assert.match(LOGGER, /mode: 0o600/u);
  });

  it('states the identifier limit the filter enforces', () => {
    assert.match(DOC, /64\s*\n?\s*characters at most/u);
    assert.deepEqual(invocationShape(['merge', 'memoro', 'x'.repeat(65)]).args, [],
      'a positional past the limit the doc states is not recorded');
    assert.deepEqual(invocationShape(['merge', 'memoro', 'x'.repeat(64)]).args, ['x'.repeat(64)]);
  });

  it('every example positional the doc says passes, passes', () => {
    for (const word of ['memoro', '11082', '#473', 'mc-log']) {
      assert.match(DOC, new RegExp(`\`${word.replace('#', '#')}\``, 'u'), `the doc no longer claims ${word} passes`);
      assert.deepEqual(invocationShape(['merge', 'x', word]).args, [word], `${word} should be recorded`);
    }
  });

  it('every free-text verb the doc names actually drops its positionals', () => {
    const named = /`send`, `dispatch`, `claim`,\n`helper`, `pm`/u.exec(DOC);
    assert.ok(named, 'the doc no longer lists the free-text verbs');
    for (const verb of ['send', 'dispatch', 'claim', 'helper', 'pm']) {
      // As a subcommand (`mc work send x "…"`) and as the verb itself.
      assert.deepEqual(invocationShape(['work', verb, 'area', 'a message']).args, []);
      assert.deepEqual(invocationShape([verb, 'anything', 'at all']).args, []);
    }
  });

  it('makes the promise about messages that the code keeps', () => {
    assert.match(DOC, /must never put a person's words in a file that\nlives forever/u);
    const shape = invocationShape(['work', 'send', 'pm', 'SLUTRAPPORT — klar']);
    assert.equal(JSON.stringify(shape).includes('SLUTRAPPORT'), false);
  });

  it('states that a flag value is dropped without being inspected', () => {
    assert.match(DOC, /`--model opus` is recorded as `--model`/u);
    const shape = invocationShape(['run', '--model', 'opus']);
    assert.deepEqual(shape.flags, ['--model']);
    assert.deepEqual(shape.args, []);
  });

  it('states the run id shape the logger generates', () => {
    assert.match(DOC, /a process-lifetime\nid, generated on first use, never accepted from outside/u);
    assert.match(runId(), /^run_[0-9a-f]{12}$/u);
  });

  it('every flag in the doc\'s usage block is a flag the command accepts', () => {
    const block = /```\n(mc log[\s\S]*?)```/u.exec(DOC);
    assert.ok(block, 'the doc no longer has a usage block');
    const flags = [...new Set(block[1].match(/--[a-z]+/gu) || [])];
    assert.ok(flags.length >= 7, `expected the usage block to document the flags, saw ${flags}`);
    for (const flag of flags) {
      const parsed = parseArgs([flag, ...(['--limit', '--since', '--repo', '--verb'].includes(flag) ? ['1'] : [])]);
      assert.equal(parsed.error, undefined, `${flag} is documented but not accepted`);
    }
  });

  it('the doc and the help text agree that mc log only reads', () => {
    assert.match(DOC, /It does not release it\./u);
    assert.match(HELP_TEXT, /releasing one stays your decision/u);
  });

  it('names the incident with the numbers that are in the lease log', () => {
    // The doc's authority is that it describes something that happened. If
    // the numbers go, so does the reason anybody believes the rest of it.
    assert.match(DOC, /#11082/u);
    assert.match(DOC, /#11085/u);
    assert.match(DOC, /pid 175/u);
  });
});
