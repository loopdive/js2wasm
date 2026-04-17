# Project Diary

Continuous log of learnings, progress, and incidents. Append new entries at the bottom with date/time.

---

## 2026-03-29 16:25 — Sprint 30 started
- Baseline: 18,284 pass / 48,088 total (38.0%)
- Team: 3 devs + blog agent
- Tasks: #848, #847, #846 (top 3 by impact, non-overlapping files)

## 2026-03-29 16:40 — ff-only merge protocol validated
- First merge attempt (#846) caught stale base — agent rebased, second attempt clean
- Protocol works as designed: ff-only is a strict check, no silent breakage

## 2026-03-29 16:55 — Checklists created
- Pre-commit, pre-completion, pre-merge, session-start checklists
- Key insight: don't embed rules at spawn time — put them in files agents re-read at the moment of action
- Context window drift is real: agents lose spawn instructions after 50K+ tokens

## 2026-03-29 17:10 — Communication discipline defined
- Broadcast only for file claims (others need to avoid conflicts)
- Everything else goes to tech lead directly
- Agents were flooding broadcasts with status updates nobody needed

## 2026-03-29 17:15 — doc commits cause rebase churn
- Every doc commit to main between merges forces agents to rebase again
- Not worth batching (risk losing changes) — added final rebase check right before signaling instead
- The gap between "rebase" and "signal" is where main moves

## 2026-03-29 17:30 — dev-2 rebase problem pattern
- dev-2 repeatedly signals completion, marks task done, moves to new tasks — ignores rebase requests
- Root cause: agent treats "code done" as "task done" but merge hasn't happened
- Retro item: "completed" must mean "merged to main", not "code done"

## 2026-03-29 17:40 — Stale dependency graph discovered
- 3 issues in a row (#824, #857, #850) already fixed by prior work
- Sprint-29 fixes resolved more issues than the dep graph tracked
- Solution: audit remaining issues against current main before dispatching

## 2026-03-29 17:55 — verifyProperty harness diagnosis (high leverage)
- dev-3 found that hundreds of test262 tests fail because the `verifyProperty` harness can't compile
- Root cause: `Object.getOwnPropertyNames` returns externref at runtime but compiler expects WasmGC string array
- This is a #822 sub-pattern — fixing it could unblock hundreds of tests in one shot

## 2026-03-29 18:05 — Architect + Scrum Master roles defined
- Architect bridges PO (what) and devs (how) — writes implementation specs in issue files
- SM runs retrospectives after each sprint
- Full role interaction flow documented in CLAUDE.md

## 2026-03-29 18:20 — Sprint history reconstructed
- Sprint historian created files for sprints 1-29 from git log + run history
- Confirmed we're actually sprint 30 — numbering was correct

## 2026-03-29 18:35 — #822 REGRESSION: -3,999 pass, +8,400 compile errors
- dev-1's #822 fix disabled return_call globally → broke compilation for ~8,400 tests
- Pass count dropped from 18,284 to 14,285 (29.7%)
- Root cause: dev ran "scoped tests" that passed, but didn't run equivalence tests or full test262
- Tech lead (me) also skipped post-merge equivalence tests — violated own pre-merge checklist
- **Learning: checklists only work if everyone follows them. Both dev and tech lead failed here.**
- Reverted #822. Re-running test262 to confirm restoration.
- dev-1 assigned to analyze the regression in their worktree without touching main

## 2026-03-29 18:45 — #822 revert confirmed, post-revert test262
- After reverting #822: 17,670 pass / 48,088 total (36.7%)
- Compile errors back to 2,107 (confirms revert fixed the CE spike)
- 614 fewer passes than baseline (18,284) — likely cache invalidation from source changes
- Sprint-30 net impact (excluding #822): modest improvements in specific areas, no regression in CEs
- **Key learning: a single bad merge can wipe out an entire sprint's gains. Equivalence tests after every merge are non-negotiable.**

## 2026-03-29 19:25 — #822 v2 clean fix merged
- dev-1 analyzed regression: original commit included stale rebase deletions (statements.ts, closures.ts)
- The return_call disable was unnecessary — #839 already handles tail-call safety
- Clean fix: only stack-balance.ts + index.ts repair passes, no tail-call changes
- Cherry-picked to main (couldn't ff-only due to diverged branch history)
- Running test262 to verify no regression

## 2026-03-29 21:15 — #822 root cause analysis
- Both v1 and v2 used post-hoc repair passes (walk instruction stream, splice in coercions)
- Repair passes are inherently fragile: they don't have semantic context, backward walks misidentify producers, splice shifts indices
- `ref.cast_null` for different struct indices assumes same-shape-different-index, but often it's genuinely different structs → runtime trap
- Expanded "safe coercion" set in sub-expressions corrupts the stack when insertion point is wrong
- **Learning: fix type mismatches at generation time (in codegen), not in post-hoc repair passes. This is an architect-level design decision.**

## 2026-03-29 21:03 — Sprint-30 final test262: 18,599 pass (38.7%)
- Clean full run with all devs shut down (9.6GB free RAM)
- +315 pass from session start (18,284 → 18,599)
- -64 CE (2,108 → 2,044)
- The earlier -614 was cache effects from #822 source churn, not real regression
- **Sprint-30 net: modest code gains, major process improvements**

## 2026-03-29 20:35 — Results archiving added
- test262 runner now archives previous JSONL + report with datetime suffix before each run
- Enables test-by-test regression analysis between any two runs
- Previously data was overwritten, making it impossible to diagnose the -614 pass regression

## 2026-03-29 20:00 — #822 v2 ALSO regressed, reverted again
- v2 (clean fix, only stack-balance.ts + index.ts) still caused +6,822 CE (14,810 pass vs 17,670)
- The ref.cast_null and repair passes are too aggressive — introducing more type mismatches than they fix
- Both v1 and v2 reverted. #822 needs a fundamentally different approach.
- **Learning: "targeted" doesn't mean "safe". Even without the return_call disable, the repair passes break compilation. This issue needs an architect to design the approach before a dev touches it.**

## 2026-03-29 19:20 — origin/main vs local main confusion
- dev-1 rebased onto origin/main (stale remote) instead of local main (29 commits ahead)
- We haven't pushed this session — local main diverged significantly from origin
- **Learning: agents in worktrees may resolve `main` to the wrong ref. Need to document that worktree `main` should track local, not origin.**

## 2026-03-29 18:40 — Sprint documentation structure
- Created plan/sprints/ with per-sprint .md files
- Living documents: planning section filled at start, results/retro updated as sprint progresses
- Sprint historian backfilled sprints 1-29 from git history

## 2026-03-30 21:50 — TRUE BASELINE ESTABLISHED: 23,832 pass (49.6%)
- Clean run: cache disabled, isolated worktree build, no agent contention
- Current main = baseline (062a7da2) + #854
- Previous numbers (17-18K) were ALL wrong from stale cache + workspace contention
- The compiler is at ~50% conformance, not ~38%

**CORRECTION (2026-03-31):** The 23,832 was the vitest pass count (includes 6,580 skips counted as pass). True conformance = 17,252. Later analysis found even that was inflated: old runner had a bug where negative tests always passed (both if/else branches said "pass"). After fixing that bug + accounting for sprint-31 reverts, honest baseline = **15,246 pass / 48,174 total (31.7%)**.

## 2026-03-31 20:30 — Sprint 31 redo, test infra overhaul

### Test infrastructure
- Merged #889: unified fork architecture (compile+execute in one child_process.fork). 9 workers, 113MB peak each, 1.7GB total.
- Fixed timestamped result files — test runs no longer overwrite each other.
- Fixed dashboard field name mismatch (`compile_error` → `ce`) and runs/index.json path.
- Single vitest invocation for all 16 chunks (was 16 sequential restarts, ~5 min waste).
- Full test262 run: ~13 min at 62 tests/sec. 15,246 pass confirmed as deterministic baseline.

### Sprint 31 team (6 devs + 1 tester)
- Stale issue problem: 5 of first 12 dev assignments (#844, #835, #836, #841, #829-partial) already fixed on main. Need PO smoke-test before dispatch.
- dev-4 built #891 (equiv test fork pool with flock) — waiting in tester queue behind #839 and #866.
- Memory pressure: 19 concurrent vitest processes from devs ignoring "tester only" rule. Broadcast PAUSE, no OOM but hit 3.8GB available.
- Tester bottleneck: merge queue growing (6 branches waiting). Single tester is serial, each equiv run ~3 min. Need #891 merged first to add flock + speed up tests.

### Regression analysis
- 18,284 → 15,246 fully explained: stale cache (~3K), negative test bug (~900), sprint-31 reverts (~2,100).
- No new bugs from #889 unified fork merge.
- Sprint-31 issues (#839, #866, #822, #826, #862) cover all recoverable tests.

### Key learnings
- **Devs must not run tests** — only tester. Without flock (#891), concurrent test runs eat memory.
- **Smoke-test issues before dispatch** — too many stale assignments waste agent time.
- **Tester is the bottleneck** — consider 2 testers or faster equiv tests when queue > 3.
- **Dashboard needs correct field names** — `ce` not `compile_error`, `skip` required.

## 2026-04-11 09:00–13:00 — Sprint 40/41 merge wave + context-discipline reset

### Pass rate
- Start: 20,711/43,164 (47.98%)
- End: 21,190/43,164 (49.09%) — **+479 in one session**, 392 from the 50% goal

### Merges (in order)
- PR #43 #929 Object.defineProperty on wrapper objects (+258)
- PR #68 #1022 Array.prototype method dispatch (+106)
- PR #71 #1023 __unbox_number(null) ToNumber semantics (+56)
- PR #64 #983 WasmGC opaque / live-mirror Proxy (+34)
- PR #70 CI: dispatch Pages deploy after sharded baseline refresh
- PR #73 close stale #984

### Closed (did not merge)
- PR #72 #1026 first attempt — catastrophic −18,504, over-broad __get_builtin rewrite broke the compiler
- PR #75 #1025 first attempt — net −114, blanket `ref.is_null` → `__extern_is_undefined` replaced some genuine struct-ref null guards
- PR #65 #1017 P3 yield* — marginal +2, orphaned by dev-1017 scale-down

### New issues filed this session
- #1025 BindingElement array-pattern audit — reopened after PR #75 close, scoped narrower
- #1026 String/Number/Boolean.prototype globals access — priority raised, scope documents exact failing tests
- #1027 Missing `__make_getter_callback` late-import in PR #43 path
- #1028 TypedArray.prototype.toLocaleString element null path
- #1029 Migrate to typescript-go (TS 7.x) — blocked on upstream API stability (microsoft/typescript-go#516)
- **Not yet filed: #1030 Array.prototype "object is not a function" long tail (372 tests)** — highest-impact unclaimed work for next session

### Sprint reassignments
- Moved error fixes to Sprint 40 (#1025, #1026, #1027, #1028, #832)
- Moved non-error work to Sprint 41 (#824, #1000, #1001, #1003, #1004, #1005, #1008, #1009, #1011, #1013)
- #832 almost moved to Sprint 41 as "infra" but user caught it — TS 6 upgrade unblocks 82 test262 parse-fails, it's an error fix

### Incidents
- **OOM kill mid-session** at ~10:44 — 30+ claude processes from accumulated tmux panes + 13 concurrent vitest runs + a stray `/tmp/probe-998.mts` from dev-998 stuck at 93% CPU for 10 min. Recovered 1.3GB by killing the stray + duplicate vitest runs. New rule broadcast: one vitest per dev at a time, no stray probes.
- **Team channel lost after kill** — tried resuming wrong session ID (dev-1022's jsonl) before identifying correct tech-lead session via `team-lead` string count (0ffbd21c, 721 matches).
- **Stale landing page** — PR #67 merged but sharded baseline refresh committed with `[skip ci]`, blocking Pages deploy. Manually triggered redeploy + filed PR #70 for permanent fix.
- **False-positive regressions** — PR #43's 12 "regressions" were `String.prototype.writable = true` tests that coincidentally "passed" on main because we compiled them to harmless `drop`. Tracked by #1026. Dev-929 caught this pattern.

### Context / budget
- Session burned ~43% of weekly token budget in one sitting. Primary drivers: long continuous context across triage + merge + planning + UI + infra phases; repeated full-file reads; leaked dev scratch (~50 untracked files) polluting every `git status`.
- **Mitigations applied this session:**
  - Moved all leaked scratch to `.tmp/` (gitignored, `b09a8d74`)
  - Added root-level scratch patterns to `.gitignore` as safety net
  - Documented convention in CLAUDE.md
- **Rules saved to memory:**
  - `feedback_compact_before_sprint.md` — /compact at sprint boundaries
  - `feedback_context_discipline.md` — stop re-checking state, split planning/execution, write handoffs to `plan/agent-context/tech-lead.md` instead of --resume
  - `feedback_team_comm_channels.md` — devs use TaskUpdate not verbose SendMessage; shutdown handoffs via agent-context files
  - `feedback_token_budget_guardrails.md` — warn at 25%, force break at 40%, hard stop at 50%
  - `feedback_dev_self_serve_tasklist.md` (earlier today) — devs claim next task from TaskList after merge, no re-dispatch

### Key learnings
- **Blanket `ref.is_null` → `__extern_is_undefined` replacements are dangerous** — some ref.is_null calls guard genuine WasmGC struct nulls, not JS undefined. PR #75 learned this the hard way (−114).
- **File-pattern issue fixes need path-conditional logic** — PR #72 (#1026) globally intercepted any builtin identifier path, breaking the compiler. Narrow patches with clear is-this-really-the-thing-I-want guards are mandatory.
- **"Regressions" on big-delta PRs are usually false positives** — when a PR flips 300+ tests pass, 20-30 new fails are almost always previously-coincidental passes being honestly exposed. Sample before blocking.
- **Dev scratch at repo root costs real tokens** — every `git status` dumps the noise into context, compounding over the session. `.tmp/` convention fixed this permanently.
- **Session resume is not free** — a `--resume` that brings back a compaction summary costs multi-thousand tokens every tool call forever. Write handoffs to disk instead.

---

## 2026-04-11/12 — Sprint 40 final session + CI crisis

### Timeline
- **16:00-18:57 UTC**: Sprint 40 merge wave — 13 PRs landed (#86-#106), baseline reached 22,157 (51.3%)
- **19:07 UTC**: Baseline silently flipped to 20,599 after PR #96 merge
- **19:20 UTC**: Pipeline PAUSED, investigation started
- **19:30-20:30 UTC**: Artifact-diff bisect (dev-1053), source audits (dev-1031), fork-worker analysis (dev-1047)
- **20:56 UTC**: PR #114 (3-PR revert) admin-merged as rescue — baseline restored to 22,157
- **21:00-22:00 UTC**: Reapply sequence — #107 clean (PR #116), #100+#96 catastrophic (PR #119 at 37k CE)
- **22:00+ UTC**: Sprint wrap-up, Sprint 41+42 planning by PO, spec references added to 72 issues

### Numbers
- Sprint 40 start: 18,899 pass (43.80%)
- Sprint 40 end: 22,185 pass (51.40%)
- Net: **+3,286 pass (+7.6 percentage points)**
- PRs merged this session: 24
- New issues filed: 28 (#1066-#1093)

### CI baseline-drift incident
- Root cause: stale-baseline gate prevents main from refreshing → PRs compare against frozen reference → regressions attributed to "drift" → compound silently
- Contributing factor: fork-worker compileCount++ bypassed on error path → RECREATE never fires under error-heavy chunks
- Contributing factor: ci-status-feed `delta` was absolute snapshot not per-test net → devs self-merged on misleading signal
- Fixes: #1082 (net_per_test, merged), #1084 (fork-worker fix, merged as PR #118), #1076-#1081 filed for structural hardening
- Reusable playbook: `plan/issues/sprints/40/sprint.md`

### Key learnings
- **Stale-baseline drift inflates PR deltas ~5x** — individual CI feeds claimed +2,778 combined, reality was +407
- **Walker-recursion hypotheses need empirical revert probes** — dev-1031's bodyUsesArguments and walkInstructions theories were mechanistically sound but empirically refuted (PR #115 had zero effect)
- **Cherry-pick ≠ reland** — #96's cherry-pick onto post-#108/#110 main caused 37k CE catastrophe from semantic conflicts that text-level merge didn't catch
- **Fork-worker RECREATE_INTERVAL matters** — lowering 200→100 via PR #118 was the actual CI recovery mechanism
- **Always fetch the spec** — new memory rule: fetch tc39.es/ecma262 before fixing test failures, cite spec section in commits
- **72 open issues now have spec references** — systematic batch by spec-linker agent

---

## 2026-04-12 — Sprint 41: pass-rate push + CI prototype-poisoning crisis

### Pass rate
- Start: 22,185/43,171 (51.40%)
- End: 22,412/43,172 (51.92%) — **+227 in one sprint**

### CI prototype-poisoning crisis (major finding)
- Discovered that test262 tests mutate built-in prototypes (Array.prototype[Symbol.iterator], Object.defineProperty on Array.prototype, etc.) which permanently poison the TypeScript compiler running in the same fork-worker process
- This caused ~37K false compile errors, dropping CI from 22,185 to 2,262
- Three-layer fix: (1) restore configurable mutations after each test, (2) exit+restart worker on non-configurable mutations, (3) bust poisoned cache with v2 prefix
- Recovery: 2,262 → 22,412 (+20,150 tests recovered)
- CI cache key expanded to include worker scripts
- Baseline promote step now handles rebase conflicts

### Sprint 41 merges (8 PRs)
- PR #120 #997 BigInt comparison
- PR #121 #1091 8 early error rules
- PR #122 #1018 ambient built-in constructors
- PR #123 #1090 ToPrimitive for WasmGC closures
- PR #124 #1024 sNaN sentinel for undefined/holes
- PR #125 #1092 WasmGC array identity in defineProperties
- PR #127 #1085 bodyUsesArguments iterative DFS
- PR #129 #1053 arguments.length __extras_argv

### Key learnings
- **test262 tests poison shared-process JS state** — any runner sharing compile+execute in one process MUST sandbox built-in prototypes
- **CI baselines must come from CI, not local runs** — local runs miss fork-worker-specific regressions
- **Non-configurable prototype mutations require process restart** — no JS-level cleanup possible
- **Cache keys must include all compilation-relevant files** — worker scripts affect results just as much as source code
