section: Fixed

- The menu reader knows the family, not one footer — and looks for a menu
  before a prompt box. The PM captured the next live menu (2026-08-23): a
  confirmation with *Enter to confirm · Esc to cancel*, drawn **below** a
  prompt box still on screen, with an explanatory sentence between the
  question and the options. The reader built the day before knew only
  *Enter to select · ↑/↓ to navigate* and looked for the box first; it said
  *could not find its prompt* — the old sentence, as designed, never a
  keystroke. Now a footer is any line naming Enter and a way out (Esc or
  cancel), numbered options make it a menu whatever the footer says, the
  menu is read before the box so a leftover box cannot hide it, and the
  question is the nearest line ending in `?` above the options. The capture
  is a test fixture.
