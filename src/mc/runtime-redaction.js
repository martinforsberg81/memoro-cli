const CREDENTIAL_VALUE_RE = /\b(mem_[A-Za-z0-9._:-]{6,}|sk-[A-Za-z0-9._-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|cap_[A-Za-z0-9_-]{6,})\b/g;
const BEARER_VALUE_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const ASSIGNED_CREDENTIAL_RE = /\b((?:access|refresh)[_-]?token|auth[_-]?json|secret|password|passphrase|api[_-]?key|credential|capability)\s*[:=]\s*["']?[^"',\s}]+["']?/gi;

export function redactCredentialText(value, maxLength = 4096) {
  return String(value ?? '')
    .replace(CREDENTIAL_VALUE_RE, '[redacted]')
    .replace(BEARER_VALUE_RE, '$1[redacted]')
    .replace(ASSIGNED_CREDENTIAL_RE, '$1=[redacted]')
    .slice(0, maxLength);
}
