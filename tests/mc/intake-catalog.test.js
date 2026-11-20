// An app suggestion is catalogued by jev and kept as it is: no proposal is written (Martin, 2026-11-20).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { catalogSuggestion, CATALOG_THRESHOLD, pageCriteria } from '../../src/mc/intake-catalog.js';
import { drainIntake } from '../../src/mc/helper-turn.js';
import { intakeArchiveDir, intakeDir } from '../../src/mc/helper-collect.js';

const NOW = new Date('2026-11-20T20:00:00Z');
const NAME = 'suggestion-abc.md';
const ROWS = [{ id: '71915e7f-e98e-4db2-a6bd-00cad8c4ce83', kind: 'bug', text: 'Fel i inkorgen: när jag väljer Radera laddas hela sidan om.', version: 27638, day: '2026-11-18' }];
const RECORD = `# Anonymous app suggestion — bug\n\n> ${ROWS[0].text}\n\n<!-- mc-suggestions-state\n${JSON.stringify(ROWS)}\n-->\n`;
const AREAS = [
  { id: 'mail-messaging', name: 'Mail and messaging', covers: 'The inbox, mail, texts and calls.', page: 'docs/technical/areas/mail-messaging.md' },
  { id: 'architecture', name: 'Architecture', covers: 'How the parts fit.', page: 'docs/technical/areas/delivery.md' },
  { id: 'users-meet', name: 'What users meet', covers: 'Surfaces, menus and windows.', page: 'docs/technical/areas/design-surface.md' },
];

function home() {
  const env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-catalog-')) };
  mkdirSync(intakeDir(env), { recursive: true });
  writeFileSync(join(intakeDir(env), NAME), RECORD);
  return env;
}

const answered = (choice, p) => async ({ body }) => {
  assert.deepEqual(Object.keys(body.questions), ['area'], 'one choice question, no text asked for');
  assert.equal(body.questions.area.type, 'choice');
  return { response: { model: 'jev-1.14.0', answers: { area: { choice, probabilities: { [choice]: p } } } } };
};

const run = (env, ask) => catalogSuggestion({
  env, now: NOW, file: NAME, deps: { areas: async () => ({ areas: AREAS }), readKeys: () => ({ TYPESAFE_API_KEY: 'k' }), ask },
});

const kept = (env, slug) => join(env.MC_WORK_ROOT, 'areas', 'memoro', slug, 'suggestions');
const catalog = (env, slug) => readFileSync(join(kept(env, slug), 'catalog.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('cataloguing an app suggestion with jev', () => {
  it('offers one option per area page, keyed by its slug', () => {
    const { criteria, slugOf } = pageCriteria(AREAS);
    assert.deepEqual(Object.keys(criteria), ['delivery', 'design_surface', 'mail_messaging']);
    assert.equal(slugOf.design_surface, 'design-surface');
  });

  it('keeps the file unchanged in the area jev names clearly, writes a catalog line and no proposal', async () => {
    const env = home();
    const out = await run(env, answered('mail_messaging', 0.93));
    assert.equal(out.ok, true);
    assert.deepEqual(out.wrote, [], 'no proposal is written');
    assert.equal(readFileSync(join(kept(env, 'mail-messaging'), NAME), 'utf8'), RECORD, 'kept as it came');
    assert.equal(existsSync(join(env.MC_WORK_ROOT, 'areas', 'memoro', 'mail-messaging', 'proposals')), false);
    const [line] = catalog(env, 'mail-messaging');
    assert.equal(line.area, 'memoro/mail-messaging');
    assert.deepEqual(line.ids, [ROWS[0].id]);
    assert.match(line.why, /mail-messaging at p 0\.93/u);
  });

  it('keeps it in the fallback area when jev is unsure or gives no answer', async () => {
    const unsure = home();
    await run(unsure, answered('design_surface', CATALOG_THRESHOLD - 0.01));
    assert.equal(readFileSync(join(kept(unsure, 'delivery'), NAME), 'utf8'), RECORD);
    assert.match(catalog(unsure, 'delivery')[0].why, /no clear area: design-surface/u);

    const silent = home();
    await run(silent, async () => ({ unavailable: 'HTTP 503 after one retry' }));
    assert.equal(readFileSync(join(kept(silent, 'delivery'), NAME), 'utf8'), RECORD);
    assert.match(catalog(silent, 'delivery')[0].why, /jev gave no answer \(HTTP 503/u);
  });

  it('is what the drain does with a suggestion file, which is then archived as before', async () => {
    const env = home();
    writeFileSync(join(intakeDir(env), 'errors-memoro-2026-11-20.md'), '# digest\n');
    const turned = [];
    const out = await drainIntake({
      env, now: () => NOW,
      deps: {
        turn: async ({ file }) => { turned.push(file); return { ok: true, wrote: [], waiting: [] }; },
        catalog: (args) => catalogSuggestion({ ...args, deps: { areas: async () => ({ areas: AREAS }), readKeys: () => ({}), ask: answered('mail_messaging', 0.9) } }),
      },
    });
    assert.deepEqual(turned, ['errors-memoro-2026-11-20.md'], 'only the digest has a model turn');
    assert.equal(out.done.find((d) => d.file === NAME).turn.catalogued.area, 'memoro/mail-messaging');
    assert.deepEqual(readdirSync(intakeArchiveDir(env, NOW)).sort(), ['errors-memoro-2026-11-20.md', NAME]);
  });
});
