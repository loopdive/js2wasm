---
title: "Sprint 41 — Non-error work: perf, infra, refactor, real-world stress tests"
status: planning
sprint: Sprint-41
---

# Sprint 41 — Non-error work and real-world stress tests

**Planned start**: after Sprint 40 closes (target: past 50% conformance)
**Starting baseline (projected)**: ~21,500+ pass / 43,164 total (>50%)
**Duration**: TBD — kickoff deferred until Sprint 40 wraps

## Scope

Sprint 41 is the **non-error** counterpart to Sprint 40. Mid-Sprint-40 (2026-04-11), the backlog was re-scoped so Sprint 40 holds only pass-rate / error-fix work. Everything else — perf, benchmarks, refactoring, infra, planning-data, and real-world stress-test investigations — moved here.

This sprint is intentionally less pass-rate-focused. The goal is to **broaden** coverage (stress tests that reveal new bugs) and **strengthen** the foundation (perf regressions, refactors, benchmark infrastructure) that were starved of attention during the Sprint 40 merge wave.

## Sprint 40 carry-over (non-error work moved here)

| #                                  | Title                                                                                                                | Category              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------- |
| [#824](../issues/ready/824.md)     | Timeout umbrella doc cleanup — replace the stale 10s compile-timeout narrative with current 30s worker-timeout model | Process / docs        |
| [#1000](../issues/ready/1000.md)   | Normalize issue frontmatter and repopulate historical sprint assignments                                             | Planning-data         |
| [#1001](../issues/ready/1001.md)   | Preallocate counted `number[]` push loops into dense WasmGC arrays                                                   | Perf                  |
| [#1003](../issues/ready/1003.md)   | Normalize issue metadata with ES edition, language feature, task type                                                | Planning-data         |
| [#1004](../issues/ready/1004.md)   | Optimize repeated string concatenation via compile-time folding                                                      | Perf                  |
| [#1005](../issues/ready/1005.md)   | Benchmark cold-start across Wasmtime, Wasm-in-Node, native Node                                                      | Benchmarks            |
| [#1007](../issues/ready/1007.md)   | Re-run historical test262 checkpoints with current harness                                                           | Historical benchmarks |
| [#1008](../issues/ready/1008.md)   | Mobile-first layout for the playground                                                                               | UI                    |
| [#1009](../issues/ready/1009.md)   | Investigate report-page benchmark outliers where Wasm loses to JS                                                    | Investigation         |
| [#1011](../issues/ready/1011.md)   | Offline-first benchmarks with Playwright DOM measurement and Run Live button                                         | Benchmarks            |
| [#1013](../issues/ready/1013.md)   | Split `src/codegen/index.ts` (14,344 lines) into focused modules                                                     | Refactor              |
| [#1029](../issues/blocked/1029.md) | Migrate to TypeScript 7.x (typescript-go) — **blocked** on microsoft/typescript-go#516 API stability                 | Infra / blocked       |

## Real-world stress tests (new, filed 2026-04-11)

The biggest thing added to Sprint 41: four **real-world-library stress tests** that compile production JavaScript libraries to Wasm and harvest error patterns for follow-up issues. These are _investigation_ tasks — success criterion is a categorized error report and concrete follow-up issues, not full library compatibility.

| #                                | Library      | Stress dimension                                     | Host imports                              | Killer acceptance test                                            |
| -------------------------------- | ------------ | ---------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| [#1031](../issues/ready/1031.md) | **lodash**   | Pure compute, iteration, prototype chain, algorithms | None                                      | Tier 1 modules unit-test clean                                    |
| [#1032](../issues/ready/1032.md) | **axios**    | I/O, streams, Promise chains                         | Node builtins (http, stream, buffer, ...) | Real GET against httpbin.org from Wasm                            |
| [#1033](../issues/ready/1033.md) | **react**    | Closures, hooks, reconciler, Symbol.for              | DOM (document, window, HTMLElement, ...)  | Counter component renders & increments on click                   |
| [#1034](../issues/ready/1034.md) | **prettier** | Parsers, string ops, recursive AST, large switches   | None                                      | Compiled-prettier output === native-prettier output byte-for-byte |

Each test stresses a distinct dimension of the compiler:

- **lodash** surfaces compute-semantics gaps (iteration, algorithms)
- **axios** surfaces the Node-builtins-as-host-imports boundary
- **react** stresses closures + hooks (the canonical "closure captures ref cell, not value" torture test)
- **prettier** is deterministic and self-hosting — **byte-for-byte diff is a killer correctness signal**

Expected output: each stress test files 3-5 concrete follow-up issues. Those follow-ups feed into future Sprint 40 error-fix sprints.

## Stress-test preconditions (filed 2026-04-11 by arch-npm-stress; corrected same day)

Architecture gap analysis (`plan/architecture/npm-stress-compiler-gaps.md`) initially identified five preconditions, but one (#1041 "multi-file module graph") was based on a framing error: `compileProject` (`src/index.ts:216`) already walks the transitive import closure via `ModuleResolver` + `resolveAllImports` and runs one shared `ts.Program` through `compileMultiSource`. The `preprocessImports` `declare const X: any` rewrite is only the single-file `compile()` fallback, not on the multi-file path.

**#1041 closed** and moved to `plan/issues/wont-fix/1041.md`. The real research issue (per-module separate compilation with consumer-driven type specialization) is filed as **#1046** in Backlog — not a sprint-41 precondition.

| #                                  | Title                                                                                           | Unblocks                              | Category            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------- |
| [#1043](../issues/ready/1043.md)   | Compile-time `process.env.NODE_ENV` substitution + dead-branch elimination                      | **#1033** (halves React surface area) | Compiler easy win   |
| [#1044](../issues/ready/1044.md)   | Node builtin modules as host imports (`NODE_HOST_IMPORT_MODULES`, `node:` prefix normalization) | **#1032** axios Tier 4                | Compiler scaffold   |
| [#1045](../issues/ready/1045.md)   | DOM globals as extern classes (`DOM_HOST_GLOBALS`, `queueMicrotask`, `requestAnimationFrame`)   | **#1033** react Tier 4                | Compiler scaffold   |
| [#1042](../issues/ready/1042.md)   | `async`/`await` state-machine lowering (Backlog — research-level)                               | #1032 Tier 4 stretch goal (real GET)  | Research / deferred |
| [#1046](../issues/backlog/1046.md) | Separate ES-module compilation + consumer-driven type specialization (Backlog — research)       | future distribution of compiled libs  | Research / deferred |

Dependency wiring applied to stress-test frontmatter:

- **#1031** lodash: `depends_on: []` — runnable today via `compileProject`
- **#1032** axios: `depends_on: [1044]`
- **#1033** react: `depends_on: [1043, 1045]`
- **#1034** prettier: `depends_on: []` — runnable today via `compileProject`

Recommended precondition work order: **#1043 first** (easy, big surface-area reduction for React), then **#1044 and #1045 in parallel** (share the module-specifier / global-identifier recognition hook). #1031 and #1034 can start immediately in parallel with the preconditions.

## WASI deliverable (new, filed 2026-04-11)

| #                                | Title                                                                                                                                                        | Category              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| [#1035](../issues/ready/1035.md) | WASI hello-world — `console.log` + `node:fs.writeFileSync` compiled to a native executable, with `node:fs` calls translated to WASI syscalls at compile time | Feature / dual-target |

First concrete "TypeScript → native executable" story. Parallels the dual-mode architecture principle (#679/#682 string and RegExp backends) applied to filesystem I/O. Nine follow-up issues (#1036–#1044) identified for the rest of the `node:fs` surface once the `writeFileSync` path lands.

## Phased task queue

### Phase 0: Stress-test preconditions (needed only for #1032/#1033)

| Order | Issue     | Rationale                                                                                    |
| ----- | --------- | -------------------------------------------------------------------------------------------- |
| 0a    | **#1043** | `process.env.NODE_ENV` DCE. Easy. Halves React dev-build surface area. Pre-#1033 iter speed. |
| 0b    | **#1044** | Node-builtin host-import routing. Precondition for #1032 Tiers 3-4.                          |
| 0c    | **#1045** | DOM globals as extern classes. Precondition for #1033 Tier 4. Parallel to #1044.             |

**#1031 (lodash)** and **#1034 (prettier)** do NOT need Phase 0 — they run directly through `compileProject` against their package entry file. Start them in parallel with Phase 0.

### Phase 1: Real-world stress tests (high signal, broad coverage)

Run the four stress tests in parallel or sequence — each produces its own error-bucket report and follow-up issues. Recommended order: **prettier first** (deterministic, no host-import design, strongest correctness signal), then **lodash** (cleanest compute surface), then **axios** (requires #1044 Node-builtin routing), then **react** (requires #1043 + #1045 DOM routing + solid closure model).

| Order | Issue              | Depends on   | Rationale                                                                                                                 |
| ----- | ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1     | **#1034** prettier | —            | Pure compute, no boundary design, self-format diff = unambiguous correctness signal. Runnable via `compileProject` today. |
| 2     | **#1031** lodash   | —            | Pure compute, smaller surface, fast feedback. Runnable via `compileProject` today.                                        |
| 3     | **#1032** axios    | #1044        | Requires Node-builtin host-import scaffold                                                                                |
| 4     | **#1033** react    | #1043, #1045 | Requires DOM host imports + NODE_ENV DCE                                                                                  |

### Phase 2: WASI feature deliverable

| Order | Issue                   | Rationale                                                                                  |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------ |
| 5     | **#1035** WASI hello-fs | First "TS → native executable" story. Unblocks the full `node:fs`→WASI line of follow-ups. |

### Phase 3: Perf and benchmark infrastructure

/
| Order | Issue | Rationale |
|-------|-------|-----------|
| 6 | **#1001** counted push-loop | Recovers lost landing-page `array.ts` benchmark advantage |
| 7 | **#1004** string concat | Addresses `string.ts` benchmark slowdown (11.9µs Wasm vs 5.2µs JS) |
| 8 | **#1005** cold-start benchmark | Adds a reproducible server-side startup measurement |
| 9 | **#1009** report-page outliers | Classifies benchmark slowdowns into real vs measurement artifact |
| 10 | **#1011** offline-first benchmarks | Stabilizes benchmark numbers and enables user-side live comparison |

### Phase 4: Refactor and infra

| Order | Issue                               | Rationale                                                         |
| ----- | ----------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| 11    | **#1013** split codegen/index.ts    | 14,344 lines, 124 exports — last remaining monolith               |
| 12    | **#1000** frontmatter normalization | Cleans up historical sprint assignments for dashboard             |
| 13    | **#1003** metadata fields           | Adds ES edition, language feature, task type to issue frontmatter |
| z     | 14                                  | **#1007** historical checkpoint re-run                            | Rebuilds a comparable conformance history timeline |
| 15    | **#1008** mobile playground         | Replaces desktop-only panel layout                                |
| 16    | **#824** timeout umbrella doc       | Stale narrative cleanup                                           |

## Acceptance criteria

- [ ] **Stress test outputs:** four error-bucket reports committed, ≥ 12 follow-up issues filed across #1031-#1034
- [ ] **Prettier self-format diff:** at least 3 real prettier source files produce byte-for-byte identical output under compiled-prettier vs native-prettier
- [ ] **WASI hello-fs:** #1035 compiles, produces `hello.txt` under wasmtime, wrapped to a native executable
- [ ] **Counter smoke test (stretch):** #1033 Counter component renders and increments on click end-to-end
- [ ] **Real HTTP GET (stretch):** #1032 completes a real GET against httpbin.org from compiled Wasm
- [ ] **Perf wins:** at least one of #1001/#1004 lands with a measurable improvement on the landing-page benchmarks
- [ ] **Codegen/index.ts split:** #1013 completes — no remaining file over 8k lines in `src/codegen/`
- [ ] **Planning-data normalized:** #1000 and #1003 complete; dashboard shows clean historical sprint assignments

## Non-goals

- Additional pass-rate work beyond what naturally falls out of stress-test follow-ups — Sprint 41 is NOT the pass-rate push
- Full library compatibility for any stress-test target — each is investigation, not completion
- Concurrent React, axios proxy support, lodash Symbol.iterator support, prettier CSS/HTML plugins — all deferred
- Anything currently blocked on upstream dependencies (e.g. #1029 typescript-go migration)

## Notes for the tech lead starting Sprint 41

- **Compact first.** Sprint 40 burned ~43% weekly token budget in one session. Start Sprint 41 in a fresh conversation, read `plan/agent-context/tech-lead.md`, do not `--resume` the Sprint 40 session.
- **Stress-test outputs are the planning fuel for next sprint's pass-rate push.** The follow-up issues each stress test files become Sprint 42's work queue.
- **Dispatch prettier first.** Deterministic self-format diff surfaces the most bugs per CPU-minute.
- **#1013 (codegen/index.ts split) is the largest refactor and should run last** — doing it during stress tests would conflict with every stress-test dev.
- **Don't let Sprint 41 become Sprint 40.** If pass-rate gaps surface during stress tests, file them as follow-up issues for the next sprint — resist the urge to fix them inline here.
