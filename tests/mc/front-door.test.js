/**
 * The front door: bare `mc` is the page, and the verbs that used to print a
 * list of their own say where they went.
 *
 * The menu reads `/dev/tty` by design, so a subprocess without a terminal
 * never reaches it — which is one of the properties asserted here: no TTY, no
 * prompt, exit 0. The menu itself is driven in process with the reading and
 * the opening handed in, so a number can be shown to open the project PROGRAMMES
 * gave that number to without a session ever starting.
 *
 * The binary itself runs for what only a process shows — no terminal, no
 * prompt, an exit, nothing but bytes in a pipe — and for the words it answers
 * before routing (`--help`, a word nothing routes). Those four runs start
 * together when the file loads, each on a fixture of its own, and the tests
 * read what they printed (`RAN`). Everything else is the routing and the
 * verbs, in this process (`runVerb`): one run of the binary was 0.7–4 s under
 * load, and a test of four spellings paid it four times (2026-11-03).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runMcCliAsync } from './_helpers/mc-cli.js';
import { runVerb } from './_helpers/mc-verb.js';
import { freshFor, menu, parsePageArgs, runnerOrder } from '../../src/mc/commands/home.js';
import { plainReader } from '../../src/mc/page-live.js';
import { programmesSection } from '../../src/mc/page-collect.js';

/** A work root with two areas and a queue, and nothing that needs a network. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-front-door-'));
  const workRoot = join(root, 'work');
  mkdirSync(join(workRoot, 'runner', 'log'), { recursive: true });
  writeFileSync(join(workRoot, 'queue.md'), '# the queue\nalpha\n');
  // Two checkouts directly under the work root that no project in the
  // register explains: strays. mc's own folders are never one.
  for (const name of ['alpha', 'beta']) mkdirSync(join(workRoot, name, 'memoro-cli', '.git'), { recursive: true });
  mkdirSync(join(workRoot, 'brief'), { recursive: true });
  return {
    root,
    workRoot,
    env: {
      MC_HOME: join(root, 'home'),
      MC_WORK_ROOT: workRoot,
      // The repositories the page reads plans from. Pointed at an empty
      // directory, so the fixture is the whole world: without it the page
      // reads whatever `~/memoro` happens to hold on the machine running the
      // test, which was invisible while the section was a list of workareas.
      MC_REPOS_HOME: join(root, 'repos'),
      MC_ROLES_DIR: join(root, 'roles'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      MC_REPOS: '',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

/** The binary's runs this file reads, started together, each on its own fixture. */
const BINARY_FIXTURES = [];
const binary = (args, { world = true } = {}) => {
  const fx = world ? fixture() : null;
  if (fx) BINARY_FIXTURES.push(fx);
  return runMcCliAsync(args, fx?.env ?? {});
};
const [page, pageJson, nonsense, help] = await Promise.all([
  binary([]), binary(['--json']), binary(['--nonsense']), binary(['--help'], { world: false }),
]);
const RAN = { page, pageJson, nonsense, help };
after(() => { for (const fx of BINARY_FIXTURES) fx.cleanup(); });

describe('bare mc', () => {
  it('prints the page, and without a terminal never prompts', () => {
    {
      const result = RAN.page;
      assert.equal(result.status, 0, result.stderr);
      // The overview: its sections, and what it leaves to the operations view (`o`).
      for (const section of ['HORIZONS', 'IN FLIGHT', 'NEEDS ATTENTION']) {
        assert.match(result.stdout, new RegExp(`^\\s+┌─ ${section}\\b`, 'mu'), `${section} is missing`);
      }
      for (const section of ['MERGE & DEPLOY', 'DEV', 'MAINTENANCE', 'SYSTEM']) {
        assert.doesNotMatch(result.stdout, new RegExp(`^\\s+(?:┌─ |── )?${section}\\b`, 'mu'), `${section} belongs to the operations view`);
      }
      assert.doesNotMatch(result.stdout, /┌─ proposals|^\s+┌─ MC\b/mu, 'no pipeline box, no hero frame');
      // No WORK heading: every session is a programme's or a desk's, and the
      // two folders nothing explains are strays under NEEDS ATTENTION.
      assert.doesNotMatch(result.stdout, /^\s+WORK\b/mu);
      assert.match(result.stdout, /^ +alpha +not an area mc knows · checkout yes · 0 uncommitted$/mu);
      assert.match(result.stdout, /^ +beta +not an area mc knows · checkout yes · 0 uncommitted$/mu);
      assert.doesNotMatch(result.stdout, /unplanned-workareas/u);
    }
  });

  it('--json exits 0 with the object the renderer takes and no prompt', async () => {
    const fx = fixture();
    try {
      const result = await runVerb(['--json'], fx.env);
      assert.equal(result.status, 0, result.stderr);
      const page = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(page), ['runner', 'billing', 'providerPriority', 'desk', 'sessions', 'dev', 'merges', 'prs', 'checks', 'docker', 'landed', 'desk_cost', 'intake', 'programmes', 'horizons', 'language', 'mc', 'caches', 'notes']);
      assert.equal(page.providerPriority, 'auto');
      assert.deepEqual(page.merges.repos.map((repo) => [repo.repo, repo.state, repo.waiting, repo.day_count]),
        [['memoro', 'idle', [], 0], ['memoro-cli', 'idle', [], 0]]);
      assert.match(page.billing, /claude \? plan · codex \? plan/u);
      // No dev server on this machine: DEV counts none, and the page says `none running`.
      assert.deepEqual([page.dev.running, page.dev.servers, page.dev.queue], [0, [], []]);
      // No goal here, so there are no programme rows, and both folders are
      // strays — mc's own brief/ is not one. There is no WORK data anywhere.
      assert.deepEqual(page.programmes.programmes, []);
      assert.equal(page.programmes.count, 0);
      assert.deepEqual(page.programmes.strays.map((item) => [item.kind, item.name]), [['directory', 'alpha'], ['directory', 'beta']]);
      assert.equal('work' in page, false);
      assert.equal('unplanned' in page.programmes, false);
      assert.equal('others' in page.sessions, false);
    } finally { fx.cleanup(); }
  });

  /**
   * The live page must not leak into a pipe.
   *
   * `mc` at a terminal refreshes every 30 s and moves the cursor to do it
   * (`page-live.js`). Without a TTY none of that may happen: `colourFor`
   * refuses colour and `run()` returns before `readerFor` is ever reached, so
   * the fork is one fork. This is the assertion that would catch a third
   * opinion about it — a script, a subprocess or a session reading the page
   * would otherwise get cursor moves in the middle of its input.
   */
  it('piped, both surfaces print once, exit 0 and write no escape byte', () => {
    {
      const printed = {};
      for (const [args, result] of [[[], RAN.page], [['--json'], RAN.pageJson]]) {
        printed[args.join(' ')] = result.stdout;
        const { elapsed } = result;
        const what = `mc ${args.join(' ')}`.trim();

        assert.equal(result.signal, null, `${what} had to be killed: it never exited`);
        assert.equal(result.status, 0, `${what}: ${result.stderr}`);
        // Not one escape byte — no colour, no cursor move, no erase.
        assert.ok(!result.stdout.includes('\u001b'), `${what} wrote an escape sequence to a pipe`);
        // It exits rather than waiting: a leaked refresh would sit here for
        // the 30 s interval at the very least, and forever at worst.
        assert.ok(elapsed < 30_000, `${what} took ${elapsed} ms — it waited for something`);
      }

      // Once, not once per refresh. Every section heading appears exactly one
      // time in the whole of stdout.
      for (const section of ['HORIZONS', 'IN FLIGHT', 'NEEDS ATTENTION']) {
        const seen = printed[''].match(new RegExp(`^\\s+(?:┌─ |── )?${section}\\b`, 'gmu')) || [];
        assert.equal(seen.length, 1, `${section} was printed ${seen.length} times`);
      }
      // And --json is one document, not a stream of them.
      const json = printed['--json'];
      assert.equal(json.trimEnd(), JSON.stringify(JSON.parse(json), null, 2));
    }
  });

  // Every session in `mc --json` has an owner, a programme or a desk: a lane
  // file's is its programme, a desk's is the desk (goal mc/no-work).
  it('gives every session in --json an owner: a lane file\'s programme, a desk', async () => {
    const fx = fixture();
    try {
      const runner = join(fx.workRoot, 'runner');
      const started = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
      writeFileSync(join(runner, 'current-memoro-cli.json'), JSON.stringify({
        name: 'alpha', step: 1, kind: 'build', variant: 'project', programme: 'mc', repo: 'memoro-cli', lane: 0,
        tool: 'claude', model: 'opus', pid: process.pid, started,
      }));
      writeFileSync(join(runner, 'current-memoro.json'), JSON.stringify({
        name: 'goal:msr/fast-path', step: null, kind: 'build', variant: 'goal', repo: 'memoro', lane: 0,
        tool: 'codex', model: 'gpt', pid: process.pid, started,
      }));
      mkdirSync(join(runner, 'foreground'), { recursive: true });
      writeFileSync(join(runner, 'foreground', `${process.pid}.json`), JSON.stringify({ verb: 'brief', area: null, tool: 'claude', pid: process.pid, started }));
      const result = await runVerb(['--json'], fx.env);
      assert.equal(result.status, 0, result.stderr);
      const page = JSON.parse(result.stdout);
      assert.deepEqual(page.runner.sessions.map((session) => [session.name, session.owner]), [
        ['alpha', { kind: 'programme', name: 'mc' }],
        // A goal's session is named `<programme>/<goal>`, as its goal row is.
        ['msr/fast-path', { kind: 'programme', name: 'msr' }],
      ]);
      assert.deepEqual(page.sessions.desks.manager.owner, { kind: 'desk', name: 'manager' });
      const all = [...page.runner.sessions, ...Object.values(page.sessions.desks).filter(Boolean),
        ...Object.values(page.sessions.planning_sessions).flat(), ...Object.values(page.sessions.programme_sessions).flat()];
      assert.equal(all.length, 3);
      for (const session of all) assert.ok(['programme', 'desk'].includes(session.owner?.kind) && session.owner.name, JSON.stringify(session));
    } finally { fx.cleanup(); }
  });

  it('refuses an argument it does not know, and says the two surfaces', () => {
    const result = RAN.nonsense;
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command "--nonsense"/u);
  });

  it('the help leads with the one surface and names no other', () => {
    const help = RAN.help.stdout;
    assert.match(help, /^ {2}mc {2,}The one page/mu);
    assert.doesNotMatch(help, /mc --watch/u);
    assert.doesNotMatch(help, /mc status --sessions/u);
    assert.doesNotMatch(help, /^ {2}mc list /mu);
  });
});

describe('the workarea verbs are gone', () => {
  it('mc work and mc worker, with or without a name, exit 2 and say where things went', async () => {
    const fx = fixture();
    try {
      for (const args of [['work'], ['work', 'alpha'], ['work', 'list', '--json'], ['work', 'add', 'x', 'memoro-cli'], ['worker', 'x']]) {
        const result = await runVerb(args, fx.env);
        const what = `mc ${args.join(' ')}`;
        assert.equal(result.status, 2, what);
        assert.equal(result.stdout, '', what);
        assert.match(result.stderr, new RegExp(`^mc: mc ${args[0]} is gone — every session belongs to a programme or a desk$`, 'mu'), what);
        assert.match(result.stderr, /mc plan <programme>/u, what);
        assert.match(result.stderr, /mc martin {13}the desk/u, what);
        assert.doesNotMatch(result.stderr, /mc helper/u, what);
      }
      assert.equal(existsSync(join(fx.workRoot, 'work')), false, 'nothing made ~/mc/work/');
    } finally { fx.cleanup(); }
  });

  it('mc project and mc step, with or without a name, exit 2 and name mc goal from-project', async () => {
    const fx = fixture();
    try {
      for (const args of [['project'], ['project', 'dev-queue'], ['project', 'send', 'x'], ['step', 'ready', 'x', '2']]) {
        const result = await runVerb(args, fx.env);
        const what = `mc ${args.join(' ')}`;
        assert.equal(result.status, 2, what);
        assert.equal(result.stdout, '', what);
        assert.match(result.stderr, new RegExp(`^mc: mc ${args[0]} is gone — projects are goals now$`, 'mu'), what);
        assert.match(result.stderr, /mc goal from-project <programme>\/<project>/u, what);
      }
    } finally { fx.cleanup(); }
  });

  it('the help has no workarea verb', () => {
    const help = RAN.help.stdout;
    assert.doesNotMatch(help, /mc work\b/u);
    assert.doesNotMatch(help, /mc worker\b/u);
  });
});

describe('the verbs that became mc', () => {
  it('mc list says where it went', async () => {
    const fx = fixture();
    try {
      const result = await runVerb(['list'], fx.env);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /mc list is now mc/u);
      assert.doesNotMatch(result.stderr, /--watch/u);
      assert.equal(result.stdout, '');
    } finally { fx.cleanup(); }
  });

  it('mc sessions — all of it — says where it went', async () => {
    const fx = fixture();
    try {
      // `mc sessions list` was the only spelling answered before; the session
      // verbs were cut on 2026-08-30 and the whole family answers now,
      // because somebody typing `mc sessions read` deserves the same sentence
      // as somebody typing `mc sessions list`.
      for (const args of [['sessions'], ['sessions', 'list'], ['sessions', 'read', 'x'], ['sessions', 'send', 'x', 'hi']]) {
        const result = await runVerb(args, fx.env);
        assert.equal(result.status, 2, args.join(' '));
        assert.match(result.stderr, /mc sessions is now mc/u, args.join(' '));
      }
    } finally { fx.cleanup(); }
  });

  it('mc status, bare or with a name, says where it went and names mc goal show', async () => {
    const fx = fixture();
    try {
      for (const args of [['status'], ['status', 'alpha'], ['status', 'alpha', '--json']]) {
        const result = await runVerb(args, fx.env);
        const what = `mc ${args.join(' ')}`;
        assert.equal(result.status, 2, what);
        assert.equal(result.stdout, '', what);
        assert.match(result.stderr, /mc status is now mc/u, what);
        assert.match(result.stderr, /mc goal show <programme>\/<goal>/u, what);
        assert.doesNotMatch(result.stderr, /mc status <name>/u, what);
      }
    } finally { fx.cleanup(); }
  });

  it('the board flags are gone too', async () => {
    const fx = fixture();
    try {
      for (const flag of ['--sessions', '--watch', '--wait']) {
        const result = await runVerb(['status', flag], fx.env);
        assert.equal(result.status, 2, `${flag} still answers`);
        assert.match(result.stderr, /mc status is now mc/u);
      }
    } finally { fx.cleanup(); }
  });
});

describe('the page flags', () => {
  it('reads --json, --fresh and --offline, and rejects the rest — --watch included', () => {
    assert.deepEqual(parsePageArgs([]), { json: false, fresh: false, offline: false });
    assert.deepEqual(parsePageArgs(['--json', '--fresh']), { json: true, fresh: true, offline: false });
    // Ruling 20: the ordinary page fetches; --offline is what skips it.
    assert.deepEqual(parsePageArgs(['--offline']), { json: false, fresh: false, offline: true });
    assert.match(parsePageArgs(['--sessions']).error, /unknown argument: --sessions/u);
    // Removed 2026-08-29: a page redrawn on a timer is not a live page.
    assert.match(parsePageArgs(['--watch']).error, /unknown argument: --watch/u);
  });
});

describe('the menu under the page', () => {
  /**
   * PROGRAMMES as the page actually hands it over — built by the section
   * itself, not written out by hand.
   *
   * It *was* written out by hand, and that is how `mc` shipped broken on
   * 2026-09-02: the page renamed `projects` to `programmes` and regrouped it,
   * the menu kept reading `data.projects.repos`, and this fixture kept
   * agreeing with the menu because it had been written to match. Bare `mc` at
   * a terminal threw a TypeError at the prompt, and every test was green —
   * the only one that touched the menu was measuring a shape nothing produced
   * any more.
   *
   * A fixture that is the real builder cannot do that. Rename a key and this
   * fails on the next run.
   */
  const DATA = {
    programmes: programmesSection({
      goalRows: [
        { name: 'mc-ui', programme: 'mc', repos: ['memoro-cli'], status: 'open', sessions: 0, last: null, running: false, problems: [] },
        { name: 'docx-editor', programme: 'docx-editing-surface', repos: ['memoro'], status: 'open', sessions: 0, last: null, running: false, problems: [] },
      ],
    }),
  };

  // The numbers the page drew are the numbers the menu shows by: goals, in
  // programme order, and no project.
  it('numbers the goals, and nothing else', () => {
    assert.deepEqual(DATA.programmes.programmes.flatMap((g) => g.goals || []).map((goal) => [goal.number, goal.name]),
      [[1, 'docx-editor'], [2, 'mc-ui']]);
    assert.equal(DATA.programmes.programmes.some((g) => 'projects' in g), false);
  });

  function drive(answers, { data = DATA, ...extra } = {}) {
    const written = [];
    const opened = [];
    const programmes = [];
    const queue = [...answers];
    // The reader a terminal too narrow for the live page gets, with the line
    // handed in instead of read: the menu has one way of asking, and this is
    // it with the terminal taken out.
    const stdout = { columns: 100, write: (text) => written.push(text) };
    return {
      opened,
      programmes,
      written,
      run: () => menu(data, {
        stdout,
        stderr: { write: (text) => written.push(text) },
        page: async () => ({ data, lines: ['  PROGRAMMES'] }),
        reader: plainReader({ stdout, ask: () => queue.shift() ?? null }),
        showGoal: async (argv) => { opened.push(argv[1]); return 0; },
        ...extra,
      }),
    };
  }

  it('shows what a number names — PROGRAMMES\' number, not a list of its own', async () => {
    const first = drive(['1', 'q']);
    assert.equal(await first.run(), 0);
    assert.deepEqual(first.opened, ['docx-editing-surface/docx-editor']);

    const second = drive(['2', 'q']);
    assert.equal(await second.run(), 0);
    assert.deepEqual(second.opened, ['mc/mc-ui']);
  });

  /** A page's data with the programmes numbered after the goals, as the collector numbers them. */
  const numbered = (rows) => {
    const programmes = programmesSection({ goalRows: rows });
    programmes.programmes.forEach((group, index) => { group.number = programmes.count + 1 + index; });
    return { programmes };
  };
  const row = (name, programme) => ({ name, programme, repos: ['memoro-cli'], status: 'open', sessions: 0, last: null, running: false, problems: [] });

  it('opens a programme alone by its number or its exact name, and h or home goes back to the overview', async () => {
    const data = numbered([row('mc-ui', 'mc'), row('docx-editor', 'docx-editing-surface')]);
    // Goals are 1 and 2; the programmes follow, by name: docx-editing-surface is 3 and mc is 4.
    assert.deepEqual(data.programmes.programmes.map((group) => [group.programme, group.number]), [['docx-editing-surface', 3], ['mc', 4]]);
    const shown = [];
    const session = drive(['3', 'mc', 'h', 'home', 'q'], { data, show: (name) => shown.push(name) });
    assert.equal(await session.run(), 0);
    assert.deepEqual(shown, ['docx-editing-surface', 'mc', null, null]);
    assert.deepEqual(session.opened, [], 'a programme is opened, not shown as a goal');
    // A number or a name that is nothing is said out loud, and nothing opens.
    const none = [];
    const missed = drive(['9', 'nothing-here', 'q'], { data, show: (name) => none.push(name) });
    assert.equal(await missed.run(), 0);
    assert.deepEqual(none, []);
    assert.match(missed.written.join(''), /nothing here called "nothing-here"/u);
  });

  it('a goal\'s number shows the goal from the overview and from a programme\'s view alike', async () => {
    const data = numbered([row('mc-ui', 'mc'), row('docx-editor', 'docx-editing-surface')]);
    const session = drive(['4', '2', 'h', '1', 'q'], { data, show: () => {} });
    assert.equal(await session.run(), 0);
    assert.deepEqual(session.opened, ['mc/mc-ui', 'docx-editing-surface/docx-editor']);
  });

  it('every word the menu answers stays the menu\'s: a programme named manager or 1 is opened by its number', async () => {
    // Goals: 1 is in the programme `1`, 2 in `manager`; the programmes follow: `1` is 3 and `manager` is 4.
    const data = numbered([row('first-goal', '1'), row('second-goal', 'manager')]);
    assert.deepEqual(data.programmes.programmes.map((group) => [group.programme, group.number]), [['1', 3], ['manager', 4]]);
    const shown = [];
    const session = drive(['manager', '4', '1', '3', 'q'], { data, show: (name) => shown.push(name) });
    assert.equal(await session.run(), 0);
    // `manager` is the retired manager's letter (it says so and keeps the page), `1` is goal 1, and the numbers open the programmes.
    assert.deepEqual(shown, ['manager', '1']);
    assert.deepEqual(session.opened, ['1/first-goal']);
    assert.match(session.written.join(''), /the interactive manager is gone/u);
  });

  it('opens the operations view on o or operations, from the overview and from a programme\'s view, and h or a number leaves it', async () => {
    const data = numbered([row('mc-ui', 'mc'), row('docx-editor', 'docx-editing-surface')]);
    const calls = [];
    // `o` and `operations`, then a number (a programme), then `o` again, then `h`.
    const session = drive(['o', 'operations', '3', 'o', 'h', 'q'], {
      data, show: (name) => calls.push(`show ${name}`), operate: (on) => calls.push(`operate ${on}`),
    });
    assert.equal(await session.run(), 0);
    assert.deepEqual(calls, ['operate true', 'operate true', 'show docx-editing-surface', 'operate true', 'show null']);
    assert.deepEqual(session.opened, [], 'neither word opens a goal or a programme');
  });

  it('`o` and `operations` are the menu\'s own: no programme takes them, and the page draws once per answer', async () => {
    // A programme named `o` or `operations` is reached by its number; the word is the view's.
    const data = numbered([row('first-goal', 'o'), row('second-goal', 'operations')]);
    const calls = [];
    const session = drive(['o', 'operations', '3', '4', 'q'], { data, show: (name) => calls.push(`show ${name}`), operate: (on) => calls.push(`operate ${on}`) });
    assert.equal(await session.run(), 0);
    assert.deepEqual(calls, ['operate true', 'operate true', 'show o', 'show operations']);
  });

  it('`a` unfolds from the overview and from a programme\'s view, and folds again', async () => {
    const data = numbered([row('mc-ui', 'mc')]);
    const flags = [];
    const session = drive(['a', '2', 'a', 'h', 'a', 'q'], { data, show: () => {}, expand: (on) => flags.push(on) });
    assert.equal(await session.run(), 0);
    assert.deepEqual(flags, [true, false, true]);
  });

  // `d` and `desk` are the desk: `mc martin`, which the page's DESK panel summarises. The order is injected, so no session opens.
  it('opens the desk on d or desk, once, and returns its code', async () => {
    for (const [answer, code] of [['d', 0], ['desk', 3]]) {
      const calls = [];
      const session = drive([answer, 'q'], { deskOrder: async (argv, io) => { calls.push([argv, Object.keys(io).sort()]); return code; } });
      assert.equal(await session.run(), code);
      assert.deepEqual(calls, [[[], ['env', 'stderr', 'stdout']]], answer);
      assert.deepEqual(session.opened, []);
    }
    // Neither the manager's letter nor a goal's number is the desk's.
    const calls = [];
    const other = drive(['1', 'q'], { deskOrder: async () => { calls.push(1); return 9; } });
    assert.equal(await other.run(), 0);
    assert.deepEqual(calls, []);
  });

  // The interactive manager is gone (D10): its old letters print the refusal and the page stays; no session opens.
  it('answers m, manager, b and brief with the refusal and draws the page again', async () => {
    for (const answer of ['m', 'manager', 'b', 'brief']) {
      const session = drive([answer, '1', 'q']);
      assert.equal(await session.run(), 0, answer);
      const said = session.written.join('');
      assert.match(said, /mc: the interactive manager is gone — talk to the desk with `mc martin`, or give the manager one task with `mc manager --headless --prompt/u, answer);
      assert.deepEqual(session.opened, ['docx-editing-surface/docx-editor'], `${answer}: the page is still there to answer`);
    }
  });

  it('names the desk and the operations view in the first line of keys, and keeps every line of keys within it', async () => {
    const session = drive(['q']);
    await session.run();
    const keys = session.written.join('').split('\n').filter((line) => /^ {2}\S/u.test(line) && /·|<n>|priority|start/u.test(line));
    assert.ok(keys.some((line) => /^ {2}<n> {2}show a goal or open a programme {3}· {3}a {2}all \/ collapse {3}· {3}o {2}operations {3}· {3}h {2}home {3}· {3}d {2}desk$/u.test(line)), keys.join('\n'));
    // The first line is the widest: the other lines of keys are no wider than it, and it is no wider than 110 columns.
    const first = keys.find((line) => /<n>/u.test(line));
    assert.ok(first.length <= 110, `${first.length} columns`);
    assert.ok(keys.every((line) => line.length <= first.length), keys.map((line) => line.length).join(','));
  });

  it('quits on q or on nothing', async () => {
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
    assert.match(typo.written.join(''), /nothing here called "mc-uii" — a goal's number shows it/u);
  });

  it('answers a workarea verb typed at the prompt with the line the shell gives, and opens nothing', async () => {
    const typed = drive(['mc work docx-editor', 'work mc-ui', 'n', 'q']);
    assert.equal(await typed.run(), 0);
    assert.deepEqual(typed.opened, []);
    const text = typed.written.join('');
    assert.equal(text.match(/mc work is gone — every session belongs to a programme or a desk/gu)?.length, 2);
    assert.match(text, /nothing here called "n"/u, 'n starts nothing any more');
  });

  it('offers a, b and p beside the numbers, and no project, watch or new', async () => {
    const shown = drive(['q']);
    await shown.run();
    const keys = shown.written.join('');
    // `p` takes no name: `mc plan` asks which programme when it is not told,
    // and the page is where being shown the list beats remembering a name.
    for (const key of ['<n>  show a goal or open a programme', 'a  all / collapse', 'h  home', 'd  desk', 'p  plan a programme', 'q  quit']) {
      assert.ok(keys.includes(key), `${key} is not offered: ${keys}`);
    }
    assert.ok(!keys.includes('m  manager'), 'the interactive manager is gone (D10)');
    assert.ok(!keys.includes('s <name>'), 'the menu offers no project');
    assert.ok(!keys.includes('watch'), 'the menu offers no watch');
    assert.ok(!keys.includes('start something new'), 'the menu starts no workarea');
  });

  /**
   * `a` is a way of looking, not a verb: it turns the collapsing off, asks for
   * the page again, and goes back to the prompt. The flag it sets belongs to
   * the caller's closure, because the live loop refreshes through that same
   * closure and a frame that did not know the mode would put the rows away
   * again thirty seconds later (`commands/home.js`).
   */
  // The runner's switch without a second terminal (2026-10-10): the verb's
  // own answer under the page, then the page again, and the menu stays.
  it('runs start, stop and update on the runner, and draws the page again', async () => {
    const orders = [];
    const written = [];
    const answers = ['start', 'stop --force', 'update', 'mc run stop', 'run update --force', 'q'];
    const stdout = { columns: 100, write: (text) => written.push(text) };
    let drawn = 0;
    const code = await menu(DATA, {
      stdout,
      stderr: { write: (text) => written.push(text) },
      page: async () => { drawn += 1; return { data: DATA, lines: ['  PROGRAMMES'] }; },
      reader: plainReader({ stdout, ask: () => answers.shift() ?? null }),
      open: async () => 0,
      runOrder: async (argv) => { orders.push(argv.join(' ')); return 0; },
    });
    assert.equal(code, 0);
    assert.deepEqual(orders, ['start', 'stop --force', 'update', 'stop', 'update --force']);
    assert.equal(drawn, 5, 'the page is drawn again after each order');
  });

  it('reads only a bare stop as the runner\'s', () => {
    assert.deepEqual(runnerOrder('stop'), ['stop']);
    assert.deepEqual(runnerOrder('mc run start --no-merge'), ['start', '--no-merge']);
    assert.equal(runnerOrder('stop mc-ui'), null);
    assert.equal(runnerOrder('run'), null, 'a foreground runner would hold the menu all day');
    assert.equal(runnerOrder('mc-ui'), null);
  });

  it('refreshes on r and refresh, then keeps accepting commands', async () => {
    const answers = ['r', 'refresh', 'q'];
    const errors = [];
    const frames = [];
    const stdout = { write: () => {} };
    let drawn = 0;
    const code = await menu(DATA, {
      stdout,
      stderr: { write: (text) => errors.push(text) },
      page: async () => ({ data: DATA, lines: [`frame ${++drawn}`], key: `key ${drawn}` }),
      reader: {
        ask: async () => answers.shift(),
        show: (lines, key) => frames.push({ lines, key }),
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(frames, [
      { lines: ['frame 1'], key: 'key 1' },
      { lines: ['frame 2'], key: 'key 2' },
    ]);
  });

  it('delegates deploy to the deploy command and returns to the page after success or refusal', async () => {
    const answers = ['deploy', 'mc deploy --dry-run', 'deploy --follow', 'q'];
    const orders = [];
    const errors = [];
    const stdout = { write: () => {} };
    const env = { MC_WORK_ROOT: '/fixture' };
    let drawn = 0;
    const code = await menu(DATA, {
      stdout, env,
      stderr: { write: (text) => errors.push(text) },
      page: async () => { drawn += 1; return { data: DATA, lines: ['  PROGRAMMES'] }; },
      reader: plainReader({ stdout, ask: () => answers.shift() }),
      deployOrder: async (argv, io) => {
        assert.equal(io.stdout, stdout);
        assert.equal(io.env, env);
        assert.equal(io.follow, false, 'the live page remains responsible for status');
        orders.push(argv);
        return orders.length === 1 ? 0 : 1;
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(orders, [[], ['--dry-run'], ['--follow']]);
    assert.equal(drawn, 3);
  });

  it('asks GitHub on f, and draws the page again', async () => {
    let asked = 0;
    let drawn = 0;
    const answers = ['f', 'fresh', 'q'];
    const stdout = { columns: 100, write: () => {} };
    await menu(DATA, {
      stdout,
      stderr: stdout,
      page: async () => { drawn += 1; return { data: DATA, lines: ['  PROGRAMMES'] }; },
      reader: plainReader({ stdout, ask: () => answers.shift() ?? null }),
      fresh: () => { asked += 1; },
    });
    assert.equal(asked, 2);
    assert.equal(drawn, 2);
  });

  // The page at a terminal refills a stale PR cache itself, but asks at most
  // once in five minutes whatever the answer was: a failing `gh` is not
  // asked again on every thirty-second redraw.
  it('freshFor: --fresh and f ask now, a terminal every five minutes, a pipe never', () => {
    const plain = { fresh: false, offline: false };
    assert.equal(freshFor({ opts: { ...plain, fresh: true }, live: false, now: 0 }), true);
    assert.equal(freshFor({ opts: plain, live: true, once: true, now: 0, askedAt: 0 }), true);
    assert.equal(freshFor({ opts: plain, live: false, now: 0 }), false, 'a pipe reads the cache');
    assert.equal(freshFor({ opts: { ...plain, offline: true }, live: true, now: 0 }), false);
    assert.equal(freshFor({ opts: plain, live: true, now: 1_000 }), 'stale', 'the first draw may ask');
    assert.equal(freshFor({ opts: plain, live: true, now: 299_000, askedAt: 0 }), false);
    assert.equal(freshFor({ opts: plain, live: true, now: 300_000, askedAt: 0 }), 'stale');
  });

  it('turns collapsing off and on again with a, and draws the page each time', async () => {
    const modes = [];
    const written = [];
    const answers = ['a', 'a', 'q'];
    const stdout = { columns: 100, write: (text) => written.push(text) };
    const code = await menu(DATA, {
      stdout,
      stderr: { write: (text) => written.push(text) },
      page: async () => ({ data: DATA, lines: ['  PROGRAMMES'] }),
      reader: plainReader({ stdout, ask: () => answers.shift() ?? null }),
      open: async () => 0,
      expand: (on) => modes.push(on),
    });
    assert.equal(code, 0);
    assert.deepEqual(modes, [true, false], 'a shows them all, a again puts them back');
  });

  // A goal's number shows the goal with `mc goal show`, and the page is drawn
  // again under the prompt, as `s` does; the goal is never opened as a project.
  it("a goal's number opens mc goal show", async () => {
    const goalData = {
      programmes: programmesSection({
        goalRows: [{
          name: 'rollout', programme: 'mc', repos: ['memoro-cli'], status: 'open', sessions: 0, last: null, running: false, problems: [],
        }],
      }),
    };
    const shown = [];
    const opened = [];
    const answers = ['1', 'q'];
    const written = [];
    const stdout = { columns: 100, write: (text) => written.push(text) };
    let drawn = 0;
    const code = await menu(goalData, {
      stdout,
      stderr: stdout,
      page: async () => { drawn += 1; return { data: goalData, lines: ['  PROGRAMMES'] }; },
      reader: plainReader({ stdout, ask: () => answers.shift() ?? null }),
      open: async (name) => { opened.push(name); return 0; },
      showGoal: async (argv) => { shown.push(argv.join(' ')); return 0; },
    });
    assert.equal(code, 0);
    assert.deepEqual(shown, ['show mc/rollout'], 'the goal is shown by its programme and name');
    assert.deepEqual(opened, [], 'a goal is not opened as a project');
    assert.equal(drawn, 1, 'the page is drawn again under the goal');
  });
});

it('the page forwards programme priority settings and redraws after the command', async () => {
  const data = { programmes: { programmes: [] } };
  const answers = ['priority mc inbox --set 10', 'q'];
  const orders = [];
  let redraws = 0;
  const code = await menu(data, {
    stdout: { write() {} }, stderr: { write(text) { assert.fail(text); } },
    reader: { ask: async () => answers.shift(), show: () => { redraws += 1; } },
    page: async () => ({ data, lines: [], key: 'changed' }),
    programOrder: async (args) => { orders.push(args); return 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(orders, [['priority', 'mc', 'inbox', '--set', '10']]);
  assert.equal(redraws, 1);
});

it('c and clear archive every finished goal through the verb and redraw, naming the key in the menu', async () => {
  const data = { programmes: { programmes: [] } };
  const answers = ['c', 'clear', 'q'];
  const orders = [];
  const prompts = [];
  let redraws = 0;
  const stdout = { write() {} };
  const code = await menu(data, {
    stdout, stderr: { write(text) { assert.fail(text); } },
    reader: { ask: async (prompt) => { prompts.push(prompt); return answers.shift(); }, show: () => { redraws += 1; } },
    page: async () => ({ data, lines: [], key: 'changed' }),
    archiveOrder: async (io) => { orders.push(io); return 0; },
  });
  assert.equal(code, 0);
  assert.equal(orders.length, 2, 'both spellings archive');
  assert.ok(orders.every((io) => io.stdout === stdout), 'the verb writes to the page\'s output');
  assert.equal(redraws, 2, 'the page is drawn again after each');
  assert.match(prompts[0], /c {2}clear finished goals/u);
});
