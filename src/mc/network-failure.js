// What a failed git or gh call printed when the network, not the change, stopped it.

/**
 * What git and gh print when the forge or the remote could not be reached at
 * all. A stop with one of these is the network's, not the change's: nothing
 * about the pull request was read, so the round answers `offline`, not `drift`,
 * `pr` or `merge`. A refusal from GitHub (not mergeable, no permission) is not
 * one of these and keeps its own stop.
 */
export const NETWORK_FAILURE = /error connecting to|could not resolve host|name or service not known|temporary failure in name resolution|network is unreachable|no route to host|connection (?:refused|reset)|\btimed? ?out\b|i\/o timeout|ECONN\w*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/iu;

/** Whether `text` (a git or gh stderr) says the remote or GitHub could not be reached at all. */
export function isNetworkFailure(text) {
  return NETWORK_FAILURE.test(String(text ?? ''));
}
