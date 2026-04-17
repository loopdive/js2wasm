# Closed-World AOT Boundaries for js2wasm

**Date**: 2026-04-02

## Thesis

For `js2wasm`, the central compilation question is usually not:

- "can this JavaScript/TypeScript semantic be lowered at all?"

It is:

- "can this semantic stay on a closed, specialized, statically-optimized path, or does it have to cross a boundary that forces a more generic representation?"

In a closed world where the compiler sees all reachable code and the host interface is explicit, most of the semantics we care about are in principle statically lowerable.

The practical challenge is preserving those specialized lowerings once the program crosses one of a few boundary types.

## Working model

The right mental model for `js2wasm` is:

1. Compile as much as possible into a closed world
2. Make every dynamic boundary explicit
3. Push conservative machinery to those boundaries
4. Keep the interior representation specialized and direct

That means:

- direct typed Wasm inside the closed world
- explicit host-call boundaries
- explicit separate-compilation/link boundaries
- explicit dynamic-code boundaries

The compiler should not leak boundary conservatism back into otherwise-provable hot code.

## Boundary categories

### 1. Host imports

Host imports are not fundamentally different from any other foreign function call if their interface is fixed.

The hard part is not the call itself. It is what the host is allowed to do:

- mutate passed objects
- retain references
- call back later
- observe identity, prototype, or property layout
- return values with broader/dynamic shape

If those effects are described explicitly, the compiler can keep specialization up to the boundary and only widen where the contract requires it.

### 2. Reflective operations

These are not impossible to support statically, but they expose or depend on object layout and property model details that direct struct lowering wants to hide.

Examples:

- `Object.keys(obj)`
- `Object.values(obj)`
- `Object.entries(obj)`
- `for (const k in obj)`
- `k in obj`
- `delete obj.x`
- `Object.getPrototypeOf(obj)`
- `Object.defineProperty(obj, ...)`
- `Reflect.get(...)`
- `Reflect.set(...)`
- `Reflect.ownKeys(...)`

These features do not make AOT compilation impossible. They mean the property model has to become explicit and first-class.

### 3. Prototype mutation

If prototype changes are known in the closed world, they can be compiled by versioning shapes and dispatch:

- old shape / prototype version
- new shape / prototype version
- call sites/property reads specialized to the active version

This is a compiler complexity and code-size problem, not a fundamental impossibility.

### 4. Dynamic code loading / eval

This can be isolated at the host boundary.

For `js2wasm`, the right model is:

- closed-world compiled code stays optimized
- `eval` / `new Function` / dynamic import become explicit host-mediated escape hatches
- only the dynamic boundary pays the generic cost

### 5. Separate compilation

Separate compilation temporarily loses information, but that does not mean the final linked program must stay generic.

With relocatable objects and a linker/LTO step, the system can:

- resolve imports to known definitions
- specialize call paths after linking
- remove interface checks once concrete imports are known
- monomorphize and devirtualize across module boundaries

So separate compilation is an information-staging problem, not a proof that static lowering is impossible.

### 6. Values escaping into unknown code

Example:

```ts
function f(x: Point) {
  unknownHost(x);
  return x.x + x.y;
}
```

If `unknownHost` is truly unconstrained, the compiler must conservatively assume that it may:

- mutate `x`
- retain `x`
- replace or observe its prototype
- inspect it reflectively
- call back into code that expects generic JS object semantics

If instead the boundary contract says none of that happens, the optimized representation can be preserved.

## Design principle

The architecture should be:

- **closed-world by default**
- **boundary-explicit by construction**
- **specialized until proven otherwise**

That means the compiler should prefer:

- whole-program type flow
- monomorphization
- shape inference
- versioned property layouts
- compile-time TDZ elimination
- link-time specialization
- host-effect contracts

and only fall back to generic runtime machinery when a boundary explicitly requires it.

## Implications for current regressions

The recent `bench_array` and `fib` regressions are examples of the wrong failure mode.

Those paths are closed-world numeric code, but the compiler currently regresses them toward:

- helper-call coercion
- unnecessary numeric representation churn
- conservative runtime checks

Those are exactly the kinds of costs that should remain isolated to real boundaries, not leak into proven hot paths.

## Existing issue coverage

Already covered:

- `#33` — relocatable Wasm object file emission
- `#496` — eval/new Function source transform path
- `#497` — dynamic import via host-side loading
- `#743` — whole-program type flow
- `#744` — function monomorphization
- `#746` — struct-based property access for inferred shapes
- `#747` — escape analysis for stack allocation
- `#898` — compile-time TDZ for loops
- `#899` — compile-time TDZ for closures
- `#900` — move missing-main handling out of runtime execution
- `#901` — remove helper-call coercion from numeric GC-array element access
- `#902` — remove helper-call coercion from pure numeric recursive paths

Reflective/property-model features already have issue coverage in existing work such as:

- `#61` — `Object.keys` / `Object.values` / `Object.entries`
- `#388` — externref bracket access through `__extern_get`
- `#739` — `Object.defineProperty` correctness

## New issue coverage added here

The missing architectural gaps are:

- `#903` — typed host import contracts and effect summaries
- `#904` — link-time specialization after separate compilation
- `#905` — versioned shapes for compile-time-known prototype mutation

## Conclusion

For `js2wasm`, most of the hard cases discussed as "too dynamic for AOT" are better understood as:

- boundary modeling problems
- compiler sophistication problems
- or linker/LTO problems

The goal is not to pretend the boundaries do not exist.

The goal is to make them explicit enough that everything on the inside can remain fast, typed, and statically specialized.
