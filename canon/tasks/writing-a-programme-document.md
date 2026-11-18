---
name: writing-a-programme-document
description: Writing a programme document in mc — what the user gets and how one sees that it works. Use before drafting or changing a programme README.
---
# Writing a programme document

A programme document is an order, as a buyer of software hands it to the firm that builds it. Martin is the buyer: it is written with him in a session, he says there that it is ready, the desk sets it ready with `mc programs state <programme> ready`, and the planner cuts goals from its README.

An order is built to its end without him (Martin, 2026-11-17). Between ready and done nothing waits for him: no picture to accept, nothing to look at, listen to or try, no reading to approve. Every choice of his is made in the document before it is ready; the build is judged against the document and measured (`mc shot`, the checks), never by his use. An act of his the work needs (money, a console, a legal commitment) is done before ready or after the end, as an act of its own.

An order is temporary: archived when its work has landed and not read again. What must last is written where it lasts before then: what runs in `docs/technical/`, aims and decisions on the area page, findings as proposals in their area ([proposals](proposals.md)).

The document binds what the user gets, how it looks and how one sees that it works. How it is built is the planner's and the builder's to settle, so leave technical detail out unless the thing ordered rests on it. Keep it short enough that he reads all of it.

## The document

- Open with what a user can do or see afterwards that they cannot today.
- One coherent thing to say yes or no to. If Martin could want half of it,
  it is two programmes.
- A part is something that is built, cut by what a user gets and not by
  layer. It can land by itself, and it keeps its number.
- Order says the sequence of the parts and what the desk does beside the build; it holds no step of Martin's.
- Three to eight parts.
- About 1,500 words, as a recommendation and not a limit (Martin, 2026-11-18):
  a document that needs more to state every case the user meets takes it, and
  no case is cut to fit. Split it into several programmes where that makes each
  clearer to say yes or no to; look first for construction that has come in.
  What runs today is written as a user meets it, from the app and the
  standards; code is read only for a fact the order depends on.

## A part

- **Closes.** What is wrong or missing today, as the user meets it.
- **Solution.** What happens, from the user's first step to the last, and
  every case that is not the plain one: nothing to show, too much, a failure,
  a second visit, the phone. Then only the construction the order rests on:
  what must be reused, what must not change, a limit that binds.
- **Design.** What the user gets and how one sees that it works. One picture
  for each thing Martin decides: the new thing as it will look, at one width,
  in the light theme. A second picture only where the phone is a choice of its
  own. No picture in the dark theme: how dark looks follows memoro
  `docs/technical/design-tokens.md`. States (failed, empty, working, cut, a
  second visit) are said in words by the app component they follow, and are
  not pictured. Where a part reuses a component as it is, the design names the
  component and shows one picture of where it stands. A surface of text is
  shown as its text. "Nothing a user sees" where that is so. At most ten
  pictures and about 1,500 words across the document.
- **Proved by.** What a user would notice if it were built wrong.
- **Not in this part.** The nearest thing someone would expect and does not get.

## What is Martin's

Put under Decided every choice he could have made otherwise, one plain line each.
Where you gave one of his words a meaning, show the meaning as a picture or as a
line there. Where you are unsure, say what you propose and that you are unsure.
Before it is ready, read every part for a step that waits on him (a look, an acceptance, a trial, a word) and settle it: decide it now, make it measurable, or move his act before ready or after the end.
When Martin says it is ready, the desk sets it ready with `mc programs state <programme> ready`; he never runs the verb himself.

English, whole sentences, the plain word, each thing said once.
