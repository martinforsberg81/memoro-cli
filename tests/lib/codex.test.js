import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { resolveRealCodexBinary } from '../../src/lib/codex.js';

// mc skips its own old wrappers at `~/.local/bin/codex` and `codex-memoro` so
// it never recurses through them. npm with a user prefix puts the official
// Codex CLI at that same `~/.local/bin/codex`; skipping it by path alone left
// hosts with "could not locate the codex binary". A temporary directory stands
// in for the home and `which -a codex` is answered by the test.

function host(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-codex-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const file = (path, body) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: 0o755 });
    return path;
  };
  return {
    home,
    wrapper: join(bin, 'codex'),
    npmEntry: join(home, '.local', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    native: join(root, 'usr', 'local', 'bin', 'codex'),
    file,
    resolve: (...paths) => resolveRealCodexBinary({ home, which: () => `${paths.join('\n')}\n` }),
  };
}

test('npm\'s official Codex CLI linked at ~/.local/bin/codex is chosen', (t) => {
  const h = host(t);
  h.file(h.npmEntry, '#!/usr/bin/env node\nimport "../dist/cli.js";\n');
  symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', h.wrapper);
  h.file(h.native, '\x7fELF');
  assert.equal(h.resolve(h.wrapper, h.native), h.wrapper);
});

test('an mc shim at ~/.local/bin/codex is skipped and the next candidate chosen', (t) => {
  const h = host(t);
  h.file(h.wrapper, `#!/bin/sh\nexec "${join(h.home, '.local', 'bin', 'codex-memoro')}" "$@"\n`);
  h.file(h.native, '\x7fELF');
  assert.equal(h.resolve(h.wrapper, h.native), h.native);
});

test('with only the mc shim there is no codex binary', (t) => {
  const h = host(t);
  h.file(h.wrapper, '#!/bin/sh\nexec codex-memoro "$@"\n');
  assert.equal(h.resolve(h.wrapper), null);
});

test('a native binary elsewhere on PATH is still chosen', (t) => {
  const h = host(t);
  h.file(h.native, '\x7fELF');
  assert.equal(h.resolve(h.native), h.native);
});
