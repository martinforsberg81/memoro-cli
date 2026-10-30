/** Shared stable identities and measurable goal criteria; no approval authority. */
export const STABLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const VERIFICATION_PHASES = Object.freeze(['premerge', 'after-integration']);

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const prose = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
const id = (value) => typeof value === 'string' && STABLE_ID_RE.test(value);

function keys(value, allowed, at, problems) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${at}.${key}: unknown key`);
}

/** Stable IDs are explicit, never derived from prose or array positions. */
export function criterionProblems(list, { instruction = false } = {}) {
  const problems = [];
  if (!Array.isArray(list) || !list.length) return ['success_criteria: at least one criterion'];
  const seen = new Set();
  list.forEach((item, index) => {
    const at = `success_criteria[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    keys(item, ['id', 'criterion', 'check', 'verification', ...(instruction ? ['instruction'] : [])], at, problems);
    if (!id(item.id)) problems.push(`${at}.id: a stable lower-case name`);
    if (seen.has(item.id)) problems.push(`${at}.id: duplicate criterion ID`);
    seen.add(item.id);
    if (!text(item.criterion)) problems.push(`${at}.criterion: what must be true`);
    if (!text(item.check)) problems.push(`${at}.check: how it is measured`);
    if (instruction && !prose(item.instruction)) problems.push(`${at}.instruction: at least one paragraph`);
    if (!VERIFICATION_PHASES.includes(item.verification)) problems.push(`${at}.verification: premerge or after-integration`);
  });
  return problems;
}

