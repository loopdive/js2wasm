# FAQ

## How is js2 different from other JavaScript-on-Wasm approaches?

Most approaches fit into one of four broad categories:

1. bundled JavaScript interpreters,
2. bundled JavaScript engines,
3. incompatible JavaScript or TypeScript subsets, supersets, and new languages,
4. direct AOT compilation of JavaScript semantics to WasmGC.

`js2` is in the fourth category. It compiles JavaScript and TypeScript source
ahead of time to WebAssembly GC without embedding a JavaScript interpreter or a
full JavaScript engine in the output module.

## How is this different from bundling a JavaScript interpreter?

Bundled-interpreter systems compile or package a JavaScript interpreter into the
Wasm module, then run the user's JavaScript program inside that interpreter.
That can provide broad compatibility because the interpreter owns the language
semantics, but every deployed module carries the interpreter/runtime cost.

`js2` takes the opposite route: the output should contain compiled program code,
not an interpreter that evaluates the program later.

## How is this different from bundling a full JavaScript engine?

Bundled-engine systems place a production JavaScript engine inside or alongside
the Wasm artifact. That inherits mature engine semantics, but it also inherits
the size, startup, integration, and sandboxing tradeoffs of shipping an engine.
In many serverless, edge, and embedded Wasm hosts, runtime code generation is
restricted or unavailable, so a JIT-capable engine may not get to use its
normal optimization model.

`js2` does not embed a full engine. It compiles ahead of time and uses WasmGC as
the object and heap model where JavaScript semantics can be represented
directly.

## How is this different from JavaScript/TypeScript subsets or new languages?

Subset, superset, and new-language approaches usually make the language easier
to compile by changing the semantic contract: unsupported dynamic JavaScript is
excluded, custom APIs are introduced, or the language is designed around Wasm
from the start.

That is a valid product direction, but it is not the `js2` direction. `js2`
keeps ECMAScript compatibility as the north star. TypeScript syntax is accepted
as input, but TypeScript annotations are not treated as proof that JavaScript
runtime behavior has changed.

## Does js2 aim for full JavaScript compatibility?

Yes. `js2` is still an active compiler effort, so compatibility is incomplete
today, but the project is driven by ECMAScript semantics and Test262
conformance rather than by defining a permanent JavaScript-like subset.

Some dynamic features require guards, boxed representations, host fallbacks, or
separately compiled units. The goal is to isolate those costs to the regions
that need them instead of forcing all code through a bundled runtime.

## Does js2 trust TypeScript types?

No. TypeScript annotations can help seed analysis, but they are not ground truth.
JavaScript semantics still win.

`js2` specializes only where whole-program analysis proves useful invariants.
At dynamic or untyped boundaries, the compiler inserts guards, normalizes
values, falls back to dynamic representations, or delegates to host imports when
needed.

## Why does WasmGC matter?

Without WasmGC, a JavaScript compiler usually needs a custom object heap in
linear memory or a bundled runtime that manages its own objects. WasmGC gives
the compiler host-managed structs, arrays, references, and function references
that can represent many JavaScript object shapes more directly.

That makes `js2` a WasmGC-native compiler, not just a JavaScript engine packaged
for Wasm.

## Does "no bundled runtime" mean no helper code at all?

No. Real JavaScript semantics still require helpers for builtins, coercions,
interop, dynamic values, and host boundaries. The distinction is that `js2` does
not ship a fixed interpreter or engine whose cost is paid by every program.

The compiler should emit or retain only the support code the compiled program
needs, and it should compile away static cases whenever possible.

## Can js2 share infrastructure with other Wasm languages or compilers?

Yes, especially at the boundaries that are not unique to JavaScript:

- WasmGC host interop,
- Web API and WebIDL/WIT binding experiments,
- string and byte-buffer bridges,
- map, set, array, and regex implementation techniques,
- binary-size benchmarks,
- runtime compatibility tests across Wasm hosts.

The semantic layer remains separate. JavaScript builtins must follow ECMAScript
behavior, including details such as coercion, insertion order, `SameValueZero`,
property descriptors, prototypes, and observable error behavior.
