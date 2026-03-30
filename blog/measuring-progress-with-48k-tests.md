# How We Track Progress on a Compiler With 48,000 Tests

*Issue anatomy, goal DAGs, error forensics, and the backlog that runs our TypeScript-to-WebAssembly compiler project.*

---

## The problem with "it works"

When you're building a compiler, "it works" is meaningless without a number. A TypeScript-to-WebAssembly compiler might handle `2 + 2` perfectly and crash on every `for...of` loop with destructuring. You need a test suite large enough to surface the patterns you haven't thought of.

We use the [test262 ECMAScript conformance suite](https://github.com/nicolo-ribaudo/tc39-proposal-test262) — 47,797 tests covering every corner of the JavaScript specification. Every `assert.throws(TypeError, ...)`, every `for-of` edge case with generators, every `Object.defineProperty` constraint. It's the closest thing to a ground-truth measurement of "how much of JavaScript does this compiler actually handle?"

Our current score: **18,167 pass (38%)**. That number was **550** when we started. Getting from 550 to 18,167 required closing over 768 issues across dozens of sprint sessions — and a project management approach built specifically for a codebase where every fix can be precisely measured.

## The four buckets

Every test262 test falls into exactly one of four outcome buckets:

| Bucket | Count | What it means |
|--------|------:|---------------|
| **Pass** | 18,167 | Compiled and produced the correct result |
| **Fail** | 21,084 | Compiled but produced the wrong result at runtime |
| **Compile Error (CE)** | 1,966 | Compiler rejected the input or produced invalid Wasm |
| **Skip** | 6,580 | Filtered out — features we've decided not to support (yet) |

These aren't just categories. They're *different kinds of work*:

- **CE** issues are usually compiler bugs — missing AST node handlers, type mismatches in codegen, unsupported syntax patterns. They tend to be surgical fixes. You find the error message, grep for it in the compiler, and add the missing case.
- **Fail** issues are runtime semantics bugs — the compiler produces valid Wasm, but the Wasm does the wrong thing. These are harder. A single "wrong value" might mean incorrect type coercion, a missing prototype chain lookup, or a destructuring pattern that casts to the wrong struct type.
- **Skip** is a deliberate scope decision. We skip `Temporal` (4,376 tests), `SharedArrayBuffer` (460), dynamic `import()` (432), and a handful of other features. Each skip filter has a corresponding issue tracking whether and when we'll support it.

The distinction between CE and Fail matters for prioritization. A CE fix often unblocks hundreds of tests that previously couldn't compile at all — some of those will pass, others will become Fails that reveal new runtime bugs. A Fail fix directly increases the pass count but doesn't unblock anything new.

## Anatomy of an issue

Every issue lives in `plan/issues/` as a markdown file with YAML frontmatter. Here's a real one (#852):

```yaml
---
id: 852
title: "Destructuring parameters cause null_deref and illegal_cast (1,525 tests)"
status: ready
priority: critical
test262_fail: 1525
feasibility: hard
depends_on: []
goal: core-semantics
---
```

The body contains:

1. **The problem** — what's failing, with exact test262 error messages
2. **Breakdown** — how many tests per sub-pattern (arrow functions vs. generators vs. for-of bindings)
3. **Sample files** — 3-5 actual test262 files with the exact line, the expected behavior, and the root cause
4. **Implementation hints** — what codegen function is responsible, what the fix likely involves

The key fields:

- **`test262_fail` / `test262_ce`**: The number of tests this issue affects. This is how we prioritize — it's not a vague "high/medium/low", it's a measured count.
- **`depends_on`**: Which issues must be completed before this one is unblocked.
- **`goal`**: Which goal in the goal DAG this issue belongs to.
- **`feasibility`**: How hard the fix is — `easy` (pattern match, <50 lines), `medium` (<150 lines), `hard` (>150 lines or architectural change).
- **`status`**: One of `backlog`, `ready`, `in-progress`, `review`, `suspended`, `done`.

Issues move through directories as their status changes: `ready/` -> `done/`. A completed issue gets `completed: YYYY-MM-DD` in frontmatter and an `## Implementation Summary` section documenting what was done, what worked, and what didn't.

## Error forensics: from 21,000 failures to actionable issues

Having 21,000 failing tests is useless unless you can turn them into a finite set of fixable issues. Our error analysis procedure turns raw test262 output into prioritized work items.

### Step 1: Classify by error signature

After a test262 run, we group failures by their error message. Not the full message — a normalized version with line numbers and file paths stripped:

```
null pointer dereference          →  1,081 tests
illegal cast                      →  1,294 tests
returned 2 (assertion failed)     →  10,099 tests
returned 0 (wrong value)          →  4,649 tests
WebAssembly.Exception             →  2,142 tests
```

This gives us the **umbrella issues** — #820 ("TypeError / null dereference failures, 6,077 tests") and #779 ("Assert failures: wrong values, 10,099 tests").

### Step 2: Deep-dive the big buckets

An umbrella issue with 10,099 tests isn't actionable. We deep-dive by reading actual test file content. For each large bucket, we sample 50-100 tests and classify by *which JavaScript feature* is being exercised:

```
returned 2 (10,099 tests):
  Object.defineProperty constraints    →  ~426
  Class static restrictions            →  ~403
  Strict mode / eval                   →  ~212
  for-of / const reassignment          →  ~141
  Object.freeze/seal                   →   ~73
  Type validation on receivers         →  ~117
  ...
```

Now each sub-bucket is a concrete issue. "Object.defineProperty should throw TypeError for non-object first arg" is something a developer agent can fix in one session.

### Step 3: Cross-reference with existing issues

Before creating new issues, we check everything in `plan/issues/ready/` and `plan/issues/blocked/`. Many failure patterns map to issues that already exist — they just need updated metrics. If an existing issue covers a pattern, we update its `test262_fail` count rather than creating a duplicate.

### Step 4: Split mega-issues

Any issue covering more than ~100 tests with multiple distinct root causes gets split. Issue #820 (6,077 failures) became:
- #825: Null dereference failures (1,081 tests)
- #826: Illegal cast failures (1,294 tests)
- #852: Destructuring params specifically (1,525 tests)
- #854: Iterator protocol null methods (126 tests)

Each child issue is independently implementable and has its own test count for progress measurement.

## The goal DAG

Issues don't exist in a flat list. They belong to **goals**, and goals form a directed acyclic graph:

```
              compilable (~95%)
             /          |         \
       crash-free    core-semantics   error-model
            |        /       |            |
       property-model   class-system   builtin-methods
            |               |              |
       iterator-protocol ←──┘              |
            |                              |
     ┌──────┴──────┐                       |
  generator-model  symbol-protocol         |
       |                  |                |
    async-model           |                |
       |                  |                |
       └──── spec-completeness ←───────────┘
                    |
            full-conformance
```

A goal is **activatable** when all its dependencies are met. Multiple goals can be active simultaneously — this isn't a linear roadmap. Right now, `compilable`, `crash-free`, `core-semantics`, `error-model`, `property-model`, `class-system`, and `builtin-methods` are all active in parallel.

Each goal has a percentage target. `compilable` means "CE approaches zero" — currently at ~2,284 CE remaining. `crash-free` means "no traps at runtime" — targeting zero null dereferences and illegal casts. These aren't arbitrary milestones; they're measurable thresholds on the test262 output.

Parallel tracks exist outside the conformance DAG: **standalone mode** (WASI/edge deployment), **performance optimization** (type inference, monomorphization), **platform support** (Component Model, HTTP handlers), and **refactoring** (modularizing the codebase). These can be worked on independently whenever it makes sense.

### Using the DAG for sprint planning

When planning a sprint, we:

1. **Pick from active/activatable goals** — don't work on blocked goals
2. **Within a goal, sort by test count** — #852 (1,525 FAIL) before #853 (58 FAIL)
3. **Check the dependency graph for coordination** — issues that touch the same codegen function shouldn't run in parallel
4. **Balance CE vs. Fail work** — CE fixes unblock new tests; Fail fixes increase the pass count directly

The sprint priority list is generated mechanically from the DAG:

```
1. #852 (1,525 FAIL) — destructuring params            [crash-free]
2. #846 (2,799 FAIL) — assert.throws not thrown         [error-model]
3. #848 (1,015 FAIL) — class computed property/accessor [class-system]
4. #822 (907 CE)     — Wasm type mismatch               [compilable]
5. #847 (660 FAIL)   — for-of destructuring             [core-semantics]
```

No subjective prioritization debates. The test count decides.

## The dependency graph

Below the goal DAG, individual issues have fine-grained dependencies documented in `plan/dependency-graph.md`. This file serves as the dispatch queue — it shows which issues are ready now, which are blocked, and which coordinate with each other:

```
#852 (destructuring params — 1,525 FAIL)
  ├── coordinates with #825 (null_deref umbrella)
  └── coordinates with #826 (illegal_cast umbrella)
```

"Coordinates with" means these issues touch overlapping code. They can't be assigned to parallel developer agents without risking merge conflicts. The dependency graph also tracks which codegen function each issue touches, so the tech lead can dispatch non-conflicting issues to concurrent agents:

```
compileDestructuringAssignment → #142, #328, #379, #420, #761, #847, #852
compileCallExpression          → #382, #409, #489, #827, #857
class codegen                  → #329, #334, #377, #427, #793, #843, #848
```

Two agents working on `compileDestructuringAssignment` is a conflict. One agent on destructuring and one on class codegen is fine — git's 3-way merge handles separate hunks.

## The backlog

The backlog (`plan/issues/backlog/backlog.md`) is a categorized inventory of all open work, organized by subsystem:

1. **Compiler Correctness** — type mismatches, AST nodes, return_call
2. **Runtime Semantics** — assertions, type errors, destructuring, iterators
3. **Built-in Methods** — Array, Set, Map, Math, Error, RegExp
4. **Class Features** — computed props, super, private fields, accessors
5. **Iterator / Generator / Async Model**
6. **Property Model / Prototype Chain**
7. **Test Infrastructure**
8. **Proposals and Standards** — Temporal, SharedArrayBuffer, Set methods
9. **Architecture / Refactoring**
10. **Performance Optimization**
11. **Platform Support**

Each category has a table with issue number, priority, impact count, and status. The backlog header shows the current state snapshot:

```
Current state (2026-03-28): 18,041 pass | 21,181 fail | 2,284 CE | 6,580 skip
```

This snapshot updates after every major sprint. Historical data at the bottom shows the trajectory:

```
Session 2026-03-19/20: 97 issues. Pass: 9,270 → 13,226 (+43%). CE: 14,950 → 6,894 (-54%).
Session 2026-03-25:    Pass: 14,720 → 18,437 (+25%). CE: 4,443 → 1,657 (-63%).
```

## Measuring what matters

The numbers that run our project:

**Pass count** is the north star. Everything we do is measured against whether it moves this number. An architectural refactoring that doesn't change the pass count is lower priority than a 20-line fix that passes 200 more tests.

**CE count** is the leading indicator. When CE drops, it means more tests are compiling for the first time. Some of those will pass immediately (features that work but were blocked by a compile error in the test wrapper). Others will fail — which creates new Fail issues to investigate. A big CE drop often *temporarily increases* the Fail count as previously uncompilable tests are now visible.

**Fail count** is the lagging indicator. It goes down as we fix runtime semantics, but it can go up when CE fixes expose new tests to the runtime. The ratio of pass/(pass+fail) is more meaningful than the absolute fail count.

**Skip count** is a scope decision. We review it periodically. When we added TypedArray/DataView/ArrayBuffer support, we removed those features from the skip filter and ~500 tests became visible. Some passed immediately; many became new CE or Fail work.

## The completion log

Every completed issue gets an entry in `plan/issues/done/log.md`:

```
| #   | Completed  | Title                                          | Sprint   |
|-----|------------|------------------------------------------------|----------|
| 827 | 2026-03-29 | Array callback methods: "fn is not a function" | Sprint 7 |
| 846 | 2026-03-29 | assert.throws not thrown for invalid built-in   | Sprint 7 |
| 848 | 2026-03-29 | Class computed property / accessor correctness  | Sprint 7 |
```

768 entries so far. The log isn't just bookkeeping — it's our velocity measure. How many issues per session? How fast is the pass count growing? Are we picking off the high-impact issues or getting distracted by low-count stragglers?

## Issue lifecycle

```
backlog → ready → in-progress → review → done
                      ↕
                  suspended
```

- **Backlog**: Known but not prioritized. Large scope, no clear path, or blocked by architectural decisions.
- **Ready**: No blockers, has enough detail for a developer to start. Sitting in `plan/issues/ready/`.
- **In-progress**: A developer agent has claimed it, updated the frontmatter, and is working.
- **Review**: Implementation complete, waiting for merge and verification.
- **Suspended**: Agent was interrupted mid-work. The issue file has a `## Suspended Work` section with the worktree path, branch name, what's done, what's left, and exact next steps. A new agent can pick up exactly where the previous one stopped.
- **Done**: Merged to main, tests passing, moved to `plan/issues/done/`.

The suspended state exists because our developer agents are AI processes that can be interrupted at any time — context limits, OOM, session boundaries. Rather than losing work, the agent writes enough state to its issue file that another agent can resume without rediscovering anything.

## What we've learned about measuring compiler progress

### 1. Absolute test counts beat subjective priority

"High priority" means different things to different people. "2,799 FAIL" is unambiguous. Every issue in our system has a test count, and that count determines sprint ordering.

### 2. Error classification is the bottleneck

The hard part isn't fixing bugs — it's figuring out which of 21,000 failures represent the same underlying bug. The error forensics procedure (normalize messages → group → sample → classify → split) is where most of the Product Owner's time goes.

### 3. CE and Fail are different workflows

CE issues are typically compiler-side fixes that unblock hundreds of tests. Fail issues are runtime semantics corrections that directly increase pass count. A healthy sprint has both — CE fixes to expand coverage, Fail fixes to convert coverage into passes.

### 4. The goal DAG prevents premature optimization

Without the DAG, it's tempting to chase the sexiest issues (performance! SIMD! Component Model!) while fundamental runtime semantics are still broken. The DAG makes dependencies explicit: you can't work on generator optimizations until the iterator protocol is solid.

### 5. Skip filters are scope decisions, not deferrals

Every skip must have an issue. If we're skipping 4,376 Temporal tests, there's an issue (#661) that says why and what it would take to support it. "We'll get to it later" isn't a skip reason — "Temporal requires a polyfill, estimated medium effort, blocked on nothing" is.

### 6. Historical data keeps you honest

Recording pass/fail/CE after every sprint makes it impossible to fool yourself about progress. A session where you closed 10 issues but the pass count didn't move? Those issues were probably in the long tail. A session where you closed 3 issues and passed 4,000 more tests? Those were the right 3 issues.

Our trajectory: 550 → 9,270 → 13,226 → 14,720 → 18,167. Each jump corresponds to a specific set of issues, and we can trace exactly which fixes drove which gains.

---

*ts2wasm is an open-source TypeScript-to-WebAssembly compiler measuring progress against the 47,797-test ECMAScript conformance suite. Project management artifacts — issues, goals, backlogs, dependency graphs — are all plain markdown files in the `plan/` directory.*
