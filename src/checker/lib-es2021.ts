export default `
interface String {
  /**
   * Replace all instances of a substring in a string, using a regular expression or search string.
   */
  replaceAll(searchValue: string | RegExp, replaceValue: string): string;
  replaceAll(searchValue: string | RegExp, replacer: (substring: string, ...args: any[]) => string): string;

  /**
   * Returns a new String consisting of the single UTF-16 code unit located at the specified index.
   */
  at(index: number): string | undefined;
}

interface Array<T> {
  /**
   * Returns the item located at the specified index.
   */
  at(index: number): T | undefined;

  /**
   * Returns the value of the last element in the array where predicate is true, and undefined otherwise.
   */
  findLast(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): T | undefined;

  /**
   * Returns the index of the last element in the array where predicate is true, and -1 otherwise.
   */
  findLastIndex(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): number;
}

interface ObjectConstructor {
  /**
   * Determines whether an object has a property with the specified name.
   */
  hasOwn(o: object, v: PropertyKey): boolean;
}

// ── WeakRef ──────────────────────────────────────────────────────

interface WeakRef<T extends object> {
  deref(): T | undefined;
}

interface WeakRefConstructor {
  new<T extends object>(target: T): WeakRef<T>;
}
declare var WeakRef: WeakRefConstructor;
`;
