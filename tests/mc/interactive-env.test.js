import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { normalizeInteractivePtyEnv } from '../../src/mc/interactive-env.js';

describe('normalizeInteractivePtyEnv', () => {
  test('repairs headless TERM and removes inherited no-color flags', () => {
    const out = normalizeInteractivePtyEnv({
      baseEnv: {
        TERM: 'dumb',
        NO_COLOR: '1',
        CLICOLOR: '0',
        COLORTERM: '',
        PATH: '/bin',
      },
    });

    assert.equal(out.termName, 'xterm-256color');
    assert.equal(out.env.TERM, 'xterm-256color');
    assert.equal(out.env.NO_COLOR, undefined);
    assert.equal(out.env.CLICOLOR, undefined);
    assert.equal(out.env.COLORTERM, 'truecolor');
    assert.equal(out.env.PATH, '/bin');
    assert.equal(out.repairedTerm, true);
  });

  test('preserves an explicit terminal and no-color preference', () => {
    const out = normalizeInteractivePtyEnv({
      baseEnv: {
        TERM: 'xterm-256color',
        NO_COLOR: '1',
        CLICOLOR: '0',
        COLORTERM: '24bit',
      },
    });

    assert.equal(out.termName, 'xterm-256color');
    assert.equal(out.env.NO_COLOR, '1');
    assert.equal(out.env.CLICOLOR, '0');
    assert.equal(out.env.COLORTERM, '24bit');
    assert.equal(out.repairedTerm, false);
  });

  test('termName overrides base env TERM', () => {
    const out = normalizeInteractivePtyEnv({
      baseEnv: { TERM: 'screen-256color' },
      termName: 'xterm-kitty',
    });

    assert.equal(out.termName, 'xterm-kitty');
    assert.equal(out.env.TERM, 'xterm-kitty');
  });
});
