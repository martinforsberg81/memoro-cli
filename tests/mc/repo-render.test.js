/**
 * How the repository view reads.
 *
 * The page has one job the board does not: saying how far behind main each
 * open branch is, and saying it in a way that cannot be mistaken for "fine".
 * Unknown, zero, and forty are three different answers and must look like it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderRepoLines, renderWatchLines } from '../../src/mc/repo-render.js';
import { width } from '../../src/mc/status-render.js';

const NOW = Date.parse('2026-08-14T12:00:00Z');

function report(overrides = {}) {
  return {
    at: new Date(NOW).toISOString(),
    offline: false,
    mode: 'computed',
    unknown: [],
    repos: [{
      name: 'memoro-cli',
      path: '/home/x/memoro-cli',
      main: {
        ref: 'origin/main',
        id: 'bc77306520c71e84fb683c57e2fddbf021e21985',
        subject: 'Remove mc supervisor',
        at: '2026-08-14T10:00:00Z',
        fetched: true,
        degraded: null,
      },
      pull_requests: { degraded: null, items: [] },
      worktrees: [],
      deploy: null,
      ...overrides,
    }],
  };
}

const page = (input, options = {}) => renderRepoLines(input, { now: NOW, ...options }).join('\n');

describe('the repository view, as a page', () => {
  it('names main by its short id, subject and age', () => {
    const text = page(report());
    assert.match(text, /bc77306\s+Remove mc supervisor\s+2h ago/u);
  });

  it('says how far behind main each pull request is — including not knowing', () => {
    const text = page(report({
      pull_requests: {
        degraded: null,
        items: [
          { number: 1, title: 'Fresh', branch: 'a', behind_main: 0, draft: false },
          { number: 2, title: 'Old', branch: 'b', behind_main: 41, draft: false },
          { number: 3, title: 'Unreadable', branch: 'c', behind_main: null, draft: true },
        ],
      },
    }));
    assert.match(text, /#1\s+a\s+on main/u);
    assert.match(text, /#2\s+b\s+41 behind main/u);
    assert.match(text, /#3\s+c\s+behind main: unknown\s+draft/u);
  });

  it('a section that could not be read says so, and never looks empty', () => {
    const text = page(report({ pull_requests: { degraded: 'gh is not installed', items: [] } }));
    assert.match(text, /gh is not installed/u);
    assert.doesNotMatch(text, /none open/u);
  });

  it('an unread main is a stated degradation, not a blank line', () => {
    const text = page(report({
      main: {
        ref: 'origin/main', id: null, subject: null, at: null, fetched: false,
        degraded: 'nothing at origin/main yet',
      },
    }));
    assert.match(text, /nothing at origin\/main yet/u);
  });

  it('a name that matched nothing is said once, without an empty-page line', () => {
    const text = page({
      at: new Date(NOW).toISOString(), offline: false, mode: 'computed', repos: [], unknown: ['nope'],
    });
    assert.match(text, /no repository called "nope"/u);
    assert.doesNotMatch(text, /mc work add/u);
  });

  it('says where the page came from: a fresh picture, an old one, or counting', () => {
    const base = report();
    const fresh = page({
      ...base, mode: 'snapshot', updated_at: new Date(NOW - 40_000).toISOString(), stale: false,
      watcher: { running: true, pid: 4711 },
    });
    assert.match(fresh, /updated 1m ago/u);
    assert.match(fresh, /watcher pid 4711/u);
    assert.doesNotMatch(fresh, /STALE/u);

    const stale = page({
      ...base, mode: 'snapshot', updated_at: new Date(NOW - 20 * 60_000).toISOString(), stale: true,
      watcher: { running: false, pid: null },
    });
    assert.match(stale, /STALE/u);
    assert.match(stale, /mc repo watch start/u);

    const counted = page({ ...base, mode: 'computed', watcher: { running: false, pid: null } });
    assert.match(counted, /counted now/u);
    assert.match(counted, /mc repo watch start/u);
  });

  it('the watcher page says which of its three ways it is not working', () => {
    const running = renderWatchLines({
      running: true, pid: 4711, interval_ms: 60_000, abandoned: false,
      last_write_at: new Date(NOW - 30_000).toISOString(), stale: false, log: '/x/watcher.log',
    }, { now: NOW }).join('\n');
    assert.match(running, /watching\s+pid 4711\s+every 60s/u);
    assert.match(running, /last wrote\s+just now|last wrote\s+1m ago/u);

    const abandoned = renderWatchLines({
      running: false, pid: null, interval_ms: 60_000, abandoned: true,
      last_write_at: new Date(NOW - 60 * 60_000).toISOString(), stale: true, log: '/x/watcher.log',
    }, { now: NOW }).join('\n');
    assert.match(abandoned, /not running/u);
    assert.match(abandoned, /pid file was left behind/u);
    assert.match(abandoned, /STALE/u);

    const never = renderWatchLines({
      running: false, pid: null, interval_ms: 60_000, abandoned: false,
      last_write_at: null, stale: null, log: '/x/watcher.log',
    }, { now: NOW }).join('\n');
    assert.match(never, /mc repo watch start/u);
    assert.match(never, /last wrote\s+never/u);
  });

  it('says who holds a round and for how long — or that it is free', () => {
    const free = page(report());
    assert.match(free, /lease\s+free/u);

    const held = page(report({
      lease: {
        held: true,
        holder: 'mc-repo',
        holder_kind: 'work-area',
        errand: 'merge round #338',
        since: new Date(NOW - 40 * 60_000).toISOString(),
        age_ms: 40 * 60_000,
      },
    }));
    assert.match(held, /lease\s+mc-repo/u);
    assert.match(held, /merge round #338/u);
    assert.match(held, /held for 40m/u);

    // The age is the only warning there is: nothing expires a lease, so a
    // forgotten one has to read differently from a round in progress.
    const forgotten = page(report({
      lease: {
        held: true, holder: 'mc-repo', holder_kind: 'work-area', errand: 'a round',
        since: new Date(NOW - 9 * 60 * 60_000).toISOString(), age_ms: 9 * 60 * 60_000,
      },
    }));
    assert.match(forgotten, /held for 9h/u);
  });

  it('every row fits the terminal, colour and all', () => {
    const text = renderRepoLines(report({
      pull_requests: {
        degraded: null,
        items: [{
          number: 12345,
          title: 'A title long enough to run off the edge of any terminal anyone has ever owned',
          branch: 'a-branch-name-that-is-also-far-too-long-to-be-reasonable',
          behind_main: 3,
          draft: false,
        }],
      },
      worktrees: [{
        area: 'a-work-area-with-a-very-long-name', repo: 'memoro-cli', path: '/x',
        branch: 'a-branch-name-that-is-also-far-too-long-to-be-reasonable',
        uncommitted: 3, unmerged_commits: 2,
      }],
    }), { columns: 80, colour: true, now: NOW });
    for (const line of text) {
      assert.ok(width(line) <= 80, `line wider than the terminal: ${JSON.stringify(line)}`);
    }
    assert.ok(text.some((line) => line.includes('…')), 'expected a clipped row');
  });
});
