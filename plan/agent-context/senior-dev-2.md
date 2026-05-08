# senior-dev-2 — Sprint 50 context summary

**Status**: terminating (shutdown approved 2026-05-08, sprint 50 complete).

## Work landed this session

### PR #264 — #1311 closure-struct identity (merged c12c03071)
- **File**: `src/codegen/closures.ts::isHostCallbackArgument`
- **Bug**: arrow args passed to `recv.method(arrow)` for user-defined class methods were lowered through host `__make_callback` (returns null in test stubs / JS-wrapped externref otherwise). Receiving method body's later dispatch site expected the WasmGC `__fn_wrap_N_struct` shape → `ref.test` failed → null fell through → `struct.get` / `return_call_ref` null-derefed.
- **Fix**: detect PropertyAccessExpression callees whose method maps to a user-defined `funcMap` entry. Walks receiver type symbol + `getBaseTypes()` for inheritance. Built-in receivers (Array/Map/Promise/Set) miss the lookup → host-callback fallthrough preserved.
- **Tests**: `tests/issue-1311.test.ts` — 5 cases (minimal, inherited, sync handler in Map, Hono async-handler reproducer, mixed sync+async).
- **CI result**: `net_per_test: +37`, `regressions_real: 7`, `improvements: 44`.

### PR #267 — #1343 Slice 2 Date time-of-day setters (merged ac0d66f4a)
- **File**: `src/codegen/expressions/builtins.ts::compileDateMethodCall`
- **Bug**: `setMilliseconds`, `setSeconds`, `setMinutes`, `setHours` (+ UTC variants) weren't in the `DATE_METHODS` allowlist. ~58 of 174 `built-ins/Date/prototype` fails were just calls falling through to externref dispatch.
- **Fix**: pure-Wasm i64 arithmetic — keep day-of-epoch portion fixed, rebuild ms-of-day from args (ToInteger via i64.trunc_sat_f64_s) or current component values for omitted args. UTC variants share impls (Wasm Date is already UTC).
- **Tests**: `tests/issue-1343-date-setters.test.ts` — 11 cases.
- **CI result**: `net_per_test: +70`, `improvements: 80`, `regressions_real: 10` (at threshold but well within criteria).

## #1343 follow-up slices (not done — for next dev)

The issue file `plan/issues/sprints/50/1343-spec-gap-date-prototype-formatters.md` has the full revised 5-slice plan. Slice 2 landed; remaining:

- **Slice 1**: NaN propagation / Invalid Date sentinel (~7 fails). The current Date impl uses `i64.trunc_sat_f64_s` which silently turns NaN into 0 — there's no Invalid Date sentinel. Adding one requires touching all getters and setters consistently (use `i64.MIN` as sentinel or switch struct field to f64).
- **Slice 3**: calendar setters `setDate` / `setMonth` / `setFullYear` and UTC variants (~36 fails). Need a new helper `__date_components_from_timestamp` that returns (y, mo, d, h, mi, s, ms) so the existing `__date_days_from_civil` can recompose with replaced fields.
- **Slice 4**: `Symbol.toPrimitive` / `toJSON` Invalid Date handling (~13 fails). `toJSON` per §21.4.4.42: ToPrimitive(this, "number"); if !isFinite, return null; else call toISOString. `Date.prototype[Symbol.toPrimitive]` needs to be registered as a method.
- **Slice 5**: `toString` / `toUTCString` format polish for edge years (~16 fails). Negative years `-000001` (6-digit), 5-digit years `+002025` (7-digit prefixed).

`toTemporalInstant` (6 fails) is the Temporal proposal — already in skip filters, no work needed.

## Worktrees still on disk

- `/workspace/.claude/worktrees/issue-1311-senior` — clean to remove (PR merged)
- `/workspace/.claude/worktrees/issue-1343-date-formatters` — clean to remove (PR merged); contains the issue file with the 5-slice plan

## Patterns learned this session

- **Arrow-lowering decision is in `isHostCallbackArgument`**, not in any of the call-site dispatch paths. The construction-site decision determines what shape the receiver gets, regardless of how the receiver later uses it.
- **Receiver-type → class name → funcMap** is the canonical way to test for user-defined methods. Use `getBaseTypes()` to walk inheritance.
- **Date is pure Wasm**, NOT host-imported. Issue files referring to "host externref forwarder" for Date are stale — Date has been i64-native since Hinnant's algorithm landed.
- **PR-batching observation**: PR #267 auto-merged before I explicitly issued `gh pr merge`. CI status file watcher's completion plus matching SHA may trigger auto-merge in this team's setup.

## Tasks status at shutdown

- Task #31 (#1311) — completed.
- Task #45 (#1344/#1343) — Slice 2 done, Slices 1/3/4/5 pending. Issue file has the plan; reassign to a fresh dev or pick up on a future session.

Outgoing.