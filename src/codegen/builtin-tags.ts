// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Built-in type-tag registry for `instanceof` short-circuit evaluation.
 *
 * Built-in JS types like `Array`, `Error`, `TypeError`, `Map` etc. are not
 * emitted as user classes (no entry in `ctx.classTagMap`), so the existing
 * struct-tag-based `instanceof` codegen cannot resolve them. The compiler
 * falls back to a `__instanceof` host import, which is unavailable in
 * standalone / WASI mode.
 *
 * This module provides:
 *   - a stable registry of well-known built-in type names (with hierarchy info)
 *   - static-evaluation helpers that let `compileHostInstanceOf` short-circuit
 *     to a constant `i32.const 0` or `i32.const 1` whenever the LHS TypeScript
 *     type (or stack value type) is provably (in)compatible with the RHS
 *     constructor.
 *
 * The numeric tag values are reserved as **negative integers** so they cannot
 * collide with user-class tags assigned by `ctx.classTagCounter` (which starts
 * at 0 and increments). This leaves room for a future Phase 2 that actually
 * stores these tags in WasmGC structs (e.g., a $Error wrapper struct for
 * thrown exceptions).
 *
 * Phase-1 scope (this module): the registry and static elimination only.
 * Phase-2 scope (later): tagged WasmGC wrapper structs for thrown errors so
 *   `catch (e) { if (e instanceof TypeError) ... }` works without a JS host.
 *
 * See the Error wrapper implementation for the companion type-tag use.
 */

/**
 * Reserved tag values for built-in JS constructors. Negative integers so they
 * do not collide with user class tags (which start at 0 and count up).
 *
 * Phase 1 does NOT yet write these tags into WasmGC structs — they are only
 * used for static reasoning. Phase 2 will tag thrown-error wrapper structs
 * with these values so pure-Wasm `catch (e) instanceof TypeError` works.
 */
export const BUILTIN_TYPE_TAGS = {
  // Roots
  Object: -1,
  Function: -2,

  // Indexed collections
  Array: -3,

  // Errors (Error is the parent of all *Error subclasses)
  Error: -10,
  TypeError: -11,
  RangeError: -12,
  SyntaxError: -13,
  URIError: -14,
  EvalError: -15,
  ReferenceError: -16,
  AggregateError: -17,

  // Keyed collections
  Map: -20,
  Set: -21,
  WeakMap: -22,
  WeakSet: -23,

  // Built-in objects
  Date: -30,
  RegExp: -31,
  Promise: -40,

  // Binary data
  ArrayBuffer: -50,
  SharedArrayBuffer: -51,
  DataView: -52,
} as const;

export type BuiltinTypeName = keyof typeof BUILTIN_TYPE_TAGS;

/**
 * Parent constructor in the built-in inheritance chain. Each *Error subclass
 * has Error as parent; Error, Array, Map, etc. all conceptually descend from
 * Object (we record this only when relevant for `instanceof` reasoning).
 *
 * `undefined` parent means "root" — nothing further up the chain (other than
 * Object, which we don't bother chaining to since `x instanceof Object` is
 * almost always true at runtime and we don't want false negatives from
 * incomplete chain data).
 */
const BUILTIN_PARENT: Partial<Record<BuiltinTypeName, BuiltinTypeName>> = {
  TypeError: "Error",
  RangeError: "Error",
  SyntaxError: "Error",
  URIError: "Error",
  EvalError: "Error",
  ReferenceError: "Error",
  AggregateError: "Error",
};

/**
 * Returns true if `name` is a known built-in JS constructor name in the
 * registry. Caller should already have checked it isn't a user class.
 */
export function isBuiltinTypeName(name: string): name is BuiltinTypeName {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TYPE_TAGS, name);
}

/**
 * Returns true if `child` is `parent` or transitively a built-in subclass of
 * `parent` (per the registry's BUILTIN_PARENT chain). Used to statically
 * decide e.g. `new TypeError() instanceof Error` → true.
 *
 * Returns false for unknown names (caller should still fall through to the
 * host import or to a `false` constant).
 */
export function isBuiltinSubtype(child: string, parent: string): boolean {
  if (!isBuiltinTypeName(child) || !isBuiltinTypeName(parent)) return false;
  let cur: BuiltinTypeName | undefined = child;
  while (cur !== undefined) {
    if (cur === parent) return true;
    cur = BUILTIN_PARENT[cur];
  }
  return false;
}

/**
 * Returns the parent constructor name for a built-in, or undefined if it has
 * no parent in the registry. Exposed for tests / debugging.
 */
export function getBuiltinParent(name: string): BuiltinTypeName | undefined {
  if (!isBuiltinTypeName(name)) return undefined;
  return BUILTIN_PARENT[name];
}

/**
 * Built-in constructors for which we emit subclass support via the existing
 * `__new_<Name>(args...) -> externref` host imports. The subclass instance
 * is represented as externref (NOT a WasmGC struct), and the host returns a
 * real JS object with the right internal slots.
 *
 * Scope:
 *   - #1366a: Error family (Error, TypeError, RangeError, …).
 *   - #1366b: container builtins (Array, Map, Set, WeakMap, WeakSet, Promise,
 *     RegExp, ArrayBuffer). These all route through the same single-arg
 *     `__new_<Name>(arg) -> externref` host import; the runtime's
 *     `extern_class new` resolver (`runtime.ts:1604`) constructs the real
 *     built-in via `new globalThis[Name](...)` after stripping trailing nulls.
 *
 * Limitations (deferred to #1366c/d):
 *   - `instanceof Sub` for non-Error subclasses: the host instance's
 *     `[[Prototype]]` is the parent's, not Sub's, so `subInst instanceof Sub`
 *     resolves via the static reasoning path (`expressions.ts:714`) rather
 *     than runtime prototype-chain walking.
 *   - `Symbol.species` is honoured by the host's spec-conforming method
 *     impls automatically (since the instance IS a real Array/Map/etc.), but
 *     methods that return "a new instance of the same kind" return the
 *     parent type, not Sub.
 *   - Default constructor `class Sub extends Array {}` does not forward
 *     `new Sub(5)`'s `5` argument to `super(5)` (Sub has 0 declared params,
 *     so callers truncate args to match). Explicit `constructor(x){super(x)}`
 *     is the supported pattern.
 *   - Multi-arg `super(a, b)` only passes the first arg today (the existing
 *     #1366a `compileSuperCall` builtin branch is single-arg). DataView's
 *     3-arg and RegExp's 2-arg forms thus don't fully work; deferred to a
 *     follow-up that pre-scans super arities.
 */
export const BUILTIN_PARENTS_HOST_CONSTRUCTIBLE: ReadonlySet<BuiltinTypeName> = new Set<BuiltinTypeName>([
  // #1366a — Error family
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
  // #1366b — container / wrapper builtins
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "RegExp",
  "ArrayBuffer",
]);

/**
 * Returns true if `name` is a built-in JS constructor that can act as a
 * parent for a host-constructible subclass (#1366a/#1366b). The subclass
 * instance is externref-backed and `super(...)` lowers to `__new_<Name>(...)`.
 */
export function isHostConstructibleBuiltin(name: string): boolean {
  return isBuiltinTypeName(name) && BUILTIN_PARENTS_HOST_CONSTRUCTIBLE.has(name as BuiltinTypeName);
}
