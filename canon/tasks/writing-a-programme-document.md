---
name: writing-a-programme-document
description: Writing a programme document in mc — the order Martin signs and the build delivers. Use before drafting or changing a programme README.
---
# Writing a programme document

A programme document is an order, as a buyer of software hands it to the firm
that builds it. Martin is the buyer: he goes through it with the desk and
signs it, and what it says is what is delivered. It binds what the user gets,
how it looks and how one sees that it works. How it is built is the planner's
and the builder's to settle, so leave technical detail out unless the thing
ordered rests on it. Keep it short enough that he reads all of it.

## Before the order

What must be known before the order can be signed is found out first, as a
stage of its own. A part a user sees needs a design: until it has one, its
Design entry reads `Design: wanted` and names the states. Proposals are then
made and Martin picks; the document cannot be signed while one is wanted.
Where the order depends on a fact, find the fact first.

## The whole

Run `mc programs model` and read that document first: copy its form and its
level, never its content. The headings are in
[the programme document](references/programme-document.md).

- Open with what a user can do or see afterwards that they cannot today.
- One coherent thing to say yes or no to. If Martin could want half of it,
  it is two programmes.
- A part is something that is built, cut by what a user gets and not by
  layer. It can land by itself, and it keeps its number.
- What Martin or the desk does beside the build stands under Order.
- Three to eight parts.

## A part

- **Closes.** What is wrong or missing today, as the user meets it.
- **Solution.** What happens, from the user's first step to the last, and
  every case that is not the plain one: nothing to show, too much, a failure,
  a second visit, the phone. Then only the construction the order rests on:
  what must be reused, what must not change, a limit that binds.
- **Design.** Everything a user sees, shown as it will be seen and never
  described: pictures of the app for a graphical surface, the text itself
  for a surface of text, one for each state, width and theme. "Nothing a
  user sees" where that is so. What is not shown is not designed.
- **Proved by.** What a user would notice if it were built wrong.
- **Not in this part.** The nearest thing someone would expect and does not
  get.

## What is Martin's

Put under Decided by signing every choice he could have made otherwise, one
plain line each. Where you gave one of his words a meaning ("polished"),
show the meaning as a design or as a line there. Where you are unsure, say
what you propose and that you are unsure. The writer calls no reading; the
desk does, when Martin has taken the document up.

English, whole sentences, the plain word, each thing said once.
