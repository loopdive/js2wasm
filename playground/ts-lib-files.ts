import libEs5 from "typescript/lib/lib.es5.d.ts?raw";
import libDecorators from "typescript/lib/lib.decorators.d.ts?raw";
import libDecoratorsLegacy from "typescript/lib/lib.decorators.legacy.d.ts?raw";
import libDom from "typescript/lib/lib.dom.d.ts?raw";
import libEs2015Core from "typescript/lib/lib.es2015.core.d.ts?raw";
import libEs2015Collection from "typescript/lib/lib.es2015.collection.d.ts?raw";
import libEs2015Generator from "typescript/lib/lib.es2015.generator.d.ts?raw";
import libEs2015Iterable from "typescript/lib/lib.es2015.iterable.d.ts?raw";
import libEs2015Promise from "typescript/lib/lib.es2015.promise.d.ts?raw";
import libEs2015Proxy from "typescript/lib/lib.es2015.proxy.d.ts?raw";
import libEs2015Reflect from "typescript/lib/lib.es2015.reflect.d.ts?raw";
import libEs2015Symbol from "typescript/lib/lib.es2015.symbol.d.ts?raw";
import libEs2015SymbolWellknown from "typescript/lib/lib.es2015.symbol.wellknown.d.ts?raw";
import libEs2016ArrayInclude from "typescript/lib/lib.es2016.array.include.d.ts?raw";
import libEs2016Intl from "typescript/lib/lib.es2016.intl.d.ts?raw";
import libEs2017Date from "typescript/lib/lib.es2017.date.d.ts?raw";
import libEs2017Intl from "typescript/lib/lib.es2017.intl.d.ts?raw";
import libEs2017Object from "typescript/lib/lib.es2017.object.d.ts?raw";
import libEs2017SharedMemory from "typescript/lib/lib.es2017.sharedmemory.d.ts?raw";
import libEs2017String from "typescript/lib/lib.es2017.string.d.ts?raw";
import libEs2017TypedArrays from "typescript/lib/lib.es2017.typedarrays.d.ts?raw";
import libEs2018AsyncGenerator from "typescript/lib/lib.es2018.asyncgenerator.d.ts?raw";
import libEs2018AsyncIterable from "typescript/lib/lib.es2018.asynciterable.d.ts?raw";
import libEs2018Intl from "typescript/lib/lib.es2018.intl.d.ts?raw";
import libEs2018Promise from "typescript/lib/lib.es2018.promise.d.ts?raw";
import libEs2018Regexp from "typescript/lib/lib.es2018.regexp.d.ts?raw";
import libEs2019Array from "typescript/lib/lib.es2019.array.d.ts?raw";
import libEs2019Intl from "typescript/lib/lib.es2019.intl.d.ts?raw";
import libEs2019Object from "typescript/lib/lib.es2019.object.d.ts?raw";
import libEs2019String from "typescript/lib/lib.es2019.string.d.ts?raw";
import libEs2019Symbol from "typescript/lib/lib.es2019.symbol.d.ts?raw";
import libEs2020BigInt from "typescript/lib/lib.es2020.bigint.d.ts?raw";
import libEs2020Date from "typescript/lib/lib.es2020.date.d.ts?raw";
import libEs2020Intl from "typescript/lib/lib.es2020.intl.d.ts?raw";
import libEs2020Number from "typescript/lib/lib.es2020.number.d.ts?raw";
import libEs2020Promise from "typescript/lib/lib.es2020.promise.d.ts?raw";
import libEs2020SharedMemory from "typescript/lib/lib.es2020.sharedmemory.d.ts?raw";
import libEs2020String from "typescript/lib/lib.es2020.string.d.ts?raw";
import libEs2020SymbolWellknown from "typescript/lib/lib.es2020.symbol.wellknown.d.ts?raw";
import libEs2021Intl from "typescript/lib/lib.es2021.intl.d.ts?raw";
import libEs2021Promise from "typescript/lib/lib.es2021.promise.d.ts?raw";
import libEs2021String from "typescript/lib/lib.es2021.string.d.ts?raw";
import libEs2021WeakRef from "typescript/lib/lib.es2021.weakref.d.ts?raw";

const TS_LIB_FILES = {
  "lib.es5.d.ts": libEs5,
  "lib.decorators.d.ts": libDecorators,
  "lib.decorators.legacy.d.ts": libDecoratorsLegacy,
  "lib.dom.d.ts": libDom,
  "lib.es2015.core.d.ts": libEs2015Core,
  "lib.es2015.collection.d.ts": libEs2015Collection,
  "lib.es2015.generator.d.ts": libEs2015Generator,
  "lib.es2015.iterable.d.ts": libEs2015Iterable,
  "lib.es2015.promise.d.ts": libEs2015Promise,
  "lib.es2015.proxy.d.ts": libEs2015Proxy,
  "lib.es2015.reflect.d.ts": libEs2015Reflect,
  "lib.es2015.symbol.d.ts": libEs2015Symbol,
  "lib.es2015.symbol.wellknown.d.ts": libEs2015SymbolWellknown,
  "lib.es2016.array.include.d.ts": libEs2016ArrayInclude,
  "lib.es2016.intl.d.ts": libEs2016Intl,
  "lib.es2017.date.d.ts": libEs2017Date,
  "lib.es2017.intl.d.ts": libEs2017Intl,
  "lib.es2017.object.d.ts": libEs2017Object,
  "lib.es2017.sharedmemory.d.ts": libEs2017SharedMemory,
  "lib.es2017.string.d.ts": libEs2017String,
  "lib.es2017.typedarrays.d.ts": libEs2017TypedArrays,
  "lib.es2018.asyncgenerator.d.ts": libEs2018AsyncGenerator,
  "lib.es2018.asynciterable.d.ts": libEs2018AsyncIterable,
  "lib.es2018.intl.d.ts": libEs2018Intl,
  "lib.es2018.promise.d.ts": libEs2018Promise,
  "lib.es2018.regexp.d.ts": libEs2018Regexp,
  "lib.es2019.array.d.ts": libEs2019Array,
  "lib.es2019.intl.d.ts": libEs2019Intl,
  "lib.es2019.object.d.ts": libEs2019Object,
  "lib.es2019.string.d.ts": libEs2019String,
  "lib.es2019.symbol.d.ts": libEs2019Symbol,
  "lib.es2020.bigint.d.ts": libEs2020BigInt,
  "lib.es2020.date.d.ts": libEs2020Date,
  "lib.es2020.intl.d.ts": libEs2020Intl,
  "lib.es2020.number.d.ts": libEs2020Number,
  "lib.es2020.promise.d.ts": libEs2020Promise,
  "lib.es2020.sharedmemory.d.ts": libEs2020SharedMemory,
  "lib.es2020.string.d.ts": libEs2020String,
  "lib.es2020.symbol.wellknown.d.ts": libEs2020SymbolWellknown,
  "lib.es2021.intl.d.ts": libEs2021Intl,
  "lib.es2021.promise.d.ts": libEs2021Promise,
  "lib.es2021.string.d.ts": libEs2021String,
  "lib.es2021.weakref.d.ts": libEs2021WeakRef,
} as const;

(globalThis as any).__js2wasmTsLibFiles = {
  ...((globalThis as any).__js2wasmTsLibFiles ?? (globalThis as any).__ts2wasmTsLibFiles ?? {}),
  ...TS_LIB_FILES,
};

export {};
