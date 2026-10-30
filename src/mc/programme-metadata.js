/** Programme context, not an approval contract or a second goal assignment. */
import { STABLE_ID_RE } from './goal-contract.js';

export function validateProgrammeMetadata(value) {
  const problems = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problems: ['programme metadata must be an object'] };
  for (const key of Object.keys(value)) if (!['id', 'brief'].includes(key)) problems.push(`programme.${key}: unknown key`);
  if (typeof value.id !== 'string' || !STABLE_ID_RE.test(value.id)) problems.push('programme.id: a stable programme name');
  if (typeof value.brief !== 'string' || !value.brief.trim()) problems.push('programme.brief: the programme description source path');
  return { ok: problems.length === 0, problems };
}
