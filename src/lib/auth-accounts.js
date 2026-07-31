// Stable OS-keychain account identifiers. Kept in a dependency-light module
// so trusted custody code does not import command, prompt, or tool adapters.
export const PRIMARY_AUTH_TOKEN_ACCOUNT = 'memoro-api-token';
export const SUPERVISOR_TOKEN_ACCOUNT = 'memoro-mc-supervisor-token';

export const ACCOUNTS = Object.freeze({
  TOKEN: PRIMARY_AUTH_TOKEN_ACCOUNT,
  PRIMARY_AUTH_TOKEN: PRIMARY_AUTH_TOKEN_ACCOUNT,
  SUPERVISOR_TOKEN: SUPERVISOR_TOKEN_ACCOUNT,
});
