# The page of a programme with a record — `~/mc/programs/<programme>/README.md`

The shape of the README of a programme that has a record (`PROGRAMME.json`,
made by `mc programs create`): a bounded piece of work that serves a horizon
and ends, or a repair: a set of small adjustments of one area, from which the runner cuts its goals. `mc programs create` writes this page with the name, the end and the
horizon filled in; the desk fills in the rest and keeps it
([designing a programme](../designing-a-programme.md)). It has no Aim, Measures
or Gap: the enduring aim belongs to the area pages, and the programme points to
them. A programme without a record has [the other page](programme-readme.md).

```markdown
# <programme> — <one line on what this programme delivers>

<One paragraph on what this programme covers and does not cover.>

## What it is for

<The horizon this programme serves and the part it delivers, or, for a repair, the small adjustments of the area it orders.>

## End

<When the programme is done, as the record says it. It is done when its goals
are done and what is now true is written back to `docs/technical/`; the runner archives it after its write-back reads OK and its other safety checks pass.>

## Decisions

<What is decided for this programme, each with who decided it and when. A
decision that reaches beyond the programme goes to `docs/technical/`; the page
records where it went, not the decision again.>

## Phases

<One line per phase that has goals: which part of the programme the phase
delivers and why it comes before the next. The goals themselves are in `mc goal
list <programme>`; they are not repeated here.>

1. <purpose of phase 1>
2. <purpose of phase 2>

## Where things are

<Pointers: the `docs/technical/` standards this work rests on, evidence
directories, the repositories and the documents that hold the detail. Pointers
only: the detail stays where it is.>
```

When a goal lands, its functionality is described in `docs/technical/` and its
section leaves this page.
