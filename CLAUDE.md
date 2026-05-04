# js2wasm

TypeScript-to-WebAssembly compiler using WasmGC.

## Running Tests
- Run all tests: `npm test` (vitest — may OOM on full suite in constrained envs)
- Run a specific test file: `npm test -- tests/issue-277.test.ts`
- Run equivalence tests only: `npm test -- tests/equivalence.test.ts`
- Test262: `pnpm run test:262` — vitest-based runner, creates its own worktree, writes to `benchmarks/results/`. Default 3 workers.

## Dev scratch
- **All ad-hoc probe / debug / repro files go in `.tmp/`** — gitignored, not picked up by vitest, doesn't pollute `git status`.
- If you spin up a quick `check-foo.ts`, `debug-bar.mts`, or `probe-*.test.ts` to investigate a bug, write it inside `.tmp/`, not at repo root or under `tests/`.
- Root-level patterns like `check-*.ts`, `debug-*.ts`, `run-*.ts`, `test-*-debug.ts`, `tests/probe-*.test.ts`, `tests/*-debug*.test.ts` are also gitignored as a safety net, but the convention is `.tmp/`.

## Working in worktrees
- **All agent work happens in worktrees**, not in `/workspace` directly. The `check-cwd.sh` hook blocks `git commit`/`merge`/`push` from `/workspace` for non-tech-lead users.
- **Canonical worktree path**: `/workspace/.claude/worktrees/<branch-name>/` — this is enforced by the `check-worktree-path.sh` hook on `git worktree add`. Worktrees outside this root (e.g. `/tmp/worktrees/`) are rejected.
- **Persistent shell cwd resets between Bash invocations**: every Bash tool call starts from `/workspace` regardless of where the previous one ended. Trailers like `Shell cwd was reset to /workspace` confirm this. The agent must prefix git commands with `cd /workspace/.claude/worktrees/<branch> &&` for them to land on the right branch.
  - Read/Edit/Write tools use absolute paths and are unaffected.
  - The `pre-git-commit.sh` hook injects a "VERIFY BEFORE COMMITTING: pwd=/workspace branch=main" reminder; that's the hook reading the (reset) shell cwd, NOT the actual command's working dir. The reminder is informational — verify by reading the commit's branch in git output (`[issue-1183-string-forof-ir 0527c7c5]`-style line shows the real branch).
- **Worktree creation**: `git worktree add /workspace/.claude/worktrees/issue-NNN-slug -b issue-NNN-slug origin/main`. Always branch from `origin/main` (post-fetch), never from local `main`.
- **Worktree cleanup after merge**: after a dev self-merges their PR, they remove their own worktree (`git worktree remove /workspace/.claude/worktrees/<branch>`) before claiming the next task. Tech-lead only removes worktrees for suspended or abandoned branches.

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
- Sprints: `plan/issues/sprints/{N}/sprint.md` — planning, task queue, results, retrospective (living doc updated during sprint)
- Issues: `plan/issues/` — organized by sprint:
  - `sprints/{N}/` — all issues for sprint N (status tracked via `status:` frontmatter field)
  - `backlog/` — unscheduled issues (no sprint assigned yet)
  - `wont-fix/` — decided against implementing
- Dependency graph: `plan/log/dependency-graph.md`
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

### Baseline files (which is authoritative?)

| File | Lives in | Authoritative for | Refreshed by | Validated by |
|------|----------|-------------------|--------------|--------------|
| `benchmarks/results/test262-current.jsonl` | main repo (committed, ~15MB) | `dev-self-merge` Step 4 bucket-by-path regression analysis | `refresh-committed-baseline.yml` (after every `Test262 Sharded` push to main) | `test262-baseline-validate.yml` spot-checks 50 random `pass` entries on every PR (#1218); fails the PR if any sampled entry no longer passes on main HEAD |
| `benchmarks/results/test262-current.json` | main repo (committed, ~kB) | landing-page summary, pass/total badges | `test262-sharded.yml` `promote-baseline` job (every push to main) | (none) |
| `test262-current.jsonl` (in `loopdive/js2wasm-baselines`) | separate repo | PR regression-gate baseline (fetched fresh per CI run) | `test262-sharded.yml` `promote-baseline` job (every push to main) | (none) |
| `benchmarks/results/playground-benchmark-sidebar.json` | main repo (committed, ~1KB) | landing-page sidebar wasm/js perf chart; `benchmark-refresh.yml` regression diff baseline | `benchmark-refresh.yml` auto-commit step on every push to main (#1216) | (none) |

The committed JSONL must be kept in sync with the JSON; otherwise the dev-self-merge bucket analysis reads stale "pass" entries and silently miscounts regressions. `refresh-committed-baseline.yml` is the dedicated workflow for that sync — it downloads the merged JSONL artifact from the most-recent successful `Test262 Sharded` run on main and commits it back with `[skip ci]`.

To validate the committed JSONL on demand, run `pnpm run test:262:validate-baseline` (uses a deterministic seed; pass `PR_NUMBER=N` to reproduce a specific CI run, or `SAMPLE_SIZE=10 SEED=12345` for a quicker check). Set `SAMPLE_SIZE=50` to match CI exactly. The validator fails fast on the first 5 most-affected entries with a pointer to `refresh-committed-baseline.yml`.

## CLI Flags
- `--target wasi` — emit WASI imports (fd_write, proc_exit) instead of JS host
- `--optimize` / `-O` — run Binaryen wasm-opt on compiled binary
- `--wit` — generate WIT interface file for Component Model
- `--nativeStrings` — use WasmGC i16 arrays instead of wasm:js-string (auto for WASI)

## Team & Workflow

See [plan/method/team-setup.md](plan/method/team-setup.md) for full team config, roles, memory budget, communication protocol, and merge lessons. Agent preferences and rules are in `.claude/memory/` (MEMORY.md index).

**Checklists** (read at the right moment, not at spawn time):
- `plan/method/session-start-checklist.md` — tech lead reads at session start
- `plan/method/pre-commit-checklist.md` — devs read before every git add/commit
- `plan/method/pre-completion-checklist.md` — devs read before signaling task completion
- `plan/method/pre-merge-checklist.md` — dev reads before merging to main

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

**Key numbers**: 16GB RAM + 16GB swap (container, set in `.devcontainer/devcontainer.json`). `free -m` may report ~20GB but Docker enforces 16GB hard limit. **Up to 8 dev teammates** (no local test262 — CI handles it). All agents use `bypassPermissions` mode + worktree isolation. Work driven by `plan/log/dependency-graph.md`.

**RAM monitoring**: Use `free -m` "available" column (not "free"). "free" excludes reclaimable disk cache. Hooks check "available" before allowing agent spawns.

**Memory budget** (measured peaks via `/proc/[pid]/status` VmHWM):
- Fixed: Cursor ~1,400MB + system ~1,200MB + tech lead ~1,400MB = **~4,000MB**
- Dev agent: ~700MB peak (no local test262)
- Test262 (CI only): ~4,300MB peak per shard — runs in GitHub Actions, not locally
- **Max 8 devs** (~9.6GB headroom). Check `free -m` available before spawning.

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
| Dev between tasks | Keep alive — wait for CI, self-merge if green, then claim next task from TaskList |
| Dev sending idle_notification pings | **Do NOT shut down.** Respond: ask if they have a PR to check on, or direct them to claim the next task from TaskList. |
| Dev idle, no tasks available | Keep alive if more tasks expected soon. Terminate only if sprint is explicitly wrapping up. |
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
| **Product Owner** | `.claude/agents/product-owner.md` | Backlog, issue creation, priorities | test262 results, dependency graph | `plan/issues/`, `plan/log/dependency-graph.md` |
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
- **Populate TaskList** at sprint start from `plan/issues/sprints/{N}/` (current sprint dir) and immediately whenever new issues are added mid-sprint. Empty queue = agents spin idle.
- Batch doc/plan commits on main AFTER all pending agent merges, not between them (doc commits force agents to re-merge main)
- Complete post-merge issue cleanup (set `status: done` in sprint dir issue file, update dep graph) after each merge
- **Tag sprints**: `git tag sprint-N/begin` when starting a sprint, `git tag sprint/N` when it finishes. Sprint stats (duration, commits, issues) are auto-generated from tags during `build:pages`.

### Sprint planning (PO + Architect + Tech Lead)

Sprint planning is a collaborative process, not a solo tech lead activity:

1. **PO validates** — smoke-tests top candidate issues against current main, closes already-fixed ones
2. **PO prioritizes** — orders by value (impact × unblocking potential), not just CE/FAIL count
3. **PO routes hard issues to Architect** — any issue marked `feasibility: hard` or touching core codegen gets an implementation spec before dev dispatch
4. **Architect specs** — reads compiler source, writes `## Implementation Plan` in the issue file with exact functions, line numbers, Wasm patterns, edge cases
5. **PO creates tasks** — via `TaskCreate` with full context, referencing architect specs where available
6. **Tech lead dispatches** — assigns tasks to devs, manages the merge queue

### Agent work dispatch
- **Tech lead populates TaskList** — devs self-serve from it. No per-task dispatch messages needed.
- **Dev loop**: claim task from TaskList → implement → push PR → wait for CI → self-merge if green → mark completed → claim next task.
- **Dev self-merge**: when `.claude/ci-status/pr-<N>.json` has matching SHA, `net_per_test > 0`, ratio <10%, no bucket >50 — run `gh pr merge <N> --admin --merge`. Escalate to tech lead only when criteria fail. See `.claude/skills/dev-self-merge.md`.
- **Devs contact tech lead only for**: TaskList empty, blocked >30 min, escalated merge criteria.
- Dev agents do NOT run full test262 locally — scoped checks only, CI validates conformance.

### Controlling agents
- **Pause (between tasks)**: create a task with `[PAUSE]` in the subject. Agents stop when they reach it and wait idle.
- **Pause (immediate)**: send `PAUSE` via SendMessage. Agent stops current work, kills running tests, waits idle. Send `RESUME` to continue.
- **Suspend**: send `SUSPEND` via SendMessage. Agent commits WIP, writes `## Suspended Work` to the issue file (worktree path, branch, resume steps), then **terminates**. A new agent resumes later from the issue file.
- **Resume suspended work**: assign the issue to a new dev agent. It reads `status: suspended` and `## Suspended Work` in the issue file, enters the existing worktree, continues.
- **Shutdown**: send `{"type": "shutdown_request"}` via SendMessage. Before sending: (1) confirm with user if they're talking to the agent, (2) ask the agent to write a context summary to `plan/agent-context/{name}.md` first. See `plan/method/agent-sessions.md` for the summary format.
- **Session registry**: track active agent sessions in `plan/method/agent-sessions.md` so sessions can be resumed. When respawning, pass the context summary in the spawn prompt.
- **Orphaned agents** (lost team context after crash): check worktrees for commits (`git -C <wt> log --oneline main..HEAD`) and uncommitted work (`git -C <wt> diff --stat`). Save any work, then kill the process. Write `## Suspended Work` in the issue file manually with the worktree path and state.

### Merge protocol (PR + CI, devs self-merge)

**Devs do NOT run local test262.** Branch validation happens in GitHub Actions:

1. **Dev merges `origin/main` INTO their branch** — `git merge origin/main` (not rebase), BEFORE opening a PR
   - Planning artifact conflicts (`dashboard/`, `plan/`, `public/`) → `git checkout --theirs` + regen
   - Compiler source conflicts (`src/**/*.ts`) → create a priority `[CONFLICT]` TaskList item; assign to `senior-developer` (Opus); do NOT resolve inline
2. **Dev runs scoped local checks** — issue-targeted compile/run checks for confidence
3. **Dev pushes the branch to origin and opens a PR against `main`**
4. **Dev waits for CI** — monitors `.claude/ci-status/pr-<N>.json` until it appears with a SHA matching HEAD (idle wait, no token burn)
5. **Dev self-merges** — if `net_per_test > 0`, SHA matches, ratio <10%, no bucket >50: `gh pr merge <N> --admin --merge`
6. **If regressions**: dev fixes on branch, pushes again, loops back to step 4
7. **Escalate to tech lead** only when: regressions >10, single bucket >50, or judgment call needed
8. **After merge**: dev marks task `completed`, claims next task
9. **Never use `git merge` on main directly.** All merges go through PRs + CI.
10. **Never rebase.** Merge preserves history and is safely reversible.

### Issue completion (post-merge)
1. Set `status: done` in the issue file at `plan/issues/sprints/{N}/{ID}.md`
2. Update `plan/log/dependency-graph.md` — remove/strikethrough completed issue
3. Update `plan/issues/backlog/backlog.md` if the issue was listed there

### Sprint History
- **Sprint 1**: 550 → 1,509 pass (+174%), 167 fail, 5,700 CE. Issues #138-#173.
- **Sprint 2**: 12 branches, 18 issues (#207-#224). Key: destructuring hoisting (~1200 CE), string comparison, .call(), member increment/decrement, labeled break. Equivalence tests: 86 → 170.
- **Sprint 3**: 32 issues (#225-#256). Target: 0 runtime failures, ~1,500 CE reduction.
- **Sprint 4+**: Transitioned to dependency-driven execution. See `plan/log/dependency-graph.md`.
- **2026-03-19 session**: 53 issues in one session. WASI target, native strings, WIT generator, tail calls, SIMD, peephole optimizer, type annotations, prototype chain, delete operator, TypedArray/ArrayBuffer support, and extensive test262 improvements.
