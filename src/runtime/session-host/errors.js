export function runtimeHostError(reason, cause = null) {
  const error = new Error(`mc runtime host error (${reason})`, cause ? { cause } : undefined);
  error.code = 'MC_RUNTIME_HOST_ERROR';
  error.reason = reason;
  return error;
}
