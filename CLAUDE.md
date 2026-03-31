# js2wasm

TypeScript-to-WebAssembly compiler using WasmGC.

## Running Tests
- Run all tests: `npm test` (vitest — may OOM on full suite in constrained envs)
- Run a specific test file: `npm test -- tests/issue-277.test.ts`
- Run equivalence tests only: `npm test -- tests/equivalence.test.ts`
- Test262: `pnpm run test:262` — vitest-based runner, creates its own worktree, writes to `benchmarks/results/`. Default 3 workers.

## Architecture Principles
- **Dual-mode: JS host optional** — the compiler supports two modes: JS host mode (uses host imports for performance/completeness) and standalone mode (pure Wasm, no JS runtime). New features should have Wasm-native implementations for standalone mode; JS host imports are acceptable as a fast path when a JS runtime is available. Don't add new host imports without a standalone fallback.
- This follows the pattern of #679 (dual string backend) and #682 (dual RegExp backend).

## Project Structure
- Codegen: `src/codegen/expressions.ts`, `src/codegen/index.ts`, `src/codegen/statements.ts`, `src/codegen/type-coercion.ts`, `src/codegen/peephole.ts`
- WIT generator: `src/wit-generator.ts` (TypeScript → WIT interface generation)
- Optimizer: `src/optimize.ts` (Binaryen wasm-opt integration)
- Tests: `tests/equivalence.test.ts` (main), `tests/test262.test.ts` (conformance dashboard, non-failing)
- Test262 runner: `tests/test262-runner.ts` — TEST_CATEGORIES list
- Test262 runner (preferred): `pnpm run test:262` — vitest-based, auto-worktree, disk cache, default 3 forks. Use `TEST262_WORKERS=5` for solo runs (no dev agents).
- Test262 runner history: `runs/index.json` is appended by the vitest runner after each run. `benchmarks/results/report.html` reads this for the trend graph.
- Backlog: `plan/issues/backlog/backlog.md`
- Sprints: `plan/sprints/sprint-{N}.md` — planning, task queue, results, retrospective (living doc updated during sprint)
- Issues: `plan/issues/` — organized by state:
  - `ready/` — no blockers, pick any to start (priority in `dependency-graph.md`)
  - `blocked/` — waiting on a dependency
  - `done/` — completed (with frontmatter + implementation summary)
  - `backlog/` — large scope / future
  - `wont-fix/` — decided against implementing
- Dependency graph: `plan/dependency-graph.md`
- Goals (DAG): `plan/goals/goal-graph.md` — high-level goals with dependencies; issues belong to goals
  - Goals are not sequential milestones — they form a DAG and multiple can be active in parallel
  - Only work on issues from goals whose dependencies are met (active/activatable)
  - Legacy milestones in `plan/milestones/` are superseded by goals

## Key Patterns
- `VOID_RESULT` sentinel in expressions.ts — `InnerResult = ValType | null | typeof VOID_RESULT`
- Ref cells for mutable closure captures — `struct (field $value (mut T))`
- FunctionContext must include `labelMap: new Map()` and `isGenerator?: boolean` in all object literals
- `as unknown as Instr` for Wasm ops not yet in the Instr union (f64.copysign, f64.min/max) — 158 occurrences, tracked for cleanup
- f64.promote_f32 IS now in the Instr union (added for Math.fround)
- `return_call` / `return_call_ref` for tail call optimization in return position
- Peephole pass removes redundant `ref.as_non_null` after `ref.cast`
- Native type annotations: `type i32 = number` → emits i32 locals and i32 arithmetic
- `nativeStrings` flag decouples WasmGC string arrays from fast mode (auto-enables for WASI)

## Type Coercion (now in `src/codegen/type-coercion.ts`)
- ref/ref_null → externref: use `extern.convert_any` (in coerceType)
- f64 → externref: use `__box_number` import
- i32 → externref: use `f64.convert_i32_s` + `__box_number`
- null/undefined in f64 context: emit `f64.const 0` / `f64.const NaN` directly (avoids externref roundtrip)

## addUnionImports
- Late import addition shifts function indices — `addUnionImports` in index.ts
- Must also shift `ctx.currentFunc.body` (the current function being compiled)
- `body: []` in FunctionContext (NOT `body: func.body`) — shared references break savedBody/swap pattern

## Test262
- test262.test.ts has no assertions — all vitest tests pass; conformance is tracked via report
- Skip filters: eval, with, Proxy, SharedArrayBuffer, Temporal, WeakRef, FinalizationRegistry, dynamic import(), top-level-await
- Many previously-skipped features now supported: TypedArray, DataView, ArrayBuffer, delete, async, generators, for-of
- Issues #618-#634 cover current failure patterns (from 2026-03-19 error analysis)
- parseInt import: `(externref, f64) -> f64` with NaN sentinel for missing radix

## CLI Flags
- `--target wasi` — emit WASI imports (fd_write, proc_exit) instead of JS host
- `--optimize` / `-O` — run Binaryen wasm-opt on compiled binary
- `--wit` — generate WIT interface file for Component Model
- `--nativeStrings` — use WasmGC i16 arrays instead of wasm:js-string (auto for WASI)

## Team & Workflow

See [plan/team-setup.md](plan/team-setup.md) for full team config, roles, memory budget, communication protocol, and merge lessons. Agent preferences and rules are in `.claude/memory/` (MEMORY.md index).

**Checklists** (read at the right moment, not at spawn time):
- `plan/session-start-checklist.md` — tech lead reads at session start
- `plan/pre-commit-checklist.md` — devs read before every git add/commit
- `plan/pre-completion-checklist.md` — devs read before signaling task completion
- `plan/pre-merge-checklist.md` — tester reads before every merge to main

**Skills** (on-demand role protocols — any agent can invoke these):
- `/test-and-merge` — full tester pipeline: merge main into branch, equiv tests, ff-only merge
- `/smoke-test-issue` — validate an issue still reproduces before dispatching
- `/analyze-regression` — diff two test262 runs to find which tests flipped
- `/sprint-wrap-up` — end-of-sprint cleanup checklist
- `/create-issue` — create issue file from a failure pattern
- `/architect-spec` — write implementation spec for a hard issue

Skills replace idle specialist agents. A dev can invoke `/test-and-merge` instead of waiting for a tester. Any agent can invoke `/architect-spec` instead of spawning an architect. Prefer skills over dedicated agents when:
- The task is short (< 5 min of agent time)
- Only one agent needs the capability at a time
- RAM is tight

Spawn dedicated agents when:
- Multiple tasks need the same role concurrently (e.g., 3 devs)
- The role needs sustained back-and-forth with the user (e.g., PO during planning)
- The role accumulates context that's hard to capture in a skill (e.g., SM during retro discussion)

**IMPORTANT: Always use teammates, not subagents.** Spawn agents via `TeamCreate` + `Agent` with `team_name` parameter. Never use bare `Agent` spawns — subagents can't coordinate, causing OOM from concurrent test runs and duplicate work. Teammates communicate via `SendMessage` to serialize test runs and coordinate on file conflicts.

**Key numbers**: 16GB RAM + 16GB swap (container, set in `.devcontainer/devcontainer.json`). `free -m` may report ~20GB but Docker enforces 16GB hard limit. Max 4 dev teammates at a time. Default 1 test262 fork. All agents use `bypassPermissions` mode + worktree isolation. Work driven by `plan/dependency-graph.md`.

**RAM monitoring**: Use `free -m` "available" column (not "free"). "free" excludes reclaimable disk cache. Example: "free" shows 1.5GB but "available" shows 7GB = the actual headroom. Hooks check "available" before allowing tests or agent spawns.

**Memory budget** (measured peaks via `/proc/[pid]/status` VmHWM):
- Fixed: Cursor ~1,400MB + system ~1,200MB + tech lead ~1,400MB = **~4,000MB**
- Dev agent: ~350MB idle, ~500MB active, ~700MB peak
- Equiv test: ~800MB (parent ~400MB + 1 fork ~400MB)
- Test262 (1 fork): ~4,300MB peak (fork grows to ~4GB over 48K tests)
- **Max 4 devs** with parallel equiv tests (~9GB). Max 2 devs during test262 (~9GB). Shut down devs for solo test262 runs.

### Agent lifecycle — when to spawn, skill, or terminate

| Situation | Action |
|-----------|--------|
| Dev needs to test + merge | Invoke `/test-and-merge` skill (no tester agent needed) |
| Need to validate 1-2 issues | Invoke `/smoke-test-issue` skill |
| Sprint planning (collaborative, multi-issue) | Spawn PO + Architect agents |
| Hard issue needs design | Invoke `/architect-spec` skill, or spawn architect if multiple issues |
| Sprint retro (discussion with user) | Spawn SM agent |
| Planning agents done, user not talking to them | Write context summary → terminate |
| Planning agents done, user IS talking to them | Keep alive until user signals done |
| Dev between tasks | Keep alive — claim next task from TaskList |
| Dev idle, no tasks available | Keep alive if more tasks expected soon. Terminate if sprint is wrapping up. |
| End of sprint | All agents write context summaries → terminate → run `/sprint-wrap-up` |

### Roles and interactions

```
User (stakeholder)
  ↕ directs priorities, approves plans
Product Owner
  ↓ creates issues with problem + acceptance criteria
Architect
  ↓ adds implementation specs to issue files (functions, Wasm patterns, edge cases)
Tech Lead
  ↓ creates task queue, dispatches to devs, merges (ff-only), runs test262
Developers (×3)
  ↑ signal completion → tech lead merges → broadcast rebase
Scrum Master
  ↔ reviews sprint → proposes process changes to PO + tech lead
```

| Role | Agent | Owns | Reads from | Writes to |
|------|-------|------|-----------|-----------|
| **Product Owner** | `.claude/agents/product-owner.md` | Backlog, issue creation, priorities | test262 results, dependency graph | `plan/issues/`, `plan/dependency-graph.md` |
| **Architect** | `.claude/agents/architect.md` | Implementation specs | Issue files, compiler source | `## Implementation Plan` in issue files |
| **Tech Lead** | (orchestrator) | Task queue, merges, test runs | Issue files, agent messages | `main` branch, task list |
| **Developer** | `.claude/agents/developer.md` | Code changes in worktree | Issue file + impl spec, checklists | Source code, test files, issue status |
| **Scrum Master** | `.claude/agents/scrum-master.md` | Process improvement | Done issues, git history, messages | `plan/retrospectives/`, checklist edits (proposed) |

**Interaction flow:**

Sprint planning:
1. **PO** validates candidate issues against current main → closes stale ones
2. **PO** prioritizes remaining issues by value → routes hard ones to architect
3. **Architect** reads issue + compiler source → writes implementation plan in the issue file
4. **PO** creates task queue with full context → tech lead dispatches to devs

During sprint:
5. **Dev** reads issue (with impl plan) → implements → follows checklists → signals completion
6. **Dev** invokes `/test-and-merge` skill → merges main into branch → equiv tests → if pass: ff-only to main → post-merge cleanup. If fail: fixes on branch.
7. **PO** accepts/rejects completed work against acceptance criteria

End of sprint:
8. **Tech lead** runs full test262 → records results
9. **SM** reviews sprint → proposes process improvements
10. **PO** grooms backlog for next sprint

**Tech lead discipline:**
- Batch doc/plan commits on main AFTER all pending agent merges, not between them (doc commits force agents to re-merge main)
- Verify equivalence tests passed (dev runs them via `/test-and-merge` skill)
- Complete post-merge issue cleanup (move to done/, update dep graph) before dispatching next task

### Sprint planning (PO + Architect + Tech Lead)

Sprint planning is a collaborative process, not a solo tech lead activity:

1. **PO validates** — smoke-tests top candidate issues against current main, closes already-fixed ones
2. **PO prioritizes** — orders by value (impact × unblocking potential), not just CE/FAIL count
3. **PO routes hard issues to Architect** — any issue marked `feasibility: hard` or touching core codegen gets an implementation spec before dev dispatch
4. **Architect specs** — reads compiler source, writes `## Implementation Plan` in the issue file with exact functions, line numbers, Wasm patterns, edge cases
5. **PO creates tasks** — via `TaskCreate` with full context, referencing architect specs where available
6. **Tech lead dispatches** — assigns tasks to devs, manages the merge queue

### Agent work dispatch
- PO creates the task queue at sprint start (tech lead dispatches to devs)
- Dev agents self-serve: after completing a task, they check `TaskList` and claim the next unowned task
- Dev agents do NOT exit after completing a task — they always check TaskList first
- Only the tech lead runs full test262; dev agents run scoped tests and equivalence tests

### Controlling agents
- **Pause (between tasks)**: create a task with `[PAUSE]` in the subject. Agents stop when they reach it and wait idle.
- **Pause (immediate)**: send `PAUSE` via SendMessage. Agent stops current work, kills running tests, waits idle. Send `RESUME` to continue.
- **Suspend**: send `SUSPEND` via SendMessage. Agent commits WIP, writes `## Suspended Work` to the issue file (worktree path, branch, resume steps), then **terminates**. A new agent resumes later from the issue file.
- **Resume suspended work**: assign the issue to a new dev agent. It reads `status: suspended` and `## Suspended Work` in the issue file, enters the existing worktree, continues.
- **Shutdown**: send `{"type": "shutdown_request"}` via SendMessage. Before sending: (1) confirm with user if they're talking to the agent, (2) ask the agent to write a context summary to `plan/agent-context/{name}.md` first. See `plan/agent-sessions.md` for the summary format.
- **Session registry**: track active agent sessions in `plan/agent-sessions.md` so sessions can be resumed. When respawning, pass the context summary in the spawn prompt.
- **Orphaned agents** (lost team context after crash): check worktrees for commits (`git -C <wt> log --oneline main..HEAD`) and uncommitted work (`git -C <wt> diff --stat`). Save any work, then kill the process. Write `## Suspended Work` in the issue file manually with the worktree path and state.

### Merge protocol (dedicated tester agents, devs don't run test262)

**Devs do NOT run test262.** The shared `/workspace` causes branch contention that corrupts results. Instead:

1. **Dev merges main INTO their branch** — `git merge main` (not rebase)
2. **Dev signals tech lead**: `"Branch <name> ready for test. Commit <hash>. Worktree: <path>."`
3. **Tech lead spawns a short-lived tester agent** (`isolation: "worktree"`) that runs `/test-and-merge` skill on the branch
4. **Tester runs equiv tests + full test262** on the integrated branch, reports results, terminates (~600MB agent overhead, frees immediately)
5. **Tech lead approves/rejects** based on pass count delta from baseline
6. **If approved**: tester merges to main with `git merge --ff-only`, does post-merge cleanup
7. **If rejected**: dev fixes on their branch, signals again
8. **One tester at a time.** Tech lead queues branches. ~8.2GB total per test run.
9. **Never use `git merge` (without --ff-only) on main.** Hook blocks non-ff-only merges to main.
10. **Never rebase.** Merge preserves history and is safely reversible.
11. **Devs continue working on next task** while waiting for test results — they don't block.
12. **Main never sees untested code.** The tester creates a merge proof at `.claude/nonces/merge-proof.json` before ff-only merge. Hook validates it.

### Issue completion (tester post-merge)
1. Move issue file from `plan/issues/ready/` to `plan/issues/done/`
2. Update `plan/dependency-graph.md` — remove/strikethrough completed issue
3. Update `plan/issues/backlog/backlog.md` — sprint priority
4. Check for unblocked issues in `plan/issues/blocked/`

### Sprint History
- **Sprint 1**: 550 → 1,509 pass (+174%), 167 fail, 5,700 CE. Issues #138-#173.
- **Sprint 2**: 12 branches, 18 issues (#207-#224). Key: destructuring hoisting (~1200 CE), string comparison, .call(), member increment/decrement, labeled break. Equivalence tests: 86 → 170.
- **Sprint 3**: 32 issues (#225-#256). Target: 0 runtime failures, ~1,500 CE reduction.
- **Sprint 4+**: Transitioned to dependency-driven execution. See `plan/dependency-graph.md`.
- **2026-03-19 session**: 53 issues in one session. WASI target, native strings, WIT generator, tail calls, SIMD, peephole optimizer, type annotations, prototype chain, delete operator, TypedArray/ArrayBuffer support, and extensive test262 improvements.
