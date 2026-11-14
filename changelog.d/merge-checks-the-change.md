section: Changed

- **A merge checks the change, not the estate.** Bare gates and merge rounds
  use changed tests and one-hop importers (base importers for deletions), with
  no command gates or cost deferral. The optional wide selection stays; the
  daily full plan keeps every test, command gate and contract suite.
  Command-only daily reds retain their diagnostics and queue a main-red mend;
  an explicit command gate can check a full-only member on unchanged main.
