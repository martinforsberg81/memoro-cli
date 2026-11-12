import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bootUnit, installBootAdapter, linuxIdentityStatus, readLinuxIdentity, rootIdentity, scopeCommand, systemdQuote, withLifecycleLock } from '../../src/mc/linux-runner-service.js';

describe('Linux runner systemd adapter', () => {
  it('generates isolated, safely quoted, allowlisted boot units', () => {
    const root = '/tmp/mc root "$x%"';
    const env = {
      HOME: '/home/test user', PATH: '/bin:/opt/tool $dir', MC_HOME: '/tmp/mc home',
      MC_WORK_ROOT: root, MC_REPOS_HOME: '/tmp/repos', TOKEN: 'must-not-persist',
      MC_EMIT_SHELL_DIRECTIVES: '1', MC_RUN_SUCCESSOR_OF: '15',
    };
    const generated = bootUnit({ root, execPath: '/opt/node/bin/node', entry: '/opt/mc/src/mc-cli.js', env });
    assert.equal(generated.unit, rootIdentity(root).unit);
    assert.match(generated.text, /Type=oneshot\nRemainAfterExit=yes\nRestart=no\nKillMode=control-group/u);
    assert.match(generated.text, /WantedBy=default\.target/u);
    assert.match(generated.text, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/mc\/src\/mc-cli\.js" "run" "start" "--if-was-running"/u);
    assert.match(generated.text, /Environment=HOME="\/home\/test user"/u);
    assert.match(generated.text, /Environment=PATH="\/bin:\/opt\/tool \$dir"/u);
    assert.ok(generated.text.includes(`Environment=MC_WORK_ROOT=${systemdQuote(root, { exec: false })}`));
    assert.doesNotMatch(generated.text, /TOKEN|MC_EMIT_SHELL_DIRECTIVES|MC_RUN_SUCCESSOR_OF|ExecStop|PIDFile|KeepAlive/u);
    assert.notEqual(rootIdentity('/tmp/root-one').unit, rootIdentity('/tmp/root-two').unit);
  });

  it('uses one distinct, root-named scope command and disables argument expansion', () => {
    const args = scopeCommand({
      root: '/tmp/root with spaces', execPath: '/node', entry: '/mc', argv: ['--no-merge'],
      deps: { canonicalRoot: (p) => p, uuid: () => '12345678-1234-1234-1234-123456789abc' },
    });
    assert.equal(args[0], '--user');
    assert.ok(args.includes('--scope'));
    assert.ok(args.includes('--expand-environment=no'));
    assert.ok(args.some((arg) => arg.startsWith('--unit=mc-runner-start-')));
    assert.deepEqual(args.slice(args.indexOf('--') + 1), ['/node', '/mc', 'run', 'start', '--no-merge']);
  });

  it('uses the same stable adapter identity for a canonical root and its symlink alias', (t) => {
    const scratch = mkdtempSync(join(tmpdir(), 'mc-linux-root-alias-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const root = join(scratch, 'root');
    const alias = join(scratch, 'alias');
    mkdirSync(root);
    symlinkSync(root, alias);
    assert.equal(rootIdentity(root).unit, rootIdentity(alias).unit);
  });

  it('installs once, reloads only on change, enables without starting and reports linger', () => {
    const files = new Map();
    const commands = [];
    const deps = {
      env: { HOME: '/home/test', USER: 'test', MC_WORK_ROOT: '/tmp/root' }, home: '/home/test',
      canonicalRoot: (p) => p, read: (p) => files.get(p) ?? null,
      write: (p, text) => files.set(p, text),
      manager: (args) => { commands.push(args); return { status: 0, stdout: args[0] === 'show-user' ? 'no\n' : '', stderr: '' }; },
    };
    const first = installBootAdapter({ root: '/tmp/root', execPath: '/node', entry: '/mc', deps });
    assert.equal(first.ok, true);
    assert.equal(first.ready, false);
    assert.match(first.lines.join('\n'), /Linger=no.*loginctl enable-linger/u);
    assert.deepEqual(commands.map((args) => args[0]), ['daemon-reload', 'enable', 'show-user']);
    commands.length = 0;
    const second = installBootAdapter({ root: '/tmp/root', execPath: '/node', entry: '/mc', deps });
    assert.equal(second.changed, false);
    assert.deepEqual(commands.map((args) => args[0]), ['enable', 'show-user']);
    assert.ok(!commands.some((args) => args.includes('--now')));
  });

  it('escapes systemd metacharacters without shell evaluation', () => {
    assert.equal(systemdQuote('a"b\\c%$'), '"a\\"b\\\\c%%$$"');
  });

  it('distinguishes same, recycled and unverifiable Linux process identities', () => {
    const files = {
      '/proc/sys/kernel/random/boot_id': 'boot-a\n',
      // comm includes a closing parenthesis; field 22 follows the final one.
      '/proc/42/stat': '42 (worker ) name) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 987654 0\n',
    };
    const identity = readLinuxIdentity(42, { read: (path) => { if (!(path in files)) throw new Error('missing'); return files[path]; } });
    assert.deepEqual(identity, { bootId: 'boot-a', starttime: '987654' });
    assert.equal(linuxIdentityStatus(identity, { bootId: 'boot-a', starttime: '987654' }, true), 'same');
    assert.equal(linuxIdentityStatus(identity, { bootId: 'boot-b', starttime: '987654' }, true), 'stale');
    assert.equal(linuxIdentityStatus({}, identity, true), 'unknown');
    assert.equal(linuxIdentityStatus(identity, identity, false), 'dead');
  });

  it('resolves an acquired lifecycle transition when the cat helper exits cleanly', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mc-linux-gate-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let entered = 0;
    const result = await withLifecycleLock(root, () => { entered += 1; return 'transitioned'; }, {
      spawnProcess: () => {
        setImmediate(() => { child.stdout.write('mc-lifecycle-ready\n'); setImmediate(() => child.emit('close', 0, null)); });
        return child;
      },
    });
    assert.equal(result, 'transitioned');
    assert.equal(entered, 1);
  });
});
