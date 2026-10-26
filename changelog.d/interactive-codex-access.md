section: Fixed

- Interactive Codex sessions opened by mc now receive filesystem access to mc's
  operational directories and shared Git metadata automatically, including
  planning sessions that contain both repositories. Foreground, background,
  resumed and replaced sessions all pass through the adapter. The user's
  sandbox and approval settings are not disabled or changed.
