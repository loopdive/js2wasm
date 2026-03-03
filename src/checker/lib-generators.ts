// Generator and Iterator type declarations for TypeScript type checking.
// These are normally part of lib.es2015.iterable.d.ts but we bundle them
// separately so the ts2wasm checker can type-check generator functions.
// Note: We omit [Symbol.iterator]() methods since our lib doesn't define
// Symbol as a value (only as a type).

const libGenerators = `
interface IteratorYieldResult<TYield> {
    done: false;
    value: TYield;
}

interface IteratorReturnResult<TReturn> {
    done: true;
    value: TReturn;
}

type IteratorResult<T, TReturn = any> = IteratorYieldResult<T> | IteratorReturnResult<TReturn>;

interface Iterator<T, TReturn = any, TNext = any> {
    next(value?: TNext): IteratorResult<T, TReturn>;
    return?(value?: TReturn): IteratorResult<T, TReturn>;
    throw?(e?: any): IteratorResult<T, TReturn>;
}

interface Iterable<T> {
}

interface IterableIterator<T> extends Iterator<T> {
}

interface Generator<T = unknown, TReturn = any, TNext = unknown> extends Iterator<T, TReturn, TNext> {
    next(value?: TNext): IteratorResult<T, TReturn>;
    return(value: TReturn): IteratorResult<T, TReturn>;
    throw(e: any): IteratorResult<T, TReturn>;
}
`;

export default libGenerators;
