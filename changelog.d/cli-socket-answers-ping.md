section: Fixed

- **The daemon's command socket answers the server's ping.** The server
  pings every socket it holds each 60 s and closes one that has not sent a
  `pong` for 210 s; `ws-client.js` logged the ping as an unknown message
  and never answered, so every `cli` socket was closed after ~240 s and
  reconnected, around the clock (memoro fingerprint `c7e3fd98`, "Heartbeat
  timeout, closing" with `deviceId: "cli"`). It now replies `{type:'pong'}`
  and ignores a stray `pong`. The memoro half — `handleCliMessage` must
  record that pong instead of answering "unknown CLI message type" — ships
  separately; until it does, the socket still cycles as before.
