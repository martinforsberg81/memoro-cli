# The programme document — `~/mc/programs/<programme>/README.md`

The complete document of a programme with a record, except an area repair
([repair page](repair-page.md)). `mc programs create` fills in the name, End,
horizon and purpose in the first fenced block below. Start a draft from the
signed document `mc programs model` names: copy its headings and part form,
never its content. [Designing a programme](../designing-a-programme.md) owns
the design procedure. A programme without a record has [the older page](programme-readme.md).

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

<What was read, at which revision, with files and lines; what the writer
opened itself and what is a reader's report.>

## Parts

### Part 1 — <name>

Closes: <The gap or gaps.>

Solution: <What changes where: files/functions, data and states, commands,
output, refusals/exit codes, budgets, migration, and what is reused.>

Design: <For everything a user sees, pictures and the components, tokens and
assets used; otherwise “nothing a user sees”.>

Proved by: <Each test's fault and its existing test file; say a new test area
outright, since it requires a planning decision.>

Not in this part: <The nearest thing a builder might add.>

## Order

<Steps, prerequisites and shared files.>

## Decided by signing

<Every choice this document makes that Martin could have made otherwise,
one line each.>

## Not built

<What this programme excludes.>

## Read before sign-off

<What the writer read and did not read, and the programme review's verdict.>

## Where things are

<Pointers to technical standards, repositories, documents and evidence.>

## Decisions

<After sign-off, sessions record programme decisions here. Cross-programme
rules belong in docs/technical/; point there instead of repeating them.>
```

The eleven required entries are title/scope/Repositories followed by What it
is for, End, Why, What runs today, Parts, Order, Decided by signing, Not built,
Read before sign-off and Where things are, in that order, all nonempty.
Repeat `### Part n — <name>` for each piece of work. Each part has five ordered
label-start entries: Closes, Solution, Design, Proved by, Not in this part.
Their first lines begin with those labels; what follows a label on the line
is free, and its content may continue as paragraphs or lists. Code checks
structure, not prose quality: the independent reading and Martin judge what
it says. Solutions are detailed enough that a builder chooses nothing.

`## Decisions` is optional and belongs to the working README after sign-off,
not the held signed copy. When a goal lands, its functionality goes to
`docs/technical/` and its section leaves README; `SIGNED.md` remains the held
source for build and review. Changing signed scope requires return, a current
reading and a new sign-off, not an edit to the signed copy.
