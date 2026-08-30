/**
 * `docs/technical/mc-helper.md` is the close-out doc: it exists so somebody
 * who has never seen the helper can say what it reads, when it runs, what it
 * writes and who acts on it without opening the source. That only holds while
 * the numbers in it are the numbers in the code, and a doc that names a
 * default goes stale silently — nothing fails when 20 becomes 30.
 *
 * So the doc is pinned. Every constant it states is read back out of the
 * prose here and compared with the export it claims to describe. This is the
 * same arrangement `tests/mc/page.test.js` uses for the palette tables.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DEFAULT_LIMIT, DEFAULT_THRESHOLD, DEPLOY_STALE_HOURS, failingConditions, helperDir, renderState,
} from '../../src/mc/helper-collect.js';
import { DEFAULT_TURN_MINUTES, INTAKE_ROLE } from '../../src/mc/helper-turn.js';
import { INTAKE_LOUD_NAMED } from '../../src/mc/page-collect.js';
import { HELPER_HOUR_UTC, HELPER_KIND, HELPER_NAME } from '../../src/mc/run-plan.js';

const DOC = readFileSync(fileURLToPath(new URL('../../docs/technical/mc-helper.md', import.meta.url)), 'utf8');

/** The one number a sentence in the doc states, by the words around it. */
const number = (pattern) => {
  const match = pattern.exec(DOC);
  assert.ok(match, `the doc no longer says ${pattern}`);
  return Number(match[1]);
};

describe('docs/technical/mc-helper.md says what the code does', () => {
  /**
   * The verb is two doors now, and a doc that describes one of them is worse
   * than a doc that describes neither: somebody reading it would type the
   * wrong thing. So both are pinned — the room the desk stands in, and the
   * role each half wears.
   */
  it('names the desk\'s room and the role each half wears', () => {
    assert.ok(DOC.includes('`~/mc/helper/`'), 'the doc no longer names the desk\'s room');
    assert.match(helperDir({ MC_WORK_ROOT: '/work' }), /\/helper$/u);
    assert.ok(DOC.includes(`\`canon/roles/${INTAKE_ROLE}.md\``), `the doc does not name canon/roles/${INTAKE_ROLE}.md`);
    assert.ok(DOC.includes('`canon/roles/helper.md`'), 'the doc does not name the desk\'s role file');
  });

  it('states the flag defaults the code exports', () => {
    assert.equal(number(/fingerprints asked for; default (\d+)/u), DEFAULT_LIMIT);
    assert.equal(number(/marked `!`; default (\d+)/u), DEFAULT_THRESHOLD);
  });

  it('states the deploy threshold `checkDeployAge` uses', () => {
    assert.equal(number(/own (\d+)-hour threshold/u), DEPLOY_STALE_HOURS);
  });

  it('states when the runner runs it, and under which name', () => {
    const hour = number(/first round\s+after (\d+):00Z/u);
    assert.equal(hour, HELPER_HOUR_UTC);
    assert.match(DOC, new RegExp(`\`${HELPER_NAME}\` in both the name and the kind column`, 'u'));
    assert.match(DOC, new RegExp(`whose \`kind\` is \`${HELPER_KIND}\``, 'u'));
  });

  it('states the turn\'s timeout and how many loud lines the page names', () => {
    assert.equal(number(/timeout (\d+)\s+minutes/u), DEFAULT_TURN_MINUTES);
    assert.equal(INTAKE_LOUD_NAMED, 3, 'the doc says "three named and the rest counted"');
    assert.match(DOC, /three named and the rest counted/u);
  });

  it('names every failing condition the delta can carry', () => {
    const named = new Set([
      ...failingConditions({ deploy: { silent: true }, health: { d1: 'healthy' } }),
      ...failingConditions({ deploy: { stale: true, consecutiveFailures: 1 }, health: { error: 'x' } }),
      ...failingConditions({ deploy: { stale: false, consecutiveFailures: 0 }, health: { d1: 'error' } }),
    ]);
    assert.equal(named.size, 5, 'a new condition needs a line in the doc too');
    for (const name of named) assert.ok(DOC.includes(`\`${name}\``), `the doc does not name ${name}`);
  });

  it('shows the state block the next digest actually parses', () => {
    const shown = /(<!-- mc-helper:state v1\n(?:.*\n)*?    -->)/u.exec(DOC);
    assert.ok(shown, 'the doc no longer shows the state block');
    const real = renderState({ fingerprints: [{ fingerprint: 'a1b2c3', count: 41 }], failing: ['deploy-webhook-silent'] });
    assert.equal(shown[1].replace(/^ {4}/gmu, ''), real);
  });
});
