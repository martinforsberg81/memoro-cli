/**
 * `brief-collect.js` — the shared reader of runs, on fixtures: the runs.tsv
 * rows. The proposal listing is `listAllProposals` (area-proposals.js), tested
 * with the intake turn that measures by it (helper-turn.test.js).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runsFor } from '../../src/mc/brief-collect.js';

const RUNS = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-24T10:00:00Z\told\tstep\t0\t100\t1\t5\t10\t20\t1000\t30\ts1\tsuccess,merged',
  '2026-08-25T18:00:00Z\tdocx\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '',
].join('\n');

describe('runner log', () => {
  it('keeps the last rows of one project', () => {
    assert.deepEqual(runsFor(RUNS, 'docx', 3).map((r) => r.pr), ['10958']);
    assert.deepEqual(runsFor(RUNS, 'old', 3).map((r) => r.ts), ['2026-08-24T10:00:00Z']);
    assert.deepEqual(runsFor(RUNS, 'never-ran', 3), []);
  });

  it('keeps only the last `limit` of them, oldest first', () => {
    const many = `${RUNS}2026-08-26T18:00:00Z\tdocx\tstep\t0\t1\t11\t-\t-\t-\t-\t-\ts4\tsuccess,open\n`;
    assert.deepEqual(runsFor(many, 'docx', 1).map((r) => r.pr), ['11']);
    assert.deepEqual(runsFor(many, 'docx', 3).map((r) => r.pr), ['10958', '11']);
  });
});
