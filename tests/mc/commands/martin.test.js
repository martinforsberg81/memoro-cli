import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { run, get } from '../../../src/mc/commands/martin.js';
import { collectMartinQueue, renderMartinQueue } from '../../../src/mc/martin-collect.js';
import { goalJson } from '../_helpers/goal-file.js';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mc-martin-'));
  roots.push(home);
  const make = (p, g, fields = {}, comments = []) => {
    const dir = join(home, p, 'goals', g);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'GOAL.json'), goalJson({ status: 'Martin', ...fields }));
    writeFileSync(join(dir, 'LOG.md'), comments.join('\n\n'));
    return dir;
  };
  mkdirSync(join(home, 'alpha'), { recursive: true });
  mkdirSync(join(home, 'beta'), { recursive: true });
  writeFileSync(join(home, 'alpha', 'README.md'), 'Alpha aim');
  writeFileSync(join(home, 'beta', 'README.md'), 'Beta aim');
  return { home, make };
}
const log = (at, status, comment, tool = 'person') => `## ${at} · ${tool} · build · ${status}\n\nComment: ${comment}`;
function io() { const out = { stdout: '', stderr: '' }; return { out, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } }; }

describe('mc martin get', () => {
  it('filters live cross-programme records, preserves old current questions, orders stably, and dedupes programme context', () => {
    const f = fixture();
    f.make('alpha', 'older', {}, [log('2026-01-01T00:00Z', 'Martin', 'Martin is asked: Keep or change?\nOption keep: Keep it\nOption change: Change it\nRecommended: change\njev: recommended change') , ...[1,2,3,4].map(n => log(`2026-01-0${n+1}T00:00Z`, 'Martin', `continuation ${n}`, 'claude'))]);
    f.make('alpha', 'questionless', {}, [log('2026-02-01T00:00Z', 'Martin', 'Martin is asked: historical question?\nOption yes: Yes\nOption no: No\nRecommended: yes'), log('2026-02-02T00:00Z', 'ready', 'returned to build'), log('2026-03-01T00:00Z', 'Martin', 'runner failure: stale lock')]);
    f.make('alpha', 'ready', { status: 'ready' }, []);
    f.make('alpha', 'blocked', { status: 'blocked' }, []);
    f.make('alpha', 'done', { stage: 'done' }, []);
    f.make('alpha', 'dropped', { stage: 'dropped' }, []);
    f.make('beta', 'third', {}, [log('2026-01-01T00:00Z', 'Martin', 'Martin is asked: Beta question?\nOption a: A\nOption b: B\nRecommended: a')]);
    f.make('alpha', 'badlog', {}, ['## this is not a valid log heading\n\nComment: malformed']);
    const archived = join(f.home, 'alpha', 'goals', '.archive', 'old'); mkdirSync(archived, { recursive: true }); writeFileSync(join(archived, 'GOAL.json'), goalJson({ status: 'Martin' }));
    mkdirSync(join(f.home, 'alpha', 'goals', 'malformed'), { recursive: true }); writeFileSync(join(f.home, 'alpha', 'goals', 'malformed', 'GOAL.json'), '{bad');
    const before = snapshot(f.home);
    const result = collectMartinQueue({ home: f.home });
    assert.deepEqual(result.items.map(i => i.reference), ['alpha/older', 'beta/third', 'alpha/questionless', 'alpha/badlog']);
    assert.equal(result.items[0].question.question, 'Keep or change?');
    assert.deepEqual(result.items[0].question.options, [{ key: 'keep', text: 'Keep it' }, { key: 'change', text: 'Change it' }]);
    assert.equal(result.items[0].question.recommendation, 'change');
    assert.match(result.items[0].question.jev, /recommended change/u);
    assert.equal(result.items[0].log.length, 3, 'tail is bounded independently of the pending question');
    assert.equal(result.items[2].question.question, undefined, 'resolved historical question is not revived');
    assert.match(result.items[2].question.reason, /runner failure: stale lock/u);
    assert.match(result.items[2].question.limitation, /No structured question/u);
    assert.deepEqual(result.programme_context.map(p => p.programme), ['alpha', 'beta']);
    const rendered = renderMartinQueue(result);
    assert.equal((rendered.match(/Alpha aim/g) || []).length, 1, 'README text appears once for alpha');
    assert.match(rendered, /\[full LOG\.md\]\(file:/u);
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues.some(i => /malformed\/GOAL\.json$/u.test(i.path)));
    assert.ok(result.issues.some(i => /badlog\/LOG\.md$/u.test(i.path)));
    assert.deepEqual(snapshot(f.home), before, 'collector is read-only');
  });

  it('supports default/all, programme and goal selectors, text and JSON with empty and invalid results', () => {
    const f = fixture(); f.make('alpha', 'waiting', {}, [log('2026-01-01T00:00Z', 'Martin', 'Martin is asked: Question?\nOption a: A\nOption b: B\nRecommended: a')]);
    for (const flags of [[], ['--all'], ['--programme', 'alpha'], ['--goal', 'alpha/waiting']]) {
      const { out, stdout, stderr } = io();
      assert.equal(get(flags, { home: f.home, stdout, stderr }), 0, out.stderr);
      assert.match(out.stdout, /alpha\/waiting/u);
    }
    const json = io(); assert.equal(get(['--goal', 'alpha/waiting', '--json'], { home: f.home, stdout: json.stdout, stderr: json.stderr }), 0);
    assert.equal(JSON.parse(json.out.stdout).items[0].reference, 'alpha/waiting');
    const allJson = io(); assert.equal(get(['--json'], { home: f.home, stdout: allJson.stdout, stderr: allJson.stderr }), 0);
    assert.deepEqual(JSON.parse(allJson.out.stdout).items.map(i => i.reference), ['alpha/waiting']);
    for (const [args, expected] of [[['--programme','beta'], /no goals waiting/u], [['--programme','absent'], /unknown or invalid programme/u], [['--goal','alpha/nope'], /unknown or invalid goal/u], [['--all','--goal','alpha/waiting'], /exactly one/u], [['--all','--all'], /exactly one/u]]) {
      const { out, stdout, stderr } = io();
      const code = get(args, { home: f.home, stdout, stderr });
      assert.equal(code, expected.source.includes('no goals') ? 0 : 2);
      assert.match(out.stdout + out.stderr, expected);
    }
  });

  it('reports unreadable source paths instead of counting missing records as resolved', () => {
    const f = fixture();
    mkdirSync(join(f.home, 'alpha', 'goals', 'opaque'), { recursive: true });
    const items = collectMartinQueue({ home: f.home, read: () => null });
    assert.equal(items.items.length, 0);
    assert.match(items.issues[0].path, /opaque\/GOAL\.json$/u);
  });
});

describe('mc martin launch', () => {
  it('opens a distinct role/path with fresh queue context and launcher conventions', async () => {
    const { out, stdout, stderr } = io(); let opened;
    const code = await run(['--resume', 'abc', '--codex', '--model', 'gpt-6.1-sol'], {
      stdout, stderr, env: { MC_WORK_ROOT: '/work', MC_HOME: '/home' }, interactive: () => true,
      collect: () => ({ items: [{ reference: 'alpha/g', title: 'Current', log: [], goal_markdown: '# Current', worktrees: [], rulings: [], evidence_paths: [] }], programme_context: [], issues: [] }),
      open: async (options) => { opened = options; return { ok: true, code: 0 }; }, mkdir: () => {},
      role: () => ({ name: 'martin', model: 'opus', tools: ['claude','codex'], cache: '5m', overlay: 'Martin role instructions' }),
    });
    assert.equal(code, 0, out.stderr);
    assert.equal(opened.areaName, 'martin'); assert.equal(opened.verb, 'martin');
    assert.equal(opened.areaRoot, '/work/martin'); assert.equal(opened.roleName, 'martin');
    assert.equal(opened.pick, 'abc'); assert.equal(opened.tool, 'codex'); assert.equal(opened.model, 'gpt-6.1-sol');
    assert.match(opened.prompt, /alpha\/g/u); assert.match(opened.resumePrompt, /Refresh from the live decision queue/u);
  });

  it('refuses unattended launch before creating a desk or opening a child', async () => {
    let opened = 0, made = 0; const { out, stdout, stderr } = io();
    assert.equal(await run([], { stdout, stderr, env: { MC_HEADLESS: '1' }, interactive: () => true, mkdir: () => { made += 1; }, open: () => { opened += 1; } }), 2);
    assert.equal(opened, 0); assert.equal(made, 0); assert.match(out.stderr, /interactive-only/u);
  });
});

function snapshot(root) {
  const rows = [];
  function walk(path) { for (const name of readdirSync(path)) { const child = join(path, name); const st = lstatSync(child); if (st.isDirectory()) { rows.push([child, 'directory']); walk(child); } else rows.push([child, 'file', readFileSync(child).toString()]); } }
  walk(root); return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
