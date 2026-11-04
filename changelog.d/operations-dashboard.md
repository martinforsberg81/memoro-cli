section: Added

- **Add the read-only `mc-admin` operations snapshot.** The second binary reads
  only the fixed admin health and operations token routes through the existing
  trusted keys runner, prints plain text or a safe schema-versioned JSON
  projection, and exits; rerunning refreshes. Headless live reads are refused.
