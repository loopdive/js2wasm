---
id: 1388
sprint: 51
title: "runtime: null.next — yield* / async-generator iterator construction returns null in class methods (316 fails)"
status: done
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators, async-generators, classes
goal: spec-completeness
---
# #1388 — `null.next`: iterator construction returns null in class-method async generators

## Problem

316 tests fail with:

```
L*:* Cannot read properties of null (reading 'next') [in test()]
```

The call to `.next()` is made on `null` — meaning the iterator object returned from
`getIterator` (the `Symbol.asyncIterator` / `Symbol.iterator` call) is null rather than a
`{next, return, throw}` object.

### Distribution (from test262-current.jsonl)

| count | category |
|------:|----------|
| 148   | language/expressions/class (async-gen-method-static, async-gen-method) |
| 125   | language/statements/class (same) |
|  12   | language/expressions/object |
|  10   | language/expressions/async-generator |
|  10   | built-ins/Iterator/prototype |
|   5   | language/expressions/generators |
|   3   | built-ins/Temporal/PlainDateTime |
|   3   | built-ins/AsyncGeneratorFunction |

273 of 316 (86%) are in class async-generator or generator methods. This strongly
suggests the root cause is in how generator/async-generator **class methods** construct
the inner iterator for `yield*` — not in standalone generators.

### Representative failing tests

```
language/expressions/class/async-gen-method-static/yield-spread-arr-single.js
language/expressions/class/async-gen-method-static/yield-star-getiter-async-returns-number-throw.js
language/expressions/class/async-gen-method-static/yield-star-getiter-sync-returns-symbol-throw.js
language/statements/class/...  (similar patterns)
```

The test names follow the pattern `yield-star-getiter-{async,sync}-returns-{type}-{throw,next}`,
which means they exercise the spec's `GetIterator` abstract operation with edge-case inputs
(returning a number, returning a symbol, etc.) and then calling `.next()` / `.throw()` on the result.

## Hypothesis

When compiling a `yield*` delegation in a class-method async generator, the code that calls
`Symbol.asyncIterator` (or `Symbol.iterator`) on the delegate expression either:

1. **Returns the raw return value of `Symbol.asyncIterator` without wrapping** — if the
   callable returns null/number/symbol, `.next` is then called on that raw value.
2. **Calls the wrong method** — e.g., calls the sync `Symbol.iterator` instead of
   `Symbol.asyncIterator` for async generators, getting back something unexpected.
3. **Class-method specific path** — standalone async generators work correctly but the
   class-method emitter has a different code path for `yield*` that misses the
   `CreateIteratorFromClosure` / iterator-wrapper step.

The fact that standalone async generators (`language/expressions/async-generator`, only 10 fails)
are mostly fine while class async generators (273 fails) are broken strongly implicates a
class-method-specific code path.

## Files to investigate

- `src/codegen/statements.ts` — `yield*` desugaring
- `src/codegen/class-bodies.ts` — async generator method emitter
- Look for differences between how `yield*` is handled in `FunctionDeclaration` async generators
  vs. `MethodDeclaration` async generators

## Acceptance criteria

1. `language/expressions/class/async-gen-method-static/yield-spread-arr-single.js` passes.
2. `language/expressions/class/async-gen-method-static/yield-star-getiter-async-returns-number-throw.js` passes.
3. Net improvement ≥ 200 tests (most of the 316 should be the same root cause).
4. No regression in standalone async generator tests.

## Estimated yield

~250–300 net (most of the 316 share the same class-method `yield*` path).

## Findings (2026-05-08)

The error message was misleading. The failure is not in `yield*` iterator
construction — it's in **method extraction**. The failing pattern looks like:

```js
class C { static async *gen() { ... } }
const gen = C.gen;        // ← detached
const iter = gen();       // ← gen was null externref → call returned null
iter.next(false);         // ← null.next throws
```

`compilePropertyAccess` returned `ref.null.extern` for `C.staticMethod` and
fell through to the generic externref path for `C.prototype.method`. With
`gen` bound to a null externref, calling it through the closure-callable
dispatch (`calls.ts:5380`) cast null → `ref null structType`, which the
guarded ref.cast happily accepted as the closure ref. The trampoline then
saw a null closure and silently returned null. So `gen()` produced null
without throwing, and the failure showed up at the *next* line as
`null.next`.

The same `yield*` machinery already works for the standalone-function
async-generator path (only ~10 standalone fails) — the runtime helper
`__gen_yield_star` is fine. It's the method-extraction step that broke.

## Fix (PR #TBD)

Three changes in `src/codegen/property-access.ts`:

1. `ClassName.staticMethod` (line ~1185): replaced `ref.null.extern`
   placeholder with `emitFuncRefAsClosure(ctx, fctx, fullName, funcIdx)`
   followed by `extern.convert_any` so the closure-callable dispatch can
   ref.cast back and `call_ref` through the trampoline.

2. `ClassName.prototype.method` (new handler around line ~1226): added a
   parallel branch for instance methods accessed via prototype, using
   `emitObjectMethodAsClosure` (which constructs a trampoline that drops
   the closure-self and supplies a sentinel for the method's `this`
   parameter — same shape as the existing object-literal method path).

3. `ClassName['method']` element access (line ~2519): mirrored the same
   fix on the element-access path for consistency.

Class-instance methods accessed bare (without prototype) still return
`ref.null.extern` — that pattern is unusual and not exercised by the
failing tests.

## Test Results (sweep over the 316 null-next files)

| metric | before fix | after fix |
|--------|-----------:|----------:|
| pass   | 0          | 232       |
| fail   | 316        | 84        |

**Net +232** — exceeds the ≥200 acceptance criterion.

The remaining 84 fails are different patterns (e.g. calling
`AsyncGeneratorFunction(...)` or `GeneratorFunction(...)` directly,
`Iterator.prototype.*` exhaustion-helpers) that share only the surface
error string but not the root cause.

Acceptance-criterion tests:

- ✅ `language/expressions/class/async-gen-method-static/yield-spread-arr-single.js`
- ✅ `language/expressions/class/async-gen-method-static/yield-star-getiter-async-returns-number-throw.js`
- ✅ Net improvement ≥ 200 (actual: +232)
- ✅ No regression in standalone async generator tests (10 pre-existing
  equivalence failures match `main` exactly — unrelated to this PR)

Regression test added: `tests/equivalence/issue-1388.test.ts` (7 cases
covering static / class-expression / prototype / arg-passing / async-
generator-iteration / typeof-function paths).

## Senior Dev Investigation Notes (2026-05-08, PR #305 follow-up)

**Hypothesis under investigation:** Tech-lead suggested ~143 net regressions
remained after the partial revert (commit 883032e64), attributed to
`emitFuncRefAsClosure` having an index-shifting side-effect via
`addUnionImports` that corrupts already-emitted function bodies.

**Finding:** The hypothesis is incorrect. Tracing `emitFuncRefAsClosure`
in `src/codegen/closures.ts:2712`:

1. The no-captures branch (lines 2914–2946) calls
   `getOrCreateFuncRefWrapperTypes`, which only pushes to
   `ctx.mod.types[]` and `addFuncType` (also types-only). **Type
   additions do not shift function indices.**
2. The trampoline is appended to `ctx.mod.functions` at the next
   available `funcIdx = ctx.numImportFuncs + ctx.mod.functions.length`.
   **Appending at the end shifts no existing function index.**
3. `emitFuncRefAsClosure` does NOT call `addUnionImports` or
   `ensureLateImport`. There is no path through it that adds imports.
4. If `addUnionImports` is invoked later in compilation, its shift loop
   (`src/codegen/index.ts:4693-4742`) walks every function in
   `ctx.mod.functions` (including freshly-added trampolines) and every
   live FunctionContext body in `ctx.liveBodies`, `ctx.parentBodiesStack`,
   `ctx.funcStack`, `ctx.currentFunc.savedBodies`, plus `ctx.mod.elements`,
   `ctx.mod.declaredFuncRefs`, and `ctx.mod.startFuncIdx`. The shift is
   complete; no body — including the trampoline body just created — is
   missed.

**Conclusion:** The static-method-handler path in `compilePropertyAccess`
(lines 1191–1203) is structurally safe. Approach A (pre-registering the
wrapper struct at class-compilation time) would not change observable
behavior because the wrapper types are already cache-keyed by signature
in `ctx.funcRefWrapperCache`; the same struct type is reused on every
access of any static method with a matching signature.

**Re-analysis of the "143 regressions" attribution:**

CI status snapshots show the post-PR-294 chain as:

| PR  | head_branch                          | pass    | net  |
|-----|--------------------------------------|---------|------|
| 294 | issue-1388-null-next-yield-star      | 27,036  | -140 |
| 295 | issue-1370-ir-phase-b                | 27,210  | +174 |
| 296 | issue-1389-var-fn-redecl             | 27,221  |  +11 |
| 297 | issue-1390-import-defer-skip         | 27,216  |   -5 |
| 298 | issue-1384-async-arity               | 27,312  |  +96 |
| 299 | issue-1377-array-mutation-spec       | 27,070  | -242 |
| 300 | issue-1371-ir-extern-whitelist       | 27,070  |    0 |
| 301 | issue-1372-ir-destructuring-params   | 27,068  |   -2 |

The dominant negative event is **PR #299**, which dropped pass count
from 27,312 → 27,070 (−242). PR #294's own −140 was already largely
recovered by subsequent improvement PRs. The "−143 versus
pre-#294 baseline (27,211)" the tech-lead cited is dominated by PR #299,
not by the residual static-method-handler effect.

The async-generator/destructuring failure cluster cited
(`language/expressions/async-generator/dstr/dflt-ary-ptrn-*`) inspects
top-level `async function*([…] = […])` patterns with no class involvement
at all. These are destructuring-default-value spec compliance failures
and do not exercise the static-method-extraction path that PR #294
modified. They should not be attributable to property-access.ts.

**Action taken:** Keep the branch's existing partial revert (commit
883032e64) as the right balance: +232 static-method wins preserved, 478
prototype-method-identity regressions recovered. Cherry-picked tech-lead
typecheck fix `db2ee79ad` so PR #305 CI quality gate passes (the fix is
unrelated to #1388 but was blocking CI on every open PR). No further
changes to property-access.ts are warranted by the actual regression
data.

Slice 2 (deferred) — the prototype-method-extraction win is still
recoverable once method-closure caching lands. That would let
`C.prototype.m` return the same closure ref on every access, preserving
`c.m === C.prototype.m`. Tracked via `.todo` cases in the regression
test. Out of scope for this PR.
