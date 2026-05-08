# senior-dev — Context Summary

**Last session**: 2026-05-08
**Status at shutdown**: handed off, #1370 awaiting architect re-spec

## Summary of this session's work

5 PRs merged totaling **+331 net** test262 conformance:

| PR  | Issue | Net | Notes |
|-----|-------|----:|-------|
| #283 | #1312 | +135 | Async recursion: narrowed nested-decl pre-registration to has-captures branch only (supersedes closed #257) |
| #286 | #1368 | +37  | Promise aggregators thisArg plumbing — `Promise_{all,race,allSettled,any}` now take `(thisArg, iter)`, delegate to `Promise.X.call(C, iter)` |
| #287 | #1367 | +89  | Iterator helpers via Iterator.prototype bridge — synthesized iterators inherit from `Iterator.prototype` so .drop/.take/.map/etc. work natively (30 LoC) |
| #288 | #1386 | +41  | Promise.race hang reclassify — verified compile no longer hangs (1.5s); removed from `HANGING_TESTS`, now reports as compile_error |
| #289 | #1377 Slice A | +29 | Array.pop/shift on empty: return JS `undefined` (not `null`) for externref/anyref element types |

Plus 2 doc-only PRs (#290 merged, #292 closed) and 1 investigation PR for #1384 with documented findings.

## Open structural findings (handed off to architect)

### #1377 Slice B+ — externref identity bug

**Surprising probe result on plain JS object** (NOT WasmGC):

```ts
const obj: any = {};
obj.length = 2;
const v = (Array.prototype.push as any).call(obj, 99);
JSON.stringify({v: v, length: obj.length, two: obj[2]})
// → {"v":3,"length":2}  ← length still 2, two missing!
```

Native push.call(obj, 99) returns 3 correctly, but mutations on obj.length and obj[2] are not visible to subsequent reads. Imports used: `__extern_method_call` (push) + `__extern_get` (length read) — both plain JS paths, no proxy.

**Hypothesis**: the externref bridge boxes/unboxes the same wasm-side `obj` to different JS values per call site. May also explain #1358 (array-like callback methods) failures.

Probes in `/workspace/.claude/worktrees/issue-1377b-length-coercion/.tmp/`:
- `probe-trace.mts` — Tests A-E narrowing
- `probe-codepath.mts` — confirms imports used

### #1384 — Promise.all+async+untyped-callback arity bug

**6-line minimum reproducer**:

```ts
async function f(): Promise<any> { return 1; }
export function test(): number {
  Promise.all([f()]).then(r => r);
  return 1;
}
```

Result: `WebAssembly.instantiate(): Compiling function #N:"test" failed: not enough arguments on the stack for call (need 2, got 0)`

**Trigger conditions** (verified):
1. Receiver is `Promise.all([asyncCall()])`
2. `.then(cb)` callback param is UNTYPED (`r => r` fails; `(r: any) => r` works)
3. Async function returns Promise<any|unknown|X|Y> (heterogeneous); `Promise<number>` works

**Workarounds**: split into intermediate var, cast to `Promise<any>`, type the callback explicitly, or use a non-heterogeneous return type.

**Fix attempt failed**: tried `flushLateImportShifts` after callback compilation in `expressions/calls.ts:3647` — verified no effect, reverted. Shift mechanism IS invoked but indices remain stale somewhere.

**Hypothesis for next dive**: `ctx.parentBodiesStack` may not be populated during arrow-body compilation when the arrow's contextual type triggers `addUnionImports`. The receiver's already-emitted `Promise.all` call bytes would then NOT be walked by the shift function.

Probes in `/workspace/.claude/worktrees/issue-1384-static-async-private/.tmp/`:
- `probe-min9.mts` — 6-line minimum
- `probe-types.mts` — confirms heterogeneous return type trigger
- `probe-instance.mts` — runs the original failing test262 file

## #1370 — IR class methods (next session start)

Tech-lead assigned then re-routed to architect re-spec. Worktree exists at `/workspace/.claude/worktrees/issue-1370-ir-class-methods` on `origin/main` HEAD with deps installed and clean tree.

**Key findings during my initial read**:

1. **Naming convention is UNDERSCORE not DOT.** The issue spec at line 67 says funcMap key is `${ClassName}.${methodName}` but `class-bodies.ts:275, 343` uses `${className}_${methodName}` (underscore). Phase A must use underscore.

2. **funcMap pre-allocation site**: `src/codegen/class-bodies.ts:341-353` registers each method at `ctx.numImportFuncs + ctx.mod.functions.length` and pushes `{ name: fullName, typeIdx, locals: [], body: [] }` into `ctx.mod.functions`. This is the slot the IR Phase B should patch.

3. **IR existing patch site**: `src/ir/integration.ts:468-469` is where the existing FunctionDeclaration path patches `ctx.mod.functions[localIdx]`. Phase B should add a parallel loop for class methods.

4. **Constructor convention**: `class-bodies.ts:253` uses `ctorName = ${className}` for constructor (no `_new` suffix at this level). Constructor result type is `(ref $ClassName)`.

5. **classMethodSet / staticMethodSet**: Track which methods belong to classes. Selectors should consult these to avoid claiming methods with unsupported features (computed names, abstract, generator, async, etc.).

**Phase A entry point**: extend `planIrCompilation` in `src/ir/select.ts:106-111`. Add a second loop after the FunctionDeclaration loop at line 140-157 that iterates `sourceFile.statements` for `ts.isClassDeclaration` and walks members.

**Phase B entry point**: in `src/ir/integration.ts:compileIrPathFunctions`, add a parallel loop after the existing function-claim loop that visits class declarations and patches their pre-allocated method bodies.

**Risk**: a hasty Phase A+B could break the existing FunctionDeclaration IR path. I declined to ship under fatigue.

## Active in-flight state

All worktrees clean (no uncommitted changes outside investigation probes in `.tmp/` which are gitignored).

| Worktree | Status |
|---------|--------|
| `issue-1377b-length-coercion` | b0ff0672f — PR #292 closed (doc-only retired). Probes preserved in `.tmp/`. Safe to remove. |
| `issue-1384-static-async-private` | 180f3a1af — PR #290 merged (doc-only). Probes preserved in `.tmp/`. Safe to remove. |
| `issue-1370-ir-class-methods` | 46fda1af9 (origin/main HEAD) — clean, deps installed, ready for next agent. |

## Communication preferences observed

Tech-lead has:
- Approved drift overrides when net positive (#225/#227 pattern reused for our PRs).
- Preferred I send concrete findings, not status pings.
- Honored "honest assessment" requests to pause vs ship rushed work.
- Re-routed work via architect re-spec when initial spec mis-targeted (#1339, #1364, #1377 Slice B, #1384, #1370).
