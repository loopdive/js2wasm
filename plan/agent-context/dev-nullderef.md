# dev-nullderef context — 2026-04-20/21

## Session summary

Dev agent for sprint 42. Worked one issue to completion + several ops/coordination tasks for team-lead.

### Task — Issue #1149 (completed, merged as PR #241)

**Problem**: 32 test262 tests in `test/language/eval-code/direct/` failing with `null_deref` trap — pattern `{async-gen-meth,gen-meth,meth}-*-declare-arguments*`. Tests follow:
```js
let o = { f(p = eval("var arguments")) { function arguments() {} }};
assert.throws(SyntaxError, o.f);
```

**Root cause** (not what the issue file originally hypothesized):
The regression was in `compilePropertyAccess` handling the detached `o.f` reference passed to `assert_throws(SyntaxError, o.f)` (which the test262 runner rewrites to `assert_throws(o.f)`). The "method-as-value" handler at `src/codegen/property-access.ts:1605` was gated on `ctx.classSet.has(typeName)`, but object-literal struct types are NOT in `classSet` — that's only populated for class declarations in `class-bodies.ts:55`. Object-literal methods register in `ctx.classMethodSet` under `${typeName}_${propName}`.

So for `o.f` on an object literal, the gate blocked the method-as-value path; fallthrough hit `patchStructNewForAddedField` which added a null-defaulted struct field. Invoking that null reference produced `null_deref` instead of TypeError.

**Fix** (1 file, +8/-2 lines):
Removed the outer `classSet.has(typeName)` gate. The inner `classMethodSet.has(methodFullName)` check is already sufficient (methodFullName encodes the struct type). `o.f` now correctly emits `ref.null.extern`; calling that throws a TypeError that `assert_throws` catches → test passes.

**Result**: 0/24 → 24/24 null_deref tests pass. 12 remaining CEs are pre-existing unrelated compile errors for `arguments`-as-param-name + implicit-any `this`. PR #241 merged 2026-04-20 22:26 UTC.

**Issue status**: Moved to `status: done` in `plan/issues/sprints/42/1149.md` (includes full Test Results section).

### Task — Issue #1150 Bucket C (stood down, filed architectural issue #1151)

**Assigned but handed off**: dev-asyncdstr's PR #243 already covered Bucket C via symptom-level guards. Team-lead had me stand down and file the architectural root cause instead.

**Architectural finding** (filed as `plan/issues/backlog/1151.md`):
Async functions compile with unwrapped `T` return type; call site wraps with `Promise.resolve` via `wrapAsyncReturn` (expressions.ts:163). If the body throws synchronously (destructure null, TDZ, etc.), the throw propagates past `wrapAsyncReturn` → Wasm trap instead of rejected Promise. Spec requires async functions to ALWAYS return a Promise; exceptions during body execution must become rejections.

**Fix options documented**:
1. **Correct**: wrap async body in Wasm try/catch; change return type to externref; emit `return_call Promise_resolve` on fall-through, `return_call Promise_reject` on catch. Touches function-body.ts, closures.ts, class-bodies.ts, literals.ts, declarations.ts. Deserves architect-spec.
2. **Incremental**: per-throw-site guards (what PR #243 did).

11/11 sampled Bucket C tests trap with `"Cannot destructure 'null' or 'undefined'"` from `__throw_type_error` — confirms root cause independent of the specific destructuring site.

### Ops tasks for team-lead

1. Closed PRs #208, #211, #231 as duplicates/subsumed. Flagged #231 mismatch ("feat(ir) Phase 1" doesn't look like a #202 duplicate) → team-lead reopened #231.
2. Commented on PR #144: it deletes `buildWasiPolyfill` from runtime.ts without updating `src/index.ts:294` which imports it → build break if merged.
3. Rerun CI on failed runs for PR #160 (branch `issue-1076-ci-merge-split`).
4. Pushed empty `[CHECKLIST-FOXTROT]` commits to trigger fresh CI on PRs #202, #221, #233, #194 after PR #162 landed live-baseline fetching on main. SHAs: f10d97b8, 868ad7f0, 8555c5ad, e51f5605.

## Worktrees owned

- `/workspace/.claude/worktrees/issue-1149-eval-method-arguments` on branch `issue-1149-null-deref-eval-method` — branch merged, can be removed.
- `/workspace/.claude/worktrees/issue-1150-forawait-dstr` on branch `issue-1150-forawait-dstr` — stood down, no commits pushed beyond empty; can be removed.

## Handoff notes for next session / replacement

- **#1151** is the architectural follow-up to watch. If baseline refresh after PR #162 + everyone's empty-commit re-triggers reveals lingering async-throw traps that #243's incremental fixes don't cover, that's the spec issue to pursue next.
- **Don't revert #1149's property-access.ts change**: the inner `classMethodSet.has(methodFullName)` check IS sufficient to restrict the codepath. The classSet gate was accidentally too narrow.
- **Test infrastructure note**: many `tests/*.test.ts` files in the worktrees fail to load with `Failed to load url ./helpers.js` — no such file exists in main either. These are pre-existing load failures, not regressions.
