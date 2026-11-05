/**
 * DEV on the page (goal mc/dev-section): the dev servers, and the session that
 * holds each. The heading counts registry-derived non-starting rows, leased
 * ones and waiters; one row per server names its holder; a holder whose session
 * has ended says `holder gone` in yellow; the queue is one yellow row; and
 * `mc --json` carries `dev` with every field the rows are drawn from.
 *
 * The section is built by the real `devSection` from registry records shaped
 * as `touchServer` leaves them, and `collectPage` reads a real registry and
 * queue under a temporary MC_HOME.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { devSection, readPool } from '../../src/mc/dev-pool.js';
import {
  collectPage, intakeSection, mergesSection, programmesSection, runnerSection, sessionsSection,
} from '../../src/mc/page-collect.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';

const NOW = new Date('2026-11-04T12:00:00Z');
const DEAD = 2_147_483_646;
const alive = (pid) => Number(pid) !== DEAD;
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/gu, '');
const ago = (seconds) => new Date(NOW.getTime() - seconds * 1000).toISOString();
const MAIN = { worktree: '/Users/martin/mc/self/memoro', service: 'memoro-worker' };

/** A registry record as `registerManifest` and `touchServer` leave it. */
function server(port, worktree, { holder = null, used = 60, registered = 3600 } = {}) {
  return {
    schema_version: 1, instance_id: `dev-${port}`, service: 'memoro-worker', session_name: 's', worktree_path: worktree,
    pid: 4000 + port, url: `http://127.0.0.1:${port}`, registered_at: ago(registered),
    ...(used == null ? {} : { last_used_at: ago(used) }),
    ...(holder ? { holder, held_since: ago(used ?? 0) } : {}),
  };
}

const BUILD = { kind: 'build', owner: 'mc', name: 'mc/no-work', pid: 501 };
const PLAN = { kind: 'plan', owner: 'mc', name: 'mc', pid: 502 };

/** The main slot, idle; two lent slots, one leased to a build and one to a plan whose session has ended. */
function pool({ planPid = DEAD, queue = [] } = {}) {
  return devSection({
    servers: [
      server(8930, '/Users/martin/mc/programs/mc/goals/other/memoro', { holder: { ...PLAN, pid: planPid }, used: 120 }),
      server(8787, MAIN.worktree, { holder: { kind: 'shot', owner: null, name: null, pid: DEAD }, used: 900 }),
      server(8920, '/Users/martin/mc/programs/mc/goals/no-work/memoro', { holder: BUILD, used: 30 }),
    ],
    queue,
    main: MAIN,
    now: NOW,
    alive,
    branchOf: (worktree) => (worktree === MAIN.worktree ? 'main' : `goal/${worktree.split('/').at(-2)}`),
  });
}

function pageData(over = {}) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    merges: mergesSection({ now: NOW }),
    intake: intakeSection({ digests: [], proposals: [], now: NOW }),
    programmes: programmesSection({}),
    language: { languages: [], last_run: null, open_gap: null },
    caches: { fresh: false, prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    ...over,
  };
}

/** The DEV section's lines: its heading to the blank line after it. */
function devBlock(lines) {
  const at = lines.findIndex((line) => /^ {2}┌─ DEV /u.test(plain(line)));
  assert.ok(at >= 0, `a DEV heading:\n${lines.map(plain).join('\n')}`);
  const end = lines.findIndex((line, index) => index > at && plain(line) === '');
  return lines.slice(at, end).filter(line => !plain(line).startsWith('  └'));
}

/** The escapes a run of text is painted with, as `yellow`, `grey`, … */
const CODES = { 33: 'yellow', 90: 'grey', 32: 'green', 1: 'bold' };
function toneOf(line, text) {
  const match = new RegExp(`((?:\\u001b\\[[0-9;]*m)+)${text}`, 'u').exec(line);
  return match ? [...match[1].matchAll(/\u001b\[([0-9;]*)m/gu)].flatMap((m) => m[1].split(';')).map((code) => CODES[code] || code) : [];
}

const QUEUE = [
  { id: 'b', pid: 601, worktree_path: '/w/two', service: 'memoro-worker', joined_at: ago(60), session: { kind: 'review', owner: 'mc', name: 'mc/email', pid: 601 } },
  { id: 'a', pid: 600, worktree_path: '/w/one', service: 'memoro-worker', joined_at: ago(200), session: { kind: 'build', owner: 'memoro', name: 'hero-detail-objects', pid: 600 } },
];

describe('DEV — the dev servers and who holds each', () => {
  it('heads the section with the counts and names each server by the session that holds it', () => {
    const data = pageData({ dev: pool({ planPid: 502 }) });
    const lines = renderPageLines(data, { columns: 120, now: NOW });
    const block = devBlock(lines).map(plain);
    assert.match(block[1], /3 running · 2 leased/u);
    assert.deepEqual(block.filter((line) => /MAIN|SLOT/u.test(line)).map((line) => line.trim()),
      ['MAIN  :8787    idle     shot     · pid 12787', 'SLOT  :8920    leased   BUILD   mc/no-work · pid 12920', 'SLOT  :8930    leased   plan    mc · pid 12930']);
    assert.equal(block.length, 5, 'heading, summary and one row per server; no repository heading');
    assert.doesNotMatch(block.join('\n'), /holder gone|goal\/no-work/u);
    const expanded = devBlock(renderPageLines(data, { columns: 120, now: NOW, expand: true })).join('\n');
    assert.match(expanded, /goal\/no-work/u);
    assert.match(expanded, /http:\/\/127.0.0.1:8920/u);
    const order = lines.map(plain).filter(line => /^  (?:┌─ )?(PROGRAMMES|DEV|MERGE)\b/u.test(line)).map(line => line.replace('┌─ ', '').trim().split(/\s/u)[0]);
    assert.deepEqual(order, ['PROGRAMMES', 'MERGE', 'DEV']);
  });

  it('says none running in readable secondary text when there is no server', () => {
    const lines = renderPageLines(pageData({ dev: devSection({ now: NOW }) }), { columns: 100, now: NOW, colour: true });
    const [head, summary, ...rest] = devBlock(lines);
    assert.match(plain(head), /^ {2}┌─ DEV ─+ mc dev list ┐$/u);
    assert.equal(plain(summary), '    none running');
    assert.deepEqual(toneOf(summary, 'none running'), ['37']);
    assert.deepEqual(rest, []);
  });

  it('says holder gone, in yellow, for a server whose session has ended — and not for a bare mc shot', () => {
    const dev = pool();
    const plan = dev.servers.find((one) => one.port === 8930);
    assert.equal(plan.holder_gone, true);
    assert.equal(plan.state, 'idle', 'a lease nobody is alive to hold');
    assert.equal(dev.servers.find((one) => one.port === 8787).holder_gone, false, 'a short shot has no session to end');
    const block = devBlock(renderPageLines(pageData({ dev }), { columns: 120, now: NOW, colour: true }));
    const row = block.find((line) => plain(line).includes('holder gone'));
    assert.match(plain(row), /holder gone/u);
    assert.deepEqual(toneOf(row, 'holder gone'), ['yellow']);
    assert.doesNotMatch(plain(block.find((line) => plain(line).includes(':8787'))), /holder gone/u);
    assert.match(plain(block[1]), /3 running · 1 leased/u);
  });

  it('draws the waiters as one yellow row naming who is first', () => {
    const dev = pool({ queue: QUEUE });
    assert.deepEqual(dev.queue.map((one) => one.name), ['BUILD hero-detail-objects', 'REVIEW mc/email']);
    const block = devBlock(renderPageLines(pageData({ dev }), { columns: 100, now: NOW, colour: true }));
    assert.match(plain(block[1]), /3 running · 1 leased · 2 queued/u);
    const last = block.at(-1);
    assert.equal(plain(last).trim(), 'REVIEW mc/email · waited 60s');
    assert.ok(block.some((line) => plain(line).includes('BUILD hero-detail-objects · waited 3 min')));
    assert.deepEqual(toneOf(last, 'REVIEW mc/email'), ['yellow']);
  });

  it('draws no DEV line past the edge at 80 columns, with long names and a long tail', () => {
    const long = { kind: 'review', owner: 'memoro', name: 'memoro/an-extraordinarily-long-goal-name-for-a-review', pid: 503 };
    const dev = devSection({
      servers: [
        server(8940, `/Users/martin/mc/programs/memoro/goals/${'deep-'.repeat(12)}worktree/memoro`, { holder: long, used: 10 }),
        server(8941, '/Users/martin/mc/programs/memoro/goals/x/memoro', { holder: { ...long, pid: DEAD }, used: 10 }),
      ],
      queue: [{ ...QUEUE[1], session: long }, QUEUE[0]],
      now: NOW,
      alive,
      branchOf: () => `goal/${'a-very-long-branch-name-'.repeat(4)}`,
    });
    for (const colour of [false, true]) {
      const block = devBlock(renderPageLines(pageData({ dev }), { columns: 80, now: NOW, colour }));
      assert.ok(block.length > 4);
      const over = block.filter((line) => width(line) > 80).map(plain);
      assert.deepEqual(over, [], `colour ${colour}`);
    }
    const block = devBlock(renderPageLines(pageData({ dev }), { columns: 80, now: NOW })).map(plain);
    assert.match(block.join('\n'), /holder gone/u, 'the tail gives way after holder gone, not before');
  });
});

describe('mc --json carries dev', () => {
  it('collectPage reads the registry and the queue into dev, with every field the rows are drawn from', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-dev-'));
    mkdirSync(join(root, 'dev-servers'), { recursive: true });
    const records = [
      { ...server(8787, MAIN.worktree, { holder: BUILD, used: 30 }), pid: process.pid },
      { ...server(8920, '/Users/martin/mc/programs/mc/goals/x/memoro-cli', { holder: { ...PLAN, pid: DEAD }, used: 400 }), pid: process.pid },
      // A server whose own process is gone is not running, and not counted.
      { ...server(8999, '/w/dead', { holder: BUILD }), pid: DEAD },
    ];
    for (const record of records) writeFileSync(join(root, 'dev-servers', `${record.instance_id}.json`), JSON.stringify(record));
    writeFileSync(join(root, 'dev-queue.json'), JSON.stringify({ schema_version: 1, tickets: [{ ...QUEUE[1], pid: process.pid }] }));
    const data = await collectPage({
      env: { MC_WORK_ROOT: root, MC_HOME: root },
      now: NOW,
      repos: [],
      offline: true,
      run: () => ({ status: 1, stdout: '' }),
      git: (cwd, args) => (args[0] === 'branch' ? `branch-of-${cwd.split('/').at(-2)}` : null),
      checkout: null,
      claudeSettings: () => null,
      alive,
      pool: (args) => readPool({ ...args, main: MAIN }),
    });
    const { dev } = JSON.parse(JSON.stringify(data));
    assert.deepEqual(Object.keys(dev).sort(), ['leased', 'queue', 'queued', 'running', 'servers', 'starting']);
    assert.deepEqual([dev.running, dev.leased, dev.queued], [2, 1, 1]);
    const fields = ['kind', 'holder', 'repo', 'state', 'idle_seconds', 'port', 'worktree', 'branch'];
    const picked = dev.servers.map((one) => Object.fromEntries(fields.map((key) => [key, one[key]])));
    assert.deepEqual(picked, [
      {
        kind: 'main', holder: BUILD, repo: 'memoro', state: 'leased', idle_seconds: 30, port: 8787, worktree: MAIN.worktree, branch: 'branch-of-self',
      },
      {
        kind: 'slot', holder: { ...PLAN, pid: DEAD }, repo: 'memoro-cli', state: 'idle', idle_seconds: 400, port: 8920,
        worktree: '/Users/martin/mc/programs/mc/goals/x/memoro-cli', branch: 'branch-of-x',
      },
    ]);
    for (const one of dev.servers) assert.deepEqual(Object.keys(one.holder).sort(), ['kind', 'name', 'owner', 'pid']);
    assert.deepEqual([dev.servers[0].name, dev.servers[1].holder_gone], ['BUILD mc/no-work', true]);
    assert.deepEqual(dev.queue, [{
      holder: { kind: 'build', owner: 'memoro', name: 'hero-detail-objects', pid: 600 }, name: 'BUILD hero-detail-objects',
      worktree: '/w/one', service: 'memoro-worker', gate: false, waited_seconds: 200,
    }]);
  });
});
