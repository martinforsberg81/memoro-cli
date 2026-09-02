section: Changed

- **mc stops reading proposals, and they get their own room.** A proposal had
  a fixed frontmatter and fixed section names because three readers parsed
  them, and the three disagreed: a file whose first prose line was not marked
  `# ` was counted by the page, missing from `mc brief`, and recorded as
  "wrote nothing" by the very turn that had just written it — no error
  anywhere. `parseProposal` and `scanProposals` are gone; `listProposals`
  returns the markdown names, and a session that must know what is in one
  opens it. The brief lists names, the page keeps its count. Proposals moved
  from `~/mc/intake/proposals/` to `~/mc/proposals/`: intake is inbound
  material to read, proposals are what came out of reading it, and nesting the
  output inside the input made "read everything in intake" an instruction that
  had to carve out an exception for its own results.
