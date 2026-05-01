# senior-promise-leaks — context summary

**Sprint:** 46
**Issue:** #1220 (`test262-worker: Promise snapshot + prototype cleanup gaps`)
**Task:** #29
**Branch / worktree:** `/workspace/.claude/worktrees/issue-1220-test262-worker-snapshots`
**PR:** https://github.com/loopdive/js2wasm/pull/114
**Last commit:** `81ada19b8` (v2 — drops FATAL exit, keeps cleanup + Promise snapshot)
**Status at shutdown:** PR open, CI in progress on `81ada19b8`, awaiting status file update.

---

## What was done

### Investigation (pre-implementation)
Diagnosed two test isolation patterns reported by team-lead:
1. **`Promise.resolve is not a function` (26 tests)** — root cause: `_STATIC_SNAPSHOTS` in `scripts/test262-worker.mjs` covers Array/Object/String/Number/Math/JSON/Reflect/RegExp but **not Promise**. Tests under `built-ins/Promise/{all,any,race,allSettled}/invoke-resolve*.js` mutate `Promise.resolve = function(...) {...}` and never restore. Subsequent tests in the same fork crash because Node's `Promise.all` calls `this.resolve(value)` internally. Confirmed via inline repro: after running a mutator test, `typeof Promise.resolve === "object"` survives across runs.
2. **`Cannot redefine property` (23 tests)** — split into 3 sub-causes:
   - 2A (3 tests): test isolation, prototype poisoning of Number/TypedArray/Iterator (this PR's scope)
   - 2B (10 tests): real compiler bug — `instanceof TypeError` doesn't unwrap host TypeError thrown by `Object.defineProperty`. **Defer S47.**
   - 2C (9 tests): real compiler bug — mapped-arguments semantics. **Separate issue.**

Findings written to `plan/notes/promise-redefine-investigation.md`.

### Implementation v1 (commit `e659a18c1`) — REGRESSED
- Bug A: added `["Promise", Promise, ["resolve", "reject", "all", "allSettled", "any", "race"]]` to `_STATIC_SNAPSHOTS`. ✓ (worked perfectly: 34 Promise improvements observed)
- Bug B v1: snapshotted own keys/symbols for 18 host prototypes; in `restoreBuiltins`, deleted extras; on non-configurable poison, `process.exit(1)` to force fork respawn (mirrored existing Array.prototype FATAL precedent at line 514).

CI result: `net=-7`, `regressions=157`, `compile_timeouts=136`. The `process.exit(1)` was the cause:
- ~51 TypedArray + ~30 Number tests defineProperty without `configurable: true` → 80+ FATAL exits per shard
- Each exit raced libuv: `process.send(prevTestResult)` queued the message, but `process.exit(1)` ran synchronously **before** the IPC channel flushed → previous test's result lost → pool sat on the pending job until 30s timeout
- Verified by cross-PR check: PRs 109-115 baseline 100-150 timeouts; mine had +71 above that, concentrated in TypedArray bucket (33 regressions, 31 timeouts)

### Implementation v2 (commit `81ada19b8`) — CURRENT
- Removed `_protoPoisonName` detection + `process.exit(1)` block (21 lines)
- Removed unused `name` from destructure
- Kept the cleanup loop — still cleans up tests using `configurable: true`
- Added an explanatory comment block citing the v1 CI evidence so future devs don't reintroduce the FATAL

Expected v2 CI: `net ≈ +26` (Bug A clean win), 3 Bug B isolation tests stay broken (revert to current baseline behavior).

---

## Next steps (for whoever resumes)

### If CI on `81ada19b8` is green (`net_per_test > 0`, no bucket >50, ratio <10%):
1. `gh pr merge 114 --admin --merge`
2. In `plan/issues/sprints/46/1220.md` set `status: done`, add brief outcome note.
3. Update `plan/log/dependency-graph.md` — strike #1220.
4. `git worktree remove /workspace/.claude/worktrees/issue-1220-test262-worker-snapshots`
5. `TaskUpdate #29 status: completed`

### If CI still regressed:
- Check `.claude/ci-status/pr-114.json` for SHA match `81ada19b8d23e842b1f5f0ab8fa0a5a2c4e16767`
- Cross-check against other open PRs (`pr-1{09..15}.json`) for baseline drift
- Specific suspicion path: even without FATAL exit, the cleanup loop iterates 18 protos × N keys per test (~7μs measured locally). Should be negligible (<1s total per shard) but worth checking timing of new compile_timeouts vs baseline if regressions persist.

### Background monitor
- ID: `b2zwljmi2` — `until [ "$(jq -r '.head_sha' /workspace/.claude/ci-status/pr-114.json)" = "81ada19b8d23e842b1f5f0ab8fa0a5a2c4e16767" ]; do sleep 30; done`
- Output: `/tmp/claude-1000/-workspace/431000da-a0a6-4277-9278-fa94076b290e/tasks/b2zwljmi2.output`
- Will fire when the CI status file updates.

### Future Bug B recovery (deferred to S47)
The 3 tests (Iterator/map/this-non-object.js, TypedArray/findLastIndex/get-length-ignores-length-prop.js, + 1 sibling) need a safer prototype-poison recovery than `process.exit(1)`. Two viable approaches:
1. `process.disconnect()` then `setImmediate(() => process.exit(1))` — disconnects the IPC channel cleanly so libuv flushes the pending message before exit.
2. Per-test fork recycle for known-polluter test paths (path-allowlist, force `RECREATE_INTERVAL=1` for those paths).

Either way: **must not** call bare `process.exit(1)` synchronously after `process.send(...)` — that's the libuv flush race that caused v1's regression.

---

## Files touched

- `scripts/test262-worker.mjs` (only file modified in PR #114)
- `plan/notes/promise-redefine-investigation.md` (created during investigation, kept)

## Files NOT touched

- All `src/` — zero compiler changes
- All other planning files — tech-lead owns them

---

## Sessions/spawn metadata

- Spawned by team-lead with senior-developer agent definition
- Used with sonnet model (per default)
- bypassPermissions + worktree isolation
- No subagents spawned
