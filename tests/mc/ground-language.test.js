/**
 * TDD spec for grounding Phase 4 — language resolution + lens auto-injection.
 *
 * Phase 4 makes two things first-class:
 *
 *   1. Lens auto-injection. The lens already flows into the bundle without a
 *      manual `lens pull` (Phase 1's pullLensMarkdown). Phase 4 broadens the
 *      fetch so it surfaces the WHOLE lens response, not just markdown, so a
 *      language preference can be derived from it. `fetchLensData` is the
 *      injectable, soft-degrading portal; `pullLensMarkdown` stays as the
 *      markdown-only convenience built on top.
 *
 *   2. Language from user_state. The session's render language is DERIVED
 *      from the user's Memoro profile, never a static choice. The default is
 *      English (= no directive). `resolveLanguage(lensResponse)` is the pure
 *      resolver: response object → language label (or null = English).
 *      `languageDirective(language)` renders the minimal "respond in <x>"
 *      line, empty for English.
 *
 * SERVER-GATE NOTE (verified live 2026-06-03 against meetmemoro.app): the
 * lens endpoints do NOT expose a language/locale field today, and no
 * /api/user_state endpoint exists. The resolver is wired against the actual
 * response SHAPE (the lens object is the only realistic carrier) so it
 * lights up the moment the server adds the field — but until then it
 * resolves to English for every real response. These tests pin BOTH: the
 * gated reality (real shapes → English) and the wired behaviour (a response
 * that DOES carry the field → that language).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLanguage,
  languageDirective,
  fetchLensData,
  pullLensMarkdown,
  assembleBundle,
} from '../../src/mc/ground.js';

// ─────────────────────────────────────────────────────────────
// resolveLanguage — pure: lens response → language label | null
// ─────────────────────────────────────────────────────────────

describe('resolveLanguage (pure)', () => {
  it('returns null (English default) for the REAL portrait-coding shape (server-gated)', () => {
    // Verified live: this is exactly what the server returns today.
    const real = {
      ok: true,
      lens: 'portrait-coding',
      version: 'portrait-coding-v1',
      markdown: '',
      generatedAt: '2026-06-03T05:59:51.515Z',
    };
    assert.equal(resolveLanguage(real), null);
  });

  it('returns null for null / undefined / non-object (soft-degrade)', () => {
    assert.equal(resolveLanguage(null), null);
    assert.equal(resolveLanguage(undefined), null);
    assert.equal(resolveLanguage('nope'), null);
    assert.equal(resolveLanguage(42), null);
  });

  it('returns null when no language field is present', () => {
    assert.equal(resolveLanguage({ ok: true, markdown: 'x' }), null);
  });

  it('reads a top-level `language` field when the server provides one', () => {
    assert.equal(resolveLanguage({ language: 'Swedish' }), 'Swedish');
  });

  it('reads `locale` and maps it to a language label', () => {
    assert.equal(resolveLanguage({ locale: 'sv-SE' }), 'Swedish');
    assert.equal(resolveLanguage({ locale: 'sv' }), 'Swedish');
    assert.equal(resolveLanguage({ locale: 'de-DE' }), 'German');
  });

  it('reads a preference nested under user_state / preferences', () => {
    assert.equal(resolveLanguage({ user_state: { language: 'French' } }), 'French');
    assert.equal(resolveLanguage({ preferences: { locale: 'es' } }), 'Spanish');
  });

  it('treats English / en / en-US as the default (null — no directive)', () => {
    assert.equal(resolveLanguage({ language: 'English' }), null);
    assert.equal(resolveLanguage({ locale: 'en' }), null);
    assert.equal(resolveLanguage({ locale: 'en-GB' }), null);
  });

  it('ignores blank / whitespace language fields', () => {
    assert.equal(resolveLanguage({ language: '   ' }), null);
    assert.equal(resolveLanguage({ language: '' }), null);
  });

  it('maps known locale codes to a label', () => {
    assert.equal(resolveLanguage({ locale: 'ja' }), 'Japanese');
  });

  it('passes through an UNMAPPED locale code as-is (best effort, never throws)', () => {
    // An unmapped code isn't dropped — better to instruct the LLM with the
    // raw tag than to silently fall back to English on a real preference.
    assert.equal(resolveLanguage({ locale: 'hu-HU' }), 'hu-HU');
  });

  it('never throws on a hostile shape', () => {
    assert.doesNotThrow(() => resolveLanguage({ user_state: null, preferences: 5 }));
    assert.equal(resolveLanguage({ user_state: null, preferences: 5 }), null);
  });
});

// ─────────────────────────────────────────────────────────────
// languageDirective — pure: language label → directive line | ''
// ─────────────────────────────────────────────────────────────

describe('languageDirective (pure)', () => {
  it('returns empty string for null (English — no directive, zero noise)', () => {
    assert.equal(languageDirective(null), '');
    assert.equal(languageDirective(undefined), '');
    assert.equal(languageDirective(''), '');
  });

  it('renders a minimal "respond in <language>" line for a real language', () => {
    const d = languageDirective('Swedish');
    assert.match(d, /Swedish/);
    assert.match(d, /respond/i);
  });

  it('is pure — same input, same output', () => {
    assert.equal(languageDirective('German'), languageDirective('German'));
  });
});

// ─────────────────────────────────────────────────────────────
// fetchLensData — injectable portal returning the WHOLE response
// ─────────────────────────────────────────────────────────────

describe('fetchLensData (auto-injection portal)', () => {
  it('returns the full response object from the injected fetch', async () => {
    const resp = { ok: true, markdown: 'body', language: 'Swedish' };
    const out = await fetchLensData({ fetchLens: async () => resp });
    assert.deepEqual(out, resp);
  });

  it('returns null (never throws) when the fetch rejects — soft-degrade', async () => {
    const out = await fetchLensData({ fetchLens: async () => { throw new Error('no token'); } });
    assert.equal(out, null);
  });

  it('returns null when the fetch yields nothing', async () => {
    assert.equal(await fetchLensData({ fetchLens: async () => null }), null);
  });
});

describe('pullLensMarkdown still extracts markdown from the response', () => {
  it('pulls .markdown out of a full response object', async () => {
    const out = await pullLensMarkdown({
      fetchLens: async () => ({ ok: true, markdown: 'lens body', version: 'v1' }),
    });
    assert.equal(out, 'lens body');
  });

  it('still accepts a bare markdown string (back-compat)', async () => {
    const out = await pullLensMarkdown({ fetchLens: async () => 'plain body' });
    assert.equal(out, 'plain body');
  });

  it('returns null when the response carries no markdown', async () => {
    assert.equal(await pullLensMarkdown({ fetchLens: async () => ({ ok: true }) }), null);
  });
});

// ─────────────────────────────────────────────────────────────
// assembleBundle — language governs the rendered directive
// ─────────────────────────────────────────────────────────────

describe('assembleBundle language directive', () => {
  it('emits a respond-in directive when a non-English language is resolved', () => {
    const out = assembleBundle({ role: 'r', language: 'Swedish' });
    assert.match(out, /Swedish/);
    assert.match(out, /respond/i);
  });

  it('emits NO directive for English (null) — clean default output', () => {
    const out = assembleBundle({ role: 'r', language: null });
    assert.ok(!/respond in/i.test(out), 'no respond-in directive for English default');
  });

  it('is still pure with a language', () => {
    const parts = { role: 'r', language: 'German' };
    assert.equal(assembleBundle(parts), assembleBundle(parts));
  });
});
