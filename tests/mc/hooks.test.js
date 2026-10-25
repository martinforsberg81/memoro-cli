/**
 * `mc hook` — what a session is told at start, and which shell commands are
 * turned to an mc verb. The rules are pure over a git runner and the inputs,
 * so they are tested without a session or a repository.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/hook.js';
import {
  ALLOW_MARK, hookDrift, hookRegistration, inMcTerritory, installHooks, knownRepo, MC_HOOKS, preToolDecision, protectedPlanFile, TOOLBOX,
  readClaudeSettings, repoHookDecision,
  repoPreToolHooks, sessionStartContext, warningsFor, worktreeState, worktreesAt,
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
    assert.equal(sessionStartContext({ cwd: '/x', inside: true, states: [] }), null, 'nothing of mc here, nothing said');
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
      ['npm test', 'npm-test', /the merger's/u],
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

describe('mc hook — a plan file under ~/mc/programs is mc\'s to change', () => {
  const programs = mkdtempSync(join(tmpdir(), 'mc-hook-programs-'));
  const deny = (input) => preToolDecision(input, { programs });

  it('names a plan, draft, state or closeout file under programs, at any depth, and no other', () => {
    assert.equal(protectedPlanFile(join(programs, 'a', 'x', 'PLAN.json'), { programs }), true);
    assert.equal(protectedPlanFile(join(programs, 'PLAN.json'), { programs }), true);
    assert.equal(protectedPlanFile(join(programs, 'a', 'rulings.md'), { programs }), false);
    assert.equal(protectedPlanFile(`${programs}-other/a/PLAN.json`, { programs }), false, 'a sibling directory is not under it');
  });

  it('refuses a Write, Edit or MultiEdit of a plan, draft, state or closeout file', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      for (const name of ['PLAN.json', 'DRAFT.json', 'STATE.json', 'CLOSEOUT.json']) {
        const decision = deny({ tool_name: tool, tool_input: { file_path: join(programs, 'a', 'x', name) } });
        assert.equal(decision?.id, 'plan-file', `${tool} ${name}`);
        assert.match(decision.reason, /a plan changes through `mc project`/u);
      }
    }
  });

  it('lets through the same name under another directory, and the other files of a programme', () => {
    for (const name of ['PLAN.json', 'STATE.json']) {
      assert.equal(deny({ tool_name: 'Write', tool_input: { file_path: join('/elsewhere', 'x', name) } }), null, name);
    }
    assert.equal(deny({ tool_name: 'Edit', tool_input: { file_path: join(programs, 'a', 'rulings.md') } }), null);
  });

  it('resolves a relative file_path against the session\'s cwd', () => {
    const input = { tool_name: 'Edit', cwd: join(programs, 'a'), tool_input: { file_path: join('x', 'STATE.json') } };
    assert.equal(deny(input)?.id, 'plan-file');
    assert.equal(deny({ ...input, cwd: '/elsewhere' }), null, 'the same relative name under another cwd is another file');
  });

  it('refuses a shell command that writes one, with the escape named, and lets a read of one through', () => {
    const file = join(programs, 'a', 'x', 'PLAN.json');
    for (const command of [`jq . > ${file}`, "sed -i '' s/a/b/ STATE.json", 'mv DRAFT.json PLAN.json', 'echo x | tee CLOSEOUT.json']) {
      const decision = preToolDecision(bash(command), { programs });
      assert.equal(decision?.id, 'plan-file', command);
      assert.match(decision.reason, /Escape, when the raw command is really meant/u, `${command}: the escape is named`);
    }
    for (const command of ['cat PLAN.json', 'jq . PLAN.json', 'mc project send x']) {
      assert.equal(preToolDecision(bash(command), { programs }), null, command);
    }
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
  function repoWithHooks() {
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
      },
    };
    assert.equal(hookDrift(hookRegistration(before)), 'pre-tool on Bash|Write|Read|Edit|MultiEdit, want Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*');
    const next = installHooks(before);
    assert.equal(hookRegistration(next).ok, true);
    assert.equal(next.hooks.PreToolUse.length, 2);
    assert.deepEqual(next.hooks.PreToolUse[0], FOREIGN);
    assert.equal(next.hooks.PreToolUse[1].matcher, 'Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*');
  });

  it('names both entries as missing from settings with no hooks', () => {
    assert.equal(hookDrift(hookRegistration({})), 'session-start not registered, pre-tool not registered');
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
      stdout: none, stderr: sink(), readStdin: async () => '{"cwd":"/tmp"}', worktreesAt: () => ({ inside: false, worktrees: [] }),
    });
    assert.equal(none.text, '');
  });

  it('refuses a form it does not know', async () => {
    const stderr = sink();
    assert.equal(await run(['post-tool'], { stdout: sink(), stderr }), 2);
    assert.match(stderr.text, /session-start or pre-tool/u);
  });
});
