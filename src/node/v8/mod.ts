/**
 * Node.js v8 module
 * Based on CModuleEngine (QuickJS) runtime introspection
 */

const engine = import.meta.use('engine');
const os = import.meta.use('os');
const algorithm = import.meta.use('algorithm');
import { concatChunks } from '../_internal/buffer';

const WIRE_VERSION = 1;
const HEADER_BYTES = Uint8Array.from([0x43, 0x54, 0x53, 0x56, 0x38, WIRE_VERSION]);
const NativePromise = globalThis.Promise;
type HookCallable = (...args: never[]) => unknown;
type UnknownCallable = (...args: unknown[]) => unknown;

let cachedFlags = '';
let promiseHookInstalled = false;

const initHooks = new Set<(promise: Promise<unknown>, parent?: Promise<unknown>) => void>();
const beforeHooks = new Set<(promise: Promise<unknown>) => void>();
const afterHooks = new Set<(promise: Promise<unknown>) => void>();
const settledHooks = new Set<(promise: Promise<unknown>) => void>();
const trackedPromises = new WeakSet<Promise<unknown>>();

function fnv1a32(input: string): number {
    return algorithm.fnv1a32(engine.encodeString(input));
}

function assertArrayBufferView(value: unknown, name: string): asserts value is ArrayBufferView {
    if (!ArrayBuffer.isView(value)) {
        throw new TypeError(`${name} must be a TypedArray or a DataView`);
    }
}

function asUint8Array(value: ArrayBufferView): Uint8Array {
    assertArrayBufferView(value, 'buffer');
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function normalizeRawByteLength(length: unknown, available: number): number {
    if (length === undefined) return available;
    const normalized = Number(length);
    if (!Number.isFinite(normalized) || normalized < 0) {
        throw new Error('ReadRawBytes() failed');
    }
    return Math.trunc(normalized);
}

function toBuffer(value: Uint8Array): Buffer {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function writeUint32LE(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    return out;
}

function writeUint64LE(hi: number, lo: number): Uint8Array {
    const out = new Uint8Array(8);
    const view = new DataView(out.buffer);
    view.setUint32(0, lo >>> 0, true);
    view.setUint32(4, hi >>> 0, true);
    return out;
}

function writeDoubleLE(value: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value, true);
    return out;
}

function ensureHookCallback(name: string, callback: HookCallable): void {
    if (typeof callback !== 'function') {
        throw new TypeError(`The "${name}" hook must be a function`);
    }
    const constructor = Reflect.get(callback, 'constructor');
    const constructorName = constructor && (typeof constructor === 'object' || typeof constructor === 'function')
        ? Reflect.get(constructor, 'name')
        : undefined;
    if (constructorName === 'AsyncFunction') {
        throw new TypeError(`The "${name}" hook must be a plain function`);
    }
}

function invokeHookSet<T extends (...args: never[]) => unknown>(hooks: Set<T>, ...args: Parameters<T>): void {
    for (const hook of hooks) Reflect.apply(hook, undefined, args);
}

function installPromiseHookDispatcher(): void {
    if (promiseHookInstalled) return;
    const trackPromise = (promise: Promise<unknown>, parent?: Promise<unknown>) => {
        if (trackedPromises.has(promise)) return;
        trackedPromises.add(promise);
        invokeHookSet(initHooks, promise, parent);
        NativePromise.prototype.then.call(
            promise,
            (value: unknown) => {
                invokeHookSet(settledHooks, promise);
                return value;
            },
            (error: unknown) => {
                invokeHookSet(settledHooks, promise);
                throw error;
            },
        );
    };

    class HookedPromise<T> extends NativePromise<T> {
        constructor(executor: ConstructorParameters<PromiseConstructor>[0]) {
            super(executor);
            trackPromise(this);
        }

        then<TResult1 = T, TResult2 = never>(
            onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
            onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): Promise<TResult1 | TResult2> {
            let continuation: Promise<unknown> | undefined;
            const wrapFulfilled = (
                callback: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
            ): ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined => {
                if (typeof callback !== 'function') return callback ?? undefined;
                return function(this: unknown, value: T) {
                    if (continuation) invokeHookSet(beforeHooks, continuation);
                    try {
                        return Reflect.apply(callback, this, [value]) as TResult1 | PromiseLike<TResult1>;
                    } finally {
                        if (continuation) invokeHookSet(afterHooks, continuation);
                    }
                };
            };
            const wrapRejected = (
                callback: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
            ): ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined => {
                if (typeof callback !== 'function') return callback ?? undefined;
                return function(this: unknown, reason: unknown) {
                    if (continuation) invokeHookSet(beforeHooks, continuation);
                    try {
                        return Reflect.apply(callback, this, [reason]) as TResult2 | PromiseLike<TResult2>;
                    } finally {
                        if (continuation) invokeHookSet(afterHooks, continuation);
                    }
                };
            };

            const wrappedFulfilled = wrapFulfilled(onFulfilled);
            const wrappedRejected = wrapRejected(onRejected);
            const result = super.then(
                wrappedFulfilled,
                wrappedRejected,
            );
            continuation = result as Promise<unknown>;
            trackPromise(continuation, this);
            return result as Promise<TResult1 | TResult2>;
        }
    }

    globalThis.Promise = HookedPromise as PromiseConstructor;
    promiseHookInstalled = true;
}

function addHook<T extends HookCallable>(name: string, target: Set<T>, callback: T): () => void {
    ensureHookCallback(name, callback);
    installPromiseHookDispatcher();
    target.add(callback);
    return () => {
        target.delete(callback);
    };
}

export function getHeapStatistics(): Record<string, number> {
    const mem = os.memoryUsage();
    return {
        total_heap_size: mem.used,
        total_heap_size_executable: 0,
        total_physical_size: mem['vm.used'] ?? 0,
        total_available_size: mem['os.free'] ?? 0,
        used_heap_size: mem['vm.used'] ?? 0,
        heap_size_limit: 0,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: mem['os.total'] ?? 0,
        total_allocated_bytes: mem.used,
    };
}

export function getHeapSpaceStatistics(): Array<{
    space_name: string; space_size: number; space_used_size: number;
    space_available_size: number; physical_space_size: number;
}> {
    const mem = os.memoryUsage();
    const used = mem['vm.used'] ?? 0;
    return [{
        space_name: 'new_space',
        space_size: used,
        space_used_size: used,
        space_available_size: 0,
        physical_space_size: used,
    }];
}

export function getHeapCodeStatistics(): {
    code_and_metadata_size: number; bytecode_and_metadata_size: number; external_script_source_size: number;
} {
    return {
        code_and_metadata_size: 0,
        bytecode_and_metadata_size: 0,
        external_script_source_size: 0,
    };
}

export function setFlagsFromString(flags: string): void {
    if (typeof flags !== 'string') {
        throw new TypeError(`The "flags" argument must be of type string. Received type ${typeof flags}`);
    }
    cachedFlags = flags;
}

export function enableTimeTravel(): void {}
export function disableTimeTravel(): void {}

export class Serializer {
    protected _chunks: Uint8Array[] = [];
    protected _headerWritten = false;
    protected _transferredArrayBuffers = new Map<number, ArrayBuffer>();

    protected _ensureWritable(): void {
    }

    protected _push(chunk: Uint8Array): void {
        this._ensureWritable();
        this._chunks.push(chunk);
    }

    writeHeader(): void {
        if (this._headerWritten) return;
        this._push(HEADER_BYTES.slice());
        this._headerWritten = true;
    }

    writeValue(val: unknown): boolean {
        this.writeHeader();
        const encoded = engine.serialize(val);
        this.writeUint32(encoded.byteLength);
        this._push(encoded);
        return true;
    }

    releaseBuffer(): Buffer {
        this._ensureWritable();
        const out = concatChunks(this._chunks);
        this._chunks = [];
        this._headerWritten = false;
        return toBuffer(out);
    }

    transferArrayBuffer(id: number, arrayBuffer: ArrayBuffer): void {
        this._transferredArrayBuffers.set(id >>> 0, arrayBuffer);
    }

    writeUint32(value: number): void {
        this._push(writeUint32LE(value));
    }

    writeUint64(hi: number, lo: number): void {
        this._push(writeUint64LE(hi, lo));
    }

    writeDouble(value: number): void {
        this._push(writeDoubleLE(value));
    }

    writeRawBytes(buffer: ArrayBufferView): void {
        assertArrayBufferView(buffer, 'source');
        const raw = asUint8Array(buffer);
        this._push(new Uint8Array(raw));
    }
}

export class DefaultSerializer extends Serializer {}

export class Deserializer {
    protected _buffer: Uint8Array;
    protected _offset = 0;
    protected _headerRead = false;
    protected _wireFormatVersion = 0;
    protected _transferredArrayBuffers = new Map<number, ArrayBuffer>();

    constructor(data: Buffer | Uint8Array | ArrayBufferView) {
        assertArrayBufferView(data, 'buffer');
        this._buffer = asUint8Array(data);
    }

    protected _ensureReadable(length: number): void {
        if (this._offset + length > this._buffer.byteLength) {
            throw new Error('Unexpected end of serialized data');
        }
    }

    protected _readBytes(length: number): Uint8Array {
        this._ensureReadable(length);
        const chunk = this._buffer.slice(this._offset, this._offset + length);
        this._offset += length;
        return chunk;
    }

    readHeader(): boolean {
        const header = this._readBytes(HEADER_BYTES.byteLength);
        if (!algorithm.bytesEqual(header, HEADER_BYTES)) {
            throw new Error('Invalid or unsupported wire format');
        }
        this._headerRead = true;
        this._wireFormatVersion = header[HEADER_BYTES.byteLength - 1] ?? 0;
        return true;
    }

    readValue(): unknown {
        if (!this._headerRead) {
            this.readHeader();
        }
        const length = this.readUint32();
        const bytes = this._readBytes(length);
        return engine.deserialize(new Uint8Array(bytes));
    }

    transferArrayBuffer(id: number, arrayBuffer: ArrayBuffer): void {
        this._transferredArrayBuffers.set(id >>> 0, arrayBuffer);
    }

    getWireFormatVersion(): number {
        if (!this._headerRead) {
            throw new Error('Deserializer header has not been read');
        }
        return this._wireFormatVersion;
    }

    readUint32(): number {
        const chunk = this._readBytes(4);
        return new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(0, true);
    }

    readUint64(): [number, number] {
        const chunk = this._readBytes(8);
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const lo = view.getUint32(0, true);
        const hi = view.getUint32(4, true);
        return [hi, lo];
    }

    readDouble(): number {
        const chunk = this._readBytes(8);
        return new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getFloat64(0, true);
    }

    readRawBytes(length?: number): Buffer {
        return toBuffer(this._readBytes(normalizeRawByteLength(length, this._buffer.byteLength - this._offset)));
    }
}

export class DefaultDeserializer extends Deserializer {}

function containsFunction(value: unknown, seen = new WeakSet<object>()): boolean {
    if (typeof value === 'function') return true;
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((item) => containsFunction(item, seen));
    if (value instanceof Map) {
        for (const [key, item] of value) {
            if (containsFunction(key, seen) || containsFunction(item, seen)) return true;
        }
        return false;
    }
    if (value instanceof Set) {
        for (const item of value) {
            if (containsFunction(item, seen)) return true;
        }
        return false;
    }
    for (const item of Object.values(value)) {
        if (containsFunction(item, seen)) return true;
    }
    return false;
}

export function serialize(value: unknown): Buffer {
    if (containsFunction(value)) {
        throw new Error('() => {} could not be cloned');
    }
    const serializer = new DefaultSerializer();
    serializer.writeHeader();
    serializer.writeValue(value);
    return serializer.releaseBuffer();
}

export function deserialize(buf: Buffer | Uint8Array): unknown {
    const deserializer = new DefaultDeserializer(buf);
    deserializer.readHeader();
    return deserializer.readValue();
}

export function cachedDataVersionTag(): number {
    return fnv1a32(`${engine.versions.quickjs}:${cachedFlags}`);
}

export const startupSnapshot = {
    isBuildingSnapshot(): boolean { return false; },
    addSerializeCallback(_cb: UnknownCallable, _data?: unknown): void {},
    addDeserializeCallback(_cb: UnknownCallable, _data?: unknown): void {},
    setDeserializeMainFunction(_cb: UnknownCallable, _data?: unknown): void {},
};

export const promiseHooks = {
    onInit(init: (promise: Promise<unknown>, parent?: Promise<unknown>) => void): () => void {
        return addHook('init', initHooks, init);
    },
    onBefore(before: (promise: Promise<unknown>) => void): () => void {
        return addHook('before', beforeHooks, before);
    },
    onAfter(after: (promise: Promise<unknown>) => void): () => void {
        return addHook('after', afterHooks, after);
    },
    onSettled(settled: (promise: Promise<unknown>) => void): () => void {
        return addHook('settled', settledHooks, settled);
    },
    createHook(callbacks: {
        init?: (promise: Promise<unknown>, parent?: Promise<unknown>) => void;
        before?: (promise: Promise<unknown>) => void;
        after?: (promise: Promise<unknown>) => void;
        settled?: (promise: Promise<unknown>) => void;
    }): () => void {
        const stops: Array<() => void> = [];
        if (callbacks.init) stops.push(addHook('init', initHooks, callbacks.init));
        if (callbacks.before) stops.push(addHook('before', beforeHooks, callbacks.before));
        if (callbacks.after) stops.push(addHook('after', afterHooks, callbacks.after));
        if (callbacks.settled) stops.push(addHook('settled', settledHooks, callbacks.settled));
        return () => {
            for (const stop of stops) stop();
        };
    },
};
