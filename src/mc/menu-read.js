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
export const MENU_FOOTER = /Enter to select|↑\/↓ to navigate/u;
const MENU_OPTION = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(.+?)\s*$/u;
const RULE_LIKE = /^[^A-Za-z0-9]*[-─═+]{3,}/u;

/**
 * `{ question, options }` or `null`. The question is the nearest line of text
 * above the first option that is not a rule or blank; null when the menu
 * sits at the very top of the capture.
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
  for (let i = first - 1; i >= 0; i -= 1) {
    const line = tail[i].trim();
    if (line === '' || RULE_LIKE.test(tail[i]) || MENU_FOOTER.test(line)) continue;
    question = line.replace(/^[⏺●◆·]\s*/u, '');
    break;
  }
  return { question, options };
}

/** The sentence every reader uses for it. */
export function menuReason(menu) {
  return `waiting on a menu — it needs an answer, not a knock${menu?.question ? `: "${menu.question}"` : ''}`;
}
