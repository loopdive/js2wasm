---
id: 1370
sprint: 51
title: "IR: claim class methods and constructors (largest legacy bypass)"
status: ready
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
