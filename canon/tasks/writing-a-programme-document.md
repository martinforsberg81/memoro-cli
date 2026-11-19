---
name: writing-a-programme-document
description: Writing a programme document in mc — what the user gets and how one sees that it works. Use before drafting or changing a programme README.
---
# Writing a programme document

A programme document is an order, as a buyer of software hands it to the firm that builds it. Write it with Martin, the buyer; the planner cuts goals from its README once it is ready.

## From proposals to an order

A user suggestion is evidence of a problem or a need. A selection of suggestions, even when grouped into numbered candidate parts, is a planning draft. Keep it in `draft` and name the decisions and evidence still needed. A request to collect suggestions authorizes preparing that draft.

The desk prepares each candidate and works through its product design with Martin in the conversation. Establish what the person is trying to do, check the report against the running app, related work and the binding standards, then present one concrete design at a time with what the person will see and do. Include the cases and constraints that can change the design: existing workflows and controls, which item or session owns the work, phone and desktop behaviour, loading and failure, accessibility, and what is stored or shared. Show the appearance or write out the behaviour, as appropriate. Record the result of the conversation for each part. A reporter's proposed button, workflow or fix is input to that design.

Complete planning and design for **every** part before bringing the order to Martin to set ready. Each part needs a settled user outcome and design, a chosen technical solution with its supporting investigations complete, and a checkable acceptance procedure. This includes behaviour-only changes and repairs. Goal cutting and build start from the ready order. They carry out the design agreed at the desk.

## What the order settles

An order is built to its end without him (Martin, 2026-11-17). Between ready and done nothing waits for him: no picture to accept, nothing to look at, listen to or try, no reading to approve. Every choice of his is made in the document before it is ready; the build is judged against the document and measured (`mc shot`, the checks), never by his use. An act of his the work needs (money, a console, a legal commitment) is done before ready or after the end, as an act of its own.

An order is temporary: archived when its work has landed and not read again. What must last is written where it lasts before then: what runs in `docs/technical/`, aims and decisions on the area page, findings as proposals in their area ([proposals](proposals.md)).

Keep the findings for the chosen technical solution in the programme's evidence or an area proposal the part names (Martin, 2026-11-18). The planner and builder settle routine construction within that solution. Include the technical details the order depends on and keep the document short enough to read in full.

## The document

- Open with what a user can do or see afterwards that they cannot today.
- One thing to say yes or no to. If Martin could want half, it is two programmes.
- Three to eight parts, cut by user outcome, not layer. Each can land alone and keeps its number.
- Order says the sequence of the parts and what the desk does beside the build; it holds no step of Martin's.
- Aim for 1,500 words, but never cut a user case to fit (Martin, 2026-11-18).
  Cut unnecessary construction first; split into programmes if that makes the choices clearer.
  Describe what runs today as users meet it, from the app and standards; read code only for facts the order needs.

## A part

- **Closes.** What is wrong or missing today, as the user meets it.
- **Solution.** The user's steps and every exception: empty, too much, failure, return visit, phone.
  Include only the construction the order relies on: required reuse, unchanged behaviour and binding limits.
- **Design.** What the user gets and how one sees that it works.
  Show the new thing at one width in light theme, one picture per choice Martin makes.
  Add a phone picture only for a distinct choice. Do not picture dark: it follows memoro's `docs/technical/design-tokens.md`.
  Describe failed, empty, working, cut and return states in words, naming the app component they follow.
  For an unchanged component, name it and show one picture of where it stands.
  Show text as text. Say "Nothing a user sees" where true. At most ten pictures across the document.
- **Proved by.** What a user would notice if it were built wrong.
- **Not in this part.** The nearest thing someone would expect and does not get.

## What is Martin's

Put under Decided every choice he could have made otherwise, one plain line each.
Where you gave one of his words a meaning, show the meaning as a picture or as a
line there. Where you are unsure, say what you propose and that you are unsure.
Before it is ready, read every part for a step that waits on him (a look, an acceptance, a trial, a word) and settle it: decide it now, make it measurable, or move his act before ready or after the end.
Before it is brought to him it has had a programme review of the text as it stands (`mc programs review <programme>`; Martin, 2026-11-18), its findings settled. When Martin says it is ready, the desk sets it ready with `mc programs state <programme> ready`; he never runs the verb himself.

English, whole sentences, the plain word, each thing said once.
