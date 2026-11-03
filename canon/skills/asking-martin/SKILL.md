---
name: asking-martin
description: Asking Martin a question or reporting to him in mc work — a decision only he can make, a blocked step or goal, the end-of-session account. Use before asking a question, blocking on an answer, or writing what you tell him.
---
# Asking Martin, and telling him

A question for Martin is one thing: what you found, what it costs, what you
would do — answerable in a word. Never a menu of options. Never ask while the
question is unclear or reading would settle it: then read.

- Headless, there is nobody to ask: your role says where the question goes (a
  blocked step, a blocked goal, a pull request).
- Tell Martin the outcome, not the bookkeeping. His, in one line with your
  recommendation: a merge that needed your judgement to go green, anything the
  gate refused, anything that changes what is deployed.
- A headless session cannot do `mc deploy`, `--admin`, production data or
  credentials: the hook refuses them (`MC_HEADLESS=1`). Work that needs one
  waits, and your entry says what it waits on. With Martin at the terminal,
  an act that changes what is deployed or what users see is said in one line
  before it runs.
