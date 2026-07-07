const engine = import.meta.use('engine');

const PIPE_ERROR_TAG = '__cno_structured_clone_error__';
const PIPE_DATE_TAG = '__cno_structured_clone_date__';
const PIPE_REGEXP_TAG = '__cno_structured_clone_regexp__';

type TransferInput = readonly unknown[] | StructuredSerializeOptions | undefined;
type TypedArrayConstructor = new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => ArrayBufferView;
type TransferableArrayBuffer = ArrayBuffer & { transfer?: () => ArrayBuffer };
type WeakRefConstructor = new (target: object) => object;
type CloneRecord = Record<string, unknown>;

type TransferHooks<TPort extends object, TPortClone extends object = TPort> = {
    createPortClone?: (port: TPort) => TPortClone;
    commitPortTransfer?: (port: TPort, clone: TPortClone) => void;
    isUncloneable?: (value: object) => boolean;
    isUntransferable?: (value: object) => boolean;
} & (
    | { isPort?: undefined }
    | { isPort: (value: unknown) => value is TPort; createPortClone: (port: TPort) => TPortClone }
);

type CloneState<TPort extends object, TPortClone extends object = TPort> = {
    buffers: Map<ArrayBuffer, ArrayBuffer>;
    transferBuffers: Set<ArrayBuffer>;
    ports: Map<TPort, TPortClone>;
    hooks: TransferHooks<TPort, TPortClone>;
};

function dataCloneError(message: string): Error {
    const DOMExceptionCtor = globalThis.DOMException;
    if (typeof DOMExceptionCtor === 'function') {
        return new DOMExceptionCtor(message, 'DataCloneError');
    }
    const error = new Error(message);
    error.name = 'DataCloneError';
    return error;
}

function normalizeTransferList(input: TransferInput): readonly unknown[] {
    if (input === undefined) return [];
    if (Array.isArray(input)) return input;
    return (input as StructuredSerializeOptions).transfer ?? [];
}

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
    return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
}

function isWeakRefConstructor(value: unknown): value is WeakRefConstructor {
    return typeof value === 'function';
}

function isUnsupportedObject(value: object): boolean {
    const weakRef: unknown = Reflect.get(globalThis, 'WeakRef');
    return value instanceof WeakMap
        || value instanceof WeakSet
        || value instanceof Promise
        || (isWeakRefConstructor(weakRef) && value instanceof weakRef);
}

function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
    if (isDetachedArrayBuffer(buffer)) {
        throw dataCloneError('An ArrayBuffer is detached and could not be cloned');
    }
    try {
        return buffer.slice(0);
    } catch (e) {
        throw dataCloneError('An ArrayBuffer is detached and could not be cloned');
    }
}

function isDetachedArrayBuffer(buffer: ArrayBuffer): boolean {
    try {
        new Uint8Array(buffer);
        return false;
    } catch {
        return true;
    }
}

function transferArrayBuffer(buffer: ArrayBuffer): void {
    try {
        const transferable = buffer as TransferableArrayBuffer;
        if (typeof transferable.transfer === 'function') {
            transferable.transfer();
        } else {
            engine.detachArrayBuffer(buffer);
        }
    } catch (e) {
        if (buffer.byteLength !== 0) throw e;
    }
}

function typedArrayConstructor(value: ArrayBufferView): TypedArrayConstructor {
    switch (Object.prototype.toString.call(value)) {
        case '[object Int8Array]': return Int8Array;
        case '[object Uint8Array]': return Uint8Array;
        case '[object Uint8ClampedArray]': return Uint8ClampedArray;
        case '[object Int16Array]': return Int16Array;
        case '[object Uint16Array]': return Uint16Array;
        case '[object Int32Array]': return Int32Array;
        case '[object Uint32Array]': return Uint32Array;
        case '[object Float32Array]': return Float32Array;
        case '[object Float64Array]': return Float64Array;
        case '[object BigInt64Array]': return BigInt64Array as TypedArrayConstructor;
        case '[object BigUint64Array]': return BigUint64Array as TypedArrayConstructor;
        default: throw dataCloneError('Unsupported ArrayBuffer view');
    }
}

function prepareTransfers<TPort extends object, TPortClone extends object = TPort>(
    transferList: readonly unknown[],
    hooks: TransferHooks<TPort, TPortClone>,
): CloneState<TPort, TPortClone> {
    const seen = new Set<object>();
    const buffers = new Map<ArrayBuffer, ArrayBuffer>();
    const transferBuffers = new Set<ArrayBuffer>();
    const ports = new Map<TPort, TPortClone>();

    for (let index = 0; index < transferList.length; index++) {
        const item = transferList[index];
        if (!item || typeof item !== 'object') {
            throw dataCloneError('Value not transferable');
        }
        if (seen.has(item)) {
            throw dataCloneError('Transfer list contains duplicate object');
        }
        seen.add(item);
        if (hooks.isUntransferable?.(item)) {
            throw dataCloneError('Object cannot be transferred');
        }

        if (item instanceof ArrayBuffer) {
            if (isDetachedArrayBuffer(item)) {
                throw dataCloneError(`ArrayBuffer at index ${index} is already detached`);
            }
            buffers.set(item, cloneArrayBuffer(item));
            transferBuffers.add(item);
            continue;
        }
        if (hooks.isPort?.(item)) {
            ports.set(item, hooks.createPortClone(item));
            continue;
        }

        throw dataCloneError('Value not transferable');
    }

    return { buffers, transferBuffers, ports, hooks };
}

function cloneBuffer<TPort extends object, TPortClone extends object>(
    buffer: ArrayBuffer,
    state: CloneState<TPort, TPortClone>,
): ArrayBuffer {
    const existing = state.buffers.get(buffer);
    if (existing) return existing;
    const cloned = cloneArrayBuffer(buffer);
    state.buffers.set(buffer, cloned);
    return cloned;
}

function cloneView<T extends DataView, TPort extends object, TPortClone extends object>(
    value: T,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): T;
function cloneView<T extends ArrayBufferView, TPort extends object, TPortClone extends object>(
    value: T,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): T;
function cloneView<TPort extends object, TPortClone extends object>(
    value: ArrayBufferView,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): ArrayBufferView {
    const source = value.buffer;
    const buffer = source instanceof ArrayBuffer
        ? state.buffers.get(source) ?? cloneBuffer(source, state)
        : source;

    if (value instanceof DataView) {
        return new DataView(buffer, value.byteOffset, value.byteLength);
    }

    const ctor = typedArrayConstructor(value);
    const length = 'length' in value && typeof value.length === 'number' ? value.length : undefined;
    return new ctor(buffer, value.byteOffset, length);
}

function cloneObjectProperties<TPort extends object, TPortClone extends object>(
    source: object,
    target: object,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): void {
    const sourceRecord = source as CloneRecord;
    const targetRecord = target as CloneRecord;
    for (const key of Object.keys(source)) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor) continue;
        if ('value' in descriptor) {
            targetRecord[key] = cloneValue(descriptor.value, state, seen);
            continue;
        }
        targetRecord[key] = cloneValue(sourceRecord[key], state, seen);
    }
}

function cloneBoxedPrimitive<TPort extends object, TPortClone extends object>(
    value: object,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): object | undefined {
    const tag = Object.prototype.toString.call(value);
    let out: object | undefined;
    if (tag === '[object Boolean]') out = new Boolean((value as Boolean).valueOf());
    else if (tag === '[object Number]') out = new Number((value as Number).valueOf());
    else if (tag === '[object String]') out = new String((value as String).valueOf());
    else if (tag === '[object BigInt]') {
        const valueOf = Reflect.get(value, 'valueOf');
        if (typeof valueOf !== 'function') return undefined;
        out = Object(Reflect.apply(valueOf, value, []));
    }
    else if (tag === '[object Symbol]') throw dataCloneError('Symbol object could not be cloned.');
    if (!out) return undefined;
    seen.set(value, out);
    return out;
}

function errorConstructor(value: Error): new (message?: string) => Error {
    if (value instanceof EvalError) return EvalError;
    if (value instanceof RangeError) return RangeError;
    if (value instanceof ReferenceError) return ReferenceError;
    if (value instanceof SyntaxError) return SyntaxError;
    if (value instanceof TypeError) return TypeError;
    if (value instanceof URIError) return URIError;
    return Error;
}

function errorConstructorByName(name: string): new (message?: string) => Error {
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

function cloneError<TPort extends object, TPortClone extends object>(
    value: Error,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): Error {
    if (seen.has(value)) {
        const cached = seen.get(value);
        if (cached instanceof Error) return cached;
    }
    const out = new (errorConstructor(value))(value.message);
    seen.set(value, out);
    if (value.stack) {
        Object.defineProperty(out, 'stack', {
            value: value.stack,
            writable: true,
            enumerable: false,
            configurable: true,
        });
    }
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause) {
        const causeValue = 'value' in cause ? cause.value : Reflect.get(value, 'cause');
        Object.defineProperty(out, 'cause', {
            value: cloneValue(causeValue, state, seen),
            writable: true,
            enumerable: false,
            configurable: true,
        });
    }
    return out;
}

function isPipeEncodedError(value: unknown): value is CloneRecord {
    return !!value && typeof value === 'object' && (value as CloneRecord)[PIPE_ERROR_TAG] === true;
}

function isPipeEncodedDate(value: unknown): value is CloneRecord {
    return !!value && typeof value === 'object' && (value as CloneRecord)[PIPE_DATE_TAG] === true;
}

function isPipeEncodedRegExp(value: unknown): value is CloneRecord {
    return !!value && typeof value === 'object' && (value as CloneRecord)[PIPE_REGEXP_TAG] === true;
}

function encodeForPipe(value: unknown, seen: Map<object, unknown>): unknown {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (value instanceof Error) {
        const out: CloneRecord = {
            [PIPE_ERROR_TAG]: true,
            name: value.name,
            message: value.message,
        };
        seen.set(value, out);
        if (value.stack) out.stack = value.stack;
        if (Object.prototype.hasOwnProperty.call(value, 'cause')) {
            out.cause = encodeForPipe(Reflect.get(value, 'cause'), seen);
        }
        return out;
    }

    if (value instanceof Date) {
        const out = { [PIPE_DATE_TAG]: true, value: value.getTime() };
        seen.set(value, out);
        return out;
    }
    if (value instanceof RegExp) {
        const out = { [PIPE_REGEXP_TAG]: true, source: value.source, flags: value.flags };
        seen.set(value, out);
        return out;
    }
    if (value instanceof ArrayBuffer || isSharedArrayBuffer(value)) {
        return value;
    }
    if (ArrayBuffer.isView(value)) return value;

    seen.set(value, value);
    if (value instanceof Map) {
        const entries = Array.from(value.entries());
        value.clear();
        for (const [key, item] of entries) {
            value.set(encodeForPipe(key, seen), encodeForPipe(item, seen));
        }
        return value;
    }
    if (value instanceof Set) {
        const items = Array.from(value.values());
        value.clear();
        for (const item of items) value.add(encodeForPipe(item, seen));
        return value;
    }
    const record = value as CloneRecord;
    for (const key of Object.keys(value)) {
        record[key] = encodeForPipe(record[key], seen);
    }
    return value;
}

function decodeFromPipe(value: unknown, seen: Map<object, unknown>): unknown {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (isPipeEncodedError(value)) {
        const out = new (errorConstructorByName(String(value.name)))(String(value.message ?? ''));
        seen.set(value, out);
        if (typeof value.stack === 'string') {
            Object.defineProperty(out, 'stack', {
                value: value.stack,
                writable: true,
                enumerable: false,
                configurable: true,
            });
        }
        if (Object.prototype.hasOwnProperty.call(value, 'cause')) {
            Object.defineProperty(out, 'cause', {
                value: decodeFromPipe(value.cause, seen),
                writable: true,
                enumerable: false,
                configurable: true,
            });
        }
        return out;
    }

    if (isPipeEncodedDate(value)) {
        const out = new Date(Number(value.value));
        seen.set(value, out);
        return out;
    }
    if (isPipeEncodedRegExp(value)) {
        const out = new RegExp(String(value.source), String(value.flags ?? ''));
        seen.set(value, out);
        return out;
    }
    if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer || isSharedArrayBuffer(value)) {
        return value;
    }
    if (ArrayBuffer.isView(value)) return value;

    seen.set(value, value);
    if (value instanceof Map) {
        const entries = Array.from(value.entries());
        value.clear();
        for (const [key, item] of entries) {
            value.set(decodeFromPipe(key, seen), decodeFromPipe(item, seen));
        }
        return value;
    }
    if (value instanceof Set) {
        const items = Array.from(value.values());
        value.clear();
        for (const item of items) value.add(decodeFromPipe(item, seen));
        return value;
    }
    const record = value as CloneRecord;
    for (const key of Object.keys(value)) {
        record[key] = decodeFromPipe(record[key], seen);
    }
    return value;
}

function cloneValue<T, TPort extends object, TPortClone extends object>(
    value: T,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): unknown {
    if (value === null || typeof value === 'undefined') return value;
    if (typeof value === 'function' || typeof value === 'symbol') {
        throw dataCloneError(`${String(value)} could not be cloned.`);
    }
    if (typeof value !== 'object') return value;
    if (state.hooks.isUncloneable?.(value)) {
        throw dataCloneError('Object cannot be cloned');
    }
    if (state.hooks.isPort?.(value)) {
        const port = state.ports.get(value);
        if (!port) throw dataCloneError('Object cannot be cloned');
        return port;
    }
    if (value instanceof ArrayBuffer) {
        return cloneBuffer(value, state);
    }
    if (isSharedArrayBuffer(value)) return value;
    if (ArrayBuffer.isView(value)) return cloneView(value, state, seen);
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) {
        const out = new RegExp(value.source, value.flags);
        return out;
    }
    if (isUnsupportedObject(value)) throw dataCloneError(`${String(value)} could not be cloned.`);
    const boxed = cloneBoxedPrimitive(value, state, seen);
    if (boxed) return boxed;
    if (value instanceof Map) {
        if (seen.has(value)) return seen.get(value);
        const out = new Map();
        seen.set(value, out);
        for (const [key, item] of value) {
            out.set(cloneValue(key, state, seen), cloneValue(item, state, seen));
        }
        return out;
    }
    if (value instanceof Set) {
        if (seen.has(value)) return seen.get(value);
        const out = new Set();
        seen.set(value, out);
        for (const item of value) out.add(cloneValue(item, state, seen));
        return out;
    }
    if (value instanceof Error) {
        return cloneError(value, state, seen);
    }
    if (seen.has(value)) return seen.get(value);

    const out = Array.isArray(value)
        ? new Array(value.length)
        : {};
    seen.set(value, out);
    cloneObjectProperties(value, out, state, seen);
    return out;
}

function commitTransfers<TPort extends object, TPortClone extends object>(state: CloneState<TPort, TPortClone>): void {
    for (const buffer of state.transferBuffers) transferArrayBuffer(buffer);
    for (const [port, clone] of state.ports) {
        state.hooks.commitPortTransfer?.(port, clone);
    }
}

export function structuredCloneWithTransfer<T, TPort extends object = object, TPortClone extends object = TPort>(
    value: T,
    transferOrOptions?: TransferInput,
    hooks: TransferHooks<TPort, TPortClone> = {},
): T {
    const transferList = normalizeTransferList(transferOrOptions);
    const state = prepareTransfers(transferList, hooks);
    const cloned = cloneValue(value, state, new Map());
    commitTransfers(state);
    return cloned as T;
}

export function getTransferList(input: TransferInput): readonly unknown[] {
    return normalizeTransferList(input);
}

export function encodeStructuredCloneForPipe<T>(value: T): T {
    return encodeForPipe(value, new Map()) as T;
}

export function decodeStructuredCloneFromPipe<T>(value: T): T {
    return decodeFromPipe(value, new Map()) as T;
}

export { dataCloneError };
