/**
 * Node.js v8 module
 * Based on CModuleEngine (QuickJS) runtime introspection
 */

const engine = import.meta.use('engine');
const os = import.meta.use('os');
const algorithm = import.meta.use('algorithm');
import { concatChunks } from '../_internal/buffer';
import { addPromiseHook, PromiseState } from '../_internal/promise-hook';

const WIRE_VERSION = 1;
const HEADER_BYTES = Uint8Array.from([0x43, 0x54, 0x53, 0x56, 0x38, WIRE_VERSION]);
type HookCallable = (...args: never[]) => unknown;
type UnknownCallable = (...args: unknown[]) => unknown;

let cachedFlags = '';

const initHooks = new Set<(promise: Promise<unknown>, parent?: Promise<unknown>) => void>();
const beforeHooks = new Set<(promise: Promise<unknown>) => void>();
const afterHooks = new Set<(promise: Promise<unknown>) => void>();
const settledHooks = new Set<(promise: Promise<unknown>) => void>();

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

let sharedHookStop: (() => void) | null = null;

function installSharedHook(): void {
    if (sharedHookStop) return;
    sharedHookStop = addPromiseHook((state, promise, parent) => {
        switch (state) {
            case PromiseState.CONSTRUCT: return invokeHookSet(initHooks, promise, parent);
            case PromiseState.BEFORE_THEN: return invokeHookSet(beforeHooks, promise);
            case PromiseState.AFTER_THEN: return invokeHookSet(afterHooks, promise);
            case PromiseState.FULFILLED: return invokeHookSet(settledHooks, promise);
        }
    });
}

function uninstallSharedHook(): void {
    if (!sharedHookStop) return;
    if (initHooks.size || beforeHooks.size || afterHooks.size || settledHooks.size) return;
    sharedHookStop();
    sharedHookStop = null;
}

function addHook<T extends HookCallable>(name: string, target: Set<T>, callback: T): () => void {
    ensureHookCallback(name, callback);
    installSharedHook();
    target.add(callback);
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        target.delete(callback);
        uninstallSharedHook();
    };
}

export function getHeapStatistics(): Record<string, number> {
    const mem = os.memoryUsage();
    const jsUsed = mem['vm.used'] ?? 0;
    const allocated = mem.used ?? 0;
    const rss = mem['os.rss'] ?? 0;
    // QuickJS reports limit 0 when no --memory-limit was given; fall back to
    // physical RAM so callers computing headroom get a usable number.
    const limit = mem.limit || mem['os.total'] || 0;
    return {
        total_heap_size: allocated,
        total_heap_size_executable: 0,
        total_physical_size: allocated,
        total_available_size: limit > allocated ? limit - allocated : 0,
        used_heap_size: jsUsed,
        heap_size_limit: limit,
        malloced_memory: mem['buffer.used'] ?? 0,
        peak_malloced_memory: 0,
        does_zap_garbage: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        // Memory held outside the JS heap, not total system RAM.
        external_memory: rss > allocated ? rss - allocated : 0,
    };
}

export function getHeapSpaceStatistics(): Array<{
    space_name: string; space_size: number; space_used_size: number;
    space_available_size: number; physical_space_size: number;
}> {
    const mem = os.memoryUsage();
    const allocated = mem.used ?? 0;
    const jsUsed = mem['vm.used'] ?? 0;
    // QuickJS has one unified heap; report it as old_space and keep the other
    // V8 space names present-but-empty so shape-walking callers still work.
    return [
        { space_name: 'read_only_space', space_size: 0, space_used_size: 0, space_available_size: 0, physical_space_size: 0 },
        { space_name: 'new_space', space_size: 0, space_used_size: 0, space_available_size: 0, physical_space_size: 0 },
        {
            space_name: 'old_space',
            space_size: allocated,
            space_used_size: jsUsed,
            space_available_size: allocated > jsUsed ? allocated - jsUsed : 0,
            physical_space_size: allocated,
        },
        { space_name: 'code_space', space_size: 0, space_used_size: 0, space_available_size: 0, physical_space_size: 0 },
        { space_name: 'large_object_space', space_size: 0, space_used_size: 0, space_available_size: 0, physical_space_size: 0 },
    ];
}

export function getHeapCodeStatistics(): {
    code_and_metadata_size: number; bytecode_and_metadata_size: number;
    external_script_source_size: number; cpu_profiler_metadata_size: number;
} {
    return {
        code_and_metadata_size: 0,
        bytecode_and_metadata_size: 0,
        external_script_source_size: 0,
        cpu_profiler_metadata_size: 0,
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
        // prepare() lives here, not in the module-level serialize(), so the
        // class API and v8.serialize() encode the same graph. Applying it twice
        // would re-walk the boxed forms as plain objects and drop them.
        const encoded = engine.serialize(prepare(val));
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
        return restore(engine.deserialize(new Uint8Array(bytes)));
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

const BOX = Symbol.for('cno.v8.box');
type Boxed = { [BOX]: string; [key: string]: unknown };

function isBoxed(value: unknown): value is Boxed {
    return !!value && typeof value === 'object' && typeof Reflect.get(value, BOX) === 'string';
}

function cloneError(err: Error): Boxed {
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(err)) {
        if (key === 'message' || key === 'stack') continue;
        extra[key] = Reflect.get(err, key);
    }
    return { [BOX]: 'error', name: String(err.name), message: String(err.message), stack: err.stack, extra };
}

function errorByName(name: string): new (message?: string) => Error {
    switch (name) {
        case 'EvalError': return EvalError;
        case 'RangeError': return RangeError;
        case 'ReferenceError': return ReferenceError;
        case 'SyntaxError': return SyntaxError;
        case 'TypeError': return TypeError;
        case 'URIError': return URIError;
        default: return Error;
    }
}

/**
 * engine.serialize cannot represent Error/DataView, throws on own accessor
 * properties, densifies sparse arrays and drops non-index array properties.
 * `prepare` rewrites those into plain boxed forms; `restore` reverses it.
 * A WeakMap keeps cycles and shared identity intact.
 */
function prepare(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (typeof value === 'function') {
        throw dataCloneError(String(value));
    }
    if (typeof value === 'symbol') {
        throw dataCloneError(String(value));
    }
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer) return value;
    // Boxed primitives are handled natively; rebuilding them would flatten
    // them into plain objects.
    if (value instanceof Number || value instanceof String || value instanceof Boolean) return value;

    if (value instanceof Error) {
        const box = cloneError(value);
        seen.set(value, box);
        box.extra = prepare(box.extra, seen);
        return box;
    }

    if (value instanceof DataView) {
        // Box the whole backing buffer, not a slice: slicing de-links a DataView
        // from any typed array sharing the same ArrayBuffer, which the native
        // serializer does preserve.
        const buffer: unknown = value.buffer;
        const box: Boxed = buffer instanceof ArrayBuffer
            ? { [BOX]: 'dataview', buffer, byteOffset: value.byteOffset, byteLength: value.byteLength }
            : { [BOX]: 'dataview', buffer: new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer, byteOffset: 0, byteLength: value.byteLength };
        seen.set(value, box);
        return box;
    }

    // Typed arrays pass through natively.
    if (ArrayBuffer.isView(value)) return value;

    if (Array.isArray(value)) {
        const indexKeys = Object.keys(value);
        const isSparse = indexKeys.length !== value.length;
        const extraKeys = indexKeys.filter((k) => String(Number(k)) !== k);
        if (isSparse || extraKeys.length > 0) {
            const box: Boxed = { [BOX]: 'array', length: value.length, entries: [] as unknown[] };
            seen.set(value, box);
            const entries: unknown[] = [];
            for (const key of indexKeys) entries.push([key, prepare(Reflect.get(value, key), seen)]);
            box.entries = entries;
            return box;
        }
        const out: unknown[] = [];
        seen.set(value, out);
        for (const item of value) out.push(prepare(item, seen));
        return out;
    }

    if (value instanceof Map) {
        const out = new Map<unknown, unknown>();
        seen.set(value, out);
        for (const [k, v] of value) out.set(prepare(k, seen), prepare(v, seen));
        return out;
    }

    if (value instanceof Set) {
        const out = new Set<unknown>();
        seen.set(value, out);
        for (const item of value) out.add(prepare(item, seen));
        return out;
    }

    // Plain object: materialise accessors into values (structuredClone does too).
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) out[key] = prepare(Reflect.get(value, key), seen);
    return out;
}

function restore(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (isBoxed(value)) {
        const kind = Reflect.get(value, BOX);
        if (kind === 'error') {
            const err = new (errorByName(String(value.name)))(String(value.message ?? ''));
            seen.set(value, err);
            if (typeof value.stack === 'string') {
                Object.defineProperty(err, 'stack', { value: value.stack, writable: true, configurable: true });
            }
            const extra = restore(value.extra, seen);
            if (extra && typeof extra === 'object') Object.assign(err, extra);
            return err;
        }
        if (kind === 'dataview') {
            const buf = value.buffer;
            if (!(buf instanceof ArrayBuffer)) {
                const empty = new DataView(new ArrayBuffer(0));
                seen.set(value, empty);
                return empty;
            }
            const off = Number(value.byteOffset) || 0;
            const len = Number(value.byteLength);
            const safe = off >= 0 && off <= buf.byteLength
                && Number.isFinite(len) && len >= 0 && off + len <= buf.byteLength;
            const view = safe ? new DataView(buf, off, len) : new DataView(buf);
            seen.set(value, view);
            return view;
        }
        if (kind === 'array') {
            const arr = new Array(Number(value.length) || 0);
            seen.set(value, arr);
            const entries = Array.isArray(value.entries) ? value.entries : [];
            for (const entry of entries) {
                if (!Array.isArray(entry)) continue;
                Reflect.set(arr, String(entry[0]), restore(entry[1], seen));
            }
            return arr;
        }
    }

    if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer) return value;
    if (value instanceof Number || value instanceof String || value instanceof Boolean) return value;
    if (ArrayBuffer.isView(value)) return value;

    if (Array.isArray(value)) {
        const out: unknown[] = [];
        seen.set(value, out);
        for (const item of value) out.push(restore(item, seen));
        return out;
    }

    if (value instanceof Map) {
        const out = new Map<unknown, unknown>();
        seen.set(value, out);
        for (const [k, v] of value) out.set(restore(k, seen), restore(v, seen));
        return out;
    }

    if (value instanceof Set) {
        const out = new Set<unknown>();
        seen.set(value, out);
        for (const item of value) out.add(restore(item, seen));
        return out;
    }

    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) out[key] = restore(Reflect.get(value, key), seen);
    return out;
}

function dataCloneError(what: string): Error {
    return Object.assign(new Error(`${what} could not be cloned.`), { name: 'DataCloneError' });
}

export function serialize(value: unknown): Buffer {
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
