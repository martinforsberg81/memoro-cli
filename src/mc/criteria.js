/**
 * `criteria.js` — the parts of a GOAL.json (`goals.js`) a plan's schema
 * (`plan-schema.js`) shares: success criteria, each with a check and a `met`,
 * the documents a reader is sent to, and the prose fields as arrays of
 * paragraphs. One definition, so a criterion means the same in both.
 */

/** The keys a criterion carries. */
export const CRITERION_KEYS = Object.freeze(['met', 'criterion', 'check']);
/** The keys a document carries. */
export const DOCUMENT_KEYS = Object.freeze(['label', 'path']);

/** Whether `value` is an object, not an array or null. */
export function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The keys of `value` that `allowed` does not name. */
export function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** Whether `value` is a string with something in it. */
export function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether `value` is prose: an array of at least `min` paragraphs, each text.
 * `min` is 1 where the field is the reason the document exists, and 0 where it
 * may honestly have nothing yet to say.
 */
export function prose(value, { min = 1 } = {}) {
  return Array.isArray(value) && value.length >= min && value.every(text);
}

/**
 * The problems of a `success_criteria` list, pushed onto `problems`: at least
 * `min` criteria (1 by default — `what` names the thing that cannot be finished
 * without one), each `{ criterion, check, met }` and nothing else.
 */
export function validateCriteria(list, problems, { min = 1, what = 'a project' } = {}) {
  if (!Array.isArray(list) || list.length < min) {
    problems.push(min > 0
      ? `success_criteria: at least one criterion — ${what} with none cannot be finished`
      : 'success_criteria: an array of criteria, possibly empty');
    return;
  }
  list.forEach((item, index) => {
    const at = `success_criteria[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    for (const key of unknownKeys(item, CRITERION_KEYS)) problems.push(`${at}.${key}: unknown key`);
    if (typeof item.met !== 'boolean') problems.push(`${at}.met: true or false`);
    if (!text(item.criterion)) problems.push(`${at}.criterion: what must be true`);
    // The check is the half a criterion is usually missing: "done" is not a
    // judgement the session makes about its own work.
    if (!text(item.check)) problems.push(`${at}.check: how it is checked — the assertion, the query, the measurement in the running app`);
  });
}

/** The problems of a `documents` list, pushed onto `problems`: each `{ label, path }`. */
export function validateDocuments(list, problems) {
  if (!Array.isArray(list)) { problems.push('documents: an array, possibly empty'); return; }
  list.forEach((item, index) => {
    const at = `documents[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    for (const key of unknownKeys(item, DOCUMENT_KEYS)) problems.push(`${at}.${key}: unknown key`);
    if (!text(item.label)) problems.push(`${at}.label: what the reader is being sent to`);
    if (!text(item.path)) problems.push(`${at}.path: a path or URL a checkout can follow`);
  });
}

/** The 1-based numbers of the success criteria of `doc` (a plan or a goal) that are not `met: true`. */
export function unmetCriteria(doc) {
  const criteria = Array.isArray(doc?.success_criteria) ? doc.success_criteria : [];
  return criteria.map((criterion, i) => (criterion?.met === true ? null : i + 1)).filter(Boolean);
}

/** `{ met, all }`: how many of `doc`'s success criteria are met, of how many. */
export function criteriaCount(doc) {
  const all = Array.isArray(doc?.success_criteria) ? doc.success_criteria.length : 0;
  return { met: all - unmetCriteria(doc).length, all };
}
