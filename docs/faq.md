# FAQ

## How is js2 different from other JavaScript on WebAssembly approaches?

**js2** is in the direct ahead-of-time compilation category. It compiles
JavaScript and TypeScript source to WebAssembly GC without embedding a
JavaScript interpreter or a full JavaScript engine in the output module.

- **Bundled interpreters** package a JavaScript interpreter into the Wasm module
  and run the user's program inside it. That can provide broad compatibility,
  but each deployed module pays the interpreter/runtime cost.
- **Bundled engines** inherit mature JavaScript engine semantics, but also
  inherit the size, startup, integration, sandboxing, and runtime code-generation
  tradeoffs of shipping an engine.
- **Subsets, supersets, and new languages** make compilation easier by changing
  the semantic contract: unsupported dynamic JavaScript is excluded, custom APIs
  are introduced, or the language is designed around Wasm from the start.
- **Direct AOT compilation to WasmGC** keeps JavaScript semantics as the target
  and uses WasmGC as the object and heap model where those semantics can be
  represented directly.

That is the `js2` direction: ECMAScript compatibility stays the north star.
TypeScript syntax is accepted as input, but TypeScript annotations are not
treated as proof that JavaScript runtime behavior has changed.

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
