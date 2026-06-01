/**
 * Brief template for `mc fanout` agent sessions (§10a).
 *
 * The brief is the quality-lift mechanism: it codifies the priming
 * a coordinator currently does by hand (load protocol, apply
 * coordinator-agent loop, report in PR-body shape, ask on 2+-option
 * design choices). Treat its shape as load-bearing — phase agents
 * read this verbatim and skipping a section makes them behave
 * subtly worse.
 *
 * Pure helper — no I/O. Exported separately from the fanout verb so
 * tests can pin the brief shape (and any future drift) without
 * spawning sessions.
 */

/**
 * Build the brief string for one phase agent.
 *
 * @param {object} opts
 * @param {string} opts.planSlug      derived from plan filename, [a-z0-9-]+
 * @param {number} opts.phaseN        phase number (positive integer)
 * @param {string} opts.phaseTitle    second capture of `## Phase N: <title>`
 * @param {string} opts.intro         plan preamble (already capped upstream)
 * @param {string} opts.body          phase body verbatim
 * @returns {string} the brief, ready to land in the child session's input
 */
export function buildFanoutBrief({ planSlug, phaseN, phaseTitle, intro, body }) {
  if (!planSlug || typeof planSlug !== 'string') {
    throw new Error('buildFanoutBrief: planSlug required');
  }
  if (!Number.isInteger(phaseN) || phaseN <= 0) {
    throw new Error('buildFanoutBrief: phaseN must be a positive integer');
  }
  if (!phaseTitle || typeof phaseTitle !== 'string') {
    throw new Error('buildFanoutBrief: phaseTitle required');
  }
  const safeIntro = typeof intro === 'string' ? intro : '';
  const safeBody = typeof body === 'string' ? body : '';

  return [
    `You are an autonomous coding agent invoked by \`mc fanout\` for plan`,
    `"${planSlug}" / phase ${phaseN}: ${phaseTitle}.`,
    '',
    'Read before starting:',
    '  - docs/coding-agent-protocol.md',
    '  - .claude/skills/agent-coordination.md (esp patterns 9-15)',
    '',
    'Apply the coordinator-agent loop. Report in the standard PR-body',
    'shape: Summary / Judgment calls / Test plan / Follow-ups. Surface',
    'uncertainties explicitly per pattern 12. On any 2+ option design',
    'choice, stop and ask the parent session — do not guess.',
    '',
    'When done, open your PR against the shared collection branch',
    `\`wip/${planSlug}\` (NOT main).`,
    '',
    'Shared context (plan intro):',
    safeIntro,
    '',
    'Your phase task:',
    safeBody,
    '',
  ].join('\n');
}
