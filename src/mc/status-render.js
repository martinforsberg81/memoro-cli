/**
 * Drawing primitives: colour, visible width, padding and clipping.
 *
 * This was the status board's renderer. The board went with `mc status`
 * (decision mc-3) and its `renderLines` with it; what is left is the half
 * every other page was already borrowing — `page-render.js` for the one page,
 * `repo-render.js` and `mc suite` for their own.
 *
 * Colour is applied through `painter`, which returns the text untouched when
 * the output is not a terminal. A page piped into a file or read by a session
 * should contain what it says and nothing else. `width` measures what a
 * terminal shows, so escape sequences take no columns — which is also why
 * text is measured and clipped *before* it is painted, never after.
 */
const SGR = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  magenta: '[35m',
  cyan: '[36m',
  white: '[37m',
  grey: '[90m',
};

export function painter(colour) {
  if (!colour) return (text) => text;
  return (text, ...styles) => `${styles.map((name) => SGR[name] || '').join('')}${text}${SGR.reset}`;
}

/** Visible width: escape sequences take no columns. */
export function width(text) {
  return String(text).replace(/\[[0-9;]*m/gu, '').length;
}

export function pad(text, to) {
  const short = to - width(text);
  return short > 0 ? text + ' '.repeat(short) : text;
}

export function clip(text, to) {
  if (width(text) <= to) return text;
  return `${String(text).slice(0, Math.max(0, to - 1))}…`;
}

/** `ps etime` — `MM:SS`, `HH:MM:SS` or `D-HH:MM:SS` — as a person says time. */
export function elapsed(etime) {
  const value = String(etime || '').trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(value);
  if (!match) return value || '?';
  const [, days = '0', hours = '0', minutes] = match;
  const total = Number(days) * 1440 + Number(hours) * 60 + Number(minutes);
  if (total < 1) return 'under a minute';
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}
