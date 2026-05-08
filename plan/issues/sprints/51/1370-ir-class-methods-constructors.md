---
id: 1370
sprint: 51
title: "IR: claim class methods and constructors (largest legacy bypass)"
status: review
created: 2026-05-08
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, codegen
language_feature: classes
goal: ir-full-coverage
---
# #1370 — IR: claim class methods and constructors

## Problem

Class methods and constructors are the **single largest category of functions permanently
excluded from the IR path**. The selector comment says explicitly:

> "Class methods themselves (and constructors) are NOT claimed in slice 4 — they remain on
> the legacy class-bodies path."

This means every TypeScript class with numeric/typed methods (`add(a: number, b: number):
number`) bypasses the IR and emits through the legacy `class-bodies.ts` path. The reason is
architectural: `collectClassDeclaration` pre-allocates funcIdx/typeIdx for all methods before
`compileIrPathFunctions` runs, and the IR integration assumes it can patch pre-allocated slots.

`src/codegen/index.ts:775` gates IR behind `options?.experimentalIR`. Class method compilation
happens inside `compileDeclarations` → `collectClassDeclaration` → `class-bodies.ts`, which
runs regardless of `experimentalIR`.

## Root cause

The IR integration (`compileIrPathFunctions`) only iterates `sourceFile.statements` looking
for `ts.isFunctionDeclaration(stmt)`. Class declarations are `ts.isClassDeclaration(stmt)`,
and their method bodies are `ts.MethodDeclaration` nodes inside the class — the outer loop
never visits them.

## Implementation plan

### Phase A: selector extension

In `src/ir/select.ts`, extend `planIrCompilation` to also visit class declarations:

1. After collecting top-level `FunctionDeclaration` candidates, iterate class declarations.
2. For each method/constructor, check IR-eligibility with the same `isIrClaimable` predicate
   (already handles the `body-shape-rejected` / `param-shape-rejected` / `external-call`
   fallback reasons).
3. Add a new fallback reason `"class-method"` for methods that fail but are still class-owned —
   this lets callers distinguish "would-be-IR but not supported" from "intentionally excluded".
4. Store the claim result in the returned `IrSelection` keyed by the synthetic name
   `${ClassName}.${methodName}` (same convention as `funcMap` uses).

### Phase B: integration wiring

In `src/ir/integration.ts`, after building `selected.funcs`, add a second loop over
`selected.classMethods` (or iterate the class declarations from `sourceFile.statements`):

1. For each claimed method, retrieve the pre-allocated `funcIdx` from `ctx.funcMap`
   (uses `ctx.funcMap.get("${ClassName}.${methodName}")`).
2. Build + verify the IrFunction for the method body.
3. Patch the Wasm body at `ctx.mod.functions[funcIdx - ctx.numImportFuncs]` — same as the
   existing slot-patching path for top-level functions.
4. Coordinate with the class registry: `ctx.structMap`, `ctx.structFields` must be populated
   before the method's IR lowerer tries to access `this.field`. The existing
   `compileIrPathFunctions` already reads `ctx.structMap` via `IrLowerResolver.resolveClass`
   in `src/ir/integration.ts:1347-1368` — confirm it's populated at call time.

### Phase C: constructor body

Constructors are special: they must return `this` (which is a struct `ref` in WasmGC). The
legacy path handles this via a separate `compileConstructorBody` path. IR equivalent:
- The constructor IrFunction result type = `(ref $ClassName)`.
- The IR allocates `struct.new $ClassName` at entry, stores to a local `$self`.
- All `this.field = x` assignments become `struct.set $ClassName $fieldIdx $self`.
- The tail `return $self`.
This is a new IrNode or a convention on top of existing `IrNode.structSet`.

### Phase D: call-graph integration

Once class methods are IR-claimed, `external-call` rejections from top-level functions that
call class methods must be re-evaluated. The `localClasses` set exemption in `select.ts:119`
already handles this — verify it covers IR-claimed methods.

## Acceptance criteria

1. A class with 3 numeric methods (`add`, `sub`, `mul`) is emitted via IR (no legacy fallback).
2. `IrIntegrationReport.compiled` includes `MyClass.add` etc.
3. Equivalence tests for class arithmetic pass.
4. `IrFallbackReason` telemetry shows `"class-method"` only for unsupported method shapes
   (closures, async, destructuring), not for simple typed numeric methods.

## Files

- `src/ir/select.ts` — extend claim loop to class declarations
- `src/ir/integration.ts` — add class-method patching loop
- `src/ir/from-ast.ts` — `lowerFunctionAstToIr` may need `MethodDeclaration` input handling
- `src/ir/nodes.ts` — possibly new IrNode for `this` field access in constructors

## Notes

This is the highest-impact single IR expansion. Class-heavy numeric code (matrix math,
physics engines, parsers) is entirely on legacy today. Feasibility: hard. Assign to senior dev.

---

## Architect Spec (2026-05-08, Phase A focused)

### Naming convention — verified from the source

**Critical correction to the original spec** (which had `${ClassName}.${methodName}` —
that is wrong). The legacy `class-bodies.ts` registers names with **underscores**:

| What | Key in `ctx.funcMap` | Source |
|------|----------------------|--------|
| Constructor | `${className}_new` | `class-bodies.ts:216` (`const ctorName = \`${className}_new\`;`) |
| Instance method | `${className}_${methodName}` | `class-bodies.ts:275` (`const fullName = \`${className}_${methodName}\`;`) |
| Static method | `${className}_${methodName}` (same shape) | `class-bodies.ts:284` (`ctx.staticMethodSet.add(fullName)`) |

Senior-dev's session note said "constructor uses `${className}` (no `_new` suffix at this
level)" — that's also wrong. **Use `${className}_new` for the constructor.** Confirmed
again by `ClassRegistry.resolve` in `src/ir/integration.ts:1392-1408`, which declares
`constructorFuncName = \`${shape.className}_new\`` and `methodFuncName: \`${className}_${name}\``.

Other class-bodies.ts sets the IR layer must consult:
- `ctx.classMethodSet` (instance methods, line 286)
- `ctx.staticMethodSet` (static methods, line 284)
- `ctx.generatorFunctions` (generator methods, line 292)
- `ctx.asyncFunctions` (async methods, line 316)
- `ctx.funcUsesArguments` (methods that read `arguments`, line 338)
- `ctx.classThrowsOnEval` (static `prototype` clash, line 280)

### Phase A — selector extension in `src/ir/select.ts`

#### Existing structure to extend

`planIrCompilation` at line 106-229 is the entry point. Today it:
1. `collectLocalClasses(sourceFile)` at line 121 → populates `Set<string>` of class names.
2. Walks `sourceFile.statements` for `ts.isFunctionDeclaration` (line 140-157) → individually claims.
3. Builds call graph (line 180), drops external-callers (line 187-192), closes under
   the local caller/callee relation (line 194-221).
4. Returns `IrSelection`.

`whyNotIrClaimable(fn, typeMap, localClasses)` at line 242-287 and its mirror
`isIrClaimable(fn, typeMap, localClasses)` at line 289-347 perform the per-function
checks. Both take a `ts.FunctionDeclaration` today.

#### Phase A changes

**1. Extend `IrSelection` to track claimed class members.**

`src/ir/select.ts:87-93`:

```ts
export interface IrSelection {
  readonly funcs: ReadonlySet<string>;
  // NEW: synthetic-name set keyed by `${className}_${methodName}` for instance/static
  // methods, and `${className}_new` for constructors. Populated only when class
  // members are IR-eligible. Empty in pre-Phase-A behavior.
  readonly classMembers?: ReadonlySet<string>;
  readonly fallbacks?: ReadonlyArray<IrFallback>;
}
```

Add a new fallback reason value `"class-method"` to the union at line 68-80:

```ts
export type IrFallbackReason =
  | "unnamed"
  | ...existing reasons...
  | "class-method"     // NEW: method-shape unsupported (e.g. abstract, private name)
  | "deferred-feature";
```

**2. Generalize the per-function check to also accept methods.**

The simplest way: split the type-resolution logic into a node-shape-agnostic helper,
then add a sibling `whyNotIrClaimableMethod(member: ts.MethodDeclaration, ...)`.

In practice, since `ts.FunctionDeclaration`, `ts.MethodDeclaration`, and
`ts.ConstructorDeclaration` all have `.parameters`, `.body`, `.type`, `.modifiers`,
`.typeParameters`, and `.asteriskToken` (for methods/decls), the existing
`whyNotIrClaimable` body works almost verbatim for method declarations — we just
need to widen the input type. Recommend:

```ts
type IrClaimableSubject = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration;

function whyNotIrClaimable(
  fn: IrClaimableSubject,
  typeMap: TypeMap | undefined,
  localClasses: ReadonlySet<string>,
  isMethod: boolean,
): IrFallbackReason | null { ... }
```

Add at the top of the function body (so methods don't trip on the unnamed check):

```ts
if (!isMethod && !fn.name) return "unnamed";
```

**Method-specific guards** to add to `whyNotIrClaimable` when `isMethod === true`:

- Reject computed property names (`name === undefined`): return `"class-method"`.
- Reject getters/setters via `ts.SyntaxKind.GetKeyword` / `SetKeyword` modifiers
  (handled separately for the legacy path; out of Phase A scope) → `"class-method"`.
- Reject abstract methods (no body): return `"body-shape-rejected"` (already
  handled — `if (!body) return "body-shape-rejected";`).
- Reject async methods: return `"deferred-feature"` for now (Phase D).
- Reject generator methods: return `"deferred-feature"` for now (Phase D).
- Reject methods on classes that extend a parent: return `"class-method"`. Phase A
  scope is **flat classes only**; inheritance and `super` calls require a separate
  slice.

**3. New top-level walk in `planIrCompilation` after the FunctionDeclaration loop.**

Insert immediately after line 157 (after the FunctionDeclaration loop), BEFORE the
"if (individuallyClaimed.size === 0) return EMPTY;" guard at line 159:

```ts
// Phase A (#1370): class methods + constructors.
//
// For each top-level class declaration, walk its members and claim:
//   - the constructor (synthetic name `${ClassName}_new`)
//   - each instance method (`${ClassName}_${methodName}`)
//   - each static method (same shape)
//
// Method bodies use the SAME shape rules as FunctionDeclarations.
// The funcMap pre-allocation in class-bodies.ts must run BEFORE
// compileIrPathFunctions so the IR can patch existing slots.
const individuallyClaimedClassMembers = new Set<string>();
const classMemberDeclByName = new Map<string, ts.MethodDeclaration | ts.ConstructorDeclaration>();
for (const stmt of sourceFile.statements) {
  if (!ts.isClassDeclaration(stmt)) continue;
  if (!stmt.name) continue; // anonymous class — skip
  const className = stmt.name.text;
  // Skip classes with parent — Phase A doesn't support `super`.
  if (stmt.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) continue;
  for (const member of stmt.members) {
    let memberName: string;
    let isCtor = false;
    if (ts.isConstructorDeclaration(member)) {
      memberName = `${className}_new`;
      isCtor = true;
    } else if (ts.isMethodDeclaration(member) && member.name) {
      const methodNameRaw = phase1MemberName(member.name); // helper: identifier/string-literal/numeric only
      if (methodNameRaw === null) continue; // computed name — skip
      memberName = `${className}_${methodNameRaw}`;
    } else {
      continue; // get/set/property — out of Phase A
    }
    classMemberDeclByName.set(memberName, member);
    const reason = trackFallbacks
      ? whyNotIrClaimable(member, typeMap, localClasses, /*isMethod*/ true)
      : isIrClaimable(member, typeMap, localClasses, /*isMethod*/ true)
        ? null
        : "class-method";
    if (reason === null) {
      individuallyClaimedClassMembers.add(memberName);
    } else if (trackFallbacks) {
      fallbackReasons.set(memberName, reason);
    }
  }
}
```

`phase1MemberName` is a small helper:

```ts
function phase1MemberName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null; // computed / private — Phase A skips
}
```

**4. Don't extend the call-graph closure in Phase A.**

Class methods aren't in the call-graph yet — Phase A claims method bodies independently.
The existing `localClasses` exemption at `select.ts:1581-1604` (the `ts.isNewExpression`
branch in `buildLocalCallGraph`) and the `ts.isPropertyAccessExpression` branch at
`select.ts:1620-1631` already let outer functions call IR-claimed methods because the
class methods retain stable signatures (the legacy pre-allocation phase set them).

When Phase B replaces the body, the **signature stays the same** (same `typeIdx`),
so the existing `call $${className}_${methodName}` instructions in legacy callers
remain valid. This is the same correctness invariant the FunctionDeclaration IR path
already relies on.

**Risk to track:** if a method is re-typed by Phase B's IR lowerer (e.g. f64 →
externref unboxing), the typeIdx changes and legacy callers break. **Phase A
must reject any method whose IR-resolved signature would differ from the
legacy-allocated signature.** This requires a parity check between
`whyNotIrClaimable`'s resolved param/return types and the legacy
`resolveWasmType(...)` output. Implementation: after computing the IR-resolved
shape, look up the existing typeIdx from `ctx.funcMap.get(memberName)` /
`ctx.mod.types[...]` and compare. If different, reject as `"class-method"`.

**5. Return updated IrSelection.**

At the existing return paths (lines 159-165, 222-228), include the class members
when populated:

```ts
return { funcs: claimed, classMembers: claimedClassMembers, fallbacks };
```

#### Diagnostic / regression coverage for Phase A

Run these existing IR integration tests after the Phase A change. They exercise
the FunctionDeclaration IR path and should remain green:

- `tests/ir-integration.test.ts` — primary IR integration suite
- `tests/ir-class-instance.test.ts` — Slice 4 class-instance use in OUTER funcs
- `tests/ir-vec-pipeline.test.ts` — vec / array IR codegen
- `tests/ir-string.test.ts` — string IR codegen
- `tests/ir-generator.test.ts` — generator IR codegen
- `tests/ir-tagged-union.test.ts` — tagged-union pass

For the new behavior, write a focused test under `.tmp/probe-1370-phaseA.mts`:

```ts
import { compile } from "../src/index.ts";
const src = `
class Calc {
  add(a: number, b: number): number { return a + b; }
  mul(a: number, b: number): number { return a * b; }
}
export function run(): number {
  const c = new Calc();
  return c.add(2, 3) + c.mul(4, 5);
}`;
const r = compile(src, { fileName: "test.ts", experimentalIR: true, trackFallbacks: true });
console.log(r.success);
console.log(r.irReport); // should list Calc_add, Calc_mul
```

The expected outcome (Phase A only — Phase B not yet built):
- `r.irReport.compiled` lists `["run"]` (not yet `Calc_add` etc., since Phase B
  doesn't exist) — but the **selector** must report Calc_add / Calc_mul in
  `selection.classMembers`. Phase A is selector-only; the integration loop is
  Phase B.
- No regression in `tests/ir-class-instance.test.ts`.

### Phase B sketch (out of scope for this spec, but flagged)

Phase B in `src/ir/integration.ts:compileIrPathFunctions`:

1. After the existing FunctionDeclaration loop (line 157-199 in current main),
   add a parallel loop that iterates `selected.classMembers` (NEW field).
2. For each `${className}_${methodName}`, look up the declaration via the
   selection's tracked map (we'll need to thread it through), call
   `lowerFunctionAstToIr` with the method node — and to do that we need to
   widen `lowerFunctionAstToIr`'s parameter from `ts.FunctionDeclaration` to
   `ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration`.
3. Patch `ctx.mod.functions[funcIdx - ctx.numImportFuncs]` with the lowered body
   (mirror line 466-475 in integration.ts).
4. Constructor body is special: must allocate `struct.new $ClassName` and
   thread `__self` through the body. Defer to Phase C.

### Phase C-D notes (deferred)

- **Phase C — constructor body**: needs new IR conventions for `this.field = x`
  and the implicit `return $self`. See existing legacy `compileConstructorBody`
  in `src/codegen/expressions/new-super.ts:780-830` for the reference pattern.
- **Phase D — async/generator methods**: integrate with `ctx.asyncFunctions` /
  `ctx.generatorFunctions` so the IR lowerer emits the right func-kind. The
  existing slice-7a generator IR (`from-ast.ts:243-251`) is the template.
- **Phase E — inheritance**: requires `super.method()` and the parent struct
  prefix in field indices. Out of #1370 scope.

### Open question for the dev

`lowerFunctionAstToIr(fn: ts.FunctionDeclaration, ...)` at `from-ast.ts:182` currently
only accepts FunctionDeclaration. Phase A is selector-only and does NOT call this
function for methods, so this is **deferred to Phase B**. When Phase B lands, the
parameter type must widen and `fn.name.text` lookups need an `isMethod`-aware
fallback (since MethodDeclaration `.name` is `PropertyName`, not `Identifier`).

---

## Phase A — Implementation Notes (2026-05-08, senior-dev-1370)

PR: https://github.com/loopdive/js2wasm/pull/293

### What landed

`src/ir/select.ts`:

1. **`IrSelection.classMembers`** — new optional `ReadonlySet<string>` field. Populated
   only when class members are claimed; left `undefined` otherwise so existing fixtures
   don't shift.
2. **`IrFallbackReason` += `"class-method"`** — for shapes the selector recognises but
   can't yet handle (extends parent, accessors, abstract, computed/private name).
3. **`IrClaimableSubject` union** = `FunctionDeclaration | MethodDeclaration | ConstructorDeclaration`.
   `whyNotIrClaimable` and `isIrClaimable` widened with an `isMethod` flag. To stay in
   sync, `isIrClaimable` now delegates to `whyNotIrClaimable === null` (negligible
   overhead vs. the AST walk).
4. **Method-specific guards** at the top of `whyNotIrClaimable`:
   - Top-level: name required, only `export` modifier allowed.
   - Method: `abstract` → `class-method`, `async` → `deferred-feature`.
   - Method generator → `deferred-feature` (Phase D).
   - Constructor: skipped return-type resolution (no source-level type).
5. **`scope.add("this")`** — class-member subject implicitly puts `this` in scope.
6. **`isPhase1Expr` accepts `ts.SyntaxKind.ThisKeyword`** when `scope.has("this")`.
   No-op for FunctionDeclaration path because outer functions never put `this` in scope.
7. **Constructor body** — checked via `isPhase1BodyStatement` rather than
   `isPhase1StatementList`, since constructors don't have a return-tail. Phase C will
   synthesise the implicit `return this`.
8. **New walk after FunctionDeclaration loop** — for each top-level `ClassDeclaration`:
   - Skip anonymous classes (no name).
   - Skip classes with `extends` clause; tag every member as `class-method` for
     telemetry. Phase E (inheritance) addresses these.
   - Iterate members:
     - `ConstructorDeclaration` → `${className}_new`
     - `MethodDeclaration` → `${className}_${methodName}` (via `phase1MemberName`)
     - `GetAccessorDeclaration` / `SetAccessorDeclaration` → `class-method` fallback
     - everything else → silently skipped (PropertyDeclaration is not a function).
   - Use the same selector predicate; cache claim/reason in
     `individuallyClaimedClassMembers` / `fallbackReasons`.
9. **Return paths** thread `classMembers` through. Empty → undefined.

`scripts/check-ir-fallbacks.ts`:

10. `class-method` added to the `UNINTENDED` set so the budget gate tracks
    Phase E / accessor-slice retirement progress.

### Critical correction (kept from architect spec)

Funcmap keys use **underscores**, not dots: `${className}_new`, `${className}_${methodName}`.
Confirmed via `class-bodies.ts:216,275,284`.

### Out of scope (Phase B+)

- `src/ir/integration.ts` — no changes. `compileIrPathFunctions` still iterates only
  FunctionDeclaration; methods on the legacy class-bodies path emit normally.
- Signature parity check between IR-resolved and legacy-allocated typeIdx — needs `ctx`
  access; deferred to Phase B where the integration loop sees `ctx`.
- `lowerFunctionAstToIr` widening — deferred to Phase B.
- Constructor body `struct.new $ClassName + $self` epilogue — Phase C.

### Verification

`.tmp/probe-1370-phaseA.mts` — `class Calc { add(a, b); mul(a, b); }`:
- `funcs: ["run"]`
- `classMembers: ["Calc_add", "Calc_mul"]`
- `fallbacks: []`

`.tmp/probe-1370-rejections.mts` — six cases:
- constructor + method → `[Point_add, Point_new]`
- extends parent → claims `Base_foo`, rejects `Derived_bar` as `class-method`
- async method → `deferred-feature`
- generator method → `deferred-feature`
- get/set accessor → `class-method`
- static method → claimed (`M_add`)

Test results:
- 14 IR-related test files: 334/335 pass (1 unrelated env failure, pre-existing on main)
- 6 class-equivalence test files: 22/22 pass
- IR fallback baseline unchanged (example corpus has no classes today)

---

## Phase B Notes (from integration reading, 2026-05-08)

These are findings from reading `src/ir/integration.ts`, `src/ir/from-ast.ts`, and
`src/codegen/class-bodies.ts` AFTER Phase A landed. Captured here so the next agent
doesn't re-derive them. **Phase B implementation goes on a NEW branch** (`issue-1370-ir-phase-b`)
off `origin/main` once PR #293 merges — do not code Phase B on the Phase A branch.

### Phase B integration target

`src/ir/integration.ts:156-199` is the FunctionDeclaration loop. The Phase B class-member
loop is structurally a parallel version of it:

1. Walk `sourceFile.statements` for `ts.isClassDeclaration(stmt)`.
2. For each member, derive the synthetic name (constructor → `${className}_new`;
   method → `${className}_${methodName}` via `phase1MemberName` from select.ts).
3. Skip if `selected.classMembers` does not contain the synthetic name.
4. Call the (widened) `lowerFunctionAstToIr(member, options)` — passing the synthetic
   name explicitly via `options.funcName` (new field, see below).
5. Verify via `verifyIrFunction`.
6. Push to `built[]` so Phase 2 (hygiene/inline/mono) and Phase 3 (Wasm lowering) run
   uniformly across top-level functions and class members.
7. Phase 3 patch (line 452-480) already does `funcMap.get(name)` lookup → it works
   unchanged for `${className}_${methodName}` keys.

### `lowerFunctionAstToIr` widening (`src/ir/from-ast.ts:182-280`)

Required changes:

1. **Param type**: `ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration`.
2. **Line 183-185**: drop `if (!fn.name) throw`. ConstructorDeclaration has no name
   node; MethodDeclaration's `.name` is `ts.PropertyName` (could be Identifier,
   StringLiteral, NumericLiteral, ComputedPropertyName, PrivateIdentifier — only the
   first three pass the selector). Accept name via a new `options.funcName: string`
   field; throw only if the caller didn't supply it AND the AST doesn't have one.
3. **Line 190**: `const name = options.funcName ?? fn.name.text` — fall back when caller
   doesn't override.
4. **Line 202** (`!!fn.asteriskToken`): only valid on FunctionDeclaration / MethodDeclaration.
   `ts.isConstructorDeclaration(fn) ? false : !!fn.asteriskToken`.
5. **Line 211** (`fn.type`): ConstructorDeclaration has no `.type` field. Phase B skips
   constructor-body lowering anyway (Phase C concern); the parity check below should
   refuse constructors until Phase C lands. For methods, `fn.type` is the same shape as
   FunctionDeclaration.
6. **`collectMutatedLetNames(fn)` at line 668**: signature widening only — body access
   (`fn.body`) works for all three subjects.
7. **`hasExportModifier(fn)` at line 485**: irrelevant for class members (they're not
   directly exported); the `built` push uses `result.main` whose `exported` flag is
   driven by `options.exported`. Pass `false` for class members.

### CRITICAL — `self` param wiring for instance methods

Confirmed via `class-bodies.ts:301`: instance method signatures pre-allocated by the
legacy path are `[(ref $structTypeIdx), ...userParams]`. The synthetic `self` param is
the first slot in the typeIdx; the legacy method body reads it as `local.get 0` and
binds it to `this`.

**The IR's lowered body MUST mirror this layout — `self` first, then user params, in
that order.** `lowerFunctionAstToIr` currently iterates only `fn.parameters` (line
212-221), which excludes the synthetic `self`. Phase B has to inject `self` for
instance methods:

- Static method: skip — no `self`. The class-bodies pre-allocation also skips it.
- Constructor: skip at Phase B — Phase C will allocate via `struct.new` in body.
- Instance method: prepend `self` to the SSA params, type `IrType.class { className }`.
  Bind `this` in scope to that SSA value so `this.field` / `this.method()` references
  work in the body.

**Where to inject**: in `lowerFunctionAstToIr`, between `builder.openBlock()` (line 234)
and the user-body lowering. Add a new option `options.selfParam?: { className: string }`;
when set, call `builder.addParam("__self", IrType.class)` first, then `scope.set("this", { kind: "local", value: selfV, type: classType })`. The user `fn.parameters` loop runs
afterwards, producing param SSA #1, #2, ... matching the legacy `local.get 1`,
`local.get 2`, ... offsets.

### Signature parity guard (per architect spec)

Before patching `ctx.mod.functions[localIdx].body`, compare:
- The IR-lowered Wasm signature (from `lowerIrFunctionToWasm(entry.fn, resolver).func.typeIdx`)
- The pre-allocated typeIdx (`ctx.mod.functions[localIdx].typeIdx`)

If they differ, skip the patch and emit a warning. The legacy class-bodies path
already wrote a working body for that slot, so dropping the IR substitution is safe.

The mismatch case to worry about most: legacy `resolveWasmType` produces `f64` for
`number`, but IR's propagation could resolve a method with no annotation as `i32` via
TypeMap — leaving the legacy callers calling through the `f64` typeIdx while the IR
body expects `i32`. The selector's `entry = typeMap?.get(name)` lookup at
`select.ts:432` is a no-op for class members in Phase A (we explicitly bypassed
TypeMap); Phase B should keep that bypass to minimize signature drift, OR widen the
TypeMap key scheme to include `${className}_${methodName}`. Recommendation: stay
bypass-only for Phase B; revisit in Phase D when method TypeMap propagation lands.

### `funcMap` confirmation (`src/codegen/class-bodies.ts`)

- `ctx.funcMap.set(${className}_new, ctorFuncIdx)` — line 253
- `ctx.funcMap.set(${className}_${methodName}, methodFuncIdx)` — line 343
- Empty `body: []` slot pre-allocated and waiting to be patched (lines 255-261, 345-351)

### Selector ↔ Integration handoff

Two options:
1. **Re-walk class declarations** in Phase B's integration loop. Cost: O(#classes × #members)
   per source file — negligible. Simpler — selector stays as-is.
2. **Selector exposes `Map<memberName, ts.MethodDeclaration | ts.ConstructorDeclaration>`**.
   Cleaner but requires another field on `IrSelection`.

Recommendation: option 1. Selector exposes only string sets; integration walks the AST
itself to find the declaration node. Mirrors how the FunctionDeclaration loop works.

### Constructor body (Phase C, deferred)

`compileConstructorBody` reference: `src/codegen/class-bodies.ts` (later in the file)
plus `src/codegen/expressions/new-super.ts:780-830`. The IR equivalent:

- Allocate `struct.new $ClassName` at body entry; bind to `__self` SSA local.
- Lower `this.field = expr` as `struct.set $ClassName $fieldIdx __self <expr>`.
- Tail: `return $self`.

This requires either:
- A new IrNode for "constructor entry" + "constructor exit" (clean), or
- Lowerer convention: when `cx.funcKind === "constructor"`, emit the prologue/epilogue
  inline (faster to land).

### Test plan for Phase B

- Reuse `.tmp/probe-1370-phaseA.mts` as a baseline — Phase B should still pass.
- Add `.tmp/probe-1370-phaseB.mts` that compiles the Calc class and verifies the
  Wasm body for `Calc_add` is the IR-lowered shape (e.g. via `wat` text + assertion).
- Run `tests/equivalence/ir-slice4-classes.test.ts` — should remain green; behaviour
  parity is the key invariant.
- Run `tests/classes.test.ts` — expect the env failures unchanged from Phase A.
- IR fallback baseline: should DROP for `class-method` bucket as Phase B claims
  more methods. Run `pnpm run check:ir-fallbacks -- --update` and commit.

---

## Phase B — Implementation Notes (2026-05-08, senior-dev-1370)

PR: https://github.com/loopdive/js2wasm/pull/295

Phase B wires the IR integration loop for class **instance methods**.
Static methods and constructors are deferred (see scope notes below).

### What landed

1. **`lowerFunctionAstToIr` widened** (`src/ir/from-ast.ts`):
   - Param type: `FunctionDeclaration | MethodDeclaration | ConstructorDeclaration`.
   - New `options.funcName` for caller-supplied names (MethodDeclaration's
     `.name` is `PropertyName`, not Identifier; ConstructorDeclaration has
     no name node).
   - New `options.selfParam: { type: IrType }` injects a synthetic `__self`
     first param. Mirrors `class-bodies.ts:301`'s `[(ref $structTypeIdx),
     ...userParams]` layout exactly so legacy callers' `call` ops still
     match the typeIdx after the patch.
   - Binds `this` in the body's scope to the `__self` SSA value. Existing
     slice-4 `class.get` / `class.set` / `class.method` lowerings handle
     `this.field` / `this.method()` via the `IrType.class` shape carried
     on the binding.
   - `lowerExpr` accepts `ts.SyntaxKind.ThisKeyword` and returns the
     `this` SSA value from scope.
   - `collectMutatedLetNames` widened to the same union.
   - ConstructorDeclaration is rejected at the lowerer with a clean
     error (Phase C work).

2. **Class-member walk in `compileIrPathFunctions`** (`src/ir/integration.ts`):
   - New parallel loop after the FunctionDeclaration loop. Walks
     `sourceFile.statements` for `ClassDeclaration`, filters to
     non-static `MethodDeclaration` whose synthetic name is in
     `selected.classMembers`. Looks up `classShapes.get(className)`,
     builds the `IrType.class` self-param, calls `lowerFunctionAstToIr`.
   - Skip branches: classes with `extends` (defensive — selector already
     rejects), missing class shape, static modifier, abstract modifier,
     computed/private member name.
   - `BuiltFn` gains `classMember?: boolean` flag. Threaded through
     hygiene/inline/mono pipeline stages.

3. **Funcidx allocation skip** (`src/ir/integration.ts`):
   - Class members already have a funcIdx pre-allocated by
     `class-bodies.ts`. The new `if (entry.classMember) continue;`
     prevents the integration's clone-allocation step from registering
     a duplicate slot.

4. **Signature parity guard** (`src/ir/integration.ts`):
   - Before patching the slot, compares `wasmFunc.typeIdx` (IR-lowered)
     to `existing.typeIdx` (legacy pre-allocated). On mismatch:
     - Don't patch — legacy body stays in place.
     - Emit a `severity: warning` diagnostic: `"class-method typeIdx
       parity mismatch: IR=N, legacy=M — keeping legacy body"`.
   - Top-level FunctionDeclarations DON'T need this guard — their
     pre-allocated body was empty and no legacy callers depend on the
     slot's prior typeIdx.

5. **Early-return short-circuit relaxed** (`src/ir/integration.ts:93`):
   - Old: `if (selected.funcs.size === 0) return EMPTY;`
   - New: `if (selected.funcs.size === 0 && (!selected.classMembers || selected.classMembers.size === 0)) return EMPTY;`
   - A source file with only a class (no top-level functions) can now
     reach the class-member walk.

6. **`safeSelection` threads `classMembers`** (`src/codegen/index.ts:854`):
   - The class-method override map isn't built (class methods are typed
     via the class shape, not TypeMap propagation). Pass the
     `classMembers` set through unchanged.

### Phase B verification

- `.tmp/probe-1370-phaseB.mts` — `class Calc { add(a,b); mul(a,b); }` →
  `run()` returns 25 in both legacy and IR. Values match.
- `.tmp/probe-1370-phaseB-trace.mts` — confirms `Calc_add` body is the
  IR-lowered shape (`local.get 1`, `local.get 2`, `f64.add`, `return`)
  and not the legacy `$name`-prefixed form.
- `.tmp/probe-1370-phaseB-this-method.mts` — `class Counter { next();
  nextNext() }` with `this.next()` cross-method call → both methods
  IR-compiled, returns 7.

Test results:
- Class equivalence tests (6 files): 22/22 pass (incl.
  `ir-slice4-classes.test.ts` exercising slice-4 class instance use
  patterns from outer functions).
- IR test suite (14 files): 327/327 pass.
- TypeScript clean.
- IR fallback budget gate: no regression.

### Out of scope (Phase B deferred)

- **Static methods** — funcMap key shape is the same
  (`${className}_${methodName}`) but no `self` injection. Could be a
  small follow-up — just skip the `selfParam` option when
  `hasStaticModifier(member)`. The selector already claims them in
  Phase A.
- **Constructors** — Phase C builds the `struct.new $ClassName` allocation
  + `__self` SSA binding + `return $self` epilogue. Phase B's lowerer
  rejects ConstructorDeclaration with a clear error.
- **Inheritance / `super`** — Phase E. Phase A's selector already
  rejects classes with `extends`.

### Risk notes

- The signature parity guard will surface as a warning in CI if any
  test triggers a mismatch. Watch the Phase B PR's test262 output for
  `class-method typeIdx parity mismatch` warnings — they indicate
  classes whose methods can't be claimed safely yet (likely f64-vs-i32
  resolution differences). If the guard fires for many cases, the
  `IrClassShape` projection in `buildIrClassShapes` (`src/codegen/index.ts:480`)
  may need to align more closely with `resolveWasmType`'s output.

---

## Phase C Notes (from constructor reading, 2026-05-08)

These findings are from reading the legacy constructor-body compilation
ahead of Phase C implementation. **The architect spec referenced a
`compileConstructorBody` function — that doesn't exist as a separate
function; constructor body compilation is INLINE in `compileClassBodies`
(`src/codegen/class-bodies.ts:658-951`).** The next agent should not
search for `compileConstructorBody`.

### Legacy constructor body recipe

Lines below refer to `src/codegen/class-bodies.ts`:

1. **Allocate `__self` local** (line 731-734):
   ```ts
   const selfLocal = allocLocal(fctx, "__self", { kind: "ref", typeIdx: structTypeIdx });
   ```
2. **Push default values for ALL fields including `__tag`** (line 737-758):
   - `__tag` → `ctx.classTagMap.get(className) ?? 0` (instanceof discrimination value)
   - f64 → `f64.const 0`, i32 → `i32.const 0`
   - ref → `ref.null typeIdx`, ref_null → `ref.null typeIdx`
   - externref → `ref.null.extern`, eqref → `ref.null.eq`, i64 → `i64.const 0n`
   - Fallback for anything else: `i32.const 0`
3. **`struct.new $structTypeIdx`** (line 759).
4. **`local.set $__self`** (line 760).
5. **Bind `this` → `__self` in localMap** (line 765):
   `fctx.localMap.set("this", selfLocal);`
6. **Optional param defaults** (line 772-846) — null/zero/NaN sentinel
   checks. **OUT OF PHASE C SCOPE** — Phase A's selector already rejects
   params with initializers, so this complexity isn't needed in the IR
   lowerer until a separate slice loosens the selector.
7. **PropertyDeclaration initializers** (line 914-926) — for each
   `field: type = expr` (no `static`):
   ```
   local.get $__self
   <compile init expr>
   struct.set $structTypeIdx fieldIdx
   ```
   Field index is from `legacyFields.findIndex` — note `__tag` is at
   index 0, user fields at 1+.
8. **Constructor body statements** (line 928-941) — compile each via
   `compileStatement`. `this.field = expr` is already handled by the
   assignment compilation looking up `this` in `localMap` (which
   resolves to `selfLocal`). `super(...)` calls get special handling
   (line 932-938) — **OUT OF PHASE C SCOPE** (Phase E for inheritance).
9. **Tail return** (line 944): `local.get $__self` as the final instr.
   Function signature has return type `(ref $structTypeIdx)`, so the
   bare `local.get` is the return value.

### Critical detail — `__tag` field

- `__tag` is at field **index 0** in `legacyFields`. User fields start
  at index 1 (or higher with parent chains, but Phase C doesn't handle
  inheritance).
- `ctx.classTagMap.get(className)` returns the unique tag value used
  by `instanceof` to discriminate this class from others.
- The IR's `IrClassShape.fields` strips `__tag` (`buildIrClassShapes:524`
  in `src/codegen/index.ts`), but `ClassRegistry.resolve` in
  `integration.ts:1387-1390` builds `fieldIdxByName` from `legacyFields`
  WHICH INCLUDES `__tag`. Therefore `class.set <userFieldName>` in IR
  already maps to the post-`__tag` index correctly — no Phase C work
  needed there.
- **Phase C's `class.new` IR lowering MUST push `__tag`'s value** when
  allocating. Either:
  - Extend `IrClassLowering` (in `integration.ts:1394`) with a new
    `tagValue` accessor that returns `ctx.classTagMap.get(className)`,
    OR
  - Have the lowerer reach into the resolver to get the class's tag
    value via a new resolver method.

### Field initialization order (subtle correctness issue)

Legacy emits in this exact order:
1. Zero-fill all fields via `struct.new` (line 737-760)
2. PropertyDeclaration initializers (line 914-926)
3. Constructor body statements (line 928-941)

Phase C must match. Otherwise:
```ts
class C {
  x: number = 1;
  constructor() {
    this.x = this.x + 10;  // legacy result: 11. wrong order: 10.
  }
}
```
The PropertyDeclaration initializer must run BEFORE the constructor
body so the body sees the initialized value.

### `this` MUST be a slot, not an SSA local

Constructor bodies may contain branches that conditionally write to
`this` (and the IR's slice 4+ supports `if`/`else`):
```ts
constructor(flag: boolean) {
  if (flag) {
    this.x = 1;
  } else {
    this.x = 2;
  }
}
```

In SSA form, the two branches produce different values. If `this` is
bound as a `local` (kind: "local") with a fixed SSA value, the writes
on each arm wouldn't merge correctly. **Bind `this` as a `slot`
binding** (kind: "slot") so cross-branch writes propagate via
`slot.write` / `slot.read` — the existing pattern for mutated lets.
The Phase B `selfParam` injection used `kind: "local"`; Phase C needs
to differentiate constructor-mode and use `kind: "slot"` instead.

For Phase B (instance methods), `this` is read-only inside the body
(callers can't reassign `this`), so `kind: "local"` is fine. Phase C's
constructor binding must be `kind: "slot"` because user code can
freely mutate `this.field` across branches AND the post-`class.new`
default fields fill the slot before any user code runs.

Wait — `slot` is for mutated identifier writes (`x = expr`). For
`this.field = expr` writes, the `this` SSA value itself doesn't
change; only its struct fields do (via `class.set`). So `this` can
be a `local` kind even in constructors — only the `struct.set` to the
field changes state.

**REVISED**: Either kind should work for `this` in a constructor. Use
`local` (matches Phase B) for consistency unless a use case surfaces
that requires slot semantics (e.g. `if (cond) { this = makeOther(); }`,
which is JS-illegal — `this` is read-only).

The slot vs. local question matters more for the ALLOCATION pattern:
the `class.new` result must be stored somewhere stable so subsequent
`class.set` ops can reference it. A `local` SSA binding is fine: the
SSA value is the struct ref, and `class.set selfV "x" expr` doesn't
change `selfV` (only the struct it references).

### Phase C — recommended implementation approach

**Approach 1: new IR primitive `IrInstr.classNew { className }`**:

1. Add a new node-kind in `src/ir/nodes.ts`:
   - `class.new { className }` → produces `IrType.class { shape }`.
2. Lower it in the resolver (`src/ir/integration.ts`):
   - Look up `IrClassLowering` via `ClassRegistry.resolve`.
   - Get `tagValue` (new accessor on `IrClassLowering`).
   - For each field in `legacyFields` (indexed 0..n):
     - Push the appropriate zero / tag value (mirror lines 740-757).
   - Emit `struct.new $structTypeIdx`.
   - Result is `(ref $structTypeIdx)`; coerce to `IrType.class` at the
     IR level.
3. Add a `constructorOf?: { className: string }` option to
   `lowerFunctionAstToIr`:
   - When set, emit `class.new` at body entry; bind `this` (kind:
     local) to the result.
   - Walk class.members for non-static `PropertyDeclaration`s with an
     initializer; emit `class.set this fieldName <init>` for each.
   - Lower constructor body statements via the existing slice-4 path
     (`this.field = expr` and `this.method()` already work).
   - Tail: emit `return this` automatically (since constructors don't
     write an explicit return).
4. The function's `returnType` should be `IrType.class { shape }`.
5. Integration loop in `compileIrPathFunctions`:
   - Detect `ConstructorDeclaration` in the class-member walk.
   - Pass `constructorOf: { className }` instead of `selfParam`.
   - Same parity check before slot patch — Phase C-emitted typeIdx
     must equal legacy `${className}_new_type` typeIdx.

**Approach 2: reuse lowerNewExpression** — REJECTED. The existing
`lowerNewExpression` lowers `new ClassName(args)` as a CALL to the
legacy ctor func; Phase C is lowering the BODY of that ctor. Different
problem.

### Risk for Phase C

1. **Typeidx parity** — same as Phase B. The constructor's legacy
   typeIdx is `${className}_new_type` from `class-bodies.ts:251`
   (params from typed source + return `(ref $structTypeIdx)`). The IR
   must match exactly; the parity guard from Phase B catches the rest.
2. **Field count drift** — `legacyFields.length` is the source of truth
   for `struct.new`. If the IR's `class.new` pushes fewer values, Wasm
   validation rejects the module. Test with classes that have fields
   spanning all the legacy default-value cases (f64, i32, ref, ref_null,
   externref, eqref).
3. **PropertyDeclaration order** — emit before body statements (legacy
   line 914 runs before line 928).
4. **Default param handling** — Phase A selector rejects params with
   `initializer`, so Phase C doesn't need lines 772-846. Defensive
   check: assert `member.parameters.every(p => !p.initializer)` before
   accepting.
5. **Inheritance** — Phase A selector rejects classes with `extends`,
   so the parent-chain field initializers (line 851-912) and `super(...)`
   handling (line 932-938) are out of Phase C scope. Phase E.
6. **Mutable `this` invariant** — JS makes `this` read-only inside a
   constructor (you can't reassign `this`, only mutate its fields).
   Bind as `kind: "local"` mirroring Phase B; document this in the
   commit so the next slice doesn't re-bikeshed.
