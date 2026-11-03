/**
 * What a run that has not ended says about its files (`runProgress`): a file
 * with a top-level test that started and did not end is unfinished, and a file
 * whose tests all ended is finished, with the seconds it took.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { measuredSeconds, runProgress } from '../../src/mc/test-times.js';

const lines = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

describe('what a run that has not ended says about its files', () => {
  it('a file with a test that started and did not end is unfinished; the others are finished, slowest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-progress-'));
    try {
      const path = join(dir, 'times.jsonl');
      writeFileSync(path, `${lines([
        { file: '/w/tests/a.test.js', started: true },
        { file: '/w/tests/a.test.js', done: true, ms: 1200 },
        { file: '/w/tests/b.test.js', started: true },
        { file: '/w/tests/b.test.js', started: true },
        { file: '/w/tests/b.test.js', done: true, ms: 40 },
        { file: '/w/tests/c.test.js', started: true },
        { file: '/w/tests/c.test.js', done: true, ms: 3000 },
      ])}not json\n`);
      const progress = runProgress([path, join(dir, 'never-written.jsonl')]);
      assert.deepEqual(progress.unfinished, ['/w/tests/b.test.js']);
      assert.deepEqual(progress.finished, [
        { file: '/w/tests/c.test.js', seconds: 3 },
        { file: '/w/tests/a.test.js', seconds: 1.2 },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a file nobody started is in neither list: the caller knows which files it asked for', () => {
    assert.deepEqual(runProgress([]), { unfinished: [], finished: [] });
  });

  it('the start lines add no seconds to the measured times', () => {
    const text = lines([{ file: '/w/a.js', started: true }, { file: '/w/a.js', done: true, ms: 500 }, { file: '/w/b.js', done: true }]);
    assert.deepEqual(measuredSeconds(text, '/w'), { 'a.js': 0.5 });
  });
});
