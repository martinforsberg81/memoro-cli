section: Fixed

- **A repair session is blue on the page, as finish was.** The fix a review's
  rejection starts runs as kind `repair`, and the palette had no colour for it:
  its activity row and frame were grey. `repair` now takes finish's blue in the
  palette, so the activity row, frame and kind table say so. The 24 h line
  prints a day's repair sessions as `repair N` after review, and says nothing
  on a day without one. The pipeline draws a repair session as a blue mark on
  the build box, beside the green build marks; before, it was counted on no
  box. The `finish` box stays, for goals from before that still stand in
  `finish`.
