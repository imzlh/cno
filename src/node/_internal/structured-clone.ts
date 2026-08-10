const engine = import.meta.use('engine');

const PIPE_ERROR_TAG = '__cno_structured_clone_error__';
const PIPE_DATE_TAG = '__cno_structured_clone_date__';
const PIPE_REGEXP_TAG = '__cno_structured_clone_regexp__';
const PIPE_DATAVIEW_TAG = '__cno_structured_clone_dataview__';
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const arrayBufferMaxByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'maxByteLength')?.get;
const arrayBufferSlice = ArrayBuffer.prototype.slice;
const arrayBufferTransfer = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer')?.value;
const dateGetTime = Date.prototype.getTime;
const booleanValueOf = Boolean.prototype.valueOf;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;
const mapForEach = Map.prototype.forEach;
const mapClear = Map.prototype.clear;
const mapSet = Map.prototype.set;
const setForEach = Set.prototype.forEach;
const setClear = Set.prototype.clear;
const setAdd = Set.prototype.add;
const regexpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get;
const regexpFlagGetters = [
    ['hasIndices', 'd'],
    ['global', 'g'],
    ['ignoreCase', 'i'],
    ['multiline', 'm'],
    ['dotAll', 's'],
    ['unicode', 'u'],
    ['unicodeSets', 'v'],
    ['sticky', 'y'],
] as const;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
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
// ArrayBuffer.isView is slot-based and never throws, so it replaces a try/catch probe
// outright. Guarded because it is the only non-throwing view predicate available and a
// host without it must keep the old path.
const arrayBufferIsView = typeof ArrayBuffer.isView === 'function' ? ArrayBuffer.isView : undefined;

// ---------------------------------------------------------------------------
// Tag-based dispatch, and why it is shaped this way.
//
// Probing a type by calling a prototype accessor and catching the TypeError costs
// ~13-48us per object in QuickJS. `cloneValue` did that seven times for every ordinary
// object (five in cloneBoxedPrimitive, plus isSharedArrayBuffer and isArrayBufferView),
// which measured 0.44ms per object -- ~800x Node for an array of 2000 plain objects.
//
// `Object.prototype.toString` answers the same question from internal slots, but only
// when @@toStringTag is absent: @@toStringTag is user-settable, so
// `{[Symbol.toStringTag]:'Map'}` reports `[object Map]` while being an ordinary object.
// So the gate checks the chain's own properties first (without invoking getters), and
// `toString` runs only when no tag is present. A Proxy in that chain is detected and sent
// through the old probes instead: a raw `in` check would invoke its `has` trap, while Node
// never runs that user code during cloning. That ordering is load-bearing for FIDELITY,
// not just speed: a spoofed tag getter must never surface.
//
// When the gate says "no @@toStringTag anywhere in the chain", the tag is derived purely
// from internal slots and is authoritative for the boxed primitives -- it even survives
// prototype surgery, which is why `Object.setPrototypeOf(new Number(11), Object.prototype)`
// still clones as a boxed Number, matching Node. When the gate says "tagged", nothing is
// assumed and the original throwing probes run unchanged, so every spoof case behaves
// exactly as before.
//
// What the tag is NOT allowed to decide is spelled out at the gate in `cloneValue`: only the
// types that `Object.prototype.toString` derives from an internal slot may be ruled out by
// it. Map/Set/ArrayBuffer/SharedArrayBuffer/DataView/TypedArray/Promise/Weak* are named by
// @@toStringTag rather than by a slot, so they are settled by non-throwing native predicates
// instead.
//
// Cross-realm objects are unaffected: a foreign Map inherits @@toStringTag from its own
// realm's Map.prototype, so it is routed to the slot-based `engine.isMap`. All 14
// cross-realm shapes in the fidelity matrix match Node.
// ---------------------------------------------------------------------------
const TAG_NUMBER = '[object Number]';
const TAG_STRING = '[object String]';
const TAG_BOOLEAN = '[object Boolean]';

// The tag is trusted for exactly one decision: "is this a boxed Number/String/Boolean?",
// where a `[object Object]` answer is taken as proof that it is not. Only two types can
// falsify that proof -- a BigInt object and a Symbol object -- because they are named by
// @@toStringTag rather than by a slot, so deleting that property makes a real one report
// `[object Object]`. It would then be cloned as a plain object (losing the BigInt value) or
// cloned at all (where a Symbol object must throw).
//
// This is checked PER CALL rather than once at load. A load-time check was tried first and
// is not sufficient: it cannot see `delete BigInt.prototype[Symbol.toStringTag]` executed
// afterwards, and measurement confirmed the divergence that let through -- cno produced a
// slot-less object where Node preserved 7n, and cloned a Symbol object where Node threw.
// Two `hasOwnProperty` calls measured 6.6us per object against 43.4us for reinstating the
// two throwing probes, so the robust version is also the cheap one.
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

function normalizeTransferList(input: TransferInput): readonly unknown[] {
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

// Blob/File carry their bytes in a private field, so the plain-object fallback
// below cloned them to `{}` and silently dropped the payload. `Symbol.for`
// avoids importing webapi/formdata here (that would be circular).
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

// Platform objects with internal slots and no serialization steps must throw
// DataCloneError. The plain-object fallback used to hand back a hollow `{}` —
// e.g. a cloned URL with `href === undefined`. This list is the measured
// intersection of what Node 24 and Deno 2 both reject; AbortSignal, EventTarget,
// TextEncoder/Decoder, Performance and BroadcastChannel are deliberately absent
// because both engines clone those to plain objects.
const nonSerializableCtors = ['URL', 'URLSearchParams', 'Headers', 'FormData',
    'Request', 'Response', 'ReadableStream', 'WritableStream', 'TransformStream'];

// This check CANNOT be gated on the @@toStringTag test: in cno, Request, Response,
// ReadableStream, WritableStream and TransformStream carry no @@toStringTag and report
// `[object Object]` (measured; in Node all five are tagged). Gating on the tag would
// silently turn "throws DataCloneError" into "clones to a hollow plain object" for them.
//
// Instead it is gated on prototype identity. `value instanceof C` walks value's prototype
// chain looking for C.prototype, so an object whose immediate prototype is exactly
// Object.prototype or Array.prototype (or null) cannot be an instance of any of the nine
// -- none of them has Object.prototype as its own `prototype`. That reduces the common case
// from nine globalThis reads plus nine instanceof checks (51.7us/object measured) to a
// single getPrototypeOf and two comparisons. Anything else still runs the full loop, so
// subclasses, cross-realm instances and exotic prototypes are unaffected.
//
// Not covered, deliberately: a constructor with a custom Symbol.hasInstance that claims
// plain objects. `instanceof` would honour it; this gate skips it. Node's structured clone
// does not consult globals at all, so that shape is outside what either engine guarantees.
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

function arrayBufferByteLength(buffer: ArrayBuffer): number {
    if (!arrayBufferByteLengthGetter) throw dataCloneError('ArrayBuffer byteLength is unavailable');
    return Reflect.apply(arrayBufferByteLengthGetter, buffer, []);
}

function isResizableArrayBuffer(buffer: ArrayBuffer): boolean {
    return arrayBufferResizableGetter ? Reflect.apply(arrayBufferResizableGetter, buffer, []) : false;
}

function arrayBufferMaxByteLength(buffer: ArrayBuffer): number {
    return arrayBufferMaxByteLengthGetter
        ? Reflect.apply(arrayBufferMaxByteLengthGetter, buffer, [])
        : arrayBufferByteLength(buffer);
}

function applyGetter<T>(getter: ((this: unknown) => T) | undefined, receiver: object, name: string): T {
    if (!getter) throw dataCloneError(`${name} is unavailable`);
    return Reflect.apply(getter, receiver, []);
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
    if (!value || typeof value !== 'object') return false;
    // Slot-based and non-throwing: correct even for a view whose prototype chain has been
    // severed from @@toStringTag, which a tag test alone could not detect.
    if (arrayBufferIsView) return arrayBufferIsView(value);
    if (engine.isDataView(value)) return true;
    if (!typedArrayBufferGetter) return false;
    try { Reflect.apply(typedArrayBufferGetter, value, []); return true; } catch { return false; }
}

function regexpSource(value: RegExp): string {
    return applyGetter(regexpSourceGetter, value, 'RegExp source');
}

function regexpFlags(value: RegExp): string {
    let flags = '';
    for (const [property, flag] of regexpFlagGetters) {
        const getter = Object.getOwnPropertyDescriptor(RegExp.prototype, property)?.get;
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
            const out = new ArrayBuffer(arrayBufferByteLength(buffer), { maxByteLength: arrayBufferMaxByteLength(buffer) });
            new Uint8Array(out).set(new Uint8Array(buffer));
            return out;
        }
        return Reflect.apply(arrayBufferSlice, buffer, [0]);
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
        // Never consult an instance property named `transfer`: structured cloning
        // operates on the ArrayBuffer internal slot, and user code must not be able
        // to intercept or suppress the detach step by shadowing the prototype.
        if (typeof arrayBufferTransfer === 'function') {
            Reflect.apply(arrayBufferTransfer, buffer, []);
        } else {
            engine.detachArrayBuffer(buffer);
        }
    } catch (e) {
        if (arrayBufferByteLength(buffer) !== 0) throw e;
    }
}

function typedArrayConstructor(value: ArrayBufferView): TypedArrayConstructor {
    const tag = applyGetter(typedArrayTagGetter, value, 'TypedArray tag');
    switch (tag) {
        case 'Int8Array': return Int8Array;
        case 'Uint8Array': return Uint8Array;
        case 'Uint8ClampedArray': return Uint8ClampedArray;
        case 'Int16Array': return Int16Array;
        case 'Uint16Array': return Uint16Array;
        case 'Int32Array': return Int32Array;
        case 'Uint32Array': return Uint32Array;
        case 'Float32Array': return Float32Array;
        case 'Float64Array': return Float64Array;
        case 'BigInt64Array': return BigInt64Array as TypedArrayConstructor;
        case 'BigUint64Array': return BigUint64Array as TypedArrayConstructor;
        default: throw dataCloneError('Unsupported ArrayBuffer view');
    }
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
    if (isArrayBufferView(cached)) return cached;
    const isDataView = engine.isDataView(value);
    const source = isDataView
        ? applyGetter(dataViewBufferGetter, value, 'DataView buffer')
        : applyGetter(typedArrayBufferGetter, value, 'TypedArray buffer');
    const buffer = engine.isArrayBuffer(source)
        ? state.buffers.get(source) ?? cloneBuffer(source, state)
        : cloneSharedBuffer(source, state);

    if (isDataView) {
        const byteOffset = applyGetter(dataViewByteOffsetGetter, value, 'DataView byteOffset');
        const byteLength = applyGetter(dataViewByteLengthGetter, value, 'DataView byteLength');
        const out = new DataView(buffer, byteOffset, byteLength);
        seen.set(value, out);
        return out;
    }

    const ctor = typedArrayConstructor(value);
    const byteOffset = applyGetter(typedArrayByteOffsetGetter, value, 'TypedArray byteOffset');
    const length = applyGetter(typedArrayLengthGetter, value, 'TypedArray length');
    const out = new ctor(buffer, byteOffset, length);
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
        // Assignment would invoke Object.prototype.__proto__. Structured clone
        // instead creates an ordinary enumerable own data property for every key.
        Object.defineProperty(target, key, {
            value: cloneValue(value, state, seen),
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }
}

// The original five-probe version, kept verbatim for every value the tag test cannot
// speak for (anything carrying @@toStringTag, and BigInt/Symbol objects which are tagged
// by definition). Correct but expensive: five caught exceptions for an ordinary object.
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

// Fast path: `plainTag` is the internal-slot-derived tag, already computed by the caller
// and only ever passed when @@toStringTag is provably absent, so it is authoritative.
// Boxed Number/String/Boolean take one valueOf call -- the one that will succeed -- rather
// than up to five that throw. Any other tag (`[object Object]`, `[object Array]`,
// `[object Date]`, ...) is proof of no boxed slot, so no probe runs at all.
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

function isPipeEncodedError(value: unknown): value is CloneRecord {
    return !!value && typeof value === 'object' && (value as CloneRecord)[PIPE_ERROR_TAG] === true;
}

function isPipeEncodedDate(value: unknown): value is CloneRecord {
    return !!value && typeof value === 'object' && (value as CloneRecord)[PIPE_DATE_TAG] === true;
}

function isPipeEncodedRegExp(value: unknown): value is CloneRecord {
    return !!value && typeof value === 'object' && (value as CloneRecord)[PIPE_REGEXP_TAG] === true;
}

function isPipeEncodedDataView(value: unknown): value is CloneRecord {
    return !!value && typeof value === 'object' && (value as CloneRecord)[PIPE_DATAVIEW_TAG] === true;
}

function encodeForPipe(value: unknown, seen: Map<object, unknown>): unknown {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (engine.isError(value)) {
        const error = value as Error;
        const out: CloneRecord = {
            [PIPE_ERROR_TAG]: true,
            name: error.name,
        };
        seen.set(value, out);
        const message = Object.getOwnPropertyDescriptor(error, 'message');
        if (message && 'value' in message) out.message = String(message.value);
        const stack = error.stack;
        out.stack = typeof stack === 'string' ? stack : undefined;
        const cause = Object.getOwnPropertyDescriptor(error, 'cause');
        if (cause && 'value' in cause) {
            out.cause = encodeForPipe(cause.value, seen);
        }
        return out;
    }

    if (engine.isDate(value)) {
        const out = { [PIPE_DATE_TAG]: true, value: Reflect.apply(dateGetTime, value, []) };
        seen.set(value, out);
        return out;
    }
    if (engine.isRegExp(value)) {
        const regexp = value as RegExp;
        const out = { [PIPE_REGEXP_TAG]: true, source: regexpSource(regexp), flags: regexpFlags(regexp) };
        seen.set(value, out);
        return out;
    }
    if (engine.isArrayBuffer(value) || isSharedArrayBuffer(value)) {
        return value;
    }
    // A DataView IS an ArrayBufferView, so without this it fell through to the
    // passthrough below and reached the native pipe serializer, which rejects it
    // with "unsupported object class". Typed arrays survive that encoder; DataView
    // does not, so it needs a tag the way Date and RegExp above do. Encoded as its
    // backing buffer plus the window, since a bare ArrayBuffer crosses intact.
    //
    // Not cosmetic: when the receiving worker is not ready the payload is queued,
    // so the throw surfaces later from _flushOutgoingQueue as an unhandled
    // rejection no try/catch around postMessage can reach, and the loop wedges.
    // Measured before this fix: cno rc=124 (killed on timeout) vs node rc=0.
    if (engine.isDataView(value)) {
        const view = value as DataView;
        const out: CloneRecord = {
            [PIPE_DATAVIEW_TAG]: true,
            buffer: encodeForPipe(view.buffer, seen),
            byteOffset: view.byteOffset,
            byteLength: view.byteLength,
        };
        seen.set(value, out);
        return out;
    }
    if (isArrayBufferView(value)) return value;

    seen.set(value, value);
    if (engine.isMap(value)) {
        const map = value as Map<unknown, unknown>;
        const entries: Array<[unknown, unknown]> = [];
        Reflect.apply(mapForEach, map, [(item: unknown, key: unknown) => entries.push([key, item])]);
        Reflect.apply(mapClear, map, []);
        for (const [key, item] of entries) {
            Reflect.apply(mapSet, map, [encodeForPipe(key, seen), encodeForPipe(item, seen)]);
        }
        return map;
    }
    if (engine.isSet(value)) {
        const set = value as Set<unknown>;
        const items: unknown[] = [];
        Reflect.apply(setForEach, set, [(item: unknown) => items.push(item)]);
        Reflect.apply(setClear, set, []);
        for (const item of items) Reflect.apply(setAdd, set, [encodeForPipe(item, seen)]);
        return set;
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
        const Ctor = errorConstructorByName(String(value.name));
        const out = Object.prototype.hasOwnProperty.call(value, 'message')
            ? new Ctor(String(value.message))
            : new Ctor();
        seen.set(value, out);
        Object.defineProperty(out, 'stack', {
            value: typeof value.stack === 'string' ? value.stack : undefined,
            writable: true,
            enumerable: false,
            configurable: true,
        });
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
    if (isPipeEncodedDataView(value)) {
        // Routed through decodeFromPipe so two views over one buffer decode to two
        // views over ONE buffer: ArrayBuffer returns identity, preserving sharing.
        const buffer = decodeFromPipe(value.buffer, seen) as ArrayBuffer;
        const out = new DataView(buffer, Number(value.byteOffset), Number(value.byteLength));
        seen.set(value, out);
        return out;
    }
    if (engine.isDate(value) || engine.isRegExp(value) || engine.isArrayBuffer(value) || isSharedArrayBuffer(value)) {
        return value;
    }
    if (isArrayBufferView(value)) return value;

    seen.set(value, value);
    if (engine.isMap(value)) {
        const map = value as Map<unknown, unknown>;
        const entries: Array<[unknown, unknown]> = [];
        Reflect.apply(mapForEach, map, [(item: unknown, key: unknown) => entries.push([key, item])]);
        Reflect.apply(mapClear, map, []);
        for (const [key, item] of entries) {
            Reflect.apply(mapSet, map, [decodeFromPipe(key, seen), decodeFromPipe(item, seen)]);
        }
        return map;
    }
    if (engine.isSet(value)) {
        const set = value as Set<unknown>;
        const items: unknown[] = [];
        Reflect.apply(setForEach, set, [(item: unknown) => items.push(item)]);
        Reflect.apply(setClear, set, []);
        for (const item of items) Reflect.apply(setAdd, set, [decodeFromPipe(item, seen)]);
        return set;
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

    // Compute the slot-derived tag once, and only when @@toStringTag is provably absent
    // from the whole prototype chain. `plainTag` non-undefined means "this tag came from
    // an internal slot and no user code was consulted to produce it".
    //
    // IMPORTANT SCOPE LIMIT, measured: the tag may be used ONLY to answer questions that
    // Object.prototype.toString answers from an internal slot -- that is, the boxed
    // primitives (Number/String/Boolean), plus Array/Date/RegExp/Error/Arguments. It must
    // NOT be used to rule out Map, Set, ArrayBuffer, SharedArrayBuffer, DataView,
    // TypedArray, Promise, WeakMap, WeakSet or WeakRef, because none of those appears in
    // that spec list: they report their name *via @@toStringTag on their prototype*. Delete
    // that property at runtime -- `delete SharedArrayBuffer.prototype[Symbol.toStringTag]`
    // -- and a real SharedArrayBuffer reports `[object Object]`.
    //
    // An earlier revision of this fix did gate the SharedArrayBuffer and Weak/Promise
    // probes on the tag, and it measurably diverged from Node: a SharedArrayBuffer cloned
    // to a hollow object (`byteLength === undefined`, payload gone) and a Promise/WeakMap
    // cloned instead of throwing, in all three cases where Node still did the right thing.
    // Node reads internal slots throughout and is immune, so those gates are gone. The
    // predicates below that are cheap and non-throwing (`engine.*`, `ArrayBuffer.isView`)
    // simply run unconditionally.
    let plainTag: string | undefined;
    const tagState = tagPropertyState(value);
    if (tagState === false && tagDispatchIsSound()) {
        plainTag = Reflect.apply(objectToString, value, []) as string;
    }

    // Views are settled by ArrayBuffer.isView: slot-based, non-throwing, and correct even
    // for a view whose prototype chain no longer carries @@toStringTag.
    if (isArrayBufferView(value)) return cloneView(value, state, seen);
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
    // Four native slot checks, no exceptions thrown. Unconditional: see the scope limit
    // above -- all four types are identified by @@toStringTag, so the tag cannot exclude them.
    if (isUnsupportedObject(value)) throw dataCloneError(`${String(value)} could not be cloned.`);

    // Map/Set/Error are settled BEFORE the boxed-primitive probe. An object holds at most
    // one of [[MapData]] / [[SetData]] / [[ErrorData]] / [[NumberData]] / [[StringData]] /
    // [[BooleanData]] -- slots are assigned at construction and cannot be added later -- so
    // these three predicates and the boxed probe are mutually exclusive and the order
    // between them cannot change any outcome. It matters for cost: Map, Set and Error all
    // carry @@toStringTag (or tag as `[object Error]`), so they take the slow path, and
    // testing them first spares them the five-throw probe.
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

    // A known slot tag settles the boxed-primitive question outright, and this IS one of the
    // questions Object.prototype.toString answers from an internal slot, so it is sound:
    // `[object Number]` / `[object String]` / `[object Boolean]` take the one valueOf call
    // that will succeed, and any other tag provably has no boxed slot, so the five-throw
    // probe is skipped. A value carrying @@toStringTag falls back to the original probe,
    // which is what keeps every spoof case behaving as before. BigInt and Symbol objects are
    // always tagged, so they always take that probe -- which is where the Symbol rejection
    // lives.
    const boxed = plainTag !== undefined
        ? cloneBoxedPrimitiveByTag(value, plainTag, state, seen)
        : cloneBoxedPrimitiveByProbe(value, state, seen);
    if (boxed) return boxed;

    // The SharedArrayBuffer probe is the one remaining throw on this path, and it cannot be
    // gated on the tag (see the scope limit above) -- so it is placed as late as possible
    // instead. Everything tested before it is identified by a distinct internal slot and is
    // therefore mutually exclusive with a SharedArrayBuffer, so a Date, RegExp, Map, Set,
    // Error, view or boxed primitive now exits before paying for it. Only genuinely
    // plain-looking objects reach it.
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

export { dataCloneError, errorConstructorByName };
