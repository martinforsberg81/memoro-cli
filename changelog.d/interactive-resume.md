section: Fixed

- **Resume interactive conversations explicitly.** `mc manager --resume`,
  `mc helper --resume` and `mc plan <programme> --resume` offer saved
  compatible conversations, including multiple conversations in the same desk.
  Supply an ID or unique prefix to resume one directly. Explicit resumes never
  fall back to a new conversation. Codex role discovery now reads up to 1 MiB
  of native history: tool definitions had pushed valid role markers beyond the
  previous 64 KiB limit, causing automatic resumes to start fresh.
