export function assertTerminalSize(cols, rows) {
  assertBoundedInteger(cols, 20, 500, 'cols');
  assertBoundedInteger(rows, 5, 200, 'rows');
}

export function validTerminalSize(cols, rows) {
  try { assertTerminalSize(cols, rows); return true; } catch { return false; }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
}
