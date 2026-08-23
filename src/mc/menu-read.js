/**
 * A pane in a menu: the tool is asking the session something, there is no
 * prompt at all, and the session waits on a person — often for the whole
 * night (2026-08-23: a pane sat on a numbered choice; the wake said "could not
 * find its prompt", which is true and names the wrong thing). A knock cannot
 * reach it: the probe would type into the menu. So the state is recognised
 * and said, with the question, by whoever looks — the wake, the guard, the
 * board.
 *
 * The shape, as Claude Code draws it: numbered options, the chosen one marked
 * `❯`, and a footer `Enter to select · ↑/↓ to navigate · Esc to cancel`.
 */
/**
 * The footer is a family, not a string. Two seen so far: `Enter to select ·
 * ↑/↓ to navigate · Esc to cancel` (a choice in a list) and `Enter to confirm
 * · Esc to cancel` (a confirmation, 2026-08-23, captured live by the PM and
 * missed by a reader that knew only the first). What they share is the shape:
 * a line that names Enter *and* a way out (Esc or cancel). A list of known
 * footers would be true today and silently out of date at the next variant.
 */
export const MENU_FOOTER = /\bEnter\b[\s\S]*(?:\bEsc\b|cancel)|(?:\bEsc\b|cancel)[\s\S]*\bEnter\b/iu;
const MENU_OPTION = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(.+?)\s*$/u;
const RULE_LIKE = /^[^A-Za-z0-9]*[-─═+]{3,}/u;

/**
 * `{ question, options }` or `null`. The question is the nearest line ending
 * in `?` within a few rows above the first option — a menu often carries an
 * explanatory sentence between the question and the options — else the
 * nearest line of text that is not a rule, blank or the footer; null when the
 * menu sits at the very top of the capture.
 */
export function readMenu(lines) {
  const tail = lines.slice(Math.max(0, lines.length - 20));
  if (!tail.some((line) => MENU_FOOTER.test(line))) return null;
  const options = [];
  let first = -1;
  for (let i = 0; i < tail.length; i += 1) {
    const match = MENU_OPTION.exec(tail[i]);
    if (!match) continue;
    if (first === -1) first = i;
    options.push(match[2]);
  }
  if (options.length === 0) return null;
  let question = null;
  let nearest = null;
  for (let i = first - 1; i >= 0 && i >= first - 6; i -= 1) {
    const line = tail[i].trim();
    if (line === '' || RULE_LIKE.test(tail[i]) || MENU_FOOTER.test(line)) continue;
    const text = line.replace(/^[⏺●◆·]\s*/u, '');
    if (nearest === null) nearest = text;
    if (text.endsWith('?')) { question = text; break; }
  }
  return { question: question ?? nearest, options };
}

/** The sentence every reader uses for it. */
export function menuReason(menu) {
  return `waiting on a menu — it needs an answer, not a knock${menu?.question ? `: "${menu.question}"` : ''}`;
}
