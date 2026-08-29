/**
 * The front door: bare `mc` is the page, and the verbs that used to print a
 * list of their own say where they went.
 *
 * The menu reads `/dev/tty` by design, so a subprocess without a terminal
 * never reaches it — which is one of the properties asserted here: no TTY, no
 * prompt, exit 0. The menu itself is driven in process with the reading and
 * the opening handed in, so a number can be shown to open the workarea WORK
 * gave that number to without a session ever starting.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runMcCli } from './_helpers/mc-cli.js';
import { menu, parsePageArgs, watch } from '../../src/mc/commands/home.js';

/** A work root with two areas and a queue, and nothing that needs a network. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-front-door-'));
  const workRoot = join(root, 'work');
  mkdirSync(join(workRoot, 'runner', 'log'), { recursive: true });
  writeFileSync(join(workRoot, 'queue.md'), '# the queue\nalpha\n');
  for (const name of ['alpha', 'beta']) mkdirSync(join(workRoot, name, 'repo', '.git'), { recursive: true });
  return {
    root,
    workRoot,
    env: {
      MC_HOME: join(root, 'home'),
      MC_WORK_ROOT: workRoot,
      MC_ROLES_DIR: join(root, 'roles'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      MC_REPOS: '',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('bare mc', () => {
  it('prints the page, and without a terminal never prompts', () => {
    const fx = fixture();
    try {
      const result = runMcCli([], fx.env);
      assert.equal(result.status, 0, result.stderr);
      for (const section of ['NOW', 'QUEUE', 'DECISIONS', 'INTAKE', 'WORK']) {
        assert.match(result.stdout, new RegExp(`^\\s+${section}\\b`, 'mu'), `${section} is missing`);
      }
      // The numbers the menu opens, on the rows the menu opens them from.
      assert.match(result.stdout, /\balpha\b/u);
      assert.match(result.stdout, /\bbeta\b/u);
    } finally { fx.cleanup(); }
  });

  it('--json exits 0 with the object the renderer takes and no prompt', () => {
    const fx = fixture();
    try {
      const result = runMcCli(['--json'], fx.env);
      assert.equal(result.status, 0, result.stderr);
      const page = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(page), ['now', 'queue', 'decisions', 'intake', 'work', 'caches', 'notes']);
      assert.deepEqual(page.work.areas.map((area) => area.number), [1, 2]);
    } finally { fx.cleanup(); }
  });

  it('mc work with no name is the same page', () => {
    const fx = fixture();
    try {
      const bare = runMcCli([], fx.env);
      const viaWork = runMcCli(['work'], fx.env);
      assert.equal(viaWork.status, 0, viaWork.stderr);
      assert.deepEqual(
        JSON.parse(runMcCli(['work', '--json'], fx.env).stdout).work.areas.map((a) => a.name),
        JSON.parse(runMcCli(['--json'], fx.env).stdout).work.areas.map((a) => a.name),
      );
      assert.equal(bare.stdout.split('\n').length, viaWork.stdout.split('\n').length);
    } finally { fx.cleanup(); }
  });

  it('refuses an argument it does not know, and says the two surfaces', () => {
    const fx = fixture();
    try {
      const result = runMcCli(['--nonsense'], fx.env);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /unknown command "--nonsense"/u);
    } finally { fx.cleanup(); }
  });
});

describe('the verbs that became mc', () => {
  it('mc list says where it went', () => {
    const fx = fixture();
    try {
      const result = runMcCli(['list'], fx.env);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /mc list is now mc/u);
      assert.match(result.stderr, /mc --watch/u);
      assert.equal(result.stdout, '');
    } finally { fx.cleanup(); }
  });

  it('mc sessions list says the same', () => {
    const fx = fixture();
    try {
      const result = runMcCli(['sessions', 'list'], fx.env);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /mc sessions list is now mc/u);
    } finally { fx.cleanup(); }
  });

  it('bare mc status says where it went; a name still answers', () => {
    const fx = fixture();
    try {
      const bare = runMcCli(['status'], fx.env);
      assert.equal(bare.status, 2);
      assert.match(bare.stderr, /mc status is now mc/u);
      assert.match(bare.stderr, /mc status <name>/u);

      const named = runMcCli(['status', 'alpha', '--json'], fx.env);
      assert.equal(named.status, 0, named.stderr);
      assert.equal(JSON.parse(named.stdout).name, 'alpha');
    } finally { fx.cleanup(); }
  });

  it('the board flags are gone — they are a name now, and there is no such project', () => {
    const fx = fixture();
    try {
      for (const flag of ['--sessions', '--watch', '--wait']) {
        const result = runMcCli(['status', flag], fx.env);
        assert.equal(result.status, 2, `${flag} still answers`);
        assert.match(result.stderr, /mc status is now mc/u);
      }
    } finally { fx.cleanup(); }
  });
});

describe('the page flags', () => {
  it('reads --watch with and without its seconds, and rejects the rest', () => {
    assert.deepEqual(parsePageArgs([]), { json: false, fresh: false, watch: 0 });
    assert.deepEqual(parsePageArgs(['--watch']), { json: false, fresh: false, watch: 15 });
    assert.deepEqual(parsePageArgs(['--watch', '3']), { json: false, fresh: false, watch: 3 });
    assert.deepEqual(parsePageArgs(['--json', '--fresh']), { json: true, fresh: true, watch: 0 });
    // What the page does anyway, still accepted so step 2's habit keeps working.
    assert.deepEqual(parsePageArgs(['--offline']), { json: false, fresh: false, watch: 0 });
    assert.match(parsePageArgs(['--sessions']).error, /unknown argument: --sessions/u);
  });

  it('watch redraws and leaves the terminal with its cursor back', async () => {
    const written = [];
    const stdout = { isTTY: true, columns: 100, write: (text) => written.push(text) };
    let drawn = 0;
    const code = await watch(15, {
      stdout,
      draw: async () => { drawn += 1; return ['  NOW', `  step ${drawn}`, '  WORK']; },
      sleep: async () => {},
      rounds: 3,
    });
    assert.equal(code, 0);
    assert.equal(drawn, 3);
    // The first page whole, then only the line that moved.
    assert.match(written[0], /NOW/u);
    assert.equal(written.filter((text) => /step 2/u.test(text)).length, 1);
    assert.ok(!/NOW/u.test(written[1]), 'a page that did not change shape is not drawn again');
    assert.equal(written.at(-1), `${String.fromCharCode(27)}[?25h`, 'the cursor is put back');
  });
});

describe('the menu under the page', () => {
  /** WORK, as the page hands it over: the numbers are these numbers. */
  const DATA = {
    work: {
      count: 2,
      areas: [
        { number: 1, name: 'mc-ui', live: true },
        { number: 2, name: 'docx-editor', live: false },
      ],
      without_workarea: 0,
    },
  };

  function drive(answers) {
    const written = [];
    const opened = [];
    const queue = [...answers];
    return {
      opened,
      written,
      run: () => menu(DATA, {
        stdout: { columns: 100, write: (text) => written.push(text) },
        stderr: { write: (text) => written.push(text) },
        page: async () => ({ data: DATA, lines: ['  WORK'] }),
        ask: () => queue.shift() ?? null,
        open: async (name) => { opened.push(name); return 0; },
      }),
    };
  }

  it('opens the workarea a number names — WORK\'s number, not a list of its own', async () => {
    const first = drive(['1']);
    assert.equal(await first.run(), 0);
    assert.deepEqual(first.opened, ['mc-ui']);

    const second = drive(['2']);
    assert.equal(await second.run(), 0);
    assert.deepEqual(second.opened, ['docx-editor']);
  });

  it('opens it by name too, and quits on q or on nothing', async () => {
    const byName = drive(['docx-editor']);
    assert.equal(await byName.run(), 0);
    assert.deepEqual(byName.opened, ['docx-editor']);

    const quit = drive(['q']);
    assert.equal(await quit.run(), 0);
    assert.deepEqual(quit.opened, []);

    const eof = drive([]);
    assert.equal(await eof.run(), 0);
    assert.deepEqual(eof.opened, []);
  });

  it('says a name that is nothing out loud, and asks again', async () => {
    const typo = drive(['mc-uii', 'q']);
    assert.equal(await typo.run(), 0);
    assert.deepEqual(typo.opened, []);
    assert.match(typo.written.join(''), /nothing here called "mc-uii" — n starts one/u);
  });

  it('reads a whole mc work command, with or without its first two words', async () => {
    const full = drive(['mc work docx-editor']);
    assert.equal(await full.run(), 0);
    assert.deepEqual(full.opened, ['docx-editor']);

    const bare = drive(['work mc-ui']);
    assert.equal(await bare.run(), 0);
    assert.deepEqual(bare.opened, ['mc-ui']);
  });

  it('offers b, p, s and w beside the numbers', async () => {
    const shown = drive(['q']);
    await shown.run();
    const keys = shown.written.join('');
    for (const key of ['n  start something new', 'b  brief', 'p <name>  plan', 's <name>', 'w  watch', 'q  quit']) {
      assert.ok(keys.includes(key), `${key} is not offered: ${keys}`);
    }
  });
});
