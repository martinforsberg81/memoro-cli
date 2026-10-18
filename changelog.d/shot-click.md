section: Added

- **`mc shot --click <selector>`, repeatable.** A pane behind a tab or a window
  behind a button could only be pictured by declaring a target in memoro's
  `.mc/shot.json`, so on 2026-10-17 a session wrote its own Playwright script
  instead. The clicks go to the capture script as the request's `click`, in
  order, and a result that does not answer `clicked` exits 1 with no path, since
  its picture lacks them. memoro's capture script does not honour `click` yet,
  so until it does that refusal is what `--click` answers.
