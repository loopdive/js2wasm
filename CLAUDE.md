# ts2wasm

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

**IMPORTANT: Always use teammates, not subagents.** Spawn agents via `TeamCreate` + `Agent` with `team_name` parameter. Never use bare `Agent` spawns — subagents can't coordinate, causing OOM from concurrent test runs and duplicate work. Teammates communicate via `SendMessage` to serialize test runs and coordinate on file conflicts.

**Key numbers**: 14GB RAM + 14GB swap (container limit). Max 3 dev teammates + 1 PO on demand. Default 3 test262 forks. All agents use `bypassPermissions` mode + worktree isolation. Work driven by `plan/dependency-graph.md`.

### Agent work dispatch
- Tech lead creates tasks via `TaskCreate` at session start (ordered by priority from `plan/dependency-graph.md`)
- Dev agents self-serve: after completing a task, they check `TaskList` and claim the next unowned task
- Dev agents do NOT exit after completing a task — they always check TaskList first
- Only the tech lead runs test262; dev agents run scoped tests only (compile + run specific test files, NOT `npx vitest`)

### Controlling agents
- **Pause**: create a task with `[PAUSE]` in the subject after the current in-progress tasks. Agents stop when they hit it.
- **Suspend**: send `SUSPEND` to an agent or broadcast `SUSPEND` to all. Agents commit WIP, update their issue file with `status: suspended` and a `## Suspended Work` section (worktree path, branch, resume instructions), then go idle.
- **Resume**: assign the issue to a dev agent. The issue file has `status: suspended` with a `## Suspended Work` section containing the worktree path and resume instructions.
- **Shutdown**: send `{"type": "shutdown_request"}` via SendMessage. Agent terminates permanently.
- **Orphaned agents** (lost team context after crash): check worktrees for commits (`git -C <wt> log --oneline main..HEAD`) and uncommitted work (`git -C <wt> diff --stat`). Save any work, then kill the process. Write `## Suspended Work` in the issue file manually with the worktree path and state.

### Issue completion protocol (tech lead responsibility)
When a dev agent reports completion, the tech lead must:
1. Merge the agent's branch to main (verify `pwd` is `/workspace`, branch is `main`). Cherry-pick only as fallback if merge fails.
2. Move issue file from `plan/issues/ready/` to `plan/issues/done/`
3. Update `plan/dependency-graph.md` — remove/strikethrough completed issue, update counts
4. Update `plan/issues/backlog/backlog.md` — move to completed section, update sprint priority
5. Check for unblocked issues in `plan/issues/blocked/`
6. Run equivalence tests to verify no regressions
7. Dispatch next issue to the freed agent

### Sprint History
- **Sprint 1**: 550 → 1,509 pass (+174%), 167 fail, 5,700 CE. Issues #138-#173.
- **Sprint 2**: 12 branches, 18 issues (#207-#224). Key: destructuring hoisting (~1200 CE), string comparison, .call(), member increment/decrement, labeled break. Equivalence tests: 86 → 170.
- **Sprint 3**: 32 issues (#225-#256). Target: 0 runtime failures, ~1,500 CE reduction.
- **Sprint 4+**: Transitioned to dependency-driven execution. See `plan/dependency-graph.md`.
- **2026-03-19 session**: 53 issues in one session. WASI target, native strings, WIT generator, tail calls, SIMD, peephole optimizer, type annotations, prototype chain, delete operator, TypedArray/ArrayBuffer support, and extensive test262 improvements.
