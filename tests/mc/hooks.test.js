/**
 * `mc hook` — what a session is told at start, and which shell commands are
 * turned to an mc verb. The rules are pure over a git runner and the inputs,
 * so they are tested without a session or a repository.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/hook.js';
import {
  agyHookInput, agyHooksEntry, hookTargets, hookTargetsDrift, targetInstall, targetRegistration,
  ALLOW_MARK, HEADLESS_RULES, hookDrift, hookRegistration, inMcTerritory, installHooks, knownRepo, MC_HOOKS, preToolDecision, protectedGoalFile, protectedProgrammeFile, TOOLBOX,
  readClaudeSettings, repoHookDecision, reviewStopDecision,
  repoPreToolHooks, sessionStartContext, shellCommands, warningsFor, worktreeState, worktreesAt,
} from '../../src/mc/hooks.js';
import { makeRepoLayout } from './_helpers/bare-layout.js';
import { git as gitIn } from './_helpers/git-fixture.js';

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

/** A git that answers from a table: the args joined by spaces → stdout, or a failure. */
function gitFrom(table) {
  return (args) => {
    const key = args.join(' ');
    return Object.hasOwn(table, key) ? { status: 0, stdout: `${table[key]}\n` } : { status: 1, stdout: '' };
  };
}

const MERGED = {
  'branch --show-current': 'plan/assistant',
  'config --get branch.plan/assistant.merge': 'refs/heads/plan/assistant',
  'rev-list --count HEAD..origin/main': '1025',
  'rev-list --count origin/main..HEAD': '1',
  'status --porcelain=v1 --untracked-files=normal': '',
  'rev-parse --path-format=absolute --git-common-dir': '/repo/.git',
};

describe('mc hook — the worktree a session starts in', () => {
  it('a merged branch far behind main is said, with the command that answers it', () => {
    const state = worktreeState('/w/memoro', {
      git: gitFrom(MERGED), now: 10 * 3_600_000, stat: () => ({ mtimeMs: 9 * 3_600_000 }),
    });
    assert.equal(state.upstreamGone, true);
    assert.equal(state.behind, 1025);
    const warnings = warningsFor(state);
    assert.equal(warnings.length, 1, 'gone outranks behind: one warning, not two for one cause');
    assert.match(warnings[0], /plan\/assistant tracked a remote branch that is gone/u);
    assert.match(warnings[0], /git switch -c <new-branch> origin\/main/u);
  });

  it('a live branch behind main is said; a fresh one says nothing', () => {
    const behind = warningsFor({ branch: 'x', upstreamGone: false, behind: 80, fetchedAgeH: 1 });
    assert.match(behind[0], /80 commits behind origin\/main/u);
    assert.deepEqual(warningsFor({ branch: 'x', upstreamGone: false, behind: 3, fetchedAgeH: 1 }), []);
    assert.match(warningsFor({ branch: 'main', upstreamGone: false, behind: 0, fetchedAgeH: 1 })[0], /never commit here/u);
    assert.match(warningsFor({ branch: 'x', upstreamGone: false, behind: 0, fetchedAgeH: 30 })[0], /last fetched 30 h ago/u);
  });

  it('a session started in a workarea is told the repository files were not loaded', () => {
    const text = sessionStartContext({
      cwd: '/home/mc/plan/assistant',
      inside: false,
      states: [{
        worktree: '/home/mc/plan/assistant/memoro', branch: 'b', behind: 0, ahead: 2, dirty: 1,
        upstreamGone: false, fetchedAgeH: 0, server: { url: 'http://127.0.0.1:8920' },
      }],
    });
    assert.match(text, /outside the repositories: their CLAUDE\.md was NOT loaded; their PreToolUse hooks are run by mc hook pre-tool/u);
    assert.match(text, /Read \/home\/mc\/plan\/assistant\/memoro\/CLAUDE\.md/u);
    assert.match(text, /b · 0 behind \/ 2 ahead of origin\/main · 1 changed file · dev server http:\/\/127\.0\.0\.1:8920/u);
    assert.match(text, /mc shot dev/u);
    assert.match(text, /mc publish/u);
    assert.match(sessionStartContext({ cwd: '/x', inside: true, states: [], env: {} }), /session role unknown.*MC_ROLE.*MC_GOAL and cwd \/x/u);
  });

  it('SessionStart does not announce proposals left in a programme directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-hook-proposals-'));
    const dir = join(root, 'programs', 'mc', 'proposals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-11-03-mc-a.md'), 'a\n');
    const text = sessionStartContext({ cwd: join(root, 'programs', 'mc'), inside: true, states: [], env: { MC_WORK_ROOT: root } });
    // The unknown-role diagnostic echoes the fixture root, not a proposal notice.
    assert.doesNotMatch(text.replaceAll(root, '<work-root>'), /proposal/u);
  });

  it('finds the worktrees of a workarea, and only those mc knows', () => {
    const area = mkdtempSync(join(tmpdir(), 'mc-hook-area-'));
    for (const name of ['memoro', 'memoro-cli', 'notes']) mkdirSync(join(area, name));
    const known = (dir) => (dir.endsWith('/memoro') || dir.endsWith('/memoro-cli')
      ? { name: dir.split('/').pop(), worktree: dir } : null);
    const found = worktreesAt(area, { knownRepo: known });
    assert.equal(found.inside, false);
    assert.deepEqual(found.worktrees.map((entry) => entry.name).sort(), ['memoro', 'memoro-cli']);
    const inside = worktreesAt(join(area, 'memoro'), { knownRepo: known });
    assert.equal(inside.inside, true);
  });

  it('knows a worktree of a bare repository, and the self checkout, by the shared git directory', () => {
    const fx = makeRepoLayout({ bare: ['memoro-cli'], self: ['memoro-cli'] });
    try {
      const worktree = join(fx.root, 'mc', 'work', 'x', 'memoro-cli');
      gitIn(join(fx.home, 'memoro-cli.git'), `worktree add -q -b x "${worktree}" origin/main`);
      assert.deepEqual(knownRepo(worktree, { env: fx.env }), { name: 'memoro-cli', worktree });
      const self = join(fx.home, 'self', 'memoro-cli');
      assert.deepEqual(knownRepo(self, { env: fx.env }), { name: 'memoro-cli', worktree: self });
      assert.equal(knownRepo(worktree, { env: { ...fx.env, MC_REPOS_HOME: join(fx.root, 'elsewhere') } }), null,
        'another home knows no such repository');
    } finally { fx.cleanup(); }
  });
});

describe('mc hook — shell commands that have an mc verb', () => {
  it('turns each to its verb', () => {
    const cases = [
      ['gh pr create --title x', 'pr-create', /mc publish/u],
      ['git push -u origin x', 'push', /mc publish/u],
      ['cd memoro && git push', 'push', /mc publish/u],
      ['gh pr edit 12 --body-file x', 'pr-edit', /mc publish/u],
      ['gh pr merge 12 --squash --match-head-commit abc', 'pr-merge', /mc merge <repo> <pr>/u],
      ['npm run ci -- --base-ref origin/main', 'ci', /mc gate <files…>/u],
      ['npm test', 'npm-test', /merge round/u],
      ['cd memoro && npm run test 2>&1 | tail', 'npm-test', /mc gate/u],
      ['node --test tests/a.test.js 2>&1 | tail -20', 'node-test', /mc gate <files…>/u],
      ['node --import ./tests/_isolate-home.mjs --test tests/a.test.js', 'node-test', /gate lane/u],
      ['npm ci', 'npm-install', /deps:ensure/u],
      ['cd memoro && npm ci 2>&1 | tail -5', 'npm-install', /deps:ensure/u],
      ['npm install', 'npm-install', /deps:ensure/u],
      ['npm i --include=dev', 'npm-install', /deps:ensure/u],
      ['npm ci --no-audit --no-fund', 'npm-install', /deps:ensure/u],
      ['npm clean-install', 'npm-install', /deps:ensure/u],
      ['npm install && npm run build', 'npm-install', /deps:ensure/u],
      ['npm run dev:agent -- --restart', 'dev-server', /mc test dev --here --url/u],
      ['npm run dev', 'dev-server', /mc test dev/u],
      ['xcrun simctl create "iPhone 16 (one-camera)" com.apple.CoreSimulator.SimDeviceType.iPhone-16', 'simulator', /device named `mc`/u],
      ['cd ios && xcrun simctl clone mc mc-2', 'simulator', /erase mc/u],
      ['simctl create mcx "iPhone 17"', 'simulator', /create exactly that one/u],
      ['xcodebuild -sdk iphonesimulator build', 'xcodebuild-sim', /mc asc build --sim/u],
      ['cd ios/App && xcodebuild -project App.xcodeproj -scheme App -destination "platform=iOS Simulator,name=mc" build 2>&1 | tail', 'xcodebuild-sim', /mc asc build --sim/u],
      ['xcrun xcodebuild -scheme App -sdk iphonesimulator -derivedDataPath build/dd archive', 'xcodebuild-sim', /stops a build that is silent for 5 minutes/u],
    ];
    for (const [command, id, said] of cases) {
      const decision = preToolDecision(bash(command));
      assert.equal(decision?.id, id, command);
      assert.match(decision.reason, said, command);
      assert.match(decision.reason, new RegExp(ALLOW_MARK, 'u'), `${command}: the escape is named`);
    }
  });

  it('leaves alone what has no verb, the admin fallback, and a command that carries the escape', () => {
    for (const command of [
      'git status', 'npm run test:affected', 'node scripts/x.mjs --test-name-pattern y', 'npm run css:lint', 'git commit -m "push the thing"', 'gh pr view 3 --json state',
      'gh pr merge 12 --squash --admin', `${ALLOW_MARK} git push --force-with-lease`, 'npm run deps:prepare',
      `${ALLOW_MARK} gh pr edit 12 --base main`, 'echo "gh pr edit 12"',
      'npm run ci -- --list --json',
      'xcrun simctl create mc "iPhone 17"', "xcrun simctl create 'mc' 'iPhone 17'", 'xcrun simctl boot mc', 'xcrun simctl erase mc',
      'xcrun simctl list devices',
      'xcodebuild -version', 'xcodebuild -list -project ios/App/App.xcodeproj', 'xcodebuild -sdk iphonesimulator -showBuildSettings -scheme App',
      'xcodebuild -project ios/App/App.xcodeproj -scheme App -destination generic/platform=iOS build', 'xcodebuild -showsdks | grep -i simulator',
      'npm install pako', 'npm i -D @types/node', 'npm install --save-dev foo', 'npm install --package-lock-only --ignore-scripts',
      'npm run deps:ensure', 'npm install-test', 'npm ci-info', `${ALLOW_MARK} npm ci`,
    ]) {
      assert.equal(preToolDecision(bash(command)), null, command);
    }
  });

  it('turns a scratch Playwright script to mc shot, and leaves the repository\'s own alone', () => {
    const write = (path, content) => ({ tool_name: 'Write', tool_input: { file_path: path, content } });
    const script = "import { chromium } from 'playwright';\n";
    const inRepo = (path) => path.startsWith('/repo/');
    assert.equal(preToolDecision(write('/tmp/scratch/measure.mjs', script), { inRepo })?.id, 'playwright');
    assert.match(preToolDecision(write('/tmp/m.mjs', script), { inRepo }).reason, /mc shot dev <target>.*--measure/u);
    assert.equal(preToolDecision(write('/repo/scripts/capture.mjs', script), { inRepo }), null);
    assert.equal(preToolDecision(write('/tmp/m.mjs', `// ${ALLOW_MARK}: needs a drag\n${script}`), { inRepo }), null);
    assert.equal(preToolDecision(write('/tmp/notes.md', 'playwright is a library'), { inRepo }), null);
  });

  it('acts only on mc\'s ground', () => {
    const env = { MC_WORK_ROOT: '/home/u/mc' };
    assert.equal(inMcTerritory('/home/u/mc/plan/assistant', { env, knownRepo: () => null }), true);
    assert.equal(inMcTerritory('/home/u/elsewhere', { env, knownRepo: () => null }), false);
    assert.equal(inMcTerritory('/home/u/memoro', { env, knownRepo: () => ({ name: 'memoro' }) }), true);
  });
});

describe('mc hook — a goal file under ~/mc/programs is mc\'s to change', () => {
  const programs = mkdtempSync(join(tmpdir(), 'mc-hook-programs-'));
  const deny = (input) => preToolDecision(input, { programs });

  it('names a GOAL.json under programs, at any depth, and no other', () => {
    assert.equal(protectedGoalFile(join(programs, 'a', 'goals', 'x', 'GOAL.json'), { programs }), true);
    assert.equal(protectedGoalFile(join(programs, 'GOAL.json'), { programs }), true);
    assert.equal(protectedGoalFile(join(programs, 'a', 'goals', 'x', 'LOG.md'), { programs }), false);
    assert.equal(protectedGoalFile(`${programs}-other/a/GOAL.json`, { programs }), false, 'a sibling directory is not under it');
  });

  it('refuses a Write, Edit or MultiEdit of a goal file', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const decision = deny({ tool_name: tool, tool_input: { file_path: join(programs, 'a', 'goals', 'x', 'GOAL.json') } });
      assert.equal(decision?.id, 'goal-file', tool);
      assert.match(decision.reason, /a goal changes through `mc goal`/u);
    }
  });

  it('lets through the same name under another directory, and the other files of a programme', () => {
    assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: join('/elsewhere', 'x', 'GOAL.json') } }), null);
    assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: join(programs, 'a', 'rulings.md') } }), null);
  });

  it('resolves a relative file_path against the session\'s cwd', () => {
    const input = { tool_name: 'Edit', cwd: join(programs, 'a'), tool_input: { file_path: join('goals', 'x', 'GOAL.json') } };
    assert.equal(deny(input)?.id, 'goal-file');
    assert.equal(deny({ ...input, cwd: '/elsewhere' }), null, 'the same relative name under another cwd is another file');
  });

  it('refuses a shell command that writes one, with the escape named, and lets a read of one through', () => {
    const file = join(programs, 'a', 'goals', 'x', 'GOAL.json');
    for (const command of [`jq . > ${file}`, "sed -i '' s/a/b/ GOAL.json", 'mv x.json GOAL.json', 'echo x | tee GOAL.json']) {
      const decision = preToolDecision(bash(command), { programs });
      assert.equal(decision?.id, 'goal-file', command);
      assert.match(decision.reason, /Escape, when the raw command is really meant/u, `${command}: the escape is named`);
    }
    for (const command of ['cat GOAL.json', 'jq . GOAL.json', 'mc goal set x/y title --text z']) {
      assert.equal(preToolDecision(bash(command), { programs }), null, command);
    }
    assert.equal(preToolDecision(bash(`${ALLOW_MARK} jq . > ${file}`), { programs }), null, 'the escape lets it through');
  });

  it('refuses a Write, Edit or MultiEdit of a programme record with id programme-file, and keeps the goal file at goal-file', () => {
    const record = join(programs, 'a', 'PROGRAMME.json');
    assert.equal(protectedProgrammeFile(record, { programs }), true);
    assert.equal(protectedProgrammeFile(join(programs, 'a', 'goals', 'x', 'GOAL.json'), { programs }), false);
    assert.equal(protectedProgrammeFile(`${programs}-other/a/PROGRAMME.json`, { programs }), false, 'a sibling directory is not under it');
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const decision = deny({ tool_name: tool, tool_input: { file_path: record } });
      assert.equal(decision?.id, 'programme-file', tool);
      assert.match(decision.reason, /mc programs create/u);
      assert.match(decision.reason, /mc programs record/u);
      assert.equal(deny({ tool_name: tool, tool_input: { file_path: join(programs, 'a', 'goals', 'x', 'GOAL.json') } })?.id, 'goal-file', `${tool}: a goal file is still a goal file`);
    }
    assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: join('/elsewhere', 'a', 'PROGRAMME.json') } }), null);
    assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: join(programs, 'a', 'README.md') } }), null);
  });

  it('refuses a shell command that writes a programme record, with the escape named, and lets a read through', () => {
    const file = join(programs, 'a', 'PROGRAMME.json');
    for (const command of [`jq . > ${file}`, "sed -i '' s/a/b/ PROGRAMME.json", 'mv x.json PROGRAMME.json', 'echo x | tee PROGRAMME.json']) {
      const decision = preToolDecision(bash(command), { programs });
      assert.equal(decision?.id, 'programme-file', command);
      assert.match(decision.reason, /Escape, when the raw command is really meant/u, `${command}: the escape is named`);
    }
    for (const command of ['cat PROGRAMME.json', 'jq . PROGRAMME.json', 'mc programs show x', 'mc programs create x --end y']) {
      assert.equal(preToolDecision(bash(command), { programs }), null, command);
    }
    assert.equal(preToolDecision(bash('jq . > GOAL.json'), { programs })?.id, 'goal-file');
    assert.equal(preToolDecision(bash(`${ALLOW_MARK} jq . > ${file}`), { programs }), null, 'the escape lets it through');
  });


  it('the PreToolUse matcher carries the edit tools, so the refusal sees them', () => {
    assert.equal(MC_HOOKS.find((hook) => hook.which === 'pre-tool').matcher, 'Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*');
  });
});

describe('mc hook — Claude in Chrome against a local dev server is turned to mc shot next', () => {
  const chrome = (verb, input) => ({ tool_name: `mcp__claude-in-chrome__${verb}`, tool_input: input });

  it('turns a navigate to 127.0.0.1, localhost or [::1] with id chrome-dev', () => {
    const decision = preToolDecision(chrome('navigate', { url: 'http://127.0.0.1:8920/app', tabId: 1 }));
    assert.equal(decision?.id, 'chrome-dev');
    assert.match(decision.reason, /mc shot dev <path> --keep.*mc shot next/u);
    assert.match(decision.reason, /#MC_HOOK_ALLOW=1/u);
    for (const url of ['http://localhost:8920/app/notes', 'http://[::1]:8920/app', 'localhost:5173']) {
      assert.equal(preToolDecision(chrome('navigate', { url }))?.id, 'chrome-dev', url);
    }
    assert.equal(preToolDecision(chrome('tabs_create_mcp', { url: 'http://localhost:8920/app' }))?.id, 'chrome-dev');
  });

  it('turns a browser_batch that holds one such navigate', () => {
    const batch = chrome('browser_batch', {
      actions: [
        { tool: 'computer', input: { action: 'screenshot' } },
        { tool: 'navigate', input: { url: 'http://127.0.0.1:8920/app' } },
      ],
    });
    assert.equal(preToolDecision(batch)?.id, 'chrome-dev');
    assert.equal(preToolDecision(chrome('browser_batch', {
      actions: [{ tool: 'navigate', input: { url: 'https://example.com' } }, { tool: 'computer', input: { action: 'screenshot' } }],
    })), null, 'a batch on a real site passes');
  });

  it('lets through a real site, a published artifact, an open tab and the escape', () => {
    for (const input of [
      chrome('navigate', { url: 'https://claude.ai/artifact/0f3c' }),
      chrome('navigate', { url: 'https://meetmemoro.app/app' }),
      chrome('navigate', { url: 'http://localhost.example.com/' }),
      chrome('computer', { action: 'screenshot', tabId: 1 }),
      chrome('tabs_context_mcp', {}),
      chrome('navigate', { url: 'http://127.0.0.1:8920/app#MC_HOOK_ALLOW=1' }),
      chrome('browser_batch', { actions: [{ tool: 'navigate', input: { url: 'http://localhost:8920/app#MC_HOOK_ALLOW=1' } }] }),
    ]) {
      assert.equal(preToolDecision(input), null, JSON.stringify(input));
    }
  });

  it('the session-start toolbox names stepping a flow with mc shot next, within the block\'s width', () => {
    assert.ok(TOOLBOX.some((line) => /^ {2}step a flow {7}mc shot next /u.test(line)));
    assert.ok(TOOLBOX.some((line) => line.includes('[--keep → mc shot next …]')));
    assert.ok(Math.max(...TOOLBOX.map((line) => [...line].length)) <= 119);
  });
});

describe('mc hook — a repository\'s own hooks, for a session that started outside it', () => {
  /**
   * One area per file, its hook scripts run once here. On macOS a freshly
   * written script pays 0.3-0.9 s at its first exec, and the tests paid it per
   * test (3.2 s, 2026-11-03). Built while the file loads, outside any test's
   * time; the tests only read the area.
   */
  const shared = buildRepoWithHooks();
  for (const script of ['block.sh', 'stop.sh']) spawnSync(join(shared.area, 'memoro', '.claude', 'hooks', script), { input: '' });
  const repoWithHooks = () => shared;

  function buildRepoWithHooks() {
    const area = mkdtempSync(join(tmpdir(), 'mc-hook-repo-'));
    const hooks = join(area, 'memoro', '.claude', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'block.sh'), `#!/bin/sh\ninput=$(cat)\ncase "$input" in *'wrangler d1 execute'*) printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by block.sh"}}';; esac\nexit 0\n`);
    writeFileSync(join(hooks, 'stop.sh'), `#!/bin/sh\ninput=$(cat)\ncase "$input" in *'git stash pop'*) echo 'stash is shared' >&2; exit 2;; esac\nexit 0\n`);
    chmodSync(join(hooks, 'block.sh'), 0o755);
    chmodSync(join(hooks, 'stop.sh'), 0o755);
    writeFileSync(join(area, 'memoro', '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/block.sh' },
              { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/stop.sh' },
            ],
          },
          { matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] },
        ],
      },
    }));
    const find = () => ({ inside: false, worktrees: [{ name: 'memoro', worktree: join(area, 'memoro') }] });
    return { area, find };
  }

  it('reads the hook commands a worktree names for a tool, in file order', () => {
    const { area } = repoWithHooks();
    assert.deepEqual(repoPreToolHooks(join(area, 'memoro'), 'Bash'), [
      '$CLAUDE_PROJECT_DIR/.claude/hooks/block.sh', '$CLAUDE_PROJECT_DIR/.claude/hooks/stop.sh',
    ]);
    assert.deepEqual(repoPreToolHooks(join(area, 'memoro'), 'Read'), ['true']);
    assert.deepEqual(repoPreToolHooks(join(area, 'memoro'), 'Write'), []);
    assert.deepEqual(repoPreToolHooks(area, 'Bash'), [], 'no .claude, no hooks');
  });

  it('passes a deny on stdout through, named by repository, with $CLAUDE_PROJECT_DIR the worktree', () => {
    const { area, find } = repoWithHooks();
    const decision = repoHookDecision(bash('cd memoro && npx wrangler d1 execute memoro-db --remote'), { cwd: area, worktreesAt: find });
    assert.equal(decision?.id, 'repo-hook');
    assert.match(decision.reason, /^memoro hook: Blocked by block\.sh/u);
  });

  it('reads exit 2 as a denial, with stderr as the reason', () => {
    const { area, find } = repoWithHooks();
    assert.equal(repoHookDecision(bash('git stash pop'), { cwd: area, worktreesAt: find })?.reason, 'memoro hook: stash is shared');
  });

  it('lets through what no hook denies, the repository Claude Code loaded itself, and a cwd with no worktrees', () => {
    const { area, find } = repoWithHooks();
    assert.equal(repoHookDecision(bash('ls'), { cwd: area, worktreesAt: find }), null);
    assert.equal(repoHookDecision(bash('npx wrangler d1 execute memoro-db --remote'), {
      cwd: area, worktreesAt: find, projectDir: join(area, 'memoro'),
    }), null, 'Claude Code already ran that repository\'s hooks');
    assert.equal(repoHookDecision(bash('npx wrangler d1 execute memoro-db --remote'), {
      cwd: area, worktreesAt: () => ({ inside: false, worktrees: [] }),
    }), null);
  });
});

describe('mc hook install — mc\'s own registration', () => {
  const FOREIGN = { matcher: 'Bash|Read', hooks: [{ type: 'command', command: '/x/block-secret-reads.sh' }] };
  const OLD = {
    permissions: { allow: ['Bash'] },
    hooks: {
      PreToolUse: [FOREIGN, { matcher: 'Bash|Write', hooks: [{ type: 'command', command: 'mc hook pre-tool 2>/dev/null || true' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'mc hook session-start 2>/dev/null || true' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'mc hook stop 2>/dev/null || true' }] }],
    },
  };

  it('names the one entry that is out of date', () => {
    const before = hookRegistration(OLD);
    assert.equal(before.problems.length, 1);
    assert.equal(before.problems[0].which, 'pre-tool');
    assert.equal(hookDrift(before), 'pre-tool on Bash|Write, want Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*');
  });

  it('replaces the entry with the matcher before the Chrome tools in place, rather than adding one', () => {
    const before = {
      hooks: {
        PreToolUse: [FOREIGN, { matcher: 'Bash|Write|Read|Edit|MultiEdit', hooks: [{ type: 'command', command: 'mc hook pre-tool 2>/dev/null || true' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'mc hook session-start 2>/dev/null || true' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'mc hook stop 2>/dev/null || true' }] }],
      },
    };
    assert.equal(hookDrift(hookRegistration(before)), 'pre-tool on Bash|Write|Read|Edit|MultiEdit, want Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*');
    const next = installHooks(before);
    assert.equal(hookRegistration(next).ok, true);
    assert.equal(next.hooks.PreToolUse.length, 2);
    assert.deepEqual(next.hooks.PreToolUse[0], FOREIGN);
    assert.equal(next.hooks.PreToolUse[1].matcher, 'Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*');
  });

  it('names all three entries as missing from settings with no hooks', () => {
    assert.equal(hookDrift(hookRegistration({})), 'session-start not registered, pre-tool not registered, stop not registered');
    assert.deepEqual(installHooks({}).hooks.Stop, [{ hooks: [{ type: 'command', command: 'mc hook stop 2>/dev/null || true' }] }]);
  });

  it('writes mc\'s entries beside the others, and changes nothing else', () => {
    const next = installHooks(OLD);
    assert.equal(hookRegistration(next).ok, true);
    assert.deepEqual(next.hooks.PreToolUse[0], FOREIGN);
    assert.deepEqual(next.permissions, { allow: ['Bash'] });
    assert.equal(OLD.hooks.PreToolUse[1].matcher, 'Bash|Write', 'the argument is not changed');
    assert.deepEqual(installHooks(next), next, 'a second install changes nothing');
  });

  it('reduces two mc pre-tool entries to one', () => {
    const next = installHooks({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'mc hook pre-tool' }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: 'mc hook pre-tool 2>/dev/null || true' }] },
        ],
      },
    });
    assert.equal(next.hooks.PreToolUse.length, 1);
    assert.deepEqual(next.hooks.PreToolUse[0], {
      matcher: 'Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*', hooks: [{ type: 'command', command: 'mc hook pre-tool 2>/dev/null || true' }],
    });
  });

  it('reads a missing, unparseable or non-object file as null, and never throws', () => {
    assert.equal(readClaudeSettings('/nope/settings.json'), null);
    assert.equal(readClaudeSettings('/whatever/settings.json', { readFileSync: () => '{oops' }), null);
    assert.equal(readClaudeSettings('/whatever/settings.json', { readFileSync: () => '[1]' }), null);
  });
});

describe('mc hook — the door', () => {
  function sink() {
    let text = '';
    return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
  }

  it('denies in the shape Claude Code reads, and exits 0 on anything', async () => {
    const stdout = sink();
    const code = await run(['pre-tool'], {
      stdout,
      stderr: sink(),
      readStdin: async () => JSON.stringify({ cwd: '/home/u/mc/x', ...bash('gh pr create') }),
      inMcTerritory: () => true,
      pathInKnownRepo: () => false,
      repoHookDecision: () => null,
    });
    assert.equal(code, 0);
    const answer = JSON.parse(stdout.text);
    assert.equal(answer.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(answer.hookSpecificOutput.permissionDecisionReason, /^mc: Use `mc publish`/u);

    const quiet = sink();
    assert.equal(await run(['pre-tool'], { stdout: quiet, stderr: sink(), readStdin: async () => 'not json' }), 0);
    assert.equal(quiet.text, '', 'a hook that cannot read its input says nothing');
    assert.equal(await run(['pre-tool'], {
      stdout: quiet, stderr: sink(), readStdin: async () => JSON.stringify(bash('gh pr create')), inMcTerritory: () => false,
    }), 0);
    assert.equal(quiet.text, '', 'outside mc\'s ground nothing is turned');
  });

  it('a repository\'s denial wins over the turn to an mc verb', async () => {
    const stdout = sink();
    await run(['pre-tool'], {
      stdout,
      stderr: sink(),
      readStdin: async () => JSON.stringify({ cwd: '/home/u/mc/plan/x', ...bash('gh pr create') }),
      inMcTerritory: () => true,
      pathInKnownRepo: () => false,
      repoHookDecision: () => ({ id: 'repo-hook', reason: 'memoro hook: Blocked by block.sh' }),
    });
    const answer = JSON.parse(stdout.text);
    assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(answer.hookSpecificOutput.permissionDecisionReason, 'mc: memoro hook: Blocked by block.sh');
  });

  it('answers session start with additional context, and silence where mc has nothing', async () => {
    const stdout = sink();
    await run(['session-start'], {
      syncSkills: () => [],
      stdout,
      stderr: sink(),
      readStdin: async () => JSON.stringify({ cwd: '/w/memoro', hook_event_name: 'SessionStart' }),
      worktreesAt: () => ({ inside: true, worktrees: [{ name: 'memoro', worktree: '/w/memoro' }] }),
      listServers: () => ({ servers: [] }),
      worktreeState: (worktree) => ({
        worktree, branch: 'plan/assistant', behind: 1025, ahead: 1, dirty: 0, upstreamGone: true, fetchedAgeH: 0, server: null,
      }),
    });
    const answer = JSON.parse(stdout.text);
    assert.equal(answer.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(answer.hookSpecificOutput.additionalContext, /WARNING: plan\/assistant tracked a remote branch that is gone/u);

    const none = sink();
    await run(['session-start'], {
      syncSkills: () => [],
      stdout: none, stderr: sink(), readStdin: async () => '{"cwd":"/tmp"}', worktreesAt: () => ({ inside: false, worktrees: [] }),
    });
    assert.match(JSON.parse(none.text).hookSpecificOutput.additionalContext, /^mc — session role unknown/u);
  });

  it('refuses a form it does not know', async () => {
    const stderr = sink();
    assert.equal(await run(['post-tool'], { stdout: sink(), stderr }), 2);
    assert.match(stderr.text, /session-start, pre-tool or stop/u);
  });
});

describe('mc hook stop: a goal\'s review ends only once it has decided and written its proposal', () => {
  const HOME = '/p';
  const STARTED = '2026-11-03T20:00:00.000Z';
  const REVIEW = { MC_ROLE: 'review-session:goal', MC_GOAL: 'mc/g', MC_SESSION_STARTED: STARTED };
  /** The deps `reviewStopDecision` reads: the goal in `stage`, and the proposals with their mtimes. */
  // The proposals are in one area of two, memoro/trust; memoro-cli/system holds none, and the programme's own
  // legacy proposals/ is never read.
  const world = (stage, proposals = {}, legacy = {}) => ({
    home: HOME, areas: '/w/areas',
    read: (path) => { if (path === '/p/mc/goals/g/GOAL.json') return JSON.stringify({ stage, status: 'ready' }); throw new Error('ENOENT'); },
    list: (path) => {
      const tree = {
        '/w/areas': ['memoro-cli', 'memoro'], '/w/areas/memoro-cli': ['system'], '/w/areas/memoro': ['trust'],
        '/w/areas/memoro-cli/system/proposals': ['archive'], '/w/areas/memoro/trust/proposals': Object.keys(proposals),
        '/p/mc/proposals': Object.keys(legacy),
      };
      if (tree[path]) return tree[path];
      throw new Error('ENOENT');
    },
    mtimeMs: (path) => ({ ...proposals, ...legacy })[path.split('/').pop()],
  });
  const after = Date.parse(STARTED) + 60_000;
  const sink = () => { const out = { text: '' }; out.write = (chunk) => { out.text += chunk; }; return out; };
  const before = Date.parse(STARTED) - 60_000;

  it('refuses the end while the goal is in review, and while no proposal was written since the review began, naming each', () => {
    const both = reviewStopDecision({ env: REVIEW, ...world('review') });
    assert.match(both.reason, /^the goal is still in review — mc goal stage merge \(OK to land: it merges all registered pull requests\) or write REVIEW\.md in the goal's directory and mc goal stage build \(not OK\); no proposal written — one file in \/w\/areas\/<repo>\/<area>\/proposals\/ /u);
    const stage = reviewStopDecision({ env: REVIEW, ...world('review', { '2026-11-03-mc-x.md': after }) });
    assert.match(stage.reason, /^the goal is still in review/u);
    assert.doesNotMatch(stage.reason, /proposal/u);
    const old = reviewStopDecision({ env: REVIEW, ...world('merge', { '2026-11-01-mc-old.md': before, 'notes.txt': after }) });
    assert.match(old.reason, /^no proposal written/u, 'one from before the review, or no .md, is none');
    const programme = reviewStopDecision({ env: REVIEW, ...world('merge', {}, { '2026-11-03-mc-x.md': after }) });
    assert.match(programme.reason, /^no proposal written/u, 'one in the programme\'s own proposals/ is none');
  });

  it('lets the review end once it is in merge or build with a proposal; and holds no other session', () => {
    for (const stage of ['merge', 'build']) assert.equal(reviewStopDecision({ env: REVIEW, ...world(stage, { '2026-11-03-mc-x.md': after }) }), null, stage);
    for (const env of [{ ...REVIEW, MC_ROLE: 'build-session:goal' }, { ...REVIEW, MC_GOAL: undefined }, {}]) {
      assert.equal(reviewStopDecision({ env, ...world('review') }), null);
    }
    assert.equal(reviewStopDecision({ env: REVIEW, ...world('review'), read: () => { throw new Error('gone'); } }), null, 'a goal it cannot read lets go');
    for (const status of ['blocked', 'Martin']) assert.equal(reviewStopDecision({ env: REVIEW, ...world('review'), read: () => JSON.stringify({ stage: 'review', status }) }), null, `a review ${status} may end without a completed review or proposal`);
  });

  it('answers Claude Code\'s Stop hook with decision block and the reason, and nothing when the review may end', async () => {
    const out = sink();
    assert.equal(await run(['stop'], { stdout: out, stderr: sink(), env: REVIEW, readStdin: async () => '{}', reviewStopDecision: () => ({ reason: 'the goal is still in review' }) }), 0);
    assert.deepEqual(JSON.parse(out.text), { decision: 'block', reason: 'mc: this review cannot end yet — the goal is still in review' });
    const quiet = sink();
    assert.equal(await run(['stop'], { stdout: quiet, stderr: sink(), env: REVIEW, readStdin: async () => '{}', reviewStopDecision: () => null }), 0);
    assert.equal(quiet.text, '');
  });
});


describe('SessionStart names the session before anything else', () => {
  it('names known roles and reports unknown directories even without a repository', async () => {
    for (const [cwd, extra, expected] of [
      ['/mc/programs/mc', {}, /^mc — session role unknown: checked MC_ROLE, MC_GOAL and cwd \/mc\/programs\/mc against \/mc\.$/u],
      ['/mc/programs/mc', { MC_GOAL: 'mc/g' }, /^You are the build session \(goal\) for programme `mc`\./u],
      ['/elsewhere', {}, /^mc — session role unknown: checked MC_ROLE, MC_GOAL and cwd \/elsewhere against \/mc\./u],
      ['/mc/programs/mc', { MC_ROLE: 'review-session:goal', MC_PROGRAMME: 'mc' }, /^You are the review session \(goal\) for programme `mc`\./u],
      ['/elsewhere', { MC_ROLE: 'brief' }, /^You are the manager session\./u],
      ['/elsewhere', { MC_ROLE: 'manager' }, /^You are the manager session\./u],
      ['/elsewhere', { MC_ROLE: 'helper' }, /^You are the helper session\./u],
      ['/elsewhere', { MC_ROLE: 'review-session:goal' }, /^You are the review session \(goal\)\./u],
    ]) {
      const stdout = { text: '', write(text) { this.text += text; } };
      await run(['session-start'], {
        syncSkills: () => [],
        stdout, env: { MC_WORK_ROOT: '/mc', ...extra }, readStdin: async () => JSON.stringify({ cwd }),
        worktreesAt: () => ({ inside: false, worktrees: [] }), listServers: () => ({ servers: [] }),
      });
      const text = JSON.parse(stdout.text).hookSpecificOutput.additionalContext;
      assert.match(text.split('\n')[0], expected);
    }
  });
});

// Martin 2026-11-03: a plan session has full freedom; the one boundary is a
// headless session's, and it is code rather than a sentence in a skill.
describe('a headless session is refused Martin\'s acts, and only it', () => {
  const headless = { env: { MC_HEADLESS: '1' } };
  const REFUSED = {
    'mc deploy': 'headless-deploy',
    'cd ~/mc && mc deploy --yes': 'headless-deploy',
    'mc merge memoro 14721 --admin': 'headless-admin',
    'gh pr merge 12 --squash --admin': 'headless-admin',
    'CLAUDE_ALLOW_PROD_WRANGLER=1 npx wrangler d1 execute memoro --remote': 'headless-production-data',
    'mc test token --set': 'headless-credentials',
    // The check after a deploy holds production's tokens; only the runner starts it.
    'node ~/mc/self/memoro/src/mc/deploy-check-run.js \'{"started":"2026-11-15T10:00:00.000Z","sha":"abc"}\'': 'headless-deploy-check',
    'MC_HOME=/tmp/x node src/mc/deploy-check-run.js {}': 'headless-deploy-check',
    // The red reaction and the provider script of the take-back are the same act as mc deploy take-back.
    'node ~/mc/self/memoro/src/mc/take-back-run.js 2026-11-15T10:00:00.000Z': 'headless-take-back',
    'MC_HOME=/tmp/x node src/mc/take-back-run.js x': 'headless-take-back',
    'node scripts/release/take-back.mjs --worker memoro=a:b --message x': 'headless-take-back',
    'cd /tmp/deploy && node /tmp/scripts/release/take-back.mjs --worker memoro=a:b': 'headless-take-back',
    'mc deploy take-back': 'headless-deploy',
    'mc deploy take-back --despite "known"': 'headless-deploy',
    'mc deploy take-back --end 2026-11-15T10:00:00.000Z --reason x': 'headless-deploy',
  };
  for (const [command, id] of Object.entries(REFUSED)) {
    it(`refuses ${command} headless, with no escape`, () => {
      for (const role of ['decision', 'martin']) assert.equal(preToolDecision(bash(command), { env: { MC_HEADLESS: '1', MC_ROLE: role } })?.id, id);
      assert.equal(preToolDecision(bash(command), headless)?.id, id);
      assert.equal(preToolDecision(bash(`${command} # ${ALLOW_MARK}`), headless)?.id, id);
      assert.match(preToolDecision(bash(command), headless).reason, /only in an interactive session/u);
    });
  }

  it('lets the same commands through with Martin at the terminal', () => {
    for (const command of Object.keys(REFUSED)) {
      const decision = preToolDecision(bash(command), { env: {} });
      assert.ok(!decision || !decision.id.startsWith('headless-'), command);
    }
  });

  it('lets a headless session do the rest of its work', () => {
    for (const command of ['mc deploy --dry-run', 'mc merge memoro 14721', 'mc publish --no-merge', 'git branch -D probe/x', 'mc test token']) {
      const decision = preToolDecision(bash(command), headless);
      assert.ok(!decision || !decision.id.startsWith('headless-'), command);
    }
  });

  it('gives no refusal to the mend session\'s repaired form: it is not a deploy', () => {
    const repaired = 'mc repo mend deploy 3 repaired --reason "x"';
    for (const command of [repaired, 'mc repo mend deploy 3 requeue --reason "x"', 'mc repo mend deploy 3 drop --reason "mc deploy shipped by hand"']) {
      for (const env of [{ MC_HEADLESS: '1', MC_ROLE: 'mend-session', MC_DEPLOY_MEND: '3' }, { MC_HEADLESS: '1' }]) {
        const decision = preToolDecision(bash(command), { env });
        assert.ok(!decision || !decision.id.startsWith('headless-'), `${command} ${JSON.stringify(env)}`);
      }
    }
    assert.equal(preToolDecision(bash('mc deploy'), { env: { MC_HEADLESS: '1', MC_ROLE: 'mend-session', MC_DEPLOY_MEND: '3' } })?.id, 'headless-deploy', 'the mend session is refused mc deploy as any headless session');
  });

  it('names one rule per act', () => {
    assert.deepEqual(HEADLESS_RULES.map((rule) => rule.id), ['headless-deploy', 'headless-admin', 'headless-production-data', 'headless-credentials', 'headless-deploy-check', 'headless-take-back']);
  });

  // 2026-11-14: one Bash call held two reserved-act questions; the words of an
  // option refused it, and both were lost.
  const TWO_ASKS = 'mc ask alpha/one --kind technical --reserved deploy --reason "Production runs an older commit." --option "deploy: Martin runs mc deploy so production includes the import" --option "hold: the work waits for a later deploy" --recommend deploy --evidence "curl -s https://example.test/api/version" 2>&1 | tail -8; echo ----; mc ask alpha/one --kind technical --reserved production-data --reason "The import needs production data." --option "run: Martin sets CLAUDE_ALLOW_PROD_WRANGLER=1 and runs it" --option "read_only: nothing is written" --recommend run 2>&1 | tail -8';

  it('allows a line that only quotes, comments or documents an act', () => {
    const LINES = [
      TWO_ASKS,
      'mc goal log --comment "waits on mc deploy by Martin"',
      'git commit -m "docs: say when mc deploy runs"',
      "git commit -F - <<'EOF'\nhooks: mc deploy is named in a message\nEOF",
      `echo "mc merge memoro 1 --admin is Martin's"`,
      'grep -rn "mc test token --set" docs/',
      'grep -rn "deploy-check-run.js" docs/ src/',
      'grep -rn "take-back-run.js" docs/ src/',
      'git commit -m "docs: take-back.mjs is memoro\'s script"',
      'node scripts/release/take-back.mjs --worker memoro=a:b --dry-run',
      'mc deploy take-back --dry-run',
      'mc deploy take-back --dry-run --json',
      'git commit -m "docs: deploy-check-run.js is the runner\'s"',
      'echo done # mc deploy',
      'mc ask alpha/one --kind product --reason "Ship it?" --option "a: run mc deploy after the gate" --option "b: wait" --recommend b',
      'mc ask alpha/one --kind technical --reason "Deploy?" --option "a: wait" --recommend a && mc ask alpha/one --kind technical --reason "Merge?" --option "a: mc merge 14 --admin" --option "b: hold" --recommend b',
      'echo "mc deploy is Martin\'s act"',
      'git commit -F msg.txt # then mc deploy',
      "cat <<'EOF'\nmc deploy\nCLAUDE_ALLOW_PROD_WRANGLER=1\nEOF",
      'grep -rn "mc deploy" docs',
      "printf '%s\\n' 'CLAUDE_ALLOW_PROD_WRANGLER=1'",
    ];
    for (const line of LINES) {
      const decision = preToolDecision(bash(line), headless);
      assert.ok(!decision || !decision.id.startsWith('headless-'), line);
    }
  });

  it('refuses an act the line runs, however the line runs it, and names the way forward', () => {
    const RUNS = {
      'echo ok; mc deploy': 'headless-deploy',
      'X=1 mc deploy --yes': 'headless-deploy',
      'echo "$(mc deploy)"': 'headless-deploy',
      'echo `mc deploy`': 'headless-deploy',
      "bash -c 'mc deploy --yes'": 'headless-deploy',
      'eval "mc deploy"': 'headless-deploy',
      'env FOO=1 mc deploy': 'headless-deploy',
      'timeout 600 mc deploy': 'headless-deploy',
      '/usr/local/bin/mc deploy': 'headless-deploy',
      'true && gh pr merge 12 --admin': 'headless-admin',
      'export CLAUDE_ALLOW_PROD_WRANGLER=1': 'headless-production-data',
      'env CLAUDE_ALLOW_PROD_WRANGLER=1 npx wrangler d1 execute db --remote': 'headless-production-data',
      'mc test token --rm': 'headless-credentials',
      'echo "x; mc deploy': 'headless-deploy',
      'echo ${X:-$(mc deploy)}': 'headless-deploy',
      'echo "${X:-$(mc deploy)}"': 'headless-deploy',
      'echo ${X:-`mc deploy`}': 'headless-deploy',
      'mc deploy --follow': 'headless-deploy',
      '(mc deploy)': 'headless-deploy',
      'echo ok | mc deploy': 'headless-deploy',
      'sudo mc deploy': 'headless-deploy',
      'bash -c "mc deploy --yes"': 'headless-deploy',
      'echo "unterminated mc deploy': 'headless-deploy',
      'mc merge memoro 3 --admin || true': 'headless-admin',
      'export CLAUDE_ALLOW_PROD_WRANGLER=1; npx wrangler d1 execute memoro --remote': 'headless-production-data',
      'env CLAUDE_ALLOW_PROD_WRANGLER=1 npx wrangler d1 execute memoro --remote': 'headless-production-data',
      'mc test token --rm alpha/one': 'headless-credentials',
      'sudo mc test token --set': 'headless-credentials',
    };
    for (const [command, id] of Object.entries(RUNS)) {
      const decision = preToolDecision(bash(command), headless);
      assert.equal(decision?.id, id, command);
      assert.match(decision.reason, /only in an interactive session/u, command);
      assert.ok(decision.reason.includes(`--reserved ${HEADLESS_RULES.find((rule) => rule.id === id).act} `), command);
      assert.ok(!decision.reason.includes('Leave the work waiting on it'), command);
    }
  });

  it('tells each refused act to be asked for under its own reserved name', () => {
    const ONE_EACH = [
      ['mc deploy', 'headless-deploy', '--reserved deploy '],
      ['gh pr merge 12 --admin', 'headless-admin', '--reserved admin '],
      ['export CLAUDE_ALLOW_PROD_WRANGLER=1', 'headless-production-data', '--reserved production-data '],
      ['mc test token --set', 'headless-credentials', '--reserved credentials '],
    ];
    for (const [command, id, reserved] of ONE_EACH) {
      const decision = preToolDecision(bash(command), headless);
      assert.equal(decision?.id, id, command);
      assert.match(decision.reason, /only in an interactive session/u, command);
      assert.ok(decision.reason.includes(reserved), `${command}: ${decision.reason}`);
      assert.ok(!decision.reason.includes('Leave the work waiting on it'), command);
    }
  });

  it('reads the commands a line runs, with quotes removed, and null for a line it cannot read', () => {
    const words = (line) => shellCommands(line)?.map((entry) => entry.words);
    assert.deepEqual(shellCommands(TWO_ASKS).map((entry) => entry.words[0]), ['mc', 'tail', 'echo', 'mc', 'tail']);
    assert.equal(shellCommands('echo "x'), null);
    assert.deepEqual(words('echo "mc deploy" && env A=1 timeout 600 mc deploy'), [['echo', 'mc deploy'], ['mc', 'deploy']]);
    assert.deepEqual(shellCommands('env A=1 timeout 600 mc deploy')[0].assignments, ['A=1']);
    assert.deepEqual(words("cat <<'EOF'\nmc deploy\nEOF\nmc publish --no-merge"), [['cat'], ['mc', 'publish', '--no-merge']]);
    assert.deepEqual(words('mc ask alpha/one --option "a: $(mc deploy)"'), [['mc', 'deploy'], ['mc', 'ask', 'alpha/one', '--option', 'a: $(mc deploy)']]);
    assert.deepEqual(words('echo ${X:-$(mc deploy)}'), [['mc', 'deploy'], ['echo', '${X:-$(mc deploy)}']]);
    assert.equal(shellCommands('echo "unterminated'), null);
  });
});

describe('agy: its own hooks file and its own hook input', () => {
  const agy = (home = '/h') => hookTargets({ env: {}, home, installed: () => true }).find((target) => target.dialect === 'agy-hooks');

  it('a tool that declares hooks and is installed is a target; one that is not installed is not', () => {
    const present = hookTargets({ env: {}, home: '/h', installed: () => true });
    assert.deepEqual(present.map((target) => target.dialect).sort(), ['agy-hooks', 'claude']);
    assert.equal(agy().path, '/h/.gemini/config/hooks.json');
    assert.deepEqual(hookTargets({ env: {}, home: '/h', installed: () => false }).map((target) => target.dialect), ['claude'], 'Claude always has one');
    assert.deepEqual(hookTargets({ env: {}, home: '/h', installed: () => { throw new Error('no'); } }).map((target) => target.dialect), ['claude']);
  });

  it('the entry runs mc with --tool agy, ends each command in `|| true`, and matches the five file tools', () => {
    const entry = agyHooksEntry(agy().spec);
    assert.deepEqual(Object.keys(entry), ['SessionStart', 'PreToolUse', 'Stop']);
    for (const command of [entry.SessionStart[0].command, entry.PreToolUse[0].hooks[0].command, entry.Stop[0].command]) assert.match(command, /^mc hook (session-start|pre-tool|stop) --tool agy 2>\/dev\/null \|\| true$/u);
    assert.equal(entry.PreToolUse[0].matcher, 'run_command|read_file|view_file|edit_file|write_to_file');
  });

  it('registration: absent, other, then right; install adds the entry and keeps the rest', () => {
    const target = agy();
    assert.equal(targetRegistration(target, {}).ok, false);
    assert.equal(targetRegistration(target, { mc: { SessionStart: [{ type: 'command', command: 'x' }] } }).ok, false);
    const installed = targetInstall(target, { theirs: { a: 1 }, other: true });
    assert.deepEqual(installed.theirs, { a: 1 });
    assert.equal(installed.other, true);
    assert.equal(targetRegistration(target, installed).ok, true);
    assert.equal(targetRegistration(target, targetInstall(target, installed)).ok, true, 'installing twice is the same file');
  });

  it('drift names the tool when its file is missing or wrong, and is null when every file is right', () => {
    const targets = hookTargets({ env: {}, home: '/h', installed: () => true });
    const files = (agyFile) => (path) => (path.endsWith('hooks.json') ? agyFile : installHooks({}));
    const right = targetInstall(agy(), {});
    assert.equal(hookTargetsDrift(targets, files(right)), null);
    assert.match(hookTargetsDrift(targets, files(null)), /^agy: hooks not registered$/u);
    assert.match(hookTargetsDrift(targets, files({ mc: {} })), /^agy: session-start not registered/u);
  });

  it('agy\'s tool calls reach the same decisions as Claude\'s', () => {
    assert.deepEqual(agyHookInput({ cwd: '/w', toolCall: { name: 'run_command', args: { CommandLine: 'mc deploy' } } }),
      { tool_name: 'Bash', tool_input: { command: 'mc deploy' }, cwd: '/w' });
    assert.deepEqual(agyHookInput({ toolCall: { name: 'write_to_file', args: { TargetFile: '/a/GOAL.json' } } }), { tool_name: 'Write', tool_input: { file_path: '/a/GOAL.json' } });
    assert.equal(agyHookInput({ toolCall: { name: 'edit_file', args: { AbsolutePath: '/a' } } }).tool_name, 'Edit');
    for (const name of ['read_file', 'view_file']) assert.equal(agyHookInput({ toolCall: { name, args: { path: '/a' } } }).tool_name, 'Read');
    assert.equal(agyHookInput({ toolCall: { name: 'browse', args: { x: 1 } } }).tool_name, 'browse', 'a tool no rule knows keeps its name');
    assert.deepEqual(agyHookInput(null), { tool_name: '', tool_input: {} });
    const seen = agyHookInput({ toolCall: { name: 'run_command', args: { CommandLine: 'mc deploy' } } });
    assert.equal(preToolDecision(seen, { inRepo: () => false, programs: '/p', env: { MC_HEADLESS: '1' } })?.id, preToolDecision(bash('mc deploy'), { inRepo: () => false, programs: '/p', env: { MC_HEADLESS: '1' } })?.id);
  });

  it('the agy dialect answers in agy\'s shape: a deny, a continue and an injected message', async () => {
    const out = [];
    const stdout = { write: (text) => out.push(JSON.parse(text)) };
    const input = JSON.stringify({ cwd: '/w', toolCall: { name: 'run_command', args: { CommandLine: 'mc deploy' } } });
    const deps = { stdout, stderr: { write() {} }, readStdin: async () => input, env: { MC_HEADLESS: '1' }, inMcTerritory: () => true, repoHookDecision: () => null, pathInKnownRepo: () => false,
      reviewStopDecision: () => ({ reason: 'not yet' }), syncSkills: () => [], worktreesAt: () => ({ inside: false, worktrees: [] }), listServers: () => ({ servers: [] }) };
    assert.equal(await run(['pre-tool', '--tool', 'agy'], deps), 0);
    assert.equal(out[0].decision, 'deny');
    assert.match(out[0].reason, /^mc: /u);
    assert.equal(await run(['stop', '--tool', 'agy'], deps), 0);
    assert.equal(out[1].decision, 'continue');
    assert.match(out[1].reason, /not yet/u);
    assert.equal(await run(['pre-tool', '--tool', 'nobody'], { ...deps, stderr: { write() {} } }), 2);
  });
});
