/**
 * Open-question heuristic (§9a).
 *
 * Detects when an assistant message is paused awaiting a human answer.
 * The trigger surface is intentionally narrow — false positives ("ends
 * with `?` mid-paragraph") drown the signal. The rules:
 *
 *   - Last non-blank line ends with `?` (URLs with `?foo=…` excluded)
 *   - Contains "Vill du" (Swedish, common phrase from this user)
 *   - Contains "Want me to"
 *   - Contains "Ja eller nej"
 *   - Contains an "A or B" choice phrase (sv: "A eller B")
 *   - Contains a numbered list of at least two items (1. … 2. …) that
 *     looks like options, not a version number
 *
 * Pure function — no I/O — so `mc list --rich`, `mc status`, and any
 * future LLM-fallback path can call it cheaply.
 */

const VILL_DU = /\bvill\s+du\b/i;
const WANT_ME_TO = /\bwant\s+me\s+to\b/i;
const JA_ELLER_NEJ = /\bja\s+eller\s+nej\b/i;
// "A or B" / "A eller B" — single capital letters / "option X" — typical
// choice prompts. We require the words on either side of "or"/"eller" to
// look like option labels, not arbitrary tokens, to avoid hits like
// "saved A or rolled back".
const A_OR_B = /\b(?:option\s+)?[A-Z](?:\s+or\s+|\s+eller\s+)(?:option\s+)?[A-Z]\b/;

/**
 * Numbered-list detection: at least two items of the form `N. text` or
 * `N) text` at line start, where N is 1-9 (not version numbers like
 * `1.2.3`).
 */
function hasNumberedChoices(text) {
  const lines = text.split('\n');
  let count = 0;
  for (const line of lines) {
    if (/^\s*[1-9][.)]\s+\S/.test(line) && !/^\s*[1-9]\.[0-9]/.test(line)) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
}

/**
 * Strip URLs so `?` inside query strings doesn't count as a question.
 */
function stripUrls(text) {
  return text.replace(/https?:\/\/\S+/g, ' ');
}

function endsWithQuestionMark(text) {
  const cleaned = stripUrls(text).trimEnd();
  return /\?\s*$/.test(cleaned);
}

export function detectOpenQuestion(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (endsWithQuestionMark(text)) return true;
  if (VILL_DU.test(text)) return true;
  if (WANT_ME_TO.test(text)) return true;
  if (JA_ELLER_NEJ.test(text)) return true;
  if (A_OR_B.test(text)) return true;
  if (hasNumberedChoices(text)) return true;
  return false;
}
