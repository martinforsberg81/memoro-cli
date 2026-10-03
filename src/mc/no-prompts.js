/**
 * No child of mc asks for a credential.
 *
 * mc runs unattended, and its terminal is the page. When the login keychain
 * locked on 2026-09-20, git's credential helper came back empty and git fell
 * through to asking on the terminal: `Username for 'https://github.com':`
 * sat at the bottom of the page, under the key legend. These three names make
 * git, gh and Git Credential Manager fail with a message instead of asking.
 * Set on `process.env` once, at the entry, so every one of the spawn sites
 * inherits them and none of them needs a change; a value already set is the
 * caller's and is kept.
 */
export const NO_PROMPT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GH_PROMPT_DISABLED: '1',
  GCM_INTERACTIVE: 'never',
});

export function forbidCredentialPrompts(env = process.env) {
  for (const [name, value] of Object.entries(NO_PROMPT_ENV)) {
    if (env[name] === undefined) env[name] = value;
  }
  return env;
}
