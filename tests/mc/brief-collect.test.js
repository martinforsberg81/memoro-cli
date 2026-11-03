/**
 * `brief-collect.js` — the shared readers of runs and proposals, on
 * fixtures: the proposal listing and the runs.tsv rows.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listProposals, runsFor } from '../../src/mc/brief-collect.js';

const RUNS = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-24T10:00:00Z\told\tstep\t0\t100\t1\t5\t10\t20\t1000\t30\ts1\tsuccess,merged',
  '2026-08-25T18:00:00Z\tdocx\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '',
].join('\n');

describe('proposals', () => {
  // mc does not read a proposal. It used to parse a frontmatter and fixed
  // section names, in three places that disagreed — a file whose first prose
  // line was not marked `# ` was counted by the page, missing from the brief,
  // and recorded as "wrote nothing" by the turn that had just written it. The
  // names are the whole of what mc knows now.
  it('lists the markdown names and nothing about what is in them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-proposals-'));
    writeFileSync(join(dir, 'b.md'), 'no heading here, and it still counts\n');
    writeFileSync(join(dir, 'a.md'), '# A title\n');
    writeFileSync(join(dir, 'notes.txt'), 'not markdown\n');
    assert.deepEqual(listProposals(dir).map((p) => p.file), ['a.md', 'b.md']);
    assert.deepEqual(Object.keys(listProposals(dir)[0]).sort(), ['file', 'path']);
  });

  it('an absent directory is empty, not an error', () => {
    assert.deepEqual(listProposals(join(tmpdir(), 'mc-no-such-proposals-dir')), []);
  });
});


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
