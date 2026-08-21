/**
 * The notices ledger (designnote §5) — the module both other legs import.
 *
 * The guarantees under test: it is append-only and nothing is ever removed;
 * delivery is a new line, so a delivered notice never comes back; a torn or
 * junk line costs the reader that line and no other; and the urgent classes
 * are the two the note names and no third.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  URGENT_PATTERNS, appendNotice, isUrgent, markDelivered, noticesPath, pendingNotices, readLedger,
} from '../../src/mc/watch-notices.js';

function home() {
  return mkdtempSync(join(tmpdir(), 'mc-test-notices-'));
}

const NOTICE = { source: 'guard', session: 'msr-cleanup', pattern: 'silent', detail: 'no output for 4h12m' };

describe('the notices ledger', () => {
  it('appends one line per notice and reads them back in order', () => {
    const root = home();
    appendNotice({ ...NOTICE, id: 'a', at: '2026-08-21T10:00:00.000Z' }, { root });
    appendNotice({ ...NOTICE, id: 'b', at: '2026-08-21T09:00:00.000Z' }, { root });

    const lines = readFileSync(noticesPath(root), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'one line per notice');
    assert.deepEqual(pendingNotices({ root }).map((n) => n.id), ['b', 'a'], 'oldest first');
  });

  it('delivers by adding a line, never by editing one', () => {
    const root = home();
    appendNotice({ ...NOTICE, id: 'a' }, { root });
    const before = readFileSync(noticesPath(root), 'utf8');

    markDelivered('a', { root });

    const after = readFileSync(noticesPath(root), 'utf8');
    assert.ok(after.startsWith(before), 'the notice line is untouched');
    assert.deepEqual(pendingNotices({ root }), [], 'and it is no longer owed');
    // Nothing is ever removed: the notice is still there to be read.
    assert.equal(readLedger({ root }).notices.length, 1);
  });

  it('a notice is delivered once and stays delivered', () => {
    const root = home();
    appendNotice({ ...NOTICE, id: 'a' }, { root });
    markDelivered('a', { root });
    appendNotice({ ...NOTICE, id: 'b' }, { root });

    assert.deepEqual(pendingNotices({ root }).map((n) => n.id), ['b']);
  });

  it('a junk line costs that line and no other', () => {
    const root = home();
    appendNotice({ ...NOTICE, id: 'a' }, { root });
    appendFileSync(noticesPath(root), '{"id":"torn","at"\n');
    appendNotice({ ...NOTICE, id: 'c' }, { root });

    const ledger = readLedger({ root });
    assert.equal(ledger.malformed, 1, 'and it is counted rather than hidden');
    assert.deepEqual(ledger.notices.map((n) => n.id), ['a', 'c']);
  });

  it('refuses a notice with nothing to say', () => {
    const root = home();
    assert.throws(() => appendNotice({ source: 'guard', pattern: 'silent' }, { root }), /session/u);
    assert.throws(() => appendNotice({ source: 'guard', session: 'x' }, { root }), /pattern/u);
    assert.equal(readLedger({ root }).exists, false, 'and writes nothing');
  });

  it('an unread ledger is empty, not an error', () => {
    const root = home();
    assert.deepEqual(pendingNotices({ root }), []);
    assert.equal(readLedger({ root }).exists, false);
  });

  it('two urgent classes, and no third', () => {
    assert.deepEqual([...URGENT_PATTERNS], ['dead', 'quota-exhausted']);
    assert.equal(isUrgent('dead'), true);
    assert.equal(isUrgent('silent'), false);
  });
});
