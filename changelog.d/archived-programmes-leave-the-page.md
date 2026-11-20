section: Fixed

- **Archived programmes leave the page.** A programme shelved before archive
  receipts, whose every remaining `docs/project/` file is read by code, stayed
  on `mc` and `mc programs list`. Running `mc plan <programme> --archive` again
  now records its receipt on the shelf, and the programme is no longer listed.
