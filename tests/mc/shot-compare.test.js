/**
 * `mc shot dev --compare <ref>`: the other tree, the diff, and what is printed.
 *
 * Git, the servers and the capture script are injected: what is asserted is
 * which git commands mc would run (and on which directories), how two measure
 * lists pair up, and the lines a caller reads.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/shot.js';
import { diffMeasure, refOutPath } from '../../src/mc/shot-compare.js';

const HERE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REF_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const FOOTER = {
  element: 'footer.assistant-layout__footer',
  rect: { top: 760, bottom: 810, left: 0, right: 390, width: 390, height: 50 },
  position: 'absolute',
  padding: '0px 12px',
  margin: '0px',
  overflow_y: 'visible',
  z_index: '5',
  scroll: null,
  visible: true,
};
const CONTENT = {
  element: 'main.window-view__content',
  rect: { top: 0, bottom: 844, left: 0, right: 390, width: 390, height: 844 },
  position: 'relative',
  padding: '0px',
  margin: '0px',
  overflow_y: 'auto',
  z_index: 'auto',
  scroll: { top: 1200, height: 2044, client: 844 },
  visible: true,
};

describe('diffMeasure', () => {
  it('the same lists give nothing, and no measure on either side gives nothing', () => {
    assert.deepEqual(diffMeasure([CONTENT, FOOTER], [CONTENT, FOOTER]), []);
    assert.deepEqual(diffMeasure(undefined, undefined), []);
    assert.deepEqual(diffMeasure([], []), []);
  });

  it('a moved rect.bottom is one entry with both values; drift under 0.05 is not', () => {
    const moved = { ...FOOTER, rect: { ...FOOTER.rect, bottom: 776, top: 726.02 } };
    const diff = diffMeasure([CONTENT, { ...FOOTER, rect: { ...FOOTER.rect, top: 726 } }], [CONTENT, moved]);
    assert.deepEqual(diff, [
      { index: 1, element: 'footer.assistant-layout__footer', field: 'rect.bottom', ref: 810, here: 776 },
    ]);
  });

  it('an element only one side has is missing on the other', () => {
    assert.deepEqual(diffMeasure([CONTENT], [CONTENT, FOOTER]), [
      { index: 1, element: FOOTER.element, field: 'missing', ref: null, here: FOOTER.element },
    ]);
    assert.deepEqual(diffMeasure([CONTENT, FOOTER], [CONTENT]), [
      { index: 1, element: FOOTER.element, field: 'missing', ref: FOOTER.element, here: null },
    ]);
  });

  it('visible flipping is a difference, and so is a scroll key', () => {
    const diff = diffMeasure([CONTENT, FOOTER], [{ ...CONTENT, scroll: { ...CONTENT.scroll, top: 1100 } }, { ...FOOTER, visible: false }]);
    assert.deepEqual(diff.map((item) => [item.index, item.field, item.ref, item.here]), [
      [0, 'scroll.top', 1200, 1100],
      [1, 'visible', true, false],
    ]);
  });

  it('the same background colour on both trees is no difference', () => {
    const navy = { ...FOOTER, background_color: 'rgb(33, 39, 49)' };
    assert.deepEqual(diffMeasure([navy], [navy]), []);
  });

  it('a different background colour is one entry with both values', () => {
    const diff = diffMeasure([{ ...FOOTER, background_color: 'rgb(33, 39, 49)' }], [{ ...FOOTER, background_color: 'rgb(255, 252, 247)' }]);
    assert.deepEqual(diff, [
      { index: 0, element: FOOTER.element, field: 'background_color', ref: 'rgb(33, 39, 49)', here: 'rgb(255, 252, 247)' },
    ]);
  });

  it('a colour only one tree reports is not compared', () => {
    assert.deepEqual(diffMeasure([{ ...FOOTER, background_color: 'rgb(33, 39, 49)' }], [FOOTER]), []);
  });
});

const SHOT_JSON = {
  schema_version: 1,
  argv: [process.execPath, 'fake-shot.mjs'],
  default_viewport: 'desktop',
  viewports: { desktop: { width: 1440, height: 900, dpr: 2 }, iphone: { width: 390, height: 844, dpr: 3, mobile: true } },
  shells: { base: '.base-view' },
  targets: [{ name: 'assistant', path: '/app/assistant' }],
  default_account: 'seeded',
  accounts: {
    seeded: { summary: 's', onboarding: { done: '/dev/login?account=seeded&ready=1', fresh: '/dev/login?account=seeded&reseed=1' } },
  },
};
const TEST_JSON = {
  schema_version: 1,
  environments: { dev: { service: 'memoro-worker' }, prod: { base_url: 'https://meetmemoro.app/' } },
  suites: [{ name: 'smoke', argv: ['true'] }],
};

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function compare(argv, {
  measures = {}, warnings = {}, refuse = null, clicked = {}, extra = {}, ambiguous = false, cwd = null,
} = {}) {
  const waits = [];
  const holders = [];
  const home = mkdtempSync(join(tmpdir(), 'mc-shot-compare-cmd-'));
  const worktree = join(home, 'programs', 'x', 'goals', 'here', 'memoro');
  const shared = join(home, 'self', 'memoro');
  const other = join(home, 'programs', 'x', 'goals', 'other', 'memoro');
  const repo = join(home, 'repos', 'memoro.git');
  const ambiguousOther = join(home, 'programs', 'y', 'goals', 'other', 'memoro');
  const refDir = other;
  mkdirSync(join(worktree, '.mc'), { recursive: true });
  mkdirSync(join(other, '.mc'), { recursive: true });
  if (ambiguous) mkdirSync(join(ambiguousOther, '.mc'), { recursive: true });
  mkdirSync(shared, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(worktree, '.mc', 'shot.json'), JSON.stringify(SHOT_JSON));
  writeFileSync(join(worktree, '.mc', 'test.json'), JSON.stringify(TEST_JSON));
  writeFileSync(join(other, '.mc', 'shot.json'), JSON.stringify(SHOT_JSON));
  writeFileSync(join(other, '.mc', 'test.json'), JSON.stringify(TEST_JSON));
  if (ambiguous) writeFileSync(join(ambiguousOther, '.mc', 'shot.json'), JSON.stringify(SHOT_JSON));
  argv = argv.map((arg) => arg === '<other-path>' ? other : arg);
  const stdout = sink();
  const stderr = sink();
  const captures = [];
  const servers = [];
  const gitCalls = [];
  const code = await run(argv, {
    stdout,
    stderr,
    env: { ...process.env, MC_REPOS_HOME: home, MC_WORK_ROOT: home },
    cwd: cwd ? cwd(worktree) : home,
    callerWorktree: () => worktree,
    serversFor: () => [],
    stopServer: () => ({ ok: true }),
    git: (args) => (gitCalls.push(args), args.includes('worktree') ? { status: 0, stdout: `worktree ${worktree}\nHEAD ${HERE_SHA}\n\nworktree ${other}\nHEAD ${REF_SHA}\n${ambiguous ? `\nworktree ${ambiguousOther}\nHEAD ${REF_SHA}\n` : ''}` } : args[0] === 'rev-list' ? { status: 0, stdout: '2\n' } : { status: 0, stdout: '' }),
    readDeclaration: () => ({ ok: true, declaration: TEST_JSON }),
    ensureAppServer: async (dir, declaration, opts) => {
      servers.push(dir);
      waits.push(opts?.deps?.admitWaitSeconds);
      holders.push(opts?.deps?.holderVerb);
      if (refuse && dir !== worktree) return { ok: false, error: refuse.error, refused: refuse.verdict };
      const port = dir === worktree ? 8787 : dir === shared ? 8788 : 8789;
      return { ok: true, baseUrl: `http://127.0.0.1:${port}`, server: { url: `http://127.0.0.1:${port}/`, built_from: { commit: dir === shared ? 'maincommit' : REF_SHA } } };
    },
    servedTree: (dir, server) => ({ worktree: dir, branch: 'b', commit: server.built_from.commit.slice(0, 10), line: dir === worktree ? 'here-tree' : 'ref-tree' }),
    runCapture: ({ worktree: ran, request }) => {
      captures.push({ ran, request });
      const side = request.base_url.endsWith('8787') ? 'here' : 'ref';
      return {
        ok: true,
        result: {
          ok: true, file: request.out, url: `${request.base_url}/app/assistant`, measure: measures[side], warnings: warnings[side] || [],
          ...(clicked[side] && request.click ? { clicked: request.click } : {}),
          ...(extra[side] || {}),
        },
      };
    },
  });
  return { code, stdout: stdout.text, stderr: stderr.text, captures, servers, worktree, refDir, shared, other, waits, holders, gitCalls, home };
}

describe('mc shot dev --compare', () => {
  it('serves both trees, captures both with this tree\'s script, prints two paths then the diff', async () => {
    const result = await compare(['dev', 'assistant', '--viewport', 'iphone', '--measure', '@layout', '--compare', 'origin/main'], {
      measures: {
        ref: [CONTENT, FOOTER],
        here: [CONTENT, { ...FOOTER, rect: { ...FOOTER.rect, bottom: 776 } }],
      },
      warnings: { ref: ['2 elements match'] },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.servers, [result.worktree, result.shared]);
    assert.match(result.stderr, /mc: here: serving here-tree/u);
    assert.match(result.stderr, /mc: main: serving ref-tree; 2 commits behind origin\/main/u);
    assert.deepEqual(result.captures.map((item) => item.ran), [result.worktree, result.worktree], 'both run with this tree\'s script');
    const [here, ref] = result.captures.map((item) => item.request);
    assert.equal(here.sign_in.url, 'http://127.0.0.1:8787/dev/login?account=seeded&ready=1');
    assert.equal(ref.sign_in.url, 'http://127.0.0.1:8788/dev/login?account=seeded&ready=1');
    assert.equal(ref.measure, here.measure);
    assert.equal(ref.out, refOutPath(here.out, 'maincommit'));
    assert.match(ref.out, /-maincom\.png$/u);
    const lines = result.stdout.trimEnd().split('\n');
    assert.deepEqual(lines, [
      here.out,
      ref.out,
      'diff  footer.assistant-layout__footer  rect.bottom  810 → 776',
      'mc: warning — main: 2 elements match',
    ]);
  });

  it('--click is pressed on both trees, and a ref side that does not say so refuses the pair', async () => {
    const both = await compare(['dev', 'assistant', '--click', '.tab', '--compare', 'origin/main'], {
      clicked: { here: true, ref: true },
    });
    assert.equal(both.code, 0, both.stderr);
    assert.deepEqual(both.captures.map((item) => item.request.click), [['.tab'], ['.tab']]);

    const refOnly = await compare(['dev', 'assistant', '--click', '.tab', '--compare', 'origin/main'], {
      clicked: { here: true },
    });
    assert.equal(refOnly.code, 1);
    assert.match(refOnly.stderr, /mc: main: the picture at /u);
    assert.equal(refOnly.stdout, '');
  });

  it('receipt: a missing compare receipt names the installed mc and the script actually used on either side', async () => {
    for (const side of ['here', 'ref']) {
      const result = await compare(['dev', 'assistant', '--click', '.tab', '--compare', 'origin/main'], {
        clicked: side === 'ref' ? { here: true } : {},
      });
      assert.equal(result.code, 1);
      const label = side === 'here' ? 'here' : 'main';
      assert.ok(result.stderr.includes(`mc: ${label}: the picture at `), result.stderr);
      assert.ok(result.stderr.includes(`this installed mc does not understand the result from ${SHOT_JSON.argv.join(' ')} in ${result.worktree}`), result.stderr);
      assert.doesNotMatch(result.stderr, /<unknown worktree>|<unknown script>/u);
      assert.equal(result.stdout, '');
    }
  });

  it('receipt: compare accepts acted for clicks on both sides and a thrown eval on either side exits 1', async () => {
    const clicked = await compare(['dev', 'assistant', '--click', '.tab', '--compare', 'origin/main'], {
      extra: { here: { acted: [{}] }, ref: { acted: [{}] } },
    });
    assert.equal(clicked.code, 0, clicked.stderr);
    assert.deepEqual(clicked.stdout.trimEnd().split('\n'), clicked.captures.map(({ request }) => request.out));

    for (const side of ['here', 'ref']) {
      const result = await compare(['dev', 'assistant', '--eval', 'document.title', '--compare', 'origin/main'], {
        extra: {
          here: { acted: [{}] }, ref: { acted: [{}] },
          [side]: { acted: [{}], evaluated: [{ error: 'Error: bad' }] },
        },
      });
      assert.equal(result.code, 1, result.stderr);
      assert.deepEqual(result.stdout.trimEnd().split('\n'), [
        ...result.captures.map(({ request }) => request.out),
        `${side === 'here' ? 'here' : 'main'}: eval 1  threw: Error: bad`,
      ]);
    }
  });

  it('each side prints its own error, eval and failed lines, and a failed step on either side exits 1', async () => {
    const result = await compare(['dev', 'assistant', '--eval', 'document.title', '--compare', 'origin/main'], {
      extra: {
        here: { acted: [{}], errors: [{ kind: 'console', text: 'boom', count: 2 }], evaluated: [{ value: 'Memoro' }] },
        ref: { evaluated: [], failed: { step: 1, kind: 'eval', error: 'ReferenceError: x is not defined' } },
      },
    });
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n').slice(2), [
      'here: error  console  boom ×2',
      'here: eval 1  "Memoro"',
      'main: failed  step 1 (eval): ReferenceError: x is not defined',
    ]);
  });

  it('says the numbers are the same when a measure was asked and nothing moved, and nothing without one', async () => {
    const same = await compare(['dev', 'assistant', '--measure', '@layout', '--compare', 'origin/main'], {
      measures: { ref: [FOOTER], here: [FOOTER] },
    });
    assert.equal(same.stdout.split('\n')[2], 'mc: the measured numbers are the same on both trees');
    const none = await compare(['dev', 'assistant', '--compare', 'origin/main']);
    assert.equal(none.stdout.trimEnd().split('\n').length, 2);
  });

  it('--json carries both results and the diff', async () => {
    const result = await compare(['dev', 'assistant', '--measure', '@layout', '--compare', 'origin/main', '--json'], {
      measures: { ref: [FOOTER], here: [{ ...FOOTER, visible: false }] },
    });
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.here.served.line, 'here-tree');
    assert.equal(json.ref.ref, 'origin/main');
    assert.equal(json.ref.commit, 'maincommit');
    assert.equal(json.ref.kind, 'main');
    assert.equal(json.ref.worktree, result.shared);
    assert.equal(json.ref.behind_origin_main, 2);
    assert.equal(json.ref.result.served.line, 'ref-tree');
    assert.deepEqual(json.diff, [{ index: 0, element: FOOTER.element, field: 'visible', ref: true, here: false }]);
  });

  it('--compare with prod or with --out exits 2 before anything runs', async () => {
    for (const [argv, said] of [
      [['prod', 'assistant', '--compare', 'origin/main'], /--compare is for dev — production has one tree/u],
      [['dev', 'assistant', '--compare', 'origin/main', '--out', 'x.png'], /two files need two names/u],
    ]) {
      const result = await compare(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.stderr, said);
      assert.deepEqual(result.servers, []);
      assert.deepEqual(result.captures, []);
    }
  });



  it('pooled: --compare main serves the shared checkout as the other side, makes no tree and no directory', async () => {
    for (const args of [['main'], ['origin/main'], []]) {
      const argv = ['dev', 'assistant', '--measure', '@layout', '--compare', ...args];
      const result = await compare(argv, { measures: { ref: [FOOTER], here: [{ ...FOOTER, visible: false }] } });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.servers, [result.worktree, result.shared]);
      assert.deepEqual(result.holders, ['shot', 'shot']);
      assert.equal(result.gitCalls.some((args) => args.includes('worktree')), false);
      assert.equal(result.stdout.trimEnd().split('\n')[0], result.captures[0].request.out);
      assert.equal(result.stdout.trimEnd().split('\n')[1], result.captures[1].request.out);
      assert.match(result.stdout, /\ndiff  footer\.assistant-layout__footer  visible  true → false/u);
      assert.match(result.stderr, /mc: main: serving ref-tree; (\d+ commits behind origin\/main|at origin\/main)/u);
      assert.equal(existsSync(join(result.home, 'compare')), false);
      assert.equal(existsSync(join(result.home, '.memoro')), false);
      if (args.length === 0) {
        const json = await compare(['dev', 'assistant', '--compare', '--json']);
        assert.equal(JSON.parse(json.stdout).ref.kind, 'main');
      }
    }
  });

  it('pooled: --compare <worktree> takes exactly one more lease, on that worktree, by path and by name', async () => {
    for (const target of ['<other-path>', 'other']) {
      const result = await compare(['dev', 'assistant', '--measure', '@layout', '--compare', target, '--json']);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.servers, [result.worktree, result.other]);
      assert.deepEqual(result.holders, ['shot', 'shot']);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ref.kind, 'worktree');
      assert.equal(json.ref.worktree, result.other);
      assert.match(result.captures[1].request.out, /-bbbbbbb\.png$/u);
    }
  });

  it('pooled: a sha, HEAD, a tag, a branch or a path outside ~/mc is refused naming the two forms, before a server starts', async () => {
    for (const value of ['bbbbbbbbbb', 'HEAD', 'v1', 'feature/x', '/tmp/elsewhere']) {
      const result = await compare(['dev', 'assistant', '--compare', value]);
      assert.equal(result.code, 2, value);
      assert.match(result.stderr, /--compare takes main .* or a memoro worktree under ~\/mc by path or name/u);
      assert.equal(result.stderr.trimEnd().split('\n').length, 1);
      assert.doesNotMatch(result.stderr, /mc: mc:/u);
      assert.deepEqual(result.servers, []);
      assert.equal(existsSync(join(result.home, 'compare')), false);
      assert.equal(existsSync(join(result.home, '.memoro')), false);
    }
    const ambiguous = await compare(['dev', 'assistant', '--compare', 'other'], { ambiguous: true });
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.stderr, /--compare takes main .* or a memoro worktree under ~\/mc by path or name/u);
    assert.match(ambiguous.stderr, /matches more than one memoro worktree/u);
    assert.match(ambiguous.stderr, /goals\/other\/memoro/u);
    assert.equal(ambiguous.stderr.trimEnd().split('\n').length, 1);
    assert.deepEqual(ambiguous.servers, []);
  });

  it('pooled: a relative path to the selected here worktree is refused from a subdirectory before either server starts', async () => {
    const result = await compare(['dev', 'assistant', '--compare', '..'], { cwd: (worktree) => join(worktree, 'src') });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stderr.trim(), 'mc: .. is this tree — nothing to compare');
    assert.deepEqual(result.servers, []);
  });

  it('pooled: compare does not excuse a second target, and a refused other server keeps admission coverage', async () => {
    const extra = await compare(['dev', 'assistant', 'ignored', '--compare', 'main']);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /one target at a time \(ignored is extra\)/u);
    assert.deepEqual(extra.servers, []);

    for (const error of [
      '2 of 2 app servers already running — srv-a (/x), srv-b (/y); stop one with mc test dev --stop in its worktree',
      'only 9% memory free (floor 15%)',
    ]) {
      const refused = await compare(['dev', 'assistant', '--compare', 'main'], { refuse: { error } });
      assert.equal(refused.code, 1, refused.stderr);
      assert.deepEqual(refused.servers, [refused.worktree, refused.shared]);
      assert.deepEqual(refused.waits, [undefined, 60]);
      assert.match(refused.stderr, new RegExp(error.startsWith('2 of') ? '2 of 2 app servers already running' : 'only 9% memory free', 'u'));
      assert.doesNotMatch(refused.stderr, /running compare servers/u);
    }
  });

});
