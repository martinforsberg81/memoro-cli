/**
 * The delivery check (D-0170): did every order line reach its track?
 *
 * The day this is for: a track stood blocked, unable to build G5, while
 * the order — verbatim, complete, with its negative test — sat under
 * `Rad till spår 3:` in an msr-design report in PM's inbox. The convention
 * held; the channel broke. What is asserted here: the convention's shapes
 * are all read (upper, lower, quoted, bare), delivery is judged by the
 * order's own text in the track's inbox or archive, a missing area is a
 * different fact from an undelivered order, and the round is quiet when
 * everything is delivered and knocks once when something is not.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { deliveryLines, ordersIn, undeliveredOrders } from '../../src/mc/watch-pm-deliveries.js';
import { pmRound } from '../../src/mc/watch-pm-round.js';

function world() {
  const box = mkdtempSync(join(tmpdir(), 'mc-deliveries-'));
  const workRoot = join(box, 'work');
  const root = join(box, 'home');
  const pmArchive = join(workRoot, 'pm', 'inbox', 'archive');
  mkdirSync(pmArchive, { recursive: true });
  mkdirSync(root, { recursive: true });
  return {
    box, workRoot, root,
    env: { MC_HOME: root, MC_WORK_ROOT: workRoot },
    report(name, body) {
      writeFileSync(join(pmArchive, name), `---\nfrom: msr-design\nat: 2026-08-23T12:00:00.000Z\n---\n\n${body}\n`);
    },
    track(n, name, body) {
      const inbox = join(workRoot, `msr-track-${n}`, 'inbox');
      mkdirSync(inbox, { recursive: true });
      if (name) writeFileSync(join(inbox, name), body);
    },
    archive(n, name, body) {
      const archive = join(workRoot, `msr-track-${n}`, 'inbox', 'archive');
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, name), body);
    },
    cleanup() { rmSync(box, { recursive: true, force: true }); },
  };
}

const G5 = "G5 före section-cost — A1:s matris mot migrerade kort, varje affordance aktiverad, intentet observerat";

describe('the convention is read in every shape it is written', () => {
  it('upper, lower, quoted and bare are all order lines; prose is not', () => {
    const found = ordersIn([
      `RAD TILL SPÅR 1: 'bygg dispatchern i blockrenderaren'`,
      `Rad till spår 3: ${G5}`,
      'rad till spår 2: "derivera totalen ur registret"',
      'En rad till spårvagnen: ingenting.',
    ].join('\n'));
    assert.deepEqual(found.map((order) => order.track), [1, 3, 2]);
    assert.match(found[0].excerpt, /^bygg dispatchern/u);
    assert.equal(found[2].excerpt, 'derivera totalen ur registret');
  });
});

describe('delivered is the order\'s own text in the track\'s inbox', () => {
  it('an undelivered order is one entry with the source, the time and eighty characters', () => {
    const fx = world();
    try {
      fx.report('2026-08-23T12-19-46.288Z-msr-design.md', `Beslut.\n\nRad till spår 3: '${G5}'`);
      fx.track(3, '2026-08-23T12-30-00.000Z-pm.md', 'Something else entirely.');
      const missing = undeliveredOrders({ env: fx.env });
      assert.equal(missing.length, 1);
      assert.equal(missing[0].track, 3);
      assert.equal(missing[0].source, '2026-08-23T12-19-46.288Z-msr-design.md');
      assert.equal(missing[0].excerpt.length <= 80, true);
      assert.match(deliveryLines(missing)[0], /^order to msr-track-3 not delivered: "G5 före section-cost/u);
    } finally { fx.cleanup(); }
  });

  it('the same order relayed — even re-wrapped, even archived — is delivered, and the check is silent', () => {
    const fx = world();
    try {
      fx.report('r1-msr-design.md', `Rad till spår 3: '${G5}'`);
      // Re-wrapped by the relay: line breaks where the report had spaces.
      fx.archive(3, 'order.md', `NYTT ARBETE:\n${G5.replace(' matris mot', '\nmatris mot')}\nBygg.`);
      assert.deepEqual(undeliveredOrders({ env: fx.env }), []);
    } finally { fx.cleanup(); }
  });

  it('a track that does not exist is said as that, not as delivered and not as an ordinary miss', () => {
    const fx = world();
    try {
      fx.report('r2-msr-design.md', "Rad till spår 7: 'en order till ett spår som inte finns'");
      const missing = undeliveredOrders({ env: fx.env });
      assert.equal(missing.length, 1);
      assert.match(missing[0].reason, /no msr-track-7 inbox to look in/u);
    } finally { fx.cleanup(); }
  });
});

describe('the round carries it: quiet when delivered, one knock when not', () => {
  it('knocks with the order named once, then is quiet — and forgets it when it lands', async () => {
    const fx = world();
    try {
      fx.report('r3-msr-design.md', `Rad till spår 3: '${G5}'`);
      fx.track(3, null, null); // the area exists, the order is not there
      const sent = [];
      const round = () => pmRound({
        root: fx.root, env: fx.env, send: (message) => { sent.push(message); return { ok: true, woke: true, file: null }; },
        doctor: () => ({ ok: true, issues: [] }),
      });
      await round();
      assert.equal(sent.length, 1, 'a new undelivered order is worth a knock');
      assert.match(sent[0].message, /1 order from msr-design has not reached its track:/u);
      assert.match(sent[0].message, /order to msr-track-3 not delivered: "G5 före section-cost/u);
      await round();
      assert.equal(sent.length, 1, 'still undelivered is not news on the second pass');
      await round();
      assert.equal(sent.length, 1, 'nor on the third — one knock per order, no reminder (PM 2026-08-24)');
      // Delivered at last: the check goes quiet, and does not announce the recovery.
      fx.track(3, 'late.md', G5);
      await round();
      assert.equal(sent.length, 1, 'quiet when everything is delivered — the one knock was the arrival');
    } finally { fx.cleanup(); }
  });
});
