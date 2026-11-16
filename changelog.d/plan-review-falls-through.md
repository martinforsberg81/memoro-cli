section: Changed

- **A plan review falls through to the next reader.** `mc goal plan-review` sets aside a candidate that cannot be launched or whose billing route is unavailable, names it with its reason, and asks the next one. The draft's author is read last, and `--avoid` names the author whoever calls. When no reader can run it exits 3, reads nothing and leaves `.plan-review-unread.json`; the runner keeps such a draft waiting for a reader rather than setting Martin, and offers it to planning again when a reader can run.
