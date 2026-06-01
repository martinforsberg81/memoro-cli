/**
 * Plan-file parser for `mc fanout` (§10a).
 *
 * Splits a plan markdown file into:
 *   - `intro`: every line preceding the first `## Phase N: …` heading,
 *     capped at INTRO_MAX_LINES (~50). Acts as shared preamble in each
 *     phase agent's brief so phases stay reproducible without re-stating
 *     the whole plan.
 *   - `phases`: ordered list `{ n, title, body }` extracted from each
 *     `^## Phase (\d+):\s*(.+)$` heading. Body = everything between this
 *     heading and the next `## Phase …` (or EOF).
 *
 * §10a explicitly chose this format over YAML frontmatter for v1
 * (negative requirement in the drev brief). Anyone landing YAML support
 * later should add it here, not at the call sites.
 *
 * Pure helper — no I/O. The caller reads the file, this parses the
 * string. Lets tests exercise corner cases (no phases, intro larger
 * than cap, malformed heading) without touching disk.
 */

/** Phase headings beyond this rank are ignored (intro stays the
 *  same regardless — only phases must come after).
 *  Heading regex per the drev brief: `^## Phase (\d+):\s*(.+)$`. */
const PHASE_HEADING_RE = /^## Phase (\d+):\s*(.+?)\s*$/;

/** Intro line cap. Per drev brief: ~50 lines. */
export const INTRO_MAX_LINES = 50;

/**
 * Parse plan text into intro + ordered phases.
 *
 * @param {string} planText raw markdown
 * @param {object} [opts]
 * @param {number} [opts.introMaxLines=INTRO_MAX_LINES] override the cap
 * @returns {{ intro: string, phases: Array<{ n: number, title: string, body: string }> }}
 */
export function parsePhases(planText, { introMaxLines = INTRO_MAX_LINES } = {}) {
  if (typeof planText !== 'string') return { intro: '', phases: [] };
  const lines = planText.split(/\r?\n/);

  // Locate every `## Phase N:` heading line by index.
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PHASE_HEADING_RE);
    if (m) {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n <= 0) continue;
      headings.push({ index: i, n, title: m[2] });
    }
  }

  // Intro = everything before the first phase heading, capped.
  let introLines;
  if (headings.length === 0) {
    introLines = lines;
  } else {
    introLines = lines.slice(0, headings[0].index);
  }
  // Trim trailing blanks so the brief doesn't carry a wall of newlines.
  while (introLines.length > 0 && introLines[introLines.length - 1].trim() === '') {
    introLines.pop();
  }
  if (introLines.length > introMaxLines) {
    introLines = introLines.slice(0, introMaxLines);
  }
  const intro = introLines.join('\n');

  // Extract each phase body.
  const phases = [];
  for (let i = 0; i < headings.length; i++) {
    const cur = headings[i];
    const next = headings[i + 1];
    const start = cur.index + 1;
    const end = next ? next.index : lines.length;
    const bodyLines = lines.slice(start, end);
    // Trim leading + trailing blanks so the agent brief reads tight.
    while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift();
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
    phases.push({ n: cur.n, title: cur.title, body: bodyLines.join('\n') });
  }

  return { intro, phases };
}

/**
 * Derive a plan slug from the plan filename (basename without `.md`).
 *
 * Rejects anything outside `[a-z0-9-]+` — the slug ends up in branch
 * names, the registry, and `gh pr list --head` patterns. Allowing
 * arbitrary characters risks shell escape footguns down the line; the
 * narrow regex is paid back by predictability.
 *
 * Pure for testing. Returns `{ ok: true, slug }` or `{ ok: false, error }`.
 *
 * @param {string} filename e.g. `onboarding-flow.md`
 */
export function planSlugFromFilename(filename) {
  if (typeof filename !== 'string' || !filename) {
    return { ok: false, error: 'filename required' };
  }
  // Strip directory prefix and `.md` extension.
  const base = filename.split('/').pop().replace(/\.md$/i, '');
  if (!base) return { ok: false, error: 'filename has no basename' };
  if (!/^[a-z0-9-]+$/.test(base)) {
    return {
      ok: false,
      error: `plan slug "${base}" must match [a-z0-9-]+ (derived from filename without .md)`,
    };
  }
  return { ok: true, slug: base };
}
