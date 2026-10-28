section: Added

- **Inactive v2 contract dispatch and CLI.** Versioned programme and goal
  commands are lazily routed, guarded v2 send validates the approved agreement
  without appending a legacy review or starting execution, and read-only status
  exposes revisioned evidence. V1 defaults remain unchanged; unknown versions
  cannot fall through to fixed-step mutation or cleanup.
