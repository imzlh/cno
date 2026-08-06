/* Node's stream iterator helpers (Readable.prototype.map/filter/forEach/reduce/
 * some/every/find/take/drop/flatMap/iterator/compose plus Duplex.from).
 *
 * Ported from the reference implementation in node's own
 * `internal/streams/operators` + `internal/streams/duplexify`, read out of the
 * installed v24 binary rather than reconstructed from docs, because the
 * ordering guarantees in map()'s pump loop are load-bearing and easy to get
 * subtly wrong. The queue-of-promises structure below is deliberately shaped
 * like node's: it is what makes `concurrency > 1` emit in *input* order while
 * still running N callbacks at once.
 *
 * Wired up from mod.ts via installStreamOperators() so that this file can
 * import nothing from mod.ts and avoid a circular import.
 */

type AnyFn = (...args: unknown[]) => unknown;

/* Minimal structural view of the streams this module manipulates. Deliberately
 * not importing the real Readable/Duplex types: this file is loaded *by* mod.ts,
 * so a type-only import is fine but a value import would cycle. */
export interface StreamLike {
    read?(n?: number): unknown;
    write?(chunk: unknown, encoding?: unknown, cb?: unknown): boolean;
    end?(): unknown;
    push?(chunk: unknown, encoding?: unknown): boolean;
    destroy?(error?: Error | null): unknown;
    destroyed?: boolean;
    errored?: Error | null;
    readable?: boolean;
    writable?: boolean;
    readableEnded?: boolean;
    writableFinished?: boolean;
    readableObjectMode?: boolean;
    writableObjectMode?: boolean;
    on?(event: string, fn: (...args: unknown[]) => void): unknown;
    once?(event: string, fn: (...args: unknown[]) => void): unknown;
    off?(event: string, fn: (...args: unknown[]) => void): unknown;
    emit?(event: string, ...args: unknown[]): unknown;
    pause?(): unknown;
    resume?(): unknown;
    pipe?(dest: unknown, opts?: unknown): unknown;
    _read?(size: number): void;
    _write?(chunk: unknown, encoding: unknown, cb: (err?: Error | null) => void): void;
    _final?(cb: (err?: Error | null) => void): void;
    _destroy?(err: Error | null, cb: (err?: Error | null) => void): void;
    _readableState?: { autoDestroy?: boolean; destroyed?: boolean; endEmitted?: boolean };
    [Symbol.asyncIterator]?(): AsyncIterableIterator<unknown>;
}

export interface OperatorDeps {
    /** Wraps an async generator back into an object-mode Readable. */
    readableFrom(src: Iterable<unknown> | AsyncIterable<unknown>, options?: unknown): StreamLike;
    /** Constructs a Duplex; used by Duplex.from and compose. */
    makeDuplex(options?: unknown): StreamLike;
    isReadableLike(value: unknown): boolean;
    isWritableLike(value: unknown): boolean;
    asError(value: unknown): Error;
    /** Prototypes the helpers get installed onto. */
    readablePrototype: object;
    duplexPrototype: object;
    /** Constructor that receives the static `from`. */
    duplexConstructor: { from?: unknown };
    /** cno's own `[Symbol.asyncIterator]`, used as the base for iterator(). */
    asyncIteratorFactory(this: StreamLike): AsyncIterableIterator<unknown>;
}

const kEmpty = Symbol('kEmpty');
const kEof = Symbol('kEof');

/* ---------------------------------------------------------------- errors --- */

function ERR_INVALID_ARG_TYPE(name: string, expected: string, actual: unknown): TypeError & { code: string } {
    const type = actual === null ? 'null' : typeof actual;
    let received: string;
    if (type === 'object' || type === 'function') {
        received = `an instance of ${(actual as object)?.constructor?.name ?? type}`;
    } else if (type === 'string') {
        received = `type string ('${String(actual)}')`;
    } else {
        received = `type ${type} (${String(actual)})`;
    }
    const err = new TypeError(`The "${name}" argument must be ${expected}. Received ${received}`);
    return Object.assign(err, { code: 'ERR_INVALID_ARG_TYPE' });
}

function ERR_OUT_OF_RANGE(name: string, range: string, actual: unknown): RangeError & { code: string } {
    const err = new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${String(actual)}`);
    return Object.assign(err, { code: 'ERR_OUT_OF_RANGE' });
}

function ERR_ILLEGAL_CONSTRUCTOR(): TypeError & { code: string } {
    return Object.assign(new TypeError('Illegal constructor'), { code: 'ERR_ILLEGAL_CONSTRUCTOR' });
}

function ERR_INVALID_RETURN_VALUE(expected: string, name: string, actual: unknown): TypeError & { code: string } {
    const type = actual === null ? 'null' : typeof actual;
    const err = new TypeError(`Expected ${expected} to be returned from the "${name}" function but got ${type}.`);
    return Object.assign(err, { code: 'ERR_INVALID_RETURN_VALUE' });
}

/* node's reduce rejects with a subclass of ERR_MISSING_ARGS carrying a bespoke
 * message. The class name is observable via `err.constructor.name`, so it is
 * reproduced exactly rather than thrown as a plain TypeError. */
class ReduceAwareErrMissingArgs extends TypeError {
    code = 'ERR_MISSING_ARGS';
    constructor() {
        super('Reduce of an empty stream requires an initial value');
    }
}

/* Likewise a real class, not an Error with `.name` reassigned: node's is
 * `class AbortError extends Error`, and `err.constructor.name` differs between
 * the two. */
class AbortError extends Error {
    code = 'ABORT_ERR';
    constructor(cause?: unknown) {
        super('The operation was aborted');
        this.name = 'AbortError';
        if (cause !== undefined) this.cause = cause;
    }
}

function createAbortError(reason?: unknown): Error & { code: string; cause?: unknown } {
    return new AbortError(reason) as Error & { code: string; cause?: unknown };
}

/* ------------------------------------------------------------ validators --- */

function validateFunction(value: unknown, name: string): void {
    if (typeof value !== 'function') throw ERR_INVALID_ARG_TYPE(name, 'of type function', value);
}

function validateObject(value: unknown, name: string): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw ERR_INVALID_ARG_TYPE(name, 'of type object', value);
    }
}

function validateAbortSignal(value: unknown, name: string): void {
    if (typeof value !== 'object' || value === null || !('aborted' in value)) {
        throw ERR_INVALID_ARG_TYPE(name, 'an instance of AbortSignal', value);
    }
}

function validateInteger(value: unknown, name: string, min: number): void {
    if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'of type number', value);
    if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
    if (value < min) throw ERR_OUT_OF_RANGE(name, `>= ${min}`, value);
}

/* Named after node's helper, and like node's it does NOT truncate — verified
 * against v24: take(1.5) yields 2 items and take(-0.5) throws, so this cannot
 * be a trunc-then-check. Only NaN is normalised, and negatives are rejected. */
function toIntegerOrInfinity(value: unknown): number {
    const number = Number(value);
    if (Number.isNaN(number)) return 0;
    if (number < 0) throw ERR_OUT_OF_RANGE('number', '>= 0', number);
    return number;
}

type OperatorOptions = {
    signal?: AbortSignal;
    concurrency?: number;
    highWaterMark?: number;
} | null | undefined;

function validateStreamOptions(options: OperatorOptions): void {
    if (options != null) validateObject(options, 'options');
    if (options?.signal != null) validateAbortSignal(options.signal, 'options.signal');
}

/* ------------------------------------------------------------------- map --- */

/* Structure is node's, near-verbatim. The invariant that matters: every started
 * callback's promise is pushed onto `queue` in *input* order, and the consumer
 * loop awaits `queue[0]`. That is what makes concurrency>1 still emit in input
 * order — a later item finishing first does not let it overtake, it just sits
 * resolved in the queue. Reordering these pushes silently breaks that. */
function mapOperator(
    this: StreamLike,
    fn: AnyFn,
    options?: OperatorOptions,
): AsyncGenerator<unknown> {
    validateFunction(fn, 'fn');
    validateStreamOptions(options);

    let concurrency = 1;
    if (options?.concurrency != null) concurrency = Math.floor(options.concurrency);

    let highWaterMark = concurrency - 1;
    if (options?.highWaterMark != null) highWaterMark = Math.floor(options.highWaterMark);

    validateInteger(concurrency, 'options.concurrency', 1);
    validateInteger(highWaterMark, 'options.highWaterMark', 0);

    highWaterMark += concurrency;

    return (async function* map(this: StreamLike) {
        const signal = AbortSignal.any([options?.signal].filter(Boolean) as AbortSignal[]);
        const stream = this;
        const queue: unknown[] = [];
        const signalOpt = { signal };

        /* Held in an object rather than as bare `let`s: both are only ever
         * assigned inside a `new Promise` executor, which TS treats as deferred,
         * so it narrows the plain variables to `null` and rejects the calls in
         * the finally block. The indirection keeps the declared type. */
        const pending: { next: (() => void) | null; resume: (() => void) | null } = {
            next: null,
            resume: null,
        };
        let done = false;
        let cnt = 0;

        function onCatch(): void {
            done = true;
            afterItemProcessed();
        }

        function afterItemProcessed(): void {
            cnt -= 1;
            maybeResume();
        }

        function maybeResume(): void {
            if (pending.resume && !done && cnt < concurrency && queue.length < highWaterMark) {
                pending.resume();
                pending.resume = null;
            }
        }

        async function pump(): Promise<void> {
            try {
                for await (const val of stream as AsyncIterable<unknown>) {
                    if (done) return;
                    if (signal.aborted) throw createAbortError(signal.reason);

                    let mapped: unknown;
                    try {
                        mapped = fn(val, signalOpt);
                        if (mapped === kEmpty) continue;
                        mapped = Promise.resolve(mapped);
                    } catch (err) {
                        mapped = Promise.reject(err);
                    }

                    cnt += 1;

                    (mapped as Promise<unknown>).then(afterItemProcessed, onCatch);

                    queue.push(mapped);
                    if (pending.next) {
                        pending.next();
                        pending.next = null;
                    }

                    if (!done && (queue.length >= highWaterMark || cnt >= concurrency)) {
                        await new Promise<void>((resolve) => { pending.resume = resolve; });
                    }
                }
                queue.push(kEof);
            } catch (err) {
                const val = Promise.reject(err);
                val.then(afterItemProcessed, onCatch);
                queue.push(val);
            } finally {
                done = true;
                if (pending.next) {
                    pending.next();
                    pending.next = null;
                }
            }
        }

        void pump();

        try {
            while (true) {
                while (queue.length > 0) {
                    const val = await queue[0];

                    if (val === kEof) return;
                    if (signal.aborted) throw createAbortError(signal.reason);
                    if (val !== kEmpty) yield val;

                    queue.shift();
                    maybeResume();
                }

                await new Promise<void>((resolve) => { pending.next = resolve; });
            }
        } finally {
            done = true;
            if (pending.resume) {
                pending.resume();
                pending.resume = null;
            }
        }
    }).call(this);
}

/* ---------------------------------------------- filter / flatMap / take --- */

function filterOperator(this: StreamLike, fn: AnyFn, options?: OperatorOptions): AsyncGenerator<unknown> {
    validateFunction(fn, 'fn');
    async function filterFn(value: unknown, opts: unknown): Promise<unknown> {
        if (await fn(value, opts)) return value;
        return kEmpty;
    }
    return mapOperator.call(this, filterFn as AnyFn, options);
}

function flatMapOperator(this: StreamLike, fn: AnyFn, options?: OperatorOptions): AsyncGenerator<unknown> {
    const values = mapOperator.call(this, fn, options);
    return (async function* flatMap() {
        for await (const val of values) {
            yield* (val as Iterable<unknown>);
        }
    }).call(this);
}

function takeOperator(this: StreamLike, count: unknown, options?: OperatorOptions): AsyncGenerator<unknown> {
    validateStreamOptions(options);
    let number = toIntegerOrInfinity(count);
    return (async function* take(this: StreamLike) {
        if (options?.signal?.aborted) throw createAbortError(options.signal.reason);
        for await (const val of this as AsyncIterable<unknown>) {
            if (options?.signal?.aborted) throw createAbortError(options.signal.reason);
            if (number-- > 0) yield val;

            // Don't pull another item once the budget is spent — this early
            // return is what destroys the source on take(n).
            if (number <= 0) return;
        }
    }).call(this);
}

function dropOperator(this: StreamLike, count: unknown, options?: OperatorOptions): AsyncGenerator<unknown> {
    validateStreamOptions(options);
    let number = toIntegerOrInfinity(count);
    return (async function* drop(this: StreamLike) {
        if (options?.signal?.aborted) throw createAbortError(options.signal.reason);
        for await (const val of this as AsyncIterable<unknown>) {
            if (options?.signal?.aborted) throw createAbortError(options.signal.reason);
            if (number-- <= 0) yield val;
        }
    }).call(this);
}

/* ------------------------------------------------- promise-returning ops --- */

/* Note these are `async function`s in node too, so a bad `fn` produces a
 * REJECTED PROMISE rather than a synchronous throw — unlike map/filter/flatMap,
 * which throw synchronously. Verified against v24; keeping the asymmetry. */

async function forEachOperator(this: StreamLike, fn: AnyFn, options?: OperatorOptions): Promise<void> {
    validateFunction(fn, 'fn');
    async function forEachFn(value: unknown, opts: unknown): Promise<unknown> {
        await fn(value, opts);
        return kEmpty;
    }
    for await (const _unused of mapOperator.call(this, forEachFn as AnyFn, options)) {
        void _unused;
    }
}

async function reduceOperator(
    this: StreamLike,
    reducer: AnyFn,
    initialValue?: unknown,
    options?: OperatorOptions,
): Promise<unknown> {
    validateFunction(reducer, 'reducer');
    validateStreamOptions(options);

    /* Deliberately arguments.length, not `initialValue !== undefined`: node
     * treats an explicitly-passed `undefined` as a real initial value. */
    let hasInitialValue = arguments.length > 1;
    if (options?.signal?.aborted) {
        const err = createAbortError(options.signal.reason);
        this.once?.('error', () => {}); // error is already propagated via the throw
        this.destroy?.(err);
        throw err;
    }
    const ac = new AbortController();
    const signal = ac.signal;
    if (options?.signal) {
        options.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    let gotAnyItemFromStream = false;
    try {
        for await (const value of this as AsyncIterable<unknown>) {
            gotAnyItemFromStream = true;
            if (options?.signal?.aborted) throw createAbortError(options.signal.reason);
            if (!hasInitialValue) {
                initialValue = value;
                hasInitialValue = true;
            } else {
                initialValue = await reducer(initialValue, value, { signal });
            }
        }
        if (!gotAnyItemFromStream && !hasInitialValue) throw new ReduceAwareErrMissingArgs();
    } finally {
        ac.abort();
    }
    return initialValue;
}

async function toArrayOperator(this: StreamLike, options?: OperatorOptions): Promise<unknown[]> {
    validateStreamOptions(options);
    const result: unknown[] = [];
    for await (const val of this as AsyncIterable<unknown>) {
        if (options?.signal?.aborted) throw createAbortError(options.signal.reason);
        result.push(val);
    }
    return result;
}

async function someOperator(this: StreamLike, fn: AnyFn, options?: OperatorOptions): Promise<boolean> {
    for await (const _unused of filterOperator.call(this, fn, options)) {
        void _unused;
        return true; // early return runs the generator's finally -> destroys source
    }
    return false;
}

async function everyOperator(this: StreamLike, fn: AnyFn, options?: OperatorOptions): Promise<boolean> {
    validateFunction(fn, 'fn');
    // De Morgan, exactly as node does it.
    return !(await someOperator.call(this, (async (...args: unknown[]) => {
        return !(await fn(...args));
    }) as AnyFn, options));
}

async function findOperator(this: StreamLike, fn: AnyFn, options?: OperatorOptions): Promise<unknown> {
    for await (const result of filterOperator.call(this, fn, options)) {
        return result;
    }
    return undefined;
}

/* -------------------------------------------------------------- iterator --- */

/* cno's `[Symbol.asyncIterator]` always destroys the stream in return(), which
 * is the correct default. `iterator({ destroyOnReturn: false })` has to keep it
 * alive and resumable instead, so we reuse the base iterator and swap return().
 * Safe because the base implementation cleans up its own event listeners as each
 * next() settles — there is nothing left attached to leak when we bail out. */
function iteratorOperator(
    this: StreamLike,
    deps: OperatorDeps,
    options?: { destroyOnReturn?: boolean } | null,
): AsyncIterableIterator<unknown> {
    if (options !== undefined && options !== null) validateObject(options, 'options');
    const base = deps.asyncIteratorFactory.call(this);
    if (options?.destroyOnReturn === false) {
        const stream = this;
        const wrapped: AsyncIterableIterator<unknown> = {
            [Symbol.asyncIterator]() { return wrapped; },
            next: () => base.next(),
            async return() {
                stream.pause?.();
                return { done: true, value: undefined };
            },
            async throw(err: unknown) {
                stream.pause?.();
                throw err;
            },
        } as AsyncIterableIterator<unknown>;
        return wrapped;
    }
    return base;
}

/* --------------------------------------------------------------- compose --- */

/* `readable.compose(tail)`: pipe this -> tail and expose tail's output. The
 * result's writable side is live only when the *head* is writable, so
 * `Readable.from([...]).compose(t)` yields a Duplex with writable===false —
 * matching node. (mod.ts's free `compose()` instead throws when the head is not
 * writable, so this cannot simply delegate to it.) */
function composeStreams(deps: OperatorDeps, head: StreamLike, tail: unknown): StreamLike {
    let tailStream: StreamLike;
    if (typeof tail === 'function') {
        tailStream = duplexFrom(deps, tail);
    } else if (tail && typeof tail === 'object') {
        tailStream = tail as StreamLike;
    } else {
        throw ERR_INVALID_ARG_TYPE('stream', 'an instance of Stream, Iterable, AsyncIterable or Function', tail);
    }

    if (!deps.isWritableLike(tailStream)) {
        throw ERR_INVALID_ARG_TYPE('streams[1]', 'writable', tail);
    }

    const headWritable = deps.isWritableLike(head);

    const composed = deps.makeDuplex({
        readableObjectMode: true,
        writableObjectMode: !!head.writableObjectMode,
        writable: headWritable,
        read() {},
        write(chunk: unknown, encoding: unknown, callback: (err?: Error | null) => void) {
            if (!headWritable) {
                callback(ERR_INVALID_ARG_TYPE('streams[0]', 'writable', head));
                return;
            }
            const ok = head.write?.(chunk, encoding);
            if (ok === false && typeof head.once === 'function') {
                head.once('drain', () => callback());
                return;
            }
            callback();
        },
        final(callback: (err?: Error | null) => void) {
            if (headWritable) head.end?.();
            callback();
        },
    });

    head.pipe?.(tailStream);
    head.on?.('error', (err: unknown) => {
        if (!tailStream.destroyed) tailStream.destroy?.(deps.asError(err));
    });

    tailStream.on?.('data', (chunk: unknown) => {
        composed.push?.(chunk);
    });
    tailStream.on?.('end', () => {
        composed.push?.(null);
    });
    tailStream.on?.('error', (err: unknown) => {
        composed.destroy?.(deps.asError(err));
    });
    /* Destroying the composed stream (e.g. take(1) bailing out early) has to
     * reach all the way back to the original source, or the head leaks. */
    composed.on?.('close', () => {
        if (!tailStream.destroyed) tailStream.destroy?.();
        if (!head.destroyed) head.destroy?.();
    });

    return composed;
}

/* ------------------------------------------------------------ Duplex.from --- */

function isIterableValue(value: unknown): boolean {
    return value != null
        && (typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
            || typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function');
}

function isThenable(value: unknown): boolean {
    return value != null
        && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as PromiseLike<unknown>).then === 'function';
}

/* Feeds an iterable into the readable side of an existing duplex. Mirrors
 * cno's Readable.from: a string or Buffer is pushed whole rather than iterated
 * per character (verified: Duplex.from('abc') yields one 'abc' chunk). */
function pumpIterableInto(
    deps: OperatorDeps,
    target: StreamLike,
    source: Iterable<unknown> | AsyncIterable<unknown>,
): void {
    if (typeof source === 'string' || (source as unknown) instanceof Uint8Array) {
        queueMicrotask(() => {
            target.push?.(source);
            target.push?.(null);
        });
        return;
    }
    void (async () => {
        try {
            for await (const chunk of source as AsyncIterable<unknown>) {
                if (target.destroyed) return;
                target.push?.(chunk);
            }
            if (!target.destroyed) target.push?.(null);
        } catch (err) {
            target.destroy?.(deps.asError(err));
        }
    })();
}

/* node's fromAsyncGen: always calls the body with a source async-iterator, so a
 * 0-arg generator function still works (it just ignores the source) while a
 * transform-style `async function* (src)` gets a live writable side. */
function fromAsyncGen(deps: OperatorDeps, fn: AnyFn): {
    value: unknown;
    write(chunk: unknown, encoding: unknown, cb: (err?: Error | null) => void): void;
    final(cb: (err?: Error | null) => void): void;
    destroy(err: Error | null, cb: (err?: Error | null) => void): void;
} {
    type Pending = { chunk?: unknown; done: boolean; cb: (err?: Error | null) => void };
    let resolve: ((value: Pending) => void) | null = null;
    let promise: Promise<Pending> | null = new Promise<Pending>((r) => { resolve = r; });
    const ac = new AbortController();
    const signal = ac.signal;

    const value = fn((async function* () {
        while (true) {
            const current = promise;
            promise = null;
            const { chunk, done, cb } = await current!;
            queueMicrotask(() => cb());
            if (done) return;
            if (signal.aborted) throw createAbortError(signal.reason);
            promise = new Promise<Pending>((r) => { resolve = r; });
            yield chunk;
        }
    })(), { signal });

    return {
        value,
        write(chunk: unknown, encoding: unknown, cb: (err?: Error | null) => void) {
            const r = resolve;
            resolve = null;
            r?.({ chunk, done: false, cb });
        },
        final(cb: (err?: Error | null) => void) {
            const r = resolve;
            resolve = null;
            r?.({ done: true, cb });
        },
        destroy(err: Error | null, cb: (err?: Error | null) => void) {
            ac.abort(err ?? undefined);
            if (resolve !== null) {
                const r = resolve;
                resolve = null;
                r({ done: true, cb() {} });
            }
            cb(err);
        },
    };
}

export function duplexFrom(deps: OperatorDeps, body: unknown, name = 'body'): StreamLike {
    const readableSide = deps.isReadableLike(body);
    const writableSide = deps.isWritableLike(body);

    if (readableSide && writableSide) return body as StreamLike;
    if (readableSide) return pairToDuplex(deps, body as StreamLike, undefined);
    if (writableSide) return pairToDuplex(deps, undefined, body as StreamLike);

    if (typeof body === 'function') {
        const { value, write, final, destroy } = fromAsyncGen(deps, body as AnyFn);

        if (deps.isReadableLike(value) && deps.isWritableLike(value)) return value as StreamLike;

        if (isIterableValue(value)) {
            const duplex = deps.makeDuplex({
                objectMode: true,
                read() {},
                write,
                final,
                destroy,
            });
            pumpIterableInto(deps, duplex, value as AsyncIterable<unknown>);
            return duplex;
        }

        if (isThenable(value)) {
            const promise = (value as PromiseLike<unknown>).then(
                (val: unknown) => {
                    if (val != null) throw ERR_INVALID_RETURN_VALUE('nully', name, val);
                },
                (err: unknown) => { duplex.destroy?.(deps.asError(err)); },
            );
            const duplex: StreamLike = deps.makeDuplex({
                objectMode: true,
                readable: false,
                write,
                final(cb: (err?: Error | null) => void) {
                    final(() => {
                        void (async () => {
                            try {
                                await promise;
                                queueMicrotask(() => cb(null));
                            } catch (err) {
                                queueMicrotask(() => cb(deps.asError(err)));
                            }
                        })();
                    });
                },
                destroy,
            });
            return duplex;
        }

        throw ERR_INVALID_RETURN_VALUE('Iterable, AsyncIterable or AsyncFunction', name, value);
    }

    if (isIterableValue(body)) {
        const duplex = deps.makeDuplex({ objectMode: true, writable: false, read() {} });
        pumpIterableInto(deps, duplex, body as Iterable<unknown>);
        return duplex;
    }

    const pair = body as { readable?: unknown; writable?: unknown } | null;
    if (pair && (typeof pair.writable === 'object' || typeof pair.readable === 'object')) {
        const readable = pair.readable
            ? (deps.isReadableLike(pair.readable) ? pair.readable as StreamLike : duplexFrom(deps, pair.readable))
            : undefined;
        const writable = pair.writable
            ? (deps.isWritableLike(pair.writable) ? pair.writable as StreamLike : duplexFrom(deps, pair.writable))
            : undefined;
        return pairToDuplex(deps, readable, writable);
    }

    if (isThenable(body)) {
        const duplex = deps.makeDuplex({ objectMode: true, writable: false, read() {} });
        (body as PromiseLike<unknown>).then(
            (val: unknown) => {
                if (val != null) duplex.push?.(val);
                duplex.push?.(null);
            },
            (err: unknown) => { duplex.destroy?.(deps.asError(err)); },
        );
        return duplex;
    }

    throw ERR_INVALID_ARG_TYPE(
        name,
        "one of type Stream, Iterable, AsyncIterable, Function, '{ readable, writable } pair' or Promise",
        body,
    );
}

/* node's _duplexify: bridge an (optional) readable and (optional) writable into
 * one Duplex, forwarding data, backpressure, end and destroy in both directions. */
function pairToDuplex(deps: OperatorDeps, r?: StreamLike, w?: StreamLike): StreamLike {
    const readable = !!r;
    const writable = !!w;

    let ondrain: (() => void) | null = null;
    let onfinish: (() => void) | null = null;

    const d: StreamLike = deps.makeDuplex({
        readableObjectMode: !!r?.readableObjectMode,
        writableObjectMode: !!w?.writableObjectMode,
        readable,
        writable,
        read() {},
        write(chunk: unknown, encoding: unknown, callback: (err?: Error | null) => void) {
            if (!w) { callback(); return; }
            if (w.write?.(chunk, encoding) === false) {
                ondrain = () => callback();
                return;
            }
            callback();
        },
        final(callback: (err?: Error | null) => void) {
            if (!w) { callback(); return; }
            w.end?.();
            onfinish = () => callback();
        },
    });

    if (w) {
        w.on?.('drain', () => {
            const cb = ondrain;
            ondrain = null;
            cb?.();
        });
        w.on?.('finish', () => {
            const cb = onfinish;
            onfinish = null;
            cb?.();
        });
        w.on?.('error', (err: unknown) => { d.destroy?.(deps.asError(err)); });
    }

    if (r) {
        r.on?.('data', (chunk: unknown) => {
            if (!d.destroyed) d.push?.(chunk);
        });
        r.on?.('end', () => {
            if (!d.destroyed) d.push?.(null);
        });
        r.on?.('error', (err: unknown) => { d.destroy?.(deps.asError(err)); });
        r.resume?.();
    }

    d.on?.('close', () => {
        if (r && !r.destroyed) r.destroy?.();
        if (w && !w.destroyed) w.destroy?.();
    });

    return d;
}

/* --------------------------------------------------------------- install --- */

/* node wraps every stream-returning operator in `Readable.from(...)`, which is
 * why `readable.map(...)` is a Readable and always objectMode:true even when the
 * source was byte-mode. Reproduced here rather than returning the bare async
 * generator, or `.map().pipe()` and `instanceof Readable` would both break. */
export function installStreamOperators(deps: OperatorDeps): void {
    const streamReturning: Record<string, AnyFn> = {
        map: mapOperator as AnyFn,
        filter: filterOperator as AnyFn,
        flatMap: flatMapOperator as AnyFn,
        take: takeOperator as AnyFn,
        drop: dropOperator as AnyFn,
    };

    const promiseReturning: Record<string, AnyFn> = {
        forEach: forEachOperator as AnyFn,
        reduce: reduceOperator as AnyFn,
        toArray: toArrayOperator as AnyFn,
        some: someOperator as AnyFn,
        every: everyOperator as AnyFn,
        find: findOperator as AnyFn,
    };

    const installed: Record<string, AnyFn> = {};

    for (const [name, op] of Object.entries(streamReturning)) {
        installed[name] = function fn(this: StreamLike, ...args: unknown[]): unknown {
            if (new.target) throw ERR_ILLEGAL_CONSTRUCTOR();
            return deps.readableFrom(op.apply(this, args) as AsyncIterable<unknown>);
        } as AnyFn;
        Object.defineProperty(installed[name], 'name', { value: name, configurable: true });
    }

    for (const [name, op] of Object.entries(promiseReturning)) {
        installed[name] = function fn(this: StreamLike, ...args: unknown[]): unknown {
            if (new.target) throw ERR_ILLEGAL_CONSTRUCTOR();
            return op.apply(this, args);
        } as AnyFn;
        Object.defineProperty(installed[name], 'name', { value: name, configurable: true });
    }

    installed.iterator = function iterator(
        this: StreamLike,
        options?: { destroyOnReturn?: boolean } | null,
    ): AsyncIterableIterator<unknown> {
        if (new.target) throw ERR_ILLEGAL_CONSTRUCTOR();
        return iteratorOperator.call(this, deps, options);
    } as AnyFn;

    installed.compose = function compose(
        this: StreamLike,
        stream: unknown,
        options?: OperatorOptions,
    ): StreamLike {
        if (new.target) throw ERR_ILLEGAL_CONSTRUCTOR();
        validateStreamOptions(options);
        const composed = composeStreams(deps, this, stream);
        if (options?.signal) {
            const signal = options.signal;
            const onAbort = () => { composed.destroy?.(createAbortError(signal.reason)); };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        return composed;
    } as AnyFn;

    /* Non-enumerable, matching node — an enumerable `map` on the prototype shows
     * up in for-in over stream instances and in some object-inspection paths. */
    for (const target of [deps.readablePrototype, deps.duplexPrototype]) {
        for (const [name, fn] of Object.entries(installed)) {
            Object.defineProperty(target, name, {
                value: fn,
                enumerable: false,
                writable: true,
                configurable: true,
            });
        }
    }

    deps.duplexConstructor.from = function from(body: unknown): StreamLike {
        return duplexFrom(deps, body, 'body');
    };
}
