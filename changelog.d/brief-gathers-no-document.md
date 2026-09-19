section: Changed

- **`mc brief` gathers no document.** It opens or resumes the brief session
  with the role and `Start the meeting.` — nothing is collected first, and a
  resumed session gets no prompt. `--collect` and `--offline` are gone (an
  unknown flag now, exit 2), and so are `collectBrief`, `renderBrief` and the
  helpers only they used; `brief-collect.js` keeps the shared readers of plans,
  runs and the runner's tables. `canon/roles/brief.md` says where the ground is
  read instead: `mc --fresh`, `mc status <name>`, `mc step <project>`,
  `ls ~/mc/proposals/`, the runner's files and `gh pr list --state merged`.
  The gathered files in `~/mc/brief/` are left for their owner to delete.
