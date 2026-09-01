// Keep public exports explicit: sibling modules also expose implementation helpers.
// Import order preserves prototype flattening from base through transform.

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

// Each class module exports both its constructor and its same-named type alias.
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

// Install after flattening so copied prototype methods use the final implementations.
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
