/**
 * Node.js stream module — public surface.
 *
 * This file is a facade: the implementation lives in the sibling modules listed
 * below, and the export list here IS the public API. It is deliberately spelled
 * out name by name rather than using `export *`, because the submodules also
 * export internals to each other (the readable/writable state helpers, the error
 * factories, the shared side tables) and `export *` would silently publish those
 * as `node:stream` exports.
 *
 *   types.ts      every interface/type, including the six internal *shape*
 *                 interfaces the class files merge their public names onto
 *   _shared.ts    helpers with more than one consumer + the single instances of
 *                 baseStreamStates and the two default-highWaterMark `let`s
 *   base.ts       Stream ctor + prototype (pipe lives here)
 *   readable.ts   Readable ctor + prototype + Readable.from
 *   writable.ts   Writable ctor + prototype
 *   duplex.ts     Duplex ctor + prototype + Duplex.fromSource
 *   transform.ts  Transform + PassThrough
 *   utils.ts      isDisturbed/isErrored/isDestroyed/isReadable/isWritable,
 *                 destroy, duplexPair, compose, ReadableFrom, addAbortSignal
 *   operators.ts  the iterator helpers, wired up at the bottom of this file
 *
 * Load order matters and is fixed by the import order below: base before
 * readable before writable before duplex before transform, so each class's
 * flattenPrototype() runs after its parent's — the same sequence the single-file
 * version produced. ./duplex pulls ./writable and ./readable itself, so both are
 * already evaluated by the time its body runs.
 */

import { installStreamOperators, type StreamLike as OperatorStreamLike } from './operators';
import { asError, isReadableLike, isWritableLike } from './_shared';
import { Readable } from './readable';
import { Duplex } from './duplex';
import type { DuplexOptions, ReadableOptions } from './types';

export type {
    StreamOptions,
    ReadableOptions,
    WritableOptions,
    DuplexOptions,
    TransformOptions,
    PipeOptions,
    StreamIteratorOptions,
    StreamIteratorCallback,
    StreamReducer,
    StreamConstructor,
    ReadableConstructor,
    WritableConstructor,
    DuplexConstructor,
    TransformConstructor,
    PassThroughConstructor,
} from './types';

/* Each of the six class names is one identifier with two meanings — the
 * interface and the constructor — as it was before the split. The class file
 * re-declares the interface next to the value, so a single line publishes both;
 * naming them in the `export type` block above as well would be a duplicate
 * identifier (TS2300) and would break `new Readable()` at every call site. */
export { Stream } from './base';
export { Readable } from './readable';
export { Writable } from './writable';
export { Duplex } from './duplex';
export { Transform, PassThrough } from './transform';

export { getDefaultHighWaterMark, setDefaultHighWaterMark } from './_shared';

export {
    isDisturbed,
    isErrored,
    isDestroyed,
    isReadable,
    isWritable,
    destroy,
    duplexPair,
    compose,
    ReadableFrom,
    addAbortSignal,
} from './utils';

/* Iterator helpers (map/filter/forEach/reduce/some/every/find/take/drop/flatMap/
 * iterator/compose) plus Duplex.from. Installed last, after every
 * flattenPrototype() call above: flatten copies parent properties down as own
 * properties, so installing earlier would leave Duplex.prototype holding a stale
 * copy of Readable's version rather than sharing one implementation.
 * Transform/PassThrough need no separate install — their prototypes are
 * Object.create(Duplex.prototype), and flatten never severs that chain, so they
 * inherit these through it. */
installStreamOperators({
    readableFrom: (src, options) => Readable.from(
        src,
        options as ReadableOptions | undefined,
    ) as unknown as OperatorStreamLike,
    makeDuplex: (options) => new Duplex(options as DuplexOptions) as unknown as OperatorStreamLike,
    isReadableLike,
    isWritableLike,
    asError,
    readablePrototype: Readable.prototype,
    duplexPrototype: Duplex.prototype,
    duplexConstructor: Duplex as unknown as { from?: unknown },
    asyncIteratorFactory: Readable.prototype[Symbol.asyncIterator] as unknown as
        (this: OperatorStreamLike) => AsyncIterableIterator<unknown>,
});
