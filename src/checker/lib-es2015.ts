/**
 * ES2015+ type declarations for Map, Set, iterable protocol,
 * and Array methods not present in the bundled ES5 lib.
 *
 * These are needed when compiling real-world TS code (e.g. the linker)
 * that uses ES2015+ features.
 */
export default `
// ── Symbol / Iterable protocol ──────────────────────────────────

interface SymbolConstructor {
  readonly iterator: unique symbol;
}
declare var Symbol: SymbolConstructor;

interface IteratorYieldResult<TYield> {
  done?: false;
  value: TYield;
}

interface IteratorReturnResult<TReturn> {
  done: true;
  value: TReturn;
}

type IteratorResult<T, TReturn = any> = IteratorYieldResult<T> | IteratorReturnResult<TReturn>;

interface Iterator<T, TReturn = any, TNext = any> {
  next(...args: [] | [TNext]): IteratorResult<T, TReturn>;
  return?(value?: TReturn): IteratorResult<T, TReturn>;
  throw?(e?: any): IteratorResult<T, TReturn>;
}

interface Iterable<T, TReturn = any, TNext = any> {
  [Symbol.iterator](): Iterator<T, TReturn, TNext>;
}

interface IterableIterator<T, TReturn = any, TNext = any> extends Iterator<T, TReturn, TNext> {
  [Symbol.iterator](): IterableIterator<T, TReturn, TNext>;
}

// ── Array ES2015+ methods ───────────────────────────────────────

interface Array<T> {
  find(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): T | undefined;
  findIndex(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): number;
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[];
  flatMap<U>(callback: (value: T, index: number, array: T[]) => U | ReadonlyArray<U>, thisArg?: any): U[];
  flat<D extends number = 1>(depth?: D): T[];
  includes(searchElement: T, fromIndex?: number): boolean;
  entries(): IterableIterator<[number, T]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

interface ReadonlyArray<T> {
  find(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): T | undefined;
  findIndex(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): number;
  map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U, thisArg?: any): U[];
  flatMap<U>(callback: (value: T, index: number, array: readonly T[]) => U | ReadonlyArray<U>, thisArg?: any): U[];
  includes(searchElement: T, fromIndex?: number): boolean;
  entries(): IterableIterator<[number, T]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

// ── Map ─────────────────────────────────────────────────────────

interface Map<K, V> {
  readonly size: number;
  clear(): void;
  delete(key: K): boolean;
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): this;
  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void;
  entries(): IterableIterator<[K, V]>;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  [Symbol.iterator](): IterableIterator<[K, V]>;
}

interface MapConstructor {
  new(): Map<any, any>;
  new<K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>;
}
declare var Map: MapConstructor;

// ── Set ─────────────────────────────────────────────────────────

interface Set<T> {
  readonly size: number;
  add(value: T): this;
  clear(): void;
  delete(value: T): boolean;
  has(value: T): boolean;
  forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any): void;
  entries(): IterableIterator<[T, T]>;
  keys(): IterableIterator<T>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

interface SetConstructor {
  new(): Set<any>;
  new<T>(values?: readonly T[] | null): Set<T>;
}
declare var Set: SetConstructor;

// TextDecoder and TextEncoder are declared in lib-dom.ts

// ── Uint8Array extensions ────────────────────────────────────────

interface Uint8ArrayConstructor {
  new(): Uint8Array<ArrayBuffer>;
}

interface Uint8Array {
  [Symbol.iterator](): IterableIterator<number>;
}

// ── String ES2015+ methods ──────────────────────────────────────

interface String {
  startsWith(searchString: string, position?: number): boolean;
  endsWith(searchString: string, endPosition?: number): boolean;
  at(index: number): string;
}

// ── Array ES2022 methods ────────────────────────────────────────

interface Array<T> {
  at(index: number): T;
}

// ── ArrayConstructor ES2015 ─────────────────────────────────────

interface ArrayConstructor {
  from<T>(arrayLike: T[]): T[];
}


// ── Number ES2015 constants and static methods ───────────────────

interface NumberConstructor {
  readonly EPSILON: number;
  readonly MAX_SAFE_INTEGER: number;
  readonly MIN_SAFE_INTEGER: number;
  readonly MAX_VALUE: number;
  readonly MIN_VALUE: number;
  readonly POSITIVE_INFINITY: number;
  readonly NEGATIVE_INFINITY: number;
  readonly NaN: number;
  isFinite(value: number): boolean;
  isInteger(value: number): boolean;
  isNaN(value: number): boolean;
  isSafeInteger(value: number): boolean;
  parseFloat(string: string): number;
  parseInt(string: string, radix?: number): number;
}

// ── Math ES2015 methods ──────────────────────────────────────────

interface Math {
  hypot(...values: number[]): number;
  acosh(x: number): number;
  asinh(x: number): number;
  atanh(x: number): number;
  cosh(x: number): number;
  sinh(x: number): number;
  tanh(x: number): number;
  cbrt(x: number): number;
  clz32(x: number): number;
  expm1(x: number): number;
  fround(x: number): number;
  imul(x: number, y: number): number;
  log1p(x: number): number;
  log2(x: number): number;
  log10(x: number): number;
  sign(x: number): number;
  trunc(x: number): number;
}

// ── Promise ES2015 ──────────────────────────────────────────────

interface PromiseConstructor {
  readonly prototype: Promise<any>;
  new <T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>;
  all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  all<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]>;
  race<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>>;
  race<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>>;
  reject<T = never>(reason?: any): Promise<T>;
  resolve(): Promise<void>;
  resolve<T>(value: T): Promise<Awaited<T>>;
  resolve<T>(value: T | PromiseLike<T>): Promise<Awaited<T>>;
}
declare var Promise: PromiseConstructor;

// ── Object.entries / Object.keys ES2017 ─────────────────────────

interface ObjectConstructor {
  entries<T>(o: { [s: string]: T } | ArrayLike<T>): [string, T][];
  entries(o: {}): [string, any][];
}
`;
