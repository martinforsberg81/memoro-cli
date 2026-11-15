section: Added

- **Proposed changes to your texts reach the desk in one form, and nothing is decided after a wait.**
  A change to a text Martin holds is now brought as a desk item of sort `text`
  in three Swedish parts (what the text says, what is proposed, what was
  found), through `mc martin propose` from any session with no goal, or
  `brief --sort text` and `lesson brief` from the desk's own sessions; a brief
  not in the form is refused. The opening lists them as "Proposed changes to
  your texts", apart from "Your acts", and shows what the system could not
  finish only as "stuck". There is no default after a wait: no clock carries
  out, closes or moves a brief, `close --by default` is refused, and the
  decision pass takes prepared items only.
