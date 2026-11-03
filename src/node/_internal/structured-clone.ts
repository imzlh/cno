const engine = import.meta.use('engine');

// The pipe is a second serialization layer (the native serializer does not know
// about Date/Error/DataView/Blob).  Keep the discriminator in a versioned tuple,
// rather than in a user-visible object field: ordinary records can consequently
// contain names such as "__cno_structured_clone_date__" without being revived.
// The long namespace and exact tuple arities make accidental user collisions
// exceedingly unlikely while keeping the wire format portable between workers.
const PIPE_PROTOCOL = '__cno_structured_clone_pipe_v1_7f3e2a91__';
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const arrayBufferMaxByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'maxByteLength')?.get;
const arrayBufferTransfer = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer')?.value;
const dateGetTime = Date.prototype.getTime;
const booleanValueOf = Boolean.prototype.valueOf;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;
const mapForEach = Map.prototype.forEach;
const mapSet = Map.prototype.set;
const setForEach = Set.prototype.forEach;
const setAdd = Set.prototype.add;
const regexpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get;
const REGEXP_FLAGS = [
    [Object.getOwnPropertyDescriptor(RegExp.prototype, 'hasIndices')?.get, 'd'],
    [Object.getOwnPropertyDescriptor(RegExp.prototype, 'global')?.get, 'g'],
    [Object.getOwnPropertyDescriptor(RegExp.prototype, 'ignoreCase')?.get, 'i'],
    [Object.getOwnPropertyDescriptor(RegExp.prototype, 'multiline')?.get, 'm'],
    [Object.getOwnPropertyDescriptor(RegExp.prototype, 'dotAll')?.get, 's'],
    [Object.getOwnPropertyDescriptor(RegExp.prototype, 'unicode')?.get, 'u'],
    [Object.getOwnPropertyDescriptor(RegExp.prototype, 'unicodeSets')?.get, 'v'],
    [Object.getOwnPropertyDescriptor(RegExp.prototype, 'sticky')?.get, 'y'],
] as const;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag,
)?.get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')?.get;
const dataViewByteOffsetGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')?.get;
const dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')?.get;
const sharedArrayBufferByteLengthGetter = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;

const objectToString = Object.prototype.toString;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.prototype.hasOwnProperty;

// Tag-based dispatch; see docs/node-internals.md#structured-clone-tagged-dispatch.
const TAG_NUMBER = '[object Number]';
const TAG_STRING = '[object String]';
const TAG_BOOLEAN = '[object Boolean]';

// Must be checked PER CALL: a load-time check misses a later `delete BigInt.prototype[Symbol.toStringTag]`.
function tagDispatchIsSound(): boolean {
    return objectHasOwn.call(BigInt.prototype, Symbol.toStringTag)
        && objectHasOwn.call(Symbol.prototype, Symbol.toStringTag);
}

/** Return false/true, or undefined when checking the chain could hit a Proxy. */
function tagPropertyState(value: object): boolean | undefined {
    let current: object | null = value;
    while (current !== null) {
        if (engine.isProxy(current)) return undefined;
        if (objectHasOwn.call(current, Symbol.toStringTag)) return true;
        current = objectGetPrototypeOf(current);
    }
    return false;
}

type TransferInput = readonly unknown[] | StructuredSerializeOptions | undefined;
type TypedArrayConstructor = new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => ArrayBufferView;
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
    sharedBuffers: Map<SharedArrayBuffer, SharedArrayBuffer>;
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

export function getTransferList(input: TransferInput): readonly unknown[] {
    if (input === undefined) return [];
    if (Array.isArray(input)) return input;
    if (input === null) return [];
    if (typeof input !== 'object') {
        throw new TypeError('structuredClone options must be an object');
    }
    const transfer = (input as StructuredSerializeOptions).transfer;
    if (transfer === undefined) return [];
    if (transfer === null || typeof transfer !== 'object') {
        throw new TypeError('structuredClone transfer must be an iterable sequence');
    }
    const iterator = Reflect.get(transfer, Symbol.iterator);
    if (typeof iterator !== 'function') {
        throw new TypeError('structuredClone transfer must be an iterable sequence');
    }
    return Array.from(transfer as Iterable<unknown>);
}

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
    if (!value || typeof value !== 'object' || !sharedArrayBufferByteLengthGetter) return false;
    try {
        Reflect.apply(sharedArrayBufferByteLengthGetter, value, []);
        return true;
    } catch {
        return false;
    }
}

function isUnsupportedObject(value: object): boolean {
    return engine.isWeakMap(value)
        || engine.isWeakSet(value)
        || engine.isPromise(value)
        || engine.isWeakRef(value);
}

// `Symbol.for` rather than an import: webapi/formdata would be circular.
const blobBytesSymbol = Symbol.for('cno.blob.bytes');

function cloneBlob(value: object): object | null {
    const BlobCtor = globalThis.Blob;
    if (typeof BlobCtor !== 'function' || !(value instanceof BlobCtor)) return null;
    const getBytes = Reflect.get(value, blobBytesSymbol);
    if (typeof getBytes !== 'function') {
        throw dataCloneError('Blob could not be cloned.');
    }
    const bytes = Reflect.apply(getBytes, value, []) as Uint8Array<ArrayBuffer>;
    const FileCtor = globalThis.File;
    if (typeof FileCtor === 'function' && value instanceof FileCtor) {
        const f = value as unknown as File;
        return new FileCtor([bytes], f.name, { type: f.type, lastModified: f.lastModified });
    }
    return new BlobCtor([bytes], { type: (value as unknown as Blob).type });
}

// Must not be gated on @@toStringTag: in cno these objects carry no tag (see docs/node-internals.md).
const nonSerializableCtors = ['URL', 'URLSearchParams', 'Headers', 'FormData',
    'Request', 'Response', 'ReadableStream', 'WritableStream', 'TransformStream'];

function hasOrdinaryPrototype(value: object): boolean {
    const proto = Object.getPrototypeOf(value);
    return proto === objectPrototype || proto === arrayPrototype || proto === null;
}

function throwIfNonSerializable(value: object): void {
    if (hasOrdinaryPrototype(value)) return;
    for (const name of nonSerializableCtors) {
        const ctor = Reflect.get(globalThis, name);
        if (typeof ctor === 'function' && value instanceof ctor) {
            throw dataCloneError(`${name} could not be cloned.`);
        }
    }
}

function isResizableArrayBuffer(buffer: ArrayBuffer): boolean {
    return arrayBufferResizableGetter ? Reflect.apply(arrayBufferResizableGetter, buffer, []) : false;
}

function arrayBufferMaxByteLength(buffer: ArrayBuffer): number {
    return arrayBufferMaxByteLengthGetter
        ? Reflect.apply(arrayBufferMaxByteLengthGetter, buffer, [])
        : buffer.byteLength;
}

function regexpSource(value: RegExp): string {
    if (!regexpSourceGetter) throw dataCloneError('RegExp could not be cloned');
    return Reflect.apply(regexpSourceGetter, value, []) as string;
}

function regexpFlags(value: RegExp): string {
    let flags = '';
    for (const [getter, flag] of REGEXP_FLAGS) {
        if (getter && Reflect.apply(getter, value, [])) flags += flag;
    }
    return flags;
}

function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
    if (isDetachedArrayBuffer(buffer)) {
        throw dataCloneError('An ArrayBuffer is detached and could not be cloned');
    }
    try {
        if (isResizableArrayBuffer(buffer)) {
            const out = new ArrayBuffer(buffer.byteLength, { maxByteLength: arrayBufferMaxByteLength(buffer) });
            new Uint8Array(out).set(new Uint8Array(buffer));
            return out;
        }
        // Copy the bytes directly: setPrototypeOf on a view also replaces its buffer's
        // prototype, so no ArrayBuffer.prototype method can be reached.
        const out = new ArrayBuffer(buffer.byteLength);
        new Uint8Array(out).set(new Uint8Array(buffer));
        return out;
    } catch (e) {
        throw dataCloneError('An ArrayBuffer is detached and could not be cloned');
    }
}

function cloneSharedArrayBuffer(buffer: SharedArrayBuffer): SharedArrayBuffer {
    try {
        return engine.deserialize(engine.serialize(buffer, engine.DUMP_DEEP | engine.DUMP_LOCAL));
    } catch {
        throw dataCloneError('A SharedArrayBuffer could not be cloned');
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
        // Internal slot, not an instance property named `transfer`, which user code could shadow.
        if (typeof arrayBufferTransfer === 'function') {
            Reflect.apply(arrayBufferTransfer, buffer, []);
        } else {
            engine.detachArrayBuffer(buffer);
        }
    } catch (e) {
        if (buffer.byteLength !== 0) throw e;
    }
}

const typedArrayCtors: Record<string, [TypedArrayConstructor, number]> = {
    Int8Array: [Int8Array, 1],
    Uint8Array: [Uint8Array, 1],
    Uint8ClampedArray: [Uint8ClampedArray, 1],
    Int16Array: [Int16Array, 2],
    Uint16Array: [Uint16Array, 2],
    Int32Array: [Int32Array, 4],
    Uint32Array: [Uint32Array, 4],
    Float32Array: [Float32Array, 4],
    Float64Array: [Float64Array, 8],
    BigInt64Array: [BigInt64Array as TypedArrayConstructor, 8],
    BigUint64Array: [BigUint64Array as TypedArrayConstructor, 8],
};

function typedArrayKind(value: ArrayBufferView): [TypedArrayConstructor, number] {
    // A subclass may override its display tag without changing its element type.
    const tag = typedArrayTagGetter ? Reflect.apply(typedArrayTagGetter, value, []) : undefined;
    const kind = typeof tag === 'string' ? typedArrayCtors[tag] : undefined;
    if (!kind) throw dataCloneError('Unsupported ArrayBuffer view');
    return kind;
}

function viewSlot<T>(getter: ((this: unknown) => T) | undefined, value: ArrayBufferView): T {
    if (!getter) throw dataCloneError('Unsupported ArrayBuffer view');
    return Reflect.apply(getter, value, []) as T;
}

function prepareTransfers<TPort extends object, TPortClone extends object = TPort>(
    transferList: readonly unknown[],
    hooks: TransferHooks<TPort, TPortClone>,
): CloneState<TPort, TPortClone> {
    const seen = new Set<object>();
    const buffers = new Map<ArrayBuffer, ArrayBuffer>();
    const sharedBuffers = new Map<SharedArrayBuffer, SharedArrayBuffer>();
    const transferBuffers = new Set<ArrayBuffer>();
    const ports = new Map<TPort, TPortClone>();

    for (let index = 0; index < transferList.length; index++) {
        const item = transferList[index];
        if (!item || typeof item !== 'object') {
            throw dataCloneError('Value not transferable');
        }
        if (engine.isProxy(item)) {
            throw dataCloneError('Proxy objects cannot be transferred');
        }
        if (seen.has(item)) {
            throw dataCloneError('Transfer list contains duplicate object');
        }
        seen.add(item);
        if (hooks.isUntransferable?.(item)) {
            throw dataCloneError('Object cannot be transferred');
        }

        if (engine.isArrayBuffer(item)) {
            const buffer = item as ArrayBuffer;
            if (isDetachedArrayBuffer(buffer)) {
                throw dataCloneError(`ArrayBuffer at index ${index} is already detached`);
            }
            buffers.set(buffer, cloneArrayBuffer(buffer));
            transferBuffers.add(buffer);
            continue;
        }
        if (hooks.isPort?.(item)) {
            ports.set(item, hooks.createPortClone(item));
            continue;
        }

        throw dataCloneError('Value not transferable');
    }

    return { buffers, sharedBuffers, transferBuffers, ports, hooks };
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

function cloneSharedBuffer<TPort extends object, TPortClone extends object>(
    buffer: SharedArrayBuffer,
    state: CloneState<TPort, TPortClone>,
): SharedArrayBuffer {
    const existing = state.sharedBuffers.get(buffer);
    if (existing) return existing;
    const cloned = cloneSharedArrayBuffer(buffer);
    state.sharedBuffers.set(buffer, cloned);
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
    const cached = seen.get(value);
    if (ArrayBuffer.isView(cached)) return cached;
    const isDataView = engine.isDataView(value);
    const source = viewSlot<ArrayBufferLike>(isDataView ? dataViewBufferGetter : typedArrayBufferGetter, value);
    const buffer = engine.isArrayBuffer(source)
        ? state.buffers.get(source as ArrayBuffer) ?? cloneBuffer(source as ArrayBuffer, state)
        : cloneSharedBuffer(source as SharedArrayBuffer, state);

    if (isDataView) {
        const byteOffset = viewSlot<number>(dataViewByteOffsetGetter, value);
        const byteLength = viewSlot<number>(dataViewByteLengthGetter, value);
        const out = new DataView(buffer as ArrayBuffer, byteOffset, byteLength);
        seen.set(value, out);
        return out;
    }

    const [ctor, bytesPerElement] = typedArrayKind(value);
    const byteOffset = viewSlot<number>(typedArrayByteOffsetGetter, value);
    const byteLength = viewSlot<number>(typedArrayByteLengthGetter, value);
    const out = new ctor(buffer as ArrayBuffer, byteOffset, byteLength / bytesPerElement);
    seen.set(value, out);
    return out;
}

function cloneObjectProperties<TPort extends object, TPortClone extends object>(
    source: object,
    target: object,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): void {
    const sourceRecord = source as CloneRecord;
    for (const key of Object.keys(source)) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor) continue;
        const value = 'value' in descriptor ? descriptor.value : sourceRecord[key];
        // defineProperty, not assignment: a `__proto__` key must become an own data property.
        Object.defineProperty(target, key, {
            value: cloneValue(value, state, seen),
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }
}

// Fallback for values the tag test cannot speak for (anything carrying @@toStringTag).
function cloneBoxedPrimitiveByProbe<TPort extends object, TPortClone extends object>(
    value: object,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): object | undefined {
    let out: object | undefined;
    try { out = new Boolean(Reflect.apply(booleanValueOf, value, [])); } catch {}
    if (!out) try { out = new Number(Reflect.apply(numberValueOf, value, [])); } catch {}
    if (!out) try { out = new String(Reflect.apply(stringValueOf, value, [])); } catch {}
    if (!out) try { out = Object(Reflect.apply(bigintValueOf, value, [])); } catch {}
    if (!out) {
        let isSymbol = false;
        try { Reflect.apply(symbolValueOf, value, []); isSymbol = true; } catch {}
        if (isSymbol) throw dataCloneError('Symbol object could not be cloned.');
    }
    if (!out) return undefined;
    seen.set(value, out);
    return out;
}

// `plainTag` is authoritative only when @@toStringTag is provably absent (caller's contract).
function cloneBoxedPrimitiveByTag<TPort extends object, TPortClone extends object>(
    value: object,
    plainTag: string,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): object | undefined {
    let out: object | undefined;
    if (plainTag === TAG_NUMBER) out = new Number(Reflect.apply(numberValueOf, value, []));
    else if (plainTag === TAG_STRING) out = new String(Reflect.apply(stringValueOf, value, []));
    else if (plainTag === TAG_BOOLEAN) out = new Boolean(Reflect.apply(booleanValueOf, value, []));
    if (!out) return undefined;
    seen.set(value, out);
    return out;
}

function cloneBoxedPrimitive<TPort extends object, TPortClone extends object>(
    value: object,
    state: CloneState<TPort, TPortClone>,
    seen: Map<object, unknown>,
): object | undefined {
    return cloneBoxedPrimitiveByProbe(value, state, seen);
}

function errorConstructor(value: Error): new (message?: string) => Error {
    return errorConstructorByName(String(value.name));
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
        if (cached && engine.isError(cached)) return cached as Error;
    }
    const messageDescriptor = Object.getOwnPropertyDescriptor(value, 'message');
    const message = messageDescriptor && 'value' in messageDescriptor
        ? String(messageDescriptor.value)
        : undefined;
    const Ctor = errorConstructor(value);
    const out = messageDescriptor && 'value' in messageDescriptor ? new Ctor(message) : new Ctor();
    seen.set(value, out);
    const stack = value.stack;
    Object.defineProperty(out, 'stack', {
        value: typeof stack === 'string' ? stack : undefined,
        writable: true,
        enumerable: false,
        configurable: true,
    });
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause && 'value' in cause) {
        Object.defineProperty(out, 'cause', {
            value: cloneValue(cause.value, state, seen),
            writable: true,
            enumerable: false,
            configurable: true,
        });
    }
    return out;
}

type PipeTuple = unknown[];

function pipeTuple(value: unknown, kind: string, length: number): value is PipeTuple {
    return Array.isArray(value)
        && value.length === length
        && value[0] === PIPE_PROTOCOL
        && value[1] === kind;
}


function copyPipeProperties(
    source: object,
    target: object,
    seen: Map<object, unknown>,
    visit: (value: unknown, seen: Map<object, unknown>) => unknown,
): void {
    const sourceRecord = source as CloneRecord;
    for (const key of Object.keys(source)) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor) continue;
        const child = 'value' in descriptor ? descriptor.value : Reflect.get(sourceRecord, key);
        // defineProperty keeps an enumerable `__proto__` field as data rather than a setter call.
        Object.defineProperty(target, key, {
            value: visit(child, seen),
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }
}

function pipeBlobInfo(value: object): [Uint8Array<ArrayBuffer>, boolean, string, string?, number?] | null {
    const BlobCtor = globalThis.Blob;
    if (typeof BlobCtor !== 'function' || !(value instanceof BlobCtor)) return null;
    const getBytes = Reflect.get(value, blobBytesSymbol);
    if (typeof getBytes !== 'function') throw dataCloneError('Blob could not be cloned.');
    const bytes = Reflect.apply(getBytes, value, []);
    if (!(bytes instanceof Uint8Array)) throw dataCloneError('Blob could not be cloned.');
    const FileCtor = globalThis.File;
    if (typeof FileCtor === 'function' && value instanceof FileCtor) {
        const file = value as unknown as File;
        return [bytes as Uint8Array<ArrayBuffer>, true, file.type, file.name, file.lastModified];
    }
    return [bytes as Uint8Array<ArrayBuffer>, false, (value as unknown as Blob).type];
}

function boxedPrimitiveInfo(value: object, plainTag: string | undefined):
    { kind: 'boolean' | 'number' | 'string' | 'bigint'; value: boolean | number | string | bigint } | null {
    try {
        if (plainTag === TAG_BOOLEAN) return { kind: 'boolean', value: Reflect.apply(booleanValueOf, value, []) };
        if (plainTag === TAG_NUMBER) return { kind: 'number', value: Reflect.apply(numberValueOf, value, []) };
        if (plainTag === TAG_STRING) return { kind: 'string', value: Reflect.apply(stringValueOf, value, []) };
    } catch {
        return null;
    }
    try { return { kind: 'boolean', value: Reflect.apply(booleanValueOf, value, []) }; } catch {}
    try { return { kind: 'number', value: Reflect.apply(numberValueOf, value, []) }; } catch {}
    try { return { kind: 'string', value: Reflect.apply(stringValueOf, value, []) }; } catch {}
    try { return { kind: 'bigint', value: Reflect.apply(bigintValueOf, value, []) }; } catch {}
    try {
        Reflect.apply(symbolValueOf, value, []);
        throw dataCloneError('Symbol object could not be cloned.');
    } catch (error) {
        if (error instanceof Error && error.name === 'DataCloneError') throw error;
    }
    return null;
}

function encodeForPipe(value: unknown, seen: Map<object, unknown>): unknown {
    // Do this before the object fast path.  Leaving either value for the native
    // queue makes the error asynchronous (and therefore uncaught by postMessage).
    if (typeof value === 'function' || typeof value === 'symbol') {
        throw dataCloneError(`${String(value)} could not be cloned.`);
    }
    if (value === null || typeof value !== 'object') return value;
    // No operation below this point is allowed to touch a Proxy.  In particular,
    // Object.keys/Reflect.get can run arbitrary traps.
    if (engine.isProxy(value)) throw dataCloneError('Proxy objects cannot be cloned');
    if (isUnsupportedObject(value)) throw dataCloneError(`${String(value)} could not be cloned.`);
    if (seen.has(value)) return seen.get(value);

    if (engine.isError(value)) {
        const error = value as Error;
        const message = Object.getOwnPropertyDescriptor(error, 'message');
        const cause = Object.getOwnPropertyDescriptor(error, 'cause');
        const out: PipeTuple = [
            PIPE_PROTOCOL, 'error', error.name,
            message && 'value' in message ? String(message.value) : undefined,
            typeof error.stack === 'string' ? error.stack : undefined,
            message && 'value' in message,
            undefined,
            cause && 'value' in cause,
        ];
        seen.set(value, out);
        if (cause && 'value' in cause) {
            out[6] = encodeForPipe(cause.value, seen);
        }
        return out;
    }

    if (engine.isDate(value)) {
        const out: PipeTuple = [PIPE_PROTOCOL, 'date', Reflect.apply(dateGetTime, value, [])];
        seen.set(value, out);
        return out;
    }
    if (engine.isRegExp(value)) {
        const regexp = value as RegExp;
        const out: PipeTuple = [PIPE_PROTOCOL, 'regexp', regexpSource(regexp), regexpFlags(regexp)];
        seen.set(value, out);
        return out;
    }
    if (engine.isArrayBuffer(value) || isSharedArrayBuffer(value)) {
        return value;
    }
    // Must precede the view passthrough: the native pipe serializer rejects a bare DataView
    // ("unsupported object class"), and the throw surfaces later from the outgoing queue
    // where no caller try/catch can reach it. Format: docs/node-internals.md#dataview-pipe-tag.
    if (engine.isDataView(value)) {
        const view = value as DataView;
        const out: PipeTuple = [PIPE_PROTOCOL, 'dataview',
            viewSlot(dataViewByteOffsetGetter, view), viewSlot(dataViewByteLengthGetter, view), undefined];
        seen.set(value, out);
        out[4] = encodeForPipe(viewSlot(dataViewBufferGetter, view), seen);
        return out;
    }
    if (ArrayBuffer.isView(value)) return value;

    if (engine.isMap(value)) {
        const map = value as Map<unknown, unknown>;
        const out = new Map<unknown, unknown>();
        seen.set(value, out);
        Reflect.apply(mapForEach, map, [(item: unknown, key: unknown) => {
            Reflect.apply(mapSet, out, [encodeForPipe(key, seen), encodeForPipe(item, seen)]);
        }]);
        return out;
    }
    if (engine.isSet(value)) {
        const set = value as Set<unknown>;
        const out = new Set<unknown>();
        seen.set(value, out);
        Reflect.apply(setForEach, set, [(item: unknown) => {
            Reflect.apply(setAdd, out, [encodeForPipe(item, seen)]);
        }]);
        return out;
    }
    const blob = pipeBlobInfo(value);
    if (blob) {
        const [bytes, isFile, type, name, lastModified] = blob;
        const out: PipeTuple = [PIPE_PROTOCOL, 'blob', bytes, isFile, type, name, lastModified];
        seen.set(value, out);
        return out;
    }

    // BigInt/Number/String/Boolean wrappers are not reliably retained by the
    // native pipe serializer.  Encode their internal value explicitly; Symbol
    // wrappers are rejected by boxedPrimitiveInfo just like cloneValue.
    let plainTag: string | undefined;
    const tagState = tagPropertyState(value);
    if (tagState === false && tagDispatchIsSound()) {
        plainTag = Reflect.apply(objectToString, value, []) as string;
    }
    const boxed = boxedPrimitiveInfo(value, plainTag);
    if (boxed) {
        const out: PipeTuple = [PIPE_PROTOCOL, 'boxed', boxed.kind, boxed.value];
        seen.set(value, out);
        return out;
    }

    if (Array.isArray(value)) {
        // Arrays get an envelope too.  This prevents an ordinary user array from
        // ever being mistaken for one of the special tuples during decode.
        const out: PipeTuple = [PIPE_PROTOCOL, 'array', value.length, []];
        seen.set(value, out);
        const entries = out[3] as unknown[];
        for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor) continue;
            const item = 'value' in descriptor ? descriptor.value : Reflect.get(value, key);
            entries.push([key, encodeForPipe(item, seen)]);
        }
        return out;
    }

    throwIfNonSerializable(value);
    const out = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, out);
    copyPipeProperties(value, out, seen, encodeForPipe);
    return out;
}

function decodeFromPipe(value: unknown, seen: Map<object, unknown>): unknown {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (pipeTuple(value, 'error', 8)) {
        const Ctor = errorConstructorByName(String(value[2]));
        const out = value[5] === true
            ? new Ctor(String(value[3]))
            : new Ctor();
        seen.set(value, out);
        Object.defineProperty(out, 'stack', {
            value: typeof value[4] === 'string' ? value[4] : undefined,
            writable: true,
            enumerable: false,
            configurable: true,
        });
        if (value[7] === true) {
            Object.defineProperty(out, 'cause', {
                value: decodeFromPipe(value[6], seen),
                writable: true,
                enumerable: false,
                configurable: true,
            });
        }
        return out;
    }

    if (pipeTuple(value, 'date', 3)) {
        const out = new Date(Number(value[2]));
        seen.set(value, out);
        return out;
    }
    if (pipeTuple(value, 'regexp', 4)) {
        const out = new RegExp(String(value[2]), String(value[3] ?? ''));
        seen.set(value, out);
        return out;
    }
    if (pipeTuple(value, 'dataview', 5)) {
        // Through decodeFromPipe so sibling views decode onto ONE buffer (ArrayBuffer is identity).
        const buffer = decodeFromPipe(value[4], seen) as ArrayBuffer;
        const out = new DataView(buffer, Number(value[2]), Number(value[3]));
        seen.set(value, out);
        return out;
    }
    if (pipeTuple(value, 'blob', 7)) {
        const bytes = value[2] as BlobPart;
        const isFile = value[3] === true;
        const type = typeof value[4] === 'string' ? value[4] : '';
        const name = typeof value[5] === 'string' ? value[5] : '';
        const BlobCtor = globalThis.Blob;
        if (typeof BlobCtor !== 'function') throw dataCloneError('Blob could not be cloned.');
        let out: Blob;
        const FileCtor = globalThis.File;
        if (isFile && typeof FileCtor === 'function') {
            out = new FileCtor([bytes], name, {
                type,
                lastModified: typeof value[6] === 'number' ? value[6] : undefined,
            });
        } else {
            out = new BlobCtor([bytes], { type });
        }
        seen.set(value, out);
        return out;
    }
    if (pipeTuple(value, 'boxed', 4)) {
        let out: object;
        switch (value[2]) {
            case 'boolean': out = new Boolean(value[3]); break;
            case 'number': out = new Number(value[3]); break;
            case 'string': out = new String(value[3]); break;
            case 'bigint': out = Object(value[3] as bigint); break;
            default: return value;
        }
        seen.set(value, out);
        return out;
    }
    if (pipeTuple(value, 'array', 4)) {
        const out = new Array(Number(value[2]));
        seen.set(value, out);
        const entries = value[3];
        if (Array.isArray(entries)) {
            for (const entry of entries) {
                if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
                Object.defineProperty(out, entry[0], {
                    value: decodeFromPipe(entry[1], seen),
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            }
        }
        return out;
    }
    if (engine.isDate(value) || engine.isRegExp(value) || engine.isArrayBuffer(value) || isSharedArrayBuffer(value)) {
        return value;
    }
    if (ArrayBuffer.isView(value)) return value;

    if (engine.isMap(value)) {
        const map = value as Map<unknown, unknown>;
        const out = new Map<unknown, unknown>();
        seen.set(value, out);
        Reflect.apply(mapForEach, map, [(item: unknown, key: unknown) => {
            Reflect.apply(mapSet, out, [decodeFromPipe(key, seen), decodeFromPipe(item, seen)]);
        }]);
        return out;
    }
    if (engine.isSet(value)) {
        const set = value as Set<unknown>;
        const out = new Set<unknown>();
        seen.set(value, out);
        Reflect.apply(setForEach, set, [(item: unknown) => {
            Reflect.apply(setAdd, out, [decodeFromPipe(item, seen)]);
        }]);
        return out;
    }
    const out = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, out);
    copyPipeProperties(value, out, seen, decodeFromPipe);
    return out;
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
    if (engine.isProxy(value)) {
        throw dataCloneError('Proxy objects cannot be cloned');
    }
    if (state.hooks.isUncloneable?.(value)) {
        throw dataCloneError('Object cannot be cloned');
    }
    if (state.hooks.isPort?.(value)) {
        const port = state.ports.get(value);
        if (!port) throw dataCloneError('Object cannot be cloned');
        return port;
    }
    if (seen.has(value)) return seen.get(value);
    if (engine.isArrayBuffer(value)) {
        return cloneBuffer(value as unknown as ArrayBuffer, state);
    }

    // Only when @@toStringTag is provably absent; must NOT rule out @@toStringTag-named types
    // (Map/Set/ArrayBuffer/views/Promise/Weak*) -- see docs/node-internals.md.
    let plainTag: string | undefined;
    const tagState = tagPropertyState(value);
    if (tagState === false && tagDispatchIsSound()) {
        plainTag = Reflect.apply(objectToString, value, []) as string;
    }

    if (ArrayBuffer.isView(value)) return cloneView(value, state, seen);
    if (engine.isDate(value)) {
        const out = new Date(Reflect.apply(dateGetTime, value, []));
        seen.set(value, out);
        return out;
    }
    if (engine.isRegExp(value)) {
        const regexp = value as unknown as RegExp;
        const out = new RegExp(regexpSource(regexp), regexpFlags(regexp));
        seen.set(value, out);
        return out;
    }
    // Unconditional: these types are @@toStringTag-named, so the tag cannot exclude them.
    if (isUnsupportedObject(value)) throw dataCloneError(`${String(value)} could not be cloned.`);

    // Before the boxed probe: slots are mutually exclusive, so order is cost only (Map/Set/Error
    // are tagged and would otherwise take the five-throw probe).
    if (engine.isMap(value)) {
        const out = new Map();
        seen.set(value, out);
        Reflect.apply(mapForEach, value, [(item: unknown, key: unknown) => {
            Reflect.apply(mapSet, out, [cloneValue(key, state, seen), cloneValue(item, state, seen)]);
        }]);
        return out;
    }
    if (engine.isSet(value)) {
        const out = new Set();
        seen.set(value, out);
        Reflect.apply(setForEach, value, [(item: unknown) => {
            Reflect.apply(setAdd, out, [cloneValue(item, state, seen)]);
        }]);
        return out;
    }
    if (engine.isError(value)) {
        return cloneError(value as unknown as Error, state, seen);
    }

    // BigInt/Symbol objects are always tagged, so they always take the probe (which rejects Symbol).
    const boxed = plainTag !== undefined
        ? cloneBoxedPrimitiveByTag(value, plainTag, state, seen)
        : cloneBoxedPrimitiveByProbe(value, state, seen);
    if (boxed) return boxed;

    // Throwing probe, cannot be tag-gated: keep it last so every other type exits first.
    if (isSharedArrayBuffer(value)) return cloneSharedBuffer(value, state);
    const blob = cloneBlob(value);
    if (blob) {
        seen.set(value, blob);
        return blob;
    }
    throwIfNonSerializable(value);
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
    const transferList = getTransferList(transferOrOptions);
    const state = prepareTransfers(transferList, hooks);
    const cloned = cloneValue(value, state, new Map());
    commitTransfers(state);
    return cloned as T;
}

export function encodeStructuredCloneForPipe<T>(value: T): T {
    return encodeForPipe(value, new Map()) as T;
}

export function decodeStructuredCloneFromPipe<T>(value: T): T {
    return decodeFromPipe(value, new Map()) as T;
}

export { dataCloneError, errorConstructorByName };
