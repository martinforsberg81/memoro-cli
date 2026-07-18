/**
 * TDD spec for the MEMORO.md `language` setting (drev: grounding-lang-setting).
 *
 * Phase 4 derived the session render language from the Memoro lens, but the
 * server exposes no language field today, so it always resolves to English.
 * Product decision: code-language ≠ Memoro-locale. A per-repo `language`
 * setting in MEMORO.md un-gates language steering locally, ahead of the
 * server.
 *
 * Precedence (prescribed — the MEMORO.md setting WINS):
 *
 *   MEMORO.md language-setting   (primary — explicit per-repo choice)
 *     > Memoro user_state locale  (fallback — unchanged Phase 4 seam)
 *       > English                 (default)
 *
 * The setting lives as a single HTML-comment convention line in MEMORO.md:
 *
 *   <!-- memoro:language: Swedish -->
 *
 * It is invisible in rendered markdown, sits anywhere in the file, and must
 * be STRIPPED from the map text rendered into the bundle so it never shows
 * up as prose. Everything here is pure / in-process and must NEVER throw.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseMapLanguage,
  resolveSessionLanguage,
  stripMapSettings,
  readMap,
  assembleBundle,
  groundSession,
} from '../../src/mc/ground.js';

// ─────────────────────────────────────────────────────────────
// parseMapLanguage — pure: MEMORO.md text → language label | null
// ─────────────────────────────────────────────────────────────

describe('parseMapLanguage (pure)', () => {
  it('reads the HTML-comment setting and returns the label', () => {
    assert.equal(parseMapLanguage('<!-- memoro:language: Swedish -->\n# MEMORO.md'), 'Swedish');
  });

  it('finds the setting anywhere in the file, not just the first line', () => {
    const map = '# MEMORO.md\n\nNorth star prose.\n\n<!-- memoro:language: German -->\n';
    assert.equal(parseMapLanguage(map), 'German');
  });

  it('tolerates whitespace variations inside the comment', () => {
    assert.equal(parseMapLanguage('<!--memoro:language:French-->'), 'French');
    assert.equal(parseMapLanguage('<!--   memoro:language:   French   -->'), 'French');
  });

  it('maps a locale code the same way the lens path does', () => {
    assert.equal(parseMapLanguage('<!-- memoro:language: sv-SE -->'), 'Swedish');
    assert.equal(parseMapLanguage('<!-- memoro:language: ja -->'), 'Japanese');
  });

  it('treats English / en as the default (null — no directive)', () => {
    assert.equal(parseMapLanguage('<!-- memoro:language: English -->'), null);
    assert.equal(parseMapLanguage('<!-- memoro:language: en -->'), null);
  });

  it('returns null when no setting is present', () => {
    assert.equal(parseMapLanguage('# MEMORO.md\nno setting here'), null);
  });

  it('returns null for null / non-string / empty (soft-degrade)', () => {
    assert.equal(parseMapLanguage(null), null);
    assert.equal(parseMapLanguage(undefined), null);
    assert.equal(parseMapLanguage(42), null);
    assert.equal(parseMapLanguage(''), null);
  });

  it('ignores a blank value', () => {
    assert.equal(parseMapLanguage('<!-- memoro:language:    -->'), null);
  });

  it('never throws on hostile input', () => {
    assert.doesNotThrow(() => parseMapLanguage('<!-- memoro:language'));
    assert.equal(parseMapLanguage('<!-- memoro:language'), null);
  });
});

// ─────────────────────────────────────────────────────────────
// resolveSessionLanguage — pure: precedence MEMORO.md > server > English
// ─────────────────────────────────────────────────────────────

describe('resolveSessionLanguage (pure precedence)', () => {
  it('MEMORO.md setting WINS over the server locale', () => {
    const map = '<!-- memoro:language: Swedish -->';
    const lens = { locale: 'de-DE' };
    assert.equal(resolveSessionLanguage({ map, lensResponse: lens }), 'Swedish');
  });

  it('falls back to the server locale when the map has no setting', () => {
    assert.equal(
      resolveSessionLanguage({ map: '# MEMORO.md', lensResponse: { locale: 'de' } }),
      'German',
    );
  });

  it('falls back to English (null) when neither is present', () => {
    assert.equal(resolveSessionLanguage({ map: '# MEMORO.md', lensResponse: { ok: true } }), null);
    assert.equal(resolveSessionLanguage({}), null);
  });

  it('an explicit English setting in the map still WINS (suppresses a server locale)', () => {
    // A user who sets English locally overrides a Swedish server profile.
    const map = '<!-- memoro:language: English -->';
    assert.equal(resolveSessionLanguage({ map, lensResponse: { locale: 'sv' } }), null);
  });

  it('never throws on hostile inputs', () => {
    assert.doesNotThrow(() => resolveSessionLanguage({ map: 5, lensResponse: 'x' }));
    assert.equal(resolveSessionLanguage({ map: 5, lensResponse: 'x' }), null);
  });
});

// ─────────────────────────────────────────────────────────────
// stripMapSettings — pure: remove the convention line from map prose
// ─────────────────────────────────────────────────────────────

describe('stripMapSettings (pure)', () => {
  it('removes the setting comment from the rendered map text', () => {
    const map = '<!-- memoro:language: Swedish -->\n# MEMORO.md\nnorth star\n';
    const out = stripMapSettings(map);
    assert.ok(!/memoro:language/.test(out), 'setting comment must be stripped');
    assert.match(out, /# MEMORO\.md/);
    assert.match(out, /north star/);
  });

  it('leaves a map without a setting byte-identical', () => {
    const map = '# MEMORO.md\nnorth star\n- **Node** — `active · L · now`\n';
    assert.equal(stripMapSettings(map), map);
  });

  it('does not leave a dangling blank line where the setting was', () => {
    const map = '# MEMORO.md\n\n<!-- memoro:language: German -->\n\nNorth star.\n';
    const out = stripMapSettings(map);
    assert.ok(!/\n{3,}/.test(out), 'no run of 3+ newlines left behind');
    assert.match(out, /North star\./);
  });

  it('returns null / input unchanged for null / non-string', () => {
    assert.equal(stripMapSettings(null), null);
    assert.equal(stripMapSettings(undefined), undefined);
  });

  it('never throws', () => {
    assert.doesNotThrow(() => stripMapSettings('<!-- memoro:language'));
  });
});

// ─────────────────────────────────────────────────────────────
// Byte-identity invariant — no setting + no server locale → English
// ─────────────────────────────────────────────────────────────

describe('byte-identity invariant (no setting + no server locale → English)', () => {
  it('assembleBundle output is identical with-vs-without an explicit-English setting source', () => {
    // The pre-drev path (Phase 4) with English/null language must produce the
    // exact same bundle bytes as this drev produces when nothing steers the
    // language. resolveSessionLanguage({}) === null === the Phase 4 default.
    const language = resolveSessionLanguage({ map: '# MEMORO.md', lensResponse: null });
    const withResolver = assembleBundle({ map: '# MEMORO.md', role: 'r', language });
    const phase4Default = assembleBundle({ map: '# MEMORO.md', role: 'r', language: null });
    assert.equal(withResolver, phase4Default);
  });

  it('groundSession bundle is byte-identical with-vs-without the language seam when nothing steers language', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-lang-identity-'));
    function fakeAdapter() {
      return {
        written: null,
        async writeGrounding(markdown, { cwd }) { this.written = { markdown, cwd }; return join(cwd, 'CLAUDE.md'); },
      };
    }

    // A MEMORO.md with NO setting + a lens with NO locale → English. The
    // bundle must be byte-identical to one grounded with an explicitly null
    // language (the Phase 4 / pre-drev path). We compare the two adapters'
    // written markdown directly — every part (role, map prose, lifecycle) is
    // produced by the same code, so equality proves the language seam added
    // zero bytes when nothing steers it.
    writeFileSync(join(dir, 'MEMORO.md'), '# MEMORO.md\nnorth star\n', 'utf8');

    const withSeam = fakeAdapter();
    await groundSession({
      cwd: dir, adapter: withSeam,
      deps: {
        buildRoleImpl: () => 'role',
        fetchMcContextDataImpl: async () => null,
        fetchLensDataImpl: async () => ({ ok: true, markdown: '' }),
        grounding: { includeRoadmap: true, includeLens: true },
      },
    });

    // Reference run: an injected lens that carries NOTHING (legacy markdown
    // path), so resolveSessionLanguage falls all the way through to English.
    const reference = fakeAdapter();
    await groundSession({
      cwd: dir, adapter: reference,
      deps: {
        buildRoleImpl: () => 'role',
        fetchMcContextDataImpl: async () => null,
        pullLensImpl: async () => null,
        grounding: { includeRoadmap: true, includeLens: true },
      },
    });

    assert.ok(!/respond in/i.test(withSeam.written.markdown), 'no directive when nothing steers language');
    assert.equal(withSeam.written.markdown, reference.written.markdown, 'byte-identical bundle');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────
// groundSession — MEMORO.md setting drives the directive end-to-end
// ─────────────────────────────────────────────────────────────

describe('groundSession honours the MEMORO.md language setting', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'mc-lang-ground-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  function fakeAdapter() {
    return {
      written: null,
      async writeGrounding(markdown, { cwd }) { this.written = { markdown, cwd }; return join(cwd, 'CLAUDE.md'); },
    };
  }

  it('the MEMORO.md setting steers the directive AND wins over the server locale', async () => {
    const p = join(dir, 'MEMORO.md');
    writeFileSync(p, '<!-- memoro:language: Swedish -->\n# MEMORO.md\nnorth star\n', 'utf8');
    const before = readFileSync(p, 'utf8');

    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir, adapter,
      // Server says German; the MEMORO.md setting (Swedish) must win.
      deps: {
        buildRoleImpl: () => 'role',
        fetchMcContextDataImpl: async () => null,
        fetchLensDataImpl: async () => ({ ok: true, markdown: 'lens', locale: 'de' }),
        grounding: { includeRoadmap: true, includeLens: true },
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.parts.language, 'Swedish');
    assert.match(adapter.written.markdown, /Swedish/);
    assert.match(adapter.written.markdown, /respond/i);
    // The setting comment must NOT be rendered into the map prose.
    assert.ok(!/memoro:language/.test(adapter.written.markdown), 'setting stripped from map');
    // Map prose still renders.
    assert.match(adapter.written.markdown, /north star/);
    // Read-only invariant preserved.
    assert.equal(readFileSync(p, 'utf8'), before, 'grounding must not write MEMORO.md');
  });

  it('falls back to the server locale when MEMORO.md has no setting', async () => {
    const p = join(dir, 'MEMORO.md');
    writeFileSync(p, '# MEMORO.md\nnorth star\n', 'utf8');
    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir, adapter,
      deps: {
        buildRoleImpl: () => 'role',
        fetchMcContextDataImpl: async () => null,
        fetchLensDataImpl: async () => ({ ok: true, markdown: 'lens', locale: 'de' }),
        grounding: { includeRoadmap: true, includeLens: true },
      },
    });
    assert.equal(res.parts.language, 'German');
    assert.match(adapter.written.markdown, /German/);
  });
});
