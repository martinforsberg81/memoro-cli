section: Added

- **`mc shot --context-click <css>`, `--long-press <css>[@ms]` and `--fill <css>=<text>`.** A label chip's menu opens on a right-click or a 500 ms press, and a rename popover needs text typed into it, so a session wrote its own Playwright script for each. The three join `--click`, and the four act in the order given. They reach the capture script as the request's `actions`; a result that does not answer `acted` with one entry per action exits 1 with no path. memoro's capture script does not honour `actions` yet, so until it does that refusal is what these flags answer.
