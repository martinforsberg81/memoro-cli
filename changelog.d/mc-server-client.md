section: Added

- **Optional mc server for interactive entrances.** Store and check one OpenSSH
  destination under the local work root, with a local override, a strict versioned
  session protocol, and a local Codex client over a private Unix-socket tunnel.
  The shared entrance asks join-or-new locally; the server retains role, model,
  effort, roots, identity and billing. New Codex threads receive only access
  flags and an optional opening user message; joins retain the thread policy.
  Clean idle quits apply the existing server end rule; a lost link leaves the
  session running. Claude attaches on the server through `ssh -t`.
