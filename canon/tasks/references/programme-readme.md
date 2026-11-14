# The programme page — `~/mc/programs/<programme>/README.md`

The shape of a programme's README. Every section is short; the detail stays
where it is and the page points at it. Written and kept by the plan session
([designing a programme](../designing-a-programme.md)).

```markdown
# <programme> — <the aim in one line>

<One paragraph on what this programme covers and does not cover.>

## Aim

<What the area is for its user when it is as good as it can be. State the
user's enduring direction in terms of what they can do and rely on, not a list
of work. This aim has no end: the programme is not finished when its goals
are. It changes only with Martin.>

## Measures

<Three to five observable or countable signs that the area is closer to the
aim. Give each sign today's reading and its date. Where no reading exists yet,
say so and what would give one.>

## Gap

<Date. What stands between today and the aim, largest first, each gap in a
sentence or two. Rewrite this section, do not append to it, whenever a goal
lands and at the end of every plan session. What landed belongs in `mc goal
list` and `docs/technical/`, not here.>

## Next horizon

<The next reachable state, in terms of what the user can do then and which
gaps it closes. When it is reached, write the next one. A programme with no
open goal is waiting for its next horizon, not finished.>

## Phases

<One line per phase that has goals: which part of the next horizon the phase
serves and why it comes before the next. The goals themselves are in `mc goal
list <programme>`; they are not repeated here.>

1. <purpose of phase 1>
2. <purpose of phase 2>

## Martin's

<Only what is specific to this programme and only Martin decides. What is
Martin's in every programme is in the roles and tasks, not here. Leave the
section out when there is nothing.>

## Where things are

<Pointers: the `docs/technical/` standards this work rests on, evidence
directories, the repositories and the documents that hold the detail. Pointers
only: the detail stays where it is.>
```

A decision settled with Martin is written on this page, or in the goal it
governs, and dated. When it reaches other programmes it goes to
`docs/technical/`; the page records where it went, not the decision again.
When a goal lands, its functionality is described in `docs/technical/`, and
its section leaves this page.
