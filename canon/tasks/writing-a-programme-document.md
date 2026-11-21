---
name: writing-a-programme-document
description: Writing a programme document in mc — what the user gets and how one sees that it works. Use before drafting or changing a programme README.
---
# Writing a programme document

A programme document is an order, as a buyer of software hands it to the firm that builds it. Write it with Martin, the buyer; once it is ready code cuts one goal per part, and each part is built as it is written.

## From proposals to an order

A user suggestion is evidence of a problem or a need. A selection of suggestions, even when grouped into numbered candidate parts, is a planning draft. Keep it in `draft` and name the decisions and evidence still needed. A request to collect suggestions authorizes preparing that draft.

Work through each part's product design with Martin in the conversation. Establish what the person is trying to do, check the report against the running app, related work and the binding standards, then present one concrete design at a time with what the person will see and do. Include the cases and constraints that can change the design: existing workflows and controls, which item or session owns the work, phone and desktop behaviour, loading and failure, accessibility, and what is stored or shared. Show the appearance or write out the behaviour as appropriate. A reporter's proposed fix is input to the design.

Record Martin's existing decisions for each part. Bring him a concrete proposal for each decision still open about the user experience, and mark it as pending in the draft.
The desk resolves technical choices using [asking-martin](asking-martin.md).

## What the order settles

An order is built to its end without him (Martin, 2026-11-17). Between ready and done nothing waits for him: no picture to accept, nothing to look at, listen to or try, no reading to approve. Every choice of his is made in the document before it is ready; the build is judged against the document and measured (`mc shot`, the checks), never by his use. An act of his the work needs (money, a console, a legal commitment) is done before ready or after the end, as an act of its own.

No verification by Martin, on a Mac or on a device is written in an order (Martin, 2026-11-21): no Proved by line, no "after the order" check, no trial of his. Where the work needs such verification, it stands as information under the horizon the order serves, in its `basis.md`, and the order holds at most one sentence saying so.

An order is temporary: archived when its work has landed and not read again. What must last is written where it lasts before then: what runs in `docs/technical/`, aims and decisions on the area page, findings as proposals in their area ([proposals](proposals.md)).

Keep the findings for the chosen technical solution in the programme's evidence or an area proposal the part names (Martin, 2026-11-18). The builder settles routine construction within that solution. Include the technical details the order depends on and keep the document short enough to read in full.

## The document

- Open with what a user can do or see afterwards that they cannot today.
- One thing to say yes or no to. If Martin could want half, it is two programmes.
- Three to eight parts, cut by user outcome, not layer. Each can land alone and keeps its number. Each waits for the part before it unless it holds the line `In parallel with the previous part.`
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
  Name and show an unchanged component in place. Show text as text. Say "Nothing a user sees" where true. At most ten pictures across the document.
- **Proved by.** What would fail if the user outcome were wrong and how to check it. Name the workspace, prerequisites and usable data or fixtures.
  Verify the setup that can be checked now. The build exercises the finished behaviour.
- **Not in this part.** The nearest thing someone would expect and does not get.

## What is Martin's

Under Decided, give each choice Martin could have made otherwise one line and attribute it to him or the desk. Show any interpretation of his words as an image or text there. Mark uncertainty and state the proposal.
Before offering readiness, give every part an agreed outcome and design, a chosen solution supported by completed investigations, and the acceptance procedure above. This includes behaviour-only changes and repairs.
Read every part for a step that waits on him. Settle it now, make it measurable or move his act before ready or after done; verification by him, on a Mac or on a device leaves the order for the horizon's basis. Review the current text once with `mc programs review <programme>` (Martin, 2026-11-18) and settle its findings; run it again only when a changed part needs fresh feedback, never until a reading comes back clean (Martin, 2026-11-21).
When Martin says the order is ready, the desk runs `mc programs state <programme> ready`.

English, whole sentences, the plain word, each thing said once.
