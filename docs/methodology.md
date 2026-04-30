# How js2wasm is Built

> An honest, technical account of building a production TypeScript-to-WebAssembly compiler with a coordinated team of AI agents.

## Status

This document is current as of the start of sprint 46 (2026-04-30).
At that point the project has accumulated:

- **45 completed sprints** (current is sprint 46)
- **95 merged pull requests** to `main`
- **8,884 commits** in the public repository
- **1,162 issue files** under `plan/issues/sprints/`, plus a backlog and a `wont-fix/` archive
- **825 test files** under `tests/` (302 issue-scoped, 178 equivalence-suite, plus other)
- **26,004 / 43,168 test262 passes** (60.2% of the official suite, full ECMAScript spec conformance)
- **12 Architecture Decision Records** under `docs/adr/`

These numbers move every day. They are recorded here so the rest of the
document can reference "the methodology produced this much output" without
asking you to take it on faith. The dashboard at the project URL
(see the repository README) shows the live versions.

---

## Section 1 — Motivation

### Why build a compiler this way?

Compilers are a useful proving ground for AI-assisted development for three
reasons. First, they have rich, well-defined domain knowledge: the
ECMAScript specification, the Wasm specification, dozens of textbook
compiler-construction techniques. Second, they have hard correctness
constraints: a compiler that miscompiles `1 + 1` is worthless, and the
test262 conformance suite measures correctness at the granularity of
individual ECMA-262 algorithm steps. Third, the output is measurable:
binary size, runtime performance, conformance pass rate. There is little
room for hand-waving. Either the compiled program runs correctly or it does
not.

A compiler is also large enough that no one person holds the entire surface
in their head at once. The project lead (Thomas Tränkler, founder of
Loopdive GmbH) is an experienced engineer but not a single-headed expert
on every subsystem — the same as on any non-trivial codebase. The question
is whether a team of AI agents, with a human directing strategy, can
produce work whose correctness, code quality, and architectural coherence
hold up to outside scrutiny.

### The leverage point

When the project lead is human and the implementation team is AI, the
human time becomes the binding resource. A skilled engineer working
full-time on a complex compiler might land 1–2 substantive issues per
day. With a coordinated team of up to eight agents, the same person can
direct work that produces 5–25 merged PRs per sprint week, depending on
issue size and architectural difficulty. The bottleneck shifts from
keystrokes to direction: deciding what to build next, evaluating proposed
designs, and making the architectural calls that the agents do not make
on their own.

This is not a free lunch. The agents need clear specifications, the human
needs to triage messages and review work, and the project still needs the
discipline of any open-source codebase: tests, CI, ADRs, retrospectives.
The methodology described here is the set of practices that have evolved
to make those constraints work in practice rather than just on paper.

### The openness angle

The methodology itself is committed to the repository. The `.claude/`
directory contains the agent definitions (`developer.md`,
`product-owner.md`, `tech-lead.md`, etc.). The `plan/` directory contains
sprint plans, issue files, retrospectives, and dependency graphs. The
`docs/adr/` directory contains the architecture decision records. There
is no separate, private process — what you read in the repository is how
the project actually runs.

This makes the methodology auditable. Anyone can look at a merged PR and
trace it back to: the issue file that specified it, the sprint plan that
prioritized it, the agent that implemented it, the CI run that gated it,
the retrospective that learned from it. That traceability is the point.
A black-box "AI built this" claim is not credible. A glass-box "AI built
this and here is every artifact along the way" is.

---

## Section 2 — Pipeline architecture

### The compilation path

js2wasm compiles TypeScript and JavaScript source code directly to
WebAssembly GC binaries. The pipeline runs entirely Ahead-of-Time — the
output is a `.wasm` module that contains no embedded JavaScript engine
and no bundled interpreter. There are three principal stages:

1. **Front end.** TypeScript source → AST via the official TypeScript
   compiler (used as a parser library only; no type erasure or
   transpilation). Type information is preserved and available to the
   downstream stages.
2. **Lowering / IR.** AST → an internal Intermediate Representation that
   is typed, SSA-like, and close to Wasm semantics but still
   human-readable. The IR is processed by the IR Phase 4 lowering pipeline
   (see ADR-0012) which handles control flow, closures, exceptions, and
   the various runtime patterns. Slices 1–10 of the IR cover everything
   from arithmetic through generators, destructuring, try/catch, and
   the JavaScript built-ins (Promise, Map, Set, TypedArray, etc.).
3. **Codegen.** IR → a Binaryen module → emitted Wasm bytes. The codegen
   stage uses Binaryen as an emission and optimization library, but does
   not delegate semantic decisions to it: every op the compiler emits is
   chosen by js2wasm code, not by Binaryen's optimizer.

### The dual-mode architecture

js2wasm targets two distinct deployment shapes from the same source code.
**JS-host mode** assumes a JavaScript runtime is available (Node.js, the
browser, Bun) and uses a small set of host imports (`__box_number`,
`__str_concat`, etc.) to delegate the parts of the JavaScript semantics
that are wasteful to reimplement in Wasm — primarily string ropes and
Number boxing. **Standalone mode** (used by the `--target wasi` flag)
emits the entire runtime in pure Wasm, producing a binary that runs
without any JavaScript runtime: `wasmtime my-program.wasm` works.

The dual-mode split is documented in ADR-0008 (dual string backend) and
ADR-0010 (eval host import). The principle is: every feature that exists
must work in both modes, and the JS-host fast path is an optimization,
not a dependency. This keeps js2wasm honest: its claims of "no embedded
JS engine" hold up because the standalone-mode binaries actually run
without one.

### How the IR was incrementally introduced

The IR did not exist on day one. The compiler began as a direct
AST-to-Wasm walker, which works for a small subset of JavaScript but
gets fragile fast as features compound. The IR was introduced as a
ten-slice migration — labelled internally as "Phase 4" — which lowers
specific feature families through the IR while leaving the rest on the
legacy walker. Each slice has its own issue (`#1169a` through `#1169m`)
with its own equivalence-test harness asserting byte-identical Wasm
output between IR and legacy paths during the cutover. This pattern made
it possible to introduce a non-trivial architectural change without ever
having a "the compiler is broken for two weeks" period — every slice
shipped its own PR, with both legacy and IR paths working in parallel
until the legacy walker was retired.

This incremental migration pattern is one of the strongest examples of
the methodology working: a major architectural change happened over the
course of seven or eight sprints, with no big-bang week, no
"compiler-down" period, and no architecture-PR larger than ~2,000 lines.
Every slice was a discrete, reviewable, mergeable unit.

---

## Section 3 — Agent team structure

### Roles

The team is fixed in composition and documented in
`plan/method/team-setup.md` (the source of truth — this section is a
synthesis):

- **Project Lead (human).** One person. Owns architecture, vision, and
  prioritization. Challenges agent assumptions. Does not write
  production code in normal operation; can intervene at any time.
- **Tech Lead (orchestrator).** A long-running Claude Code session
  acting on behalf of the human. Owns the sprint TaskList, dispatches
  work, merges to main, runs test262, and handles escalations. The tech
  lead has elevated permissions: it can commit to `main` directly when
  needed (planning artifacts, sprint stats), whereas every other agent
  must go through a PR.
- **Product Owner.** A teammate agent, spawned on demand at sprint
  boundaries. Owns the backlog, validates issues against current main
  (closes already-fixed ones), prioritizes by value, and writes new
  issues. Only writes to `plan/`.
- **Architect.** A teammate agent, spawned for hard issues. Reads the
  compiler source and writes implementation specs into the issue file —
  exact functions, line numbers, Wasm patterns, and edge cases. The
  architect does not write code; it writes the plan that a developer
  implements.
- **Developer (×8).** Teammate agents in worktree isolation. Each
  developer claims a task from the TaskList, reads the issue file
  (including the architect's spec if present), implements the fix in
  its worktree, opens a PR, waits for CI, and self-merges if green.
- **Senior Developer.** A specialist developer for hard or
  architectural issues. Used when an issue is marked
  `feasibility: hard` or `reasoning_effort: max`. Same workflow as a
  regular developer; deeper reasoning per task.
- **Scrum Master.** A teammate agent spawned at end-of-sprint. Reviews
  what shipped, identifies process problems, and proposes changes to
  the checklists in `plan/method/`.

### Communication protocol

The team communicates through three channels, each with a strict scope:

- **TaskList** is the work queue. Tech lead populates it from issue
  files; developers self-claim tasks (lowest ID first), update status
  on completion. There is no per-task dispatch message — the queue is
  authoritative.
- **SendMessage** is for blockers, decisions, and merge escalations.
  Developers contact the tech lead only when something cannot be
  resolved by the standard workflow. Status updates do not go through
  SendMessage; they go through TaskUpdate.
- **Issue files** are the persistent contract. They contain the problem
  statement, the implementation spec (if architect-generated), the
  acceptance criteria, and (after merge) the implementation summary.
  An agent that picks up an issue should be able to do its job from the
  file alone, without backlog-scrolling or asking the tech lead what
  the goal was.

### Worktree isolation

Every writing agent works in its own git worktree under
`/workspace/.claude/worktrees/<branch>/`. The worktree is a real
checkout on a real branch — not a sandbox or container — but it is
physically separate from `/workspace`, so two agents working on
different issues cannot corrupt each other's working tree even if they
edit the same file. A `check-cwd.sh` git hook enforces that
`git commit`/`merge`/`push` from `/workspace` is blocked for non-tech-lead
agents; this catches accidental writes before they reach main.

The rule is: each PR comes from one worktree; each worktree corresponds
to one branch; and worktree cleanup happens after the PR merges (or the
work is suspended). The `.claude/worktrees/` directory is the visual
representation of "what is currently in flight" — `git worktree list`
shows it directly.

### Issue file as the contract

The issue file is the most important artifact in the methodology. It
contains:

- A YAML front-matter (`status`, `priority`, `feasibility`,
  `reasoning_effort`, `goal`, `depends_on`, etc.).
- A problem statement and context (written by the PO).
- An implementation plan (written by the architect for hard issues, or
  inline by the dev for easy ones).
- Acceptance criteria (written by the PO; the dev's job is to satisfy
  them; the PO accepts or rejects after merge).
- An implementation summary (written by the dev after merge,
  documenting what actually shipped vs. what was planned).

The reason this works: when the next sprint starts, the methodology
does not depend on any agent retaining cross-session memory. It depends
on issue files being precise enough that a fresh agent can pick up
where the last one left off. This is the same property that makes
human-team handoffs work — written contracts beat tribal knowledge.

---

## Section 4 — Correctness anchors

A compiler that says "trust me" is a compiler nobody trusts. The
methodology depends on multiple, independent correctness anchors that
make it hard for a regression to slip through.

### test262

The Ecma TC39 test262 conformance suite is the canonical correctness
anchor. As of this writing, js2wasm passes 26,004 of 43,168 official
test262 tests (60.2%). The `tests/test262.test.ts` runner shards the
suite across CI workers, generates per-test JSONL results, and
post-processes them into `public/benchmarks/results/test262-report.json`.
The dashboard surfaces this with categorical breakdown (per
`built-ins/Object`, `built-ins/Promise`, `language/statements`, etc.)
so a reader can see which feature areas are mature and which are gaps —
not just an aggregate percentage.

Every PR is gated against the previous main's test262 results. The
self-merge criteria require: net pass count ≥ 0 (no regressions on
average), regression-to-improvement ratio < 10%, no single bucket with
more than 50 regressions. These thresholds are not arbitrary — they
were tuned over the first 30 sprints by observing CI noise and finding
the level at which signal beat noise reliably.

### Equivalence test suite

`tests/equivalence/` contains 178 hand-written tests, each comparing a
specific JavaScript program's output between V8 and js2wasm. These
tests are smaller and more targeted than test262 — they exercise
specific compiler paths (closures, generators, destructuring,
prototype chains, etc.) where a bug would cause a particular kind of
miscompilation. They are the daily-development safety net: a developer
working on a closure-related issue will run the closure equivalence
tests locally for fast feedback, and CI runs all of them on every PR.

### Issue-scoped tests

`tests/issue-*.test.ts` (302 files) is the issue-scoped test suite.
Each merged issue ships with a regression test named after its issue
number, asserting that the specific bug the issue described stays
fixed. Over the lifetime of the project this has become the strongest
single defense against regressions: any future change that breaks an
old fix triggers the corresponding `issue-NNN.test.ts` and surfaces in
PR CI.

### Differential testing (planned)

Issue #1203 (in flight in sprint 46) adds a differential testing
harness that runs randomized programs against both V8 and js2wasm and
flags divergent outputs. This will catch the class of bugs that
test262 misses: programs the spec doesn't directly exercise but that
real code might write. The harness runs nightly in CI and produces a
report of any divergences found.

### CI baseline drift detection

A subtle but important anchor: the test262 baseline that PR regressions
are measured against is **fetched fresh from the
`loopdive/js2wasm-baselines` repository** every CI run, not read from
the PR's branch. This prevents an attacker (or a careless commit) from
silently rewriting the baseline to mask regressions. The committed
baseline in the main repo is used only for local dev tooling; the
authoritative number lives in a separate, read-only-by-default
repository.

The combination of these anchors is what gives the methodology its
correctness teeth. Any one of them can be circumvented; all four
together cannot. A regression that escapes test262, equivalence tests,
the issue-scoped suite, and differential testing all at once would have
to be a genuinely novel bug class — at which point the response is to
write a new test for it and add it to the suite. The methodology is
designed to learn from every failure.

---

## Section 5 — Decision boundaries

A working AI-assisted methodology requires a clear answer to the
question: who decides what?

### Agents decide

- **Implementation approach within a spec'd issue.** If the issue says
  "fix the off-by-one in `compileForOf`," the developer chooses how
  to fix it: which lines to change, how to structure the patch, what
  helper functions to extract. The architect's spec, when present,
  narrows the choices but does not eliminate them.
- **Test structure.** Each issue gets a `tests/issue-NNN.test.ts`
  file; the developer writes its contents. The naming convention is
  fixed; the test cases are not.
- **Code organisation within the worktree.** Helper functions, file
  splits, refactor-while-fixing — all developer judgment, within the
  scope of the issue.
- **CI escalation thresholds in normal operation.** A developer can
  self-merge a PR if it meets the criteria; it doesn't need a human
  approval for a normal green-CI PR.

### Human decides

- **Sprint priorities.** Which goals get worked on next sprint, which
  get deferred. The PO drafts; the human approves.
- **Architecture changes.** Anything that would require a new ADR or
  modify an existing one. The architect proposes; the human decides
  whether to adopt the change.
- **Merge conflicts in `src/**`.** Any conflict in compiler source
  during a `merge origin/main into branch` is escalated by the agent
  to the senior-developer (Opus) for resolution; the human reviews
  the resolution if it is non-mechanical.
- **Changes to `.github/workflows/`, `.claude/`, or `plan/method/`.**
  These are infrastructure changes — a buggy workflow can break every
  PR, a buggy agent definition can break every developer. Agents do
  edit these in PR'd worktrees, but the human signs off on the merge
  (this is enforced by ratio thresholds and bucket sizes that flag
  anything unusual for escalation).
- **Override merges.** When the regression gate flags drift on a PR
  that is mathematically incapable of affecting the gated metric (a
  YAML-only change, a doc-only PR), the override is approved by the
  human via SendMessage. The agent does not self-override.

### Safety model

The decision boundary is enforced by three mechanisms:

1. **Branch protection.** `main` requires a PR; PRs require CI green
   (with override available); pushes to `main` are restricted to the
   tech lead account.
2. **`check-cwd.sh` and `check-worktree-path.sh` hooks.** Block
   `git commit` from non-worktree paths; block worktree creation
   outside the canonical root. Both are runtime checks that fail
   loudly.
3. **CODEOWNERS (planned).** Sensitive paths get a CODEOWNERS rule
   requiring human review even on green CI. This is the "the agents
   are right 95% of the time, but the remaining 5% should not be in a
   workflow file" check.

The principle is that the agents are deeply trusted within the scope
they have proven they handle well, and explicitly distrusted on
anything novel or impactful. The boundaries are set by the human at
sprint planning time and enforced by mechanical checks — not by hoping
the agents respect them.

---

## Section 6 — Failure modes

The honest answer to "does this methodology work?" includes a list of
the ways it has gone wrong.

### Agent inbox failures

In sprint 45, all three active developer agents lost their SendMessage
inbox simultaneously due to a coordination-layer bug. The agents
continued working but the tech lead could not signal them, and they
could not signal each other. The recovery: the tech lead wrote
"context summaries" for each developer to `plan/agent-context/<name>.md`
and respawned the agents with the summaries as part of their spawn
prompt. The summaries captured what the previous agent had been
working on, what was committed, and what the next steps were.

After the incident the methodology added an explicit
"`plan/agent-context/<name>.md` handoff" pattern, used routinely now
when an agent reaches its token limit or needs to be respawned. The
inbox-failure mode is rare but real, and the recovery pattern doubles
as a "fresh agent picks up where stale agent left off" handoff.

### Token budget exhaustion

Sprint 44 ran past its token budget — roughly 50% over the planned
spend for the sprint, mostly because a senior-developer task on a hard
codegen issue accumulated context across several days. The lesson:
hard issues need explicit token caps in their issue file, and a senior
developer should `/compact` between sub-tasks rather than carrying full
debugging context across an entire issue.

### Regression crises

Sprint 45 had one revert: PR #76 (`#1177` TDZ closure captures) merged
with apparently-correct targeted tests but caused a 14.7% test262
regression (~1,940 tests) across an unrelated bucket. The revert was
clean; the lesson was that targeted tests are not enough for
TDZ-related changes — the fix interacts with closure capture indices
in ways that cross feature boundaries. The follow-up issue (#1205) was
opened with a much more conservative implementation plan, currently in
flight as of sprint 46.

### Architecture drift

Without active management, agents tend to add helper functions and
intermediate abstractions that solve the immediate problem without
fitting the existing architecture. The countermeasure is the
**refactor-issue pattern**: every 5–8 sprints a "refactor sprint" item
is filed (e.g., #1185 IrLowerResolver refactor) that consolidates
accumulated shortcuts into the proper architecture. ADRs serve a
similar function — when the same design question keeps coming up, an
ADR is written so future agents read the answer instead of inventing
it again.

### Merge conflicts

When two agents touch the same compiler-source function in parallel,
the second agent's `git merge origin/main` produces a conflict in
`src/**`. The protocol (in `plan/method/team-setup.md`) is: the agent
**does not resolve the conflict inline**. Instead, the agent creates
a `[CONFLICT]` priority TaskList item assigned to senior-developer.
The senior reviews both branches' intent, picks the right resolution,
and either re-pushes the agent's branch or asks the agent to re-base
its work on the new state. Mechanical conflict resolution by an agent
that does not understand both sides has caused regressions in the
past; the explicit-escalation rule is the fix.

### Agent produces wrong answer

The most common failure mode is an agent producing a fix that compiles
and passes its targeted tests but is wrong in a way the tests didn't
exercise. CI catches most of these (test262 + equivalence + issue
suite). The remaining ones surface as a follow-up issue ("X regressed
Y") and get fixed by the next sprint. This is acceptable because the
methodology is designed for fast iteration: a wrong answer is a
testable hypothesis, not a disaster.

The cost is not zero — every regression-flag is dev time spent on
investigation rather than new features. The mitigation is the
correctness anchor stack (Section 4); the meta-mitigation is the
retrospective process, which examines wrong answers and adjusts the
checklists or specs to prevent the same class from recurring.

---

## Section 7 — Comparison with traditional development

### Throughput

A focused human compiler engineer might land 1–2 substantive issues
per day on a project of this complexity. The js2wasm methodology has
sustained 5–25 merged PRs per sprint week — accounting for mix of
small fixes, medium features, and occasional refactor sprints. The
upper bound is set not by agent throughput but by the human's
capacity to triage messages, review work, and make
architecture-relevant decisions; sustained 25 PRs/week is rare.

The honest summary: a single human directing a team of agents
produces output equivalent to a small (3–6 person) traditional
engineering team on tasks that are well-suited to the agentic
methodology — incremental fixes, well-specified features,
test-driven work. On open-ended exploratory work
(language design, novel algorithms, performance tuning that
requires deep intuition) the leverage is much smaller, perhaps
1.5×–2× a solo human.

### Quality

Test-driven by construction: every issue ships with at least one
issue-scoped test, and the CI gate prevents regressions across the
broader suites. Code style is enforced by lint and by the
agent-definition checklists (see `.claude/agents/developer.md`).
Documentation density is high because the issue file is part of
the deliverable.

The weakness: architectural coherence. A single-author project
tends to have a stylistic and architectural unity that an
agent-team project does not produce by default. The
mitigation is ADRs, the refactor-issue pattern, and active
human intervention on architecturally significant decisions.
A reader of `src/codegen/` will see places where the
architecture is slightly inconsistent — these are the
seams where the methodology accepted a shortcut to ship the
feature, with a refactor issue filed for later.

### Context limits

Agents do not retain cross-session memory. A developer agent
spawned for sprint 47 has no recollection of sprint 46's
work — it reads the issue files and the recent commit history
and works from there. This is a hard constraint, not a bug.
The methodology accommodates it by making issue files
self-contained: any context an agent needs is either in the
issue, in `CLAUDE.md`, in `plan/method/`, or accessible via
`git log`.

The trade-off vs. a long-tenured human engineer is real: a
human with five years of context on a codebase has intuitions
that no agent will reproduce in a single session. The
methodology's response is to capture those intuitions in
written artifacts — ADRs, sprint retrospectives,
architecture-section docs — so they survive context resets.

### Cost

At current Anthropic API pricing, a typical sprint week
(8 active developers, 1 PO, 1 architect, 1 tech lead, 1
scrum master, with a mix of Opus and Sonnet) runs at a cost
that scales linearly with developer-hours. Precise figures
will be added once the project's token-tracking logs cover a
representative sprint range; current estimates are within
the range a small team's monthly cloud bill would fall in,
not within the range of paying a 3–6 person engineering team.

The cost does not include the human's time — which is the
real binding resource and the one a CFO would be most
interested in. A reasonable framing: the API spend is the
cost of giving the project lead the equivalent of a team's
worth of typing and remembering and patient retest cycles.
Whether that is a good trade depends on the comparable cost
of the same output from a traditional team.

---

## Section 8 — How to contribute

Both human and AI contributors are welcome. The workflows differ in
detail but converge on the same artifacts.

### Human contributors

The standard open-source flow:

1. Clone the repository: `git clone <repo>`.
2. Read one ADR (`docs/adr/`) and one recent sprint retrospective
   (`plan/log/retrospectives/`) — together they convey the
   architectural and process context.
3. Pick an issue from `plan/issues/sprints/<current>/` with
   `status: ready` (or from `plan/issues/backlog/` if you want to
   propose a new direction).
4. Create a branch and a worktree under
   `.claude/worktrees/issue-<N>-<slug>/`.
5. Implement, test, push, open a PR against `main`. CI gates the
   merge. Self-merge if green; escalate if not.

Required tooling: Node.js 22+, pnpm, wasmtime 44+. Recommended:
the official Claude Code CLI if you intend to spawn a developer
agent on your branch.

### AI agent contributors

Spawn a `developer` agent (definition in
`.claude/agents/developer.md`) pointed at a `plan/issues/sprints/<N>/<id>.md`
file. The agent reads the issue, creates a worktree, implements
the spec, opens a PR, and self-merges if CI passes. The TaskList
mechanism (see `plan/method/team-setup.md`) provides the work
queue for a multi-agent team; for a single-agent run the issue
file alone is sufficient.

The agent definitions are idempotent — spawning a developer with
the same issue twice produces two PRs solving the same problem,
which is wasteful but not unsafe. Coordination beyond a single
agent requires the TaskList and SendMessage mechanisms.

### What to read first

- `README.md` — project value proposition.
- One ADR — `docs/adr/0012-intermediate-representation.md` is a
  good entry point because it's the most recent architectural
  decision and references the older ones.
- The most recent sprint retrospective in
  `plan/log/retrospectives/`.
- `plan/method/team-setup.md` — the canonical team configuration
  document. This methodology document synthesizes it for an
  external reader; that one is the authoritative source.
- For agent contributors: `.claude/agents/developer.md` and
  `.claude/skills/dev-self-merge.md`.

---

## Section 9 — Open questions

The methodology is a work in progress. The questions below are open in
the sense that the project lead does not yet have a confident answer.

**Q: Can the methodology scale to projects with more architectural ambiguity?**
js2wasm has the advantage of a well-defined input language (JavaScript),
a well-defined output target (Wasm GC), and an authoritative correctness
oracle (test262). A project without any of those — say, an exploratory
research codebase, a new programming language, or a domain-specific
business application — would be much harder to manage with this
methodology. The agents thrive on tight specifications; loose
specifications produce drift.

**Q: What is the right human:agent ratio for a production codebase?**
js2wasm has run with 1 human + 1–8 agents in flight. Below ~3 agents
the human capacity for direction is underutilized; above 8 the human
becomes a triage bottleneck and queue depth grows. The right number
depends on the human's skill at writing specs and triaging messages —
we have not tried teams of 2 or 3 humans yet, and the coordination
costs there are unknown.

**Q: How do we handle agent disagreement on approach?**
Currently: the human decides. Two agents proposing different fixes for
the same issue would result in one of them being told to stop. We have
not yet seen a case where two agents argue past each other; the
TaskList claim-and-mark-completed pattern prevents most of it
mechanically.

**Q: When is the methodology not appropriate?**
Highly exploratory R&D where the goal is "find an answer" rather than
"implement a known answer." Open-ended user research or design
research. Domains where the agent's training data is sparse (highly
specialized scientific computing, novel hardware platforms). Domains
where the failure modes are not testable (security review of a
crypto library, adversarial testing of an agentic system itself).

**Q: Does the methodology produce code that is auditable by humans?**
We believe so but the evidence is partial. A senior compiler engineer
reading `src/codegen/` will find the code understandable, with
recognizable patterns and consistent style. They will also find
spots where the architecture is rougher than a single-author project
would produce. The honest answer is: human auditability is a
first-class goal, but it depends on continued investment in
refactor sprints and ADRs.

**Q: Is the methodology itself stable, or is it still evolving?**
Still evolving. Concrete examples from the last 10 sprints:
the `/dev-self-merge` skill replaced a dedicated tester agent;
the `[CONFLICT]` escalation pattern replaced inline merge resolution;
the `plan/agent-context/<name>.md` handoff pattern emerged from the
sprint 45 inbox-failure incident. The retrospective process surfaces
new patterns sprint over sprint, and the methodology document is
updated when a pattern stabilizes. Treat this document as the current
snapshot, not the final word.

---

## Closing note

This document exists to be wrong in interesting ways rather than
right in boring ones. If you find an inaccuracy, an overpromise, or
a glossed-over failure mode, the project welcomes the issue or the
PR. The point of an open methodology is that it can be improved by
people outside the team that wrote it.

The work product — the compiler, the tests, the dashboard — is the
primary evidence that the methodology works. The sprint
retrospectives, ADRs, and issue files are the secondary evidence
that the methodology is a methodology and not an accident. Both are
in the repository. Both are reviewable.

— *The js2wasm team*
