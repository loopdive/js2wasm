import ts from "typescript";

export interface TypedAST {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  diagnostics: ts.Diagnostic[];
  syntacticDiagnostics: readonly ts.Diagnostic[];
}

/**
 * Parse and type-check a TS source file.
 * In-memory CompilerHost – no filesystem needed.
 */
export function analyzeSource(
  source: string,
  fileName = "input.ts",
): TypedAST {
  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return ts.createSourceFile(
          name,
          source,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        );
      }
      if (name === "lib.d.ts" || name.startsWith("lib.")) {
        return ts.createSourceFile(
          name,
          MINIMAL_LIB_DTS,
          languageVersion,
        );
      }
      return undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) =>
      name === fileName || name === "lib.d.ts" || name.startsWith("lib."),
    readFile: () => undefined,
    getDirectories: () => [],
    directoryExists: () => true,
  };

  const program = ts.createProgram(
    [fileName],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true,
      noImplicitAny: false,
      noEmit: true,
    },
    compilerHost,
  );

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = program.getSemanticDiagnostics();
  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  return {
    sourceFile: program.getSourceFile(fileName)!,
    checker: program.getTypeChecker(),
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}

/** Minimal built-in type definitions – only what the compiler needs */
const MINIMAL_LIB_DTS = `
interface Array<T> {
  length: number;
  push(item: T): number;
  pop(): T | undefined;
  shift(): T | undefined;
  unshift(...items: T[]): number;
  splice(start: number, deleteCount?: number, ...items: T[]): T[];
  slice(start?: number, end?: number): T[];
  concat(...items: T[]): T[];
  indexOf(searchElement: T, fromIndex?: number): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  find(predicate: (value: T, index: number, array: T[]) => boolean): T | undefined;
  findIndex(predicate: (value: T, index: number, array: T[]) => boolean): number;
  filter(predicate: (value: T, index: number, array: T[]) => boolean): T[];
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[];
  forEach(callbackfn: (value: T, index: number, array: T[]) => void): void;
  reduce<U>(callbackfn: (prev: U, cur: T, index: number, array: T[]) => U, initialValue: U): U;
  some(predicate: (value: T, index: number, array: T[]) => boolean): boolean;
  every(predicate: (value: T, index: number, array: T[]) => boolean): boolean;
  sort(compareFn?: (a: T, b: T) => number): T[];
  reverse(): T[];
  join(separator?: string): string;
  [index: number]: T;
}
interface ReadonlyArray<T> {
  readonly length: number;
  indexOf(searchElement: T, fromIndex?: number): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  filter(predicate: (value: T, index: number, array: readonly T[]) => boolean): T[];
  map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U): U[];
  forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void): void;
  reduce<U>(callbackfn: (prev: U, cur: T, index: number, array: readonly T[]) => U, initialValue: U): U;
  some(predicate: (value: T, index: number, array: readonly T[]) => boolean): boolean;
  every(predicate: (value: T, index: number, array: readonly T[]) => boolean): boolean;
  find(predicate: (value: T, index: number, array: readonly T[]) => boolean): T | undefined;
  readonly [index: number]: T;
}
interface String {
  readonly length: number;
  charAt(pos: number): string;
  charCodeAt(index: number): number;
  indexOf(searchString: string, position?: number): number;
  slice(start?: number, end?: number): string;
  substring(start: number, end?: number): string;
  toLowerCase(): string;
  toUpperCase(): string;
  trim(): string;
  split(separator: string): string[];
  includes(searchString: string, position?: number): boolean;
  startsWith(searchString: string, position?: number): boolean;
  endsWith(searchString: string, endPosition?: number): boolean;
  replace(searchValue: string, replaceValue: string): string;
  padStart(maxLength: number, fillString?: string): string;
  padEnd(maxLength: number, fillString?: string): string;
}
interface Number {
  toFixed(fractionDigits?: number): string;
  toString(radix?: number): string;
}
interface Boolean {}
interface Function {}
interface Object {
  constructor: Function;
  toString(): string;
  hasOwnProperty(v: string): boolean;
}
interface RegExp {}
interface IArguments {}
interface Math {
  sqrt(x: number): number;
  abs(x: number): number;
  floor(x: number): number;
  ceil(x: number): number;
  round(x: number): number;
  trunc(x: number): number;
  sign(x: number): number;
  min(...values: number[]): number;
  max(...values: number[]): number;
  pow(x: number, y: number): number;
  exp(x: number): number;
  log(x: number): number;
  log2(x: number): number;
  log10(x: number): number;
  sin(x: number): number;
  cos(x: number): number;
  tan(x: number): number;
  asin(x: number): number;
  acos(x: number): number;
  atan(x: number): number;
  atan2(y: number, x: number): number;
  random(): number;
  hypot(...values: number[]): number;
  clz32(x: number): number;
  fround(x: number): number;
  PI: number;
  E: number;
  LN2: number;
  LN10: number;
  SQRT2: number;
}
declare const Math: Math;
declare const console: { log(...args: any[]): void };
declare const Infinity: number;
declare const NaN: number;
declare function parseInt(string: string, radix?: number): number;
declare function parseFloat(string: string): number;
declare function isNaN(number: number): boolean;
declare function isFinite(number: number): boolean;
declare function Boolean(value?: any): boolean;
interface Performance {
  now(): number;
}
declare const performance: Performance;
interface EventTarget {
  addEventListener(type: string, listener: (event: any) => void, options?: any): void;
  removeEventListener(type: string, listener: (event: any) => void, options?: any): void;
  dispatchEvent(event: any): boolean;
}
interface Node extends EventTarget {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly parentNode: Node | null;
  readonly childNodes: NodeList;
  appendChild<T extends Node>(node: T): T;
  removeChild<T extends Node>(child: T): T;
  cloneNode(deep?: boolean): Node;
  contains(other: Node | null): boolean;
}
interface NodeList {
  readonly length: number;
  item(index: number): Node | null;
  [index: number]: Node;
  forEach(callbackfn: (value: Node, key: number, parent: NodeList) => void): void;
}
interface Element extends Node {
  readonly tagName: string;
  id: string;
  className: string;
  innerHTML: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  querySelector(selectors: string): Element | null;
  querySelectorAll(selectors: string): NodeList;
  readonly children: HTMLCollection;
  readonly classList: DOMTokenList;
}
interface HTMLCollection {
  readonly length: number;
  item(index: number): Element | null;
  [index: number]: Element;
}
interface DOMTokenList {
  readonly length: number;
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  toggle(token: string, force?: boolean): boolean;
  contains(token: string): boolean;
}
interface HTMLElement extends Element {
  readonly style: CSSStyleDeclaration;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  click(): void;
  focus(): void;
  blur(): void;
}
interface CSSStyleDeclaration {
  [property: string]: string;
}
interface HTMLInputElement extends HTMLElement {
  value: string;
  checked: boolean;
  type: string;
  disabled: boolean;
}
interface HTMLButtonElement extends HTMLElement {
  disabled: boolean;
}
interface Document extends Node {
  readonly body: HTMLElement;
  readonly head: HTMLElement;
  readonly documentElement: HTMLElement;
  getElementById(elementId: string): HTMLElement | null;
  querySelector(selectors: string): Element | null;
  querySelectorAll(selectors: string): NodeList;
  createElement(tagName: string): HTMLElement;
  createTextNode(data: string): Node;
}
interface Window extends EventTarget {
  readonly document: Document;
  readonly location: { href: string; pathname: string; search: string };
  alert(message?: string): void;
  confirm(message?: string): boolean;
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(id: number): void;
  setInterval(handler: () => void, timeout?: number): number;
  clearInterval(id: number): void;
  fetch(input: string, init?: any): Promise<any>;
}
declare const document: Document;
declare const window: Window;
interface Promise<T> {
  then<U>(onfulfilled: (value: T) => U | Promise<U>): Promise<U>;
  catch(onrejected: (reason: any) => any): Promise<any>;
}
declare function fetch(input: string, init?: any): Promise<any>;
declare class EventTarget {
  addEventListener(type: string, listener: any): void;
  removeEventListener(type: string, listener: any): void;
}
declare class Node extends EventTarget {
  appendChild(node: any): any;
  removeChild(child: any): any;
  readonly parentNode: any;
  readonly nodeType: number;
  textContent: string | null;
}
declare class Element extends Node {
  readonly tagName: string;
  id: string;
  className: string;
  innerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
  readonly classList: any;
}
declare class HTMLElement extends Element {
  readonly style: CSSStyleDeclaration;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  click(): void;
  focus(): void;
  blur(): void;
}
declare class HTMLInputElement extends HTMLElement {
  value: string;
  checked: boolean;
  type: string;
  disabled: boolean;
}
declare class HTMLButtonElement extends HTMLElement {
  disabled: boolean;
}
declare class Document extends Node {
  readonly body: HTMLElement;
  readonly head: HTMLElement;
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
  createElement(tagName: string): HTMLElement;
  createTextNode(data: string): any;
}
declare class Window extends EventTarget {
  readonly document: Document;
  alert(message?: string): void;
}
declare class CSSStyleDeclaration {
  backgroundColor: string;
  color: string;
  display: string;
  width: string;
  height: string;
  margin: string;
  padding: string;
  border: string;
  position: string;
  top: string;
  left: string;
  right: string;
  bottom: string;
  fontSize: string;
  fontWeight: string;
  textAlign: string;
  opacity: string;
  overflow: string;
  zIndex: string;
  transform: string;
}
declare class NodeList {
  readonly length: number;
  item(index: number): any;
}
declare class HTMLCollection {
  readonly length: number;
  item(index: number): any;
}
declare class DOMTokenList {
  readonly length: number;
  add(token: string): void;
  remove(token: string): void;
  toggle(token: string): boolean;
  contains(token: string): boolean;
}
`;
