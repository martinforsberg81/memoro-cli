section: Changed

- **Codex on the API reserve keeps a websocket open instead of resending the
  thread.** The gateway spoke only HTTP, so Codex sent the whole thread with
  every request: 8.3 MB per request for a 205k-token thread, and 114 s to the
  first byte. The gateway now accepts Codex's upgrade on
  `/codex/v1/responses`, checks the grant before the handshake, and opens its
  own socket to OpenAI with the key, which stays in the wrapper. Each
  `response.create` is checked for the session's model and counted against
  its request limit; a refused one closes the socket with 1008. The server
  side uses the `ws` package, Node having no websocket server.
