# ts2wasm

TypeScript-to-WebAssembly compiler using WasmGC.

## Running Tests
- Run all tests: `npm test` (vitest — may OOM on full suite in constrained envs)
- Run a specific test file: `npm test -- tests/issue-277.test.ts`
- Run equivalence tests only: `npm test -- tests/equivalence.test.ts`
- Test262 standalone: `npx tsx scripts/run-test262.ts [category...]` — writes JSONL + JSON report to `benchmarks/results/`, supports filtering by category

## Architecture Principles
- **Never delegate to JS host** — the goal is pure Wasm, no JS runtime dependency. Inline Wasm implementations are always preferred over host imports.
- Existing host imports (Math methods, string ops) are legacy/temporary — don't add new ones.

## Project Structure
- Codegen: `src/codegen/expressions.ts`, `src/codegen/index.ts`, `src/codegen/statements.ts`
- Tests: `tests/equivalence.test.ts` (main), `tests/test262.test.ts` (conformance dashboard, non-failing)
- Test262 runner: `tests/test262-runner.ts` — TEST_CATEGORIES list
- Standalone runner: `scripts/run-test262.ts` — writes JSONL + JSON report to `benchmarks/results/`. Run via `npx tsx scripts/run-test262.ts [category...]`. Supports `--resume` to continue an interrupted run (same git HEAD only — code changes force a fresh run).
- Backlog: `plan/issues/backlog/backlog.md`
- Issues: `plan/issues/` — organized by state:
  - `ready/` — no blockers, pick any to start (priority in `dependency-graph.md`)
  - `blocked/` — waiting on a dependency
  - `done/` — completed (with frontmatter + implementation summary)
  - `backlog/` — large scope / future
  - `wont-fix/` — decided against implementing
- Dependency graph: `plan/dependency-graph.md`

## Key Patterns
- `VOID_RESULT` sentinel in expressions.ts — `InnerResult = ValType | null | typeof VOID_RESULT`
- Ref cells for mutable closure captures — `struct (field $value (mut T))`
- FunctionContext must include `labelMap: new Map()` in all object literals
- `as unknown as Instr` for Wasm ops not yet in the Instr union (f64.copysign, f64.min/max)
- f64.promote_f32 IS now in the Instr union (added for Math.fround)

## Type Coercion
- ref/ref_null → externref: use `extern.convert_any` (in coerceType at expressions.ts ~160)
- f64 → externref: use `__box_number` import
- i32 → externref: use `f64.convert_i32_s` + `__box_number`
- null/undefined in f64 context: emit `f64.const 0` / `f64.const NaN` directly (avoids externref roundtrip)

## addUnionImports
- Late import addition shifts function indices — `addUnionImports` in index.ts
- Must also shift `ctx.currentFunc.body` (the current function being compiled)
- `body: []` in FunctionContext (NOT `body: func.body`) — shared references break savedBody/swap pattern

## Test262
- test262.test.ts has no assertions — all vitest tests pass; conformance is tracked via report
- Skip filters: eval, with, wrapper constructors, NaN/undefined loops, delete, Object.defineProperty/create/freeze/seal, Object.prototype.hasOwnProperty.call, propertyIsEnumerable, prototype chain, throw+try/catch, for-of+generators, object as loop condition
- Issues #138-#256 cover all identified failure patterns
- parseInt import: `(externref, f64) -> f64` with NaN sentinel for missing radix

## Team & Workflow

See [plan/team-setup.md](plan/team-setup.md) for full team config, roles, and merge lessons.

### Continuous execution (rolling pool, dependency-driven)

Work is driven by `plan/dependency-graph.md`. Maintain a **rolling pool of 8 developer agents** — whenever one finishes, cherry-pick its work and immediately launch a replacement on the next ready issue.

1. **Pick work**: choose by priority (critical > high > medium > low) from `plan/issues/ready/`
2. **Function locking**: no two agents touch the same *function* concurrently. Same file is OK if different functions (Git 3-way merge handles separate hunks).
3. **Complete work**: cherry-pick to main, then follow the issue completion procedure:
   - Move issue from `ready/` to `done/`
   - Add `completed: YYYY-MM-DD` frontmatter
   - Append `## Implementation Summary` with: what was done, what worked, what didn't, files changed, tests now passing
   - Add entry to `plan/issues/done/log.md`
   - Check `plan/issues/blocked/` for issues unblocked by this completion — move newly unblocked to `ready/`
   - Update `plan/dependency-graph.md`
4. **Immediately launch replacement**: pick next ready issue, launch new agent — keep 8 slots filled until no ready issues remain

### Sprint History
- **Sprint 1**: 550 → 1,509 pass (+174%), 167 fail, 5,700 CE. Issues #138-#173.
- **Sprint 2**: 12 branches, 18 issues (#207-#224). Key: destructuring hoisting (~1200 CE), string comparison, .call(), member increment/decrement, labeled break. Equivalence tests: 86 → 170.
- **Sprint 3**: 32 issues (#225-#256). Target: 0 runtime failures, ~1,500 CE reduction.
- **Sprint 4+**: Transitioned to dependency-driven execution. See `plan/dependency-graph.md`.
