/**
 * The layout file and the area helpers that read it (ruling 51). Layout 1 is
 * the absence of `runner/layout.json`; layout 2 is its presence. Every case
 * runs on a temporary work root, never the real one.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const {
  LAYOUT_FILE, areaKindOf, areaOfPath, depsAreaName, layoutVersion, planAreaName, planAreaRoot,
  sessionName, stepAreaName, stepAreaRoot,
} = await import('../../src/mc/paths.js');

const roots = [];
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

/** A temporary work root, with `runner/layout.json` holding `text` when given. */
function workRootWith(text) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-paths-layout-'));
  roots.push(dir);
  if (text !== undefined) {
    mkdirSync(join(dir, 'runner'), { recursive: true });
    writeFileSync(join(dir, 'runner', LAYOUT_FILE), text);
  }
  return dir;
}

const LAYOUT_2 = '{"schema":"mc-layout","version":2}\n';

describe('layoutVersion', () => {
  it('is 1 with no file', () => {
    assert.equal(layoutVersion({ root: workRootWith() }), 1);
  });

  it('is 1 with an empty object', () => {
    assert.equal(layoutVersion({ root: workRootWith('{}') }), 1);
  });

  it('is 1 with a version this code does not know', () => {
    assert.equal(layoutVersion({ root: workRootWith('{"schema":"mc-layout","version":3}') }), 1);
  });

  it('is 1 with unparsable text', () => {
    assert.equal(layoutVersion({ root: workRootWith('{"schema":') }), 1);
  });

  it('is 2 with the right file', () => {
    assert.equal(layoutVersion({ root: workRootWith(LAYOUT_2) }), 2);
  });

  it('reads the file on every call, so a file that appears is seen at once', () => {
    const root = workRootWith();
    assert.equal(layoutVersion({ root }), 1);
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(join(root, 'runner', LAYOUT_FILE), LAYOUT_2);
    assert.equal(layoutVersion({ root }), 2);
  });
});

describe('layout 1 keeps today\'s paths', () => {
  const root = workRootWith();

  it('names the area of a planning session plan/<programme>', () => {
    assert.equal(planAreaName('p', { root }), 'plan/p');
  });

  it('names a runner area step/<project> when no checkout is under the root', () => {
    assert.equal(stepAreaName('x', { root }), 'step/x');
  });

  it('names a runner area by its legacy name when a checkout sits directly under the root', () => {
    const legacy = workRootWith();
    mkdirSync(join(legacy, 'x', 'memoro', '.git'), { recursive: true });
    assert.equal(stepAreaName('x', { root: legacy }), 'x');
  });

  it('names a deps area step/<name>', () => {
    assert.equal(depsAreaName('deps-a', { root }), 'step/deps-a');
  });

  it('roots the planning sessions at plan/ and the runner areas at step/', () => {
    assert.equal(planAreaRoot({ root }), join(root, 'plan'));
    assert.equal(stepAreaRoot({ root }), join(root, 'step'));
  });
});

describe('layout 2 names the new structure', () => {
  const root = workRootWith(LAYOUT_2);

  it('names the area of a planning session programs/<programme>', () => {
    assert.equal(planAreaName('p', { root }), 'programs/p');
  });

  it('names a runner area runner/step/<project>', () => {
    assert.equal(stepAreaName('x', { root }), 'runner/step/x');
  });

  it('ignores a legacy checkout under the root', () => {
    const legacy = workRootWith(LAYOUT_2);
    mkdirSync(join(legacy, 'x', 'memoro', '.git'), { recursive: true });
    assert.equal(stepAreaName('x', { root: legacy }), 'runner/step/x');
  });

  it('names a deps area runner/deps/<name>', () => {
    assert.equal(depsAreaName('deps-a', { root }), 'runner/deps/deps-a');
  });

  it('roots the planning sessions at programs/ and the runner areas at runner/step/', () => {
    assert.equal(planAreaRoot({ root }), join(root, 'programs'));
    assert.equal(stepAreaRoot({ root }), join(root, 'runner', 'step'));
  });
});

describe('areaKindOf', () => {
  it('classifies every area of both layouts', () => {
    const cases = [
      ['plan/p', { kind: 'plan', name: 'p', area: 'plan/p' }],
      ['programs/p', { kind: 'plan', name: 'p', area: 'programs/p' }],
      ['runner/step/p', { kind: 'step', name: 'p', area: 'runner/step/p' }],
      ['runner/deps/n', { kind: 'deps', name: 'n', area: 'runner/deps/n' }],
      ['step/p', { kind: 'step', name: 'p', area: 'step/p' }],
      ['step/deps-a', { kind: 'deps', name: 'deps-a', area: 'step/deps-a' }],
      ['work/n', { kind: 'work', name: 'n', area: 'work/n' }],
      ['jobbet', { kind: 'legacy', name: 'jobbet', area: 'jobbet' }],
    ];
    for (const [name, expected] of cases) assert.deepEqual(areaKindOf(name), expected, name);
  });

  it('ignores the segments after the area', () => {
    assert.deepEqual(areaKindOf('runner/step/x/memoro/src'), { kind: 'step', name: 'x', area: 'runner/step/x' });
    assert.deepEqual(areaKindOf('step/x/memoro/src/a.js'), { kind: 'step', name: 'x', area: 'step/x' });
    assert.deepEqual(areaKindOf('jobbet/memoro/.git'), { kind: 'legacy', name: 'jobbet', area: 'jobbet' });
  });

  it('is null for a kind\'s root alone, for other runner tables, and for nothing', () => {
    for (const name of ['', 'plan', 'programs', 'step', 'work', 'runner', 'runner/step', 'runner/deps', 'runner/log/2026', 'runner/log/x', 'intake', 'helper', '.git', '.mc.json']) {
      assert.equal(areaKindOf(name), null, name);
    }
  });
});

describe('areaOfPath', () => {
  it('classifies a path below the root by its area', () => {
    assert.deepEqual(areaOfPath('/w/runner/step/x/memoro/src', '/w'), { kind: 'step', name: 'x', area: 'runner/step/x' });
  });

  it('is null for a path not below the root, and for the root itself', () => {
    assert.equal(areaOfPath('/elsewhere/runner/step/x', '/w'), null);
    assert.equal(areaOfPath('/w', '/w'), null);
  });
});

describe('sessionName', () => {
  it('drops the kind of an area and keeps a planning area whole', () => {
    const cases = [
      ['work/a', 'a'],
      ['step/a', 'a'],
      ['runner/step/a', 'a'],
      ['runner/deps/a', 'a'],
      ['plan/a', 'plan/a'],
      ['programs/a', 'programs/a'],
      ['a', 'a'],
    ];
    for (const [area, expected] of cases) assert.equal(sessionName(area), expected, area);
  });
});
