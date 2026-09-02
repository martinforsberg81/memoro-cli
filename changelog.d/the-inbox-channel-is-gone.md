section: Removed

- **The inbox channel.** `mc work send <name> "<message>"` wrote a file into
  `~/mc/<name>/inbox/` and, with `--wake`, knocked on whatever conversation was
  running there. It was the PM-era answer to "how does one session tell
  another something", and the PM is gone: `mc run` drives both lanes in one
  process, so the session to be told is the one asking. `src/mc/work-send.js`
  (735 lines), the verb, its parsing, its five outcome sentences and the tmux
  knocking that carried them are all gone.
- **A refused lease no longer writes to the holder.** `lease-refusal.js` sent a
  `CLAIM REFUSED` file with a wake to whoever held a repository, so the wait
  was theirs to end. It rode on the channel, and the sentence the asker gets
  says the same facts. What is left is that sentence.
- **`FILING_DIRECTORIES` goes with the inbox it filtered.** A workarea is a
  directory that holds checkouts, and nothing else — no list of names to keep
  off the board, because there is nothing to keep off it. One consequence is
  worth knowing: `mc work release` now takes a directory in an area that is not
  a checkout, the way it always took any other non-checkout. It is named in the
  dry run before it is taken, and that is asserted.
- The command matrix documented `mc sessions send` and `mc sessions read`,
  which the router stopped carrying some time ago, and `mc dispatch` / `mc read`
  as what they route to. All four rows and the section around them are gone.
