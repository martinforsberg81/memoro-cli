/**
 * Unit tests for the update-check module.
 *
 * Covers the pure semver helper and the notice-printing behaviour (TTY gate,
 * env opt-out, version comparison). The network-backed background refresh
 * is not covered here — it runs in a detached child process and hitting npm
 * in unit tests would be flaky.
 */

import assert from 'node:assert/strict';
import test, { describe, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeConfig } from '../src/lib/config.js';
import { isSemverGreaterThan, showUpdateNoticeIfAvailable } from '../src/lib/update-check.js';

let sandbox;
let originalHome;
let originalTtyDesc;
let stderrChunks;
let originalStderrWrite;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'memoro-update-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = sandbox;

  originalTtyDesc = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
});

after(() => {
  process.env.HOME = originalHome;
  if (originalTtyDesc) {
    Object.defineProperty(process.stderr, 'isTTY', originalTtyDesc);
  } else {
    delete process.stderr.isTTY;
  }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  stderrChunks = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  delete process.env.MEMORO_NO_UPDATE_CHECK;
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
});

function restoreStderr() {
  if (originalStderrWrite) process.stderr.write = originalStderrWrite;
}

describe('isSemverGreaterThan', () => {
  test('detects major/minor/patch bumps', () => {
    assert.equal(isSemverGreaterThan('1.0.0', '0.9.9'), true);
    assert.equal(isSemverGreaterThan('0.2.0', '0.1.5'), true);
    assert.equal(isSemverGreaterThan('0.1.1', '0.1.0'), true);
  });

  test('returns false for equal or older versions', () => {
    assert.equal(isSemverGreaterThan('0.1.0', '0.1.0'), false);
    assert.equal(isSemverGreaterThan('0.1.0', '0.1.1'), false);
    assert.equal(isSemverGreaterThan('0.1.0', '1.0.0'), false);
  });

  test('strips pre-release and build tags before comparing', () => {
    assert.equal(isSemverGreaterThan('0.2.0-beta.1', '0.1.0'), true);
    assert.equal(isSemverGreaterThan('0.1.0+build.42', '0.1.0'), false);
  });

  test('returns false for unparseable input instead of throwing', () => {
    assert.equal(isSemverGreaterThan('not-a-version', '0.1.0'), false);
    assert.equal(isSemverGreaterThan('0.1.0', null), false);
    assert.equal(isSemverGreaterThan(null, '0.1.0'), false);
    assert.equal(isSemverGreaterThan('0.1', '0.0.9'), false); // 2-part not supported
  });
});

describe('showUpdateNoticeIfAvailable', () => {
  test('prints a notice when cache has a newer version', async () => {
    try {
      await writeConfig({
        apiUrl: 'https://meetmemoro.app',
        latestVersion: '0.2.0',
        latestCheckedAt: new Date().toISOString(),
      });
      await showUpdateNoticeIfAvailable('0.1.0');
      const out = stderrChunks.join('');
      assert.match(out, /memoro-cli: new version 0\.2\.0 available/);
      assert.match(out, /npm update -g memoro-cli/);
    } finally {
      restoreStderr();
    }
  });

  test('is silent when cache matches installed version', async () => {
    try {
      await writeConfig({ latestVersion: '0.1.0' });
      await showUpdateNoticeIfAvailable('0.1.0');
      assert.equal(stderrChunks.join(''), '');
    } finally {
      restoreStderr();
    }
  });

  test('is silent when cache is empty (first run)', async () => {
    try {
      await writeConfig({ latestVersion: null });
      await showUpdateNoticeIfAvailable('0.1.0');
      assert.equal(stderrChunks.join(''), '');
    } finally {
      restoreStderr();
    }
  });

  test('is silent when stderr is not a TTY (pipe / hook / slash command)', async () => {
    try {
      Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false });
      await writeConfig({ latestVersion: '0.2.0' });
      await showUpdateNoticeIfAvailable('0.1.0');
      assert.equal(stderrChunks.join(''), '');
    } finally {
      restoreStderr();
    }
  });

  test('is silent when MEMORO_NO_UPDATE_CHECK is set', async () => {
    try {
      process.env.MEMORO_NO_UPDATE_CHECK = '1';
      await writeConfig({ latestVersion: '0.2.0' });
      await showUpdateNoticeIfAvailable('0.1.0');
      assert.equal(stderrChunks.join(''), '');
    } finally {
      restoreStderr();
    }
  });
});
