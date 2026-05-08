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
