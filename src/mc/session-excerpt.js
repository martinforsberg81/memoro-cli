export function extractExcerpt(rawBuffer, max = 500) {
  if (!rawBuffer) return '';

  let s = rawBuffer
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>cDEHM7-9NO]/g, '');

  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');
  if (s.length > max) s = s.slice(-max);
  return s.replace(/^\s+/, '');
}
