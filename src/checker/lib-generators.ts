// Generator type declaration for TypeScript type checking.
// Iterator/Iterable types are now in lib-es2015.ts — only Generator remains here.

const libGenerators = `
interface Generator<T = unknown, TReturn = any, TNext = unknown> extends Iterator<T, TReturn, TNext> {
    next(value?: TNext): IteratorResult<T, TReturn>;
    return(value: TReturn): IteratorResult<T, TReturn>;
    throw(e: any): IteratorResult<T, TReturn>;
}
`;

export default libGenerators;
