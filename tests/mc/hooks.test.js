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
  ALLOW_MARK, inMcTerritory, preToolDecision, repoHookDecision, repoPreToolHooks, sessionStartContext, warningsFor,
  worktreeState, worktreesAt,
} from '../../src/mc/hooks.js';

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
});

describe('mc hook — shell commands that have an mc verb', () => {
  it('turns each to its verb', () => {
    const cases = [
      ['gh pr create --title x', 'pr-create', /mc publish/u],
      ['git push -u origin x', 'push', /mc publish/u],
      ['cd memoro && git push', 'push', /mc publish/u],
      ['gh pr edit 12 --body-file x', 'pr-edit', /mc publish/u],
      ['gh pr merge 12 --squash --match-head-commit abc', 'pr-merge', /mc merge <repo> <pr>/u],
      ['npm run ci -- --base-ref origin/main', 'ci', /mc gate/u],
      ['npm run dev:agent -- --restart', 'dev-server', /mc test dev --here --url/u],
      ['npm run dev', 'dev-server', /mc test dev/u],
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
      'git status', 'npm test', 'npm run css:lint', 'git commit -m "push the thing"', 'gh pr view 3 --json state',
      'gh pr merge 12 --squash --admin', `${ALLOW_MARK} git push --force-with-lease`, 'npm run deps:prepare',
      `${ALLOW_MARK} gh pr edit 12 --base main`, 'echo "gh pr edit 12"',
      'npm run ci -- --list --json',
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
