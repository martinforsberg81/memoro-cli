# The programme document — `~/mc/programs/<programme>/README.md`

The complete document of a programme with a record, except an area repair
([repair page](repair-page.md)). `mc programs create` fills in the name, End,
horizon and purpose in the first fenced block below. A programme is written with
Martin in a session, he sets it ready there, and the planner cuts goals from its
README. [Designing a programme](../designing-a-programme.md) owns the design
procedure. A programme without a record has [the older page](programme-readme.md).

```markdown
# <programme> — <one line on what this programme delivers>

<One paragraph on what the programme changes and does not change.>

Repositories: <repositories this programme changes>.

## What it is for

<Horizon slug and the numbered gaps of its basis this programme closes.>

## End

<When the programme is done, as its record says it.>

## Why

<Martin's words and decisions this rests on, quoted with dates.>

## What runs today

<What runs today as the user meets it. Cite the app, standards and source at
the revision read. Attribute any finding drawn from a reader's report.>

## Parts

### Part 1 — <name>

Closes: <The gap or gaps.>

Solution: <What the user does and what happens, including relevant existing
and exceptional cases. Name the chosen approach and the constraints the order
depends on, such as required reuse, binding limits or migration behaviour.>

Design: <For everything a user sees, pictures and the components, tokens and
assets used; for text in a terminal, each line written out as it will appear;
otherwise “nothing a user sees”.>

Proved by: <What would fail if the behaviour were wrong and how to check it.
Name the workspace, prerequisites and usable data or fixtures. For tests,
name the fault and existing test file. State any new test area explicitly
for a planning decision.>

Not in this part: <The nearest thing a builder might add.>

## Order

<Steps, prerequisites and shared files. No step of Martin's: the order is
built to its end without him.>

## Decided

<Every choice this document makes that Martin could have made otherwise,
one line each.>

## Not built

<What this programme excludes.>

## Read

<What the writer read and did not read, and what an advisory reading found.>

## Where things are

<Pointers to technical standards, repositories, documents and evidence.>

## Decisions

<Once the programme is ready, sessions record programme decisions here. Cross-programme
rules belong in docs/technical/ and lasting direction on the area page; point there
instead of repeating them. Nothing here outlives the programme.>
```

Repeat `### Part n — <name>` for each piece of work: the planner cuts one or
more goals per part, each naming its part. Code checks none of these headings;
Martin judges what the document says. The document binds what the user gets,
how it looks and how one sees that it works; the construction is the planner's
and the builder's ([writing a programme document](../writing-a-programme-document.md)).

Each thing Martin decides is shown, as one picture or as its text; an order
has at most ten pictures, in the light theme. A state a Solution mentions (a
refusal, an error, a wait, a notice, an empty result) is said in Design as a
rule in words that names the app's existing component it follows, or as its
literal text; it is not pictured. A terminal line is written out whole in
the established form, `mc: <what is wrong> — <the call that works>`, with its
exit code. Where an existing line is used again, quote it and say it is reused;
where a change makes an existing line fire for a new cause or read wrong, say
whether it stays, is reworded (show the new text) or goes. A Solution that says
"refused", "says so" or "a line" without the line is not finished. Before the
document comes to the desk, the writer goes through every Solution sentence that
changes what a user sees and checks that Design shows or says it.

The desk resolves the findings of the advisory reading before offering the
whole order for readiness. A finding that changes an agreed outcome or design
is worked through with Martin. The build runs from ready to done on the order
and its checks ([writing a programme document](../writing-a-programme-document.md)).

`## Decisions` is optional and belongs to the working README.
When a goal lands, its functionality goes to `docs/technical/` and its section
leaves README.
