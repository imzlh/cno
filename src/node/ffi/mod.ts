import { Buffer } from '../buffer/mod';

const ffi = import.meta.use('ffi');
const os = import.meta.use('os');

export type ReturnType =
    | 'void'
    | 'char' | 'bool'
    | 'i8' | 'int8' | 'u8' | 'uint8'
    | 'i16' | 'int16' | 'u16' | 'uint16'
    | 'i32' | 'int32' | 'u32' | 'uint32'
    | 'i64' | 'int64' | 'u64' | 'uint64'
    | 'float' | 'f32' | 'float32' | 'double' | 'f64' | 'float64'
    | 'pointer' | 'ptr' | 'function' | 'buffer' | 'arraybuffer' | 'string' | 'str';

export type ArgumentType = Exclude<ReturnType, 'void'>;

export interface FunctionSignature {
    return?: ReturnType;
    arguments?: readonly ArgumentType[];
}

export interface FunctionDefinitions {
    [symbol: string]: FunctionSignature;
}

type PointerArgument = bigint | string | ArrayBuffer | ArrayBufferView<ArrayBufferLike> | null;
type FfiArgument = number | bigint | PointerArgument;
type FfiReturn = number | bigint | void;

export interface WrappedFunction extends Function {
    readonly pointer: bigint;
}

interface NormalizedSignature {
    result: CanonicalType;
    args: CanonicalType[];
    key: string;
}

type CanonicalType =
    | 'void' | 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32'
    | 'i64' | 'u64' | 'f32' | 'f64' | 'pointer';

interface FunctionRecord {
    signature: NormalizedSignature;
    fn: WrappedFunction;
}

type CallbackFunction = (...args: FfiArgument[]) => FfiReturn;

interface CallbackRecord {
    callback: CModuleFFI.Callback;
    pointer: CModuleFFI.Pointer;
    strongCallback?: CallbackFunction;
    weakCallback: WeakRef<CallbackFunction>;
}

// A callback pointer can be passed to a function obtained from any library,
// not only the DynamicLibrary that created it. Preserve the native Pointer
// object (and therefore its callback provenance) across those library
// boundaries for as long as the callback remains registered. The registry is
// weak so it does not outlive the DynamicLibrary that strongly owns the record.
const activeCallbacks = new Map<bigint, WeakRef<CallbackRecord>>();

function getActiveCallback(address: bigint): CallbackRecord | undefined {
    const reference = activeCallbacks.get(address);
    const record = reference?.deref();
    if (reference && !record) activeCallbacks.delete(address);
    return record;
}

function deleteActiveCallback(address: bigint, record: CallbackRecord): void {
    if (activeCallbacks.get(address)?.deref() === record) activeCallbacks.delete(address);
}

/* node: modules cannot import the shared utils layer; keep these local. */
const nativeLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
export const suffix = (() => {
    const system = os.uname().sysname;
    if (system === 'Windows_NT') return 'dll';
    if (system === 'Darwin') return 'dylib';
    return 'so';
})();

export enum types {
    VOID = 'void',
    POINTER = 'pointer',
    BUFFER = 'buffer',
    ARRAY_BUFFER = 'arraybuffer',
    FUNCTION = 'function',
    BOOL = 'bool',
    CHAR = 'char',
    STRING = 'string',
    FLOAT = 'float',
    DOUBLE = 'double',
    INT_8 = 'int8',
    UINT_8 = 'uint8',
    INT_16 = 'int16',
    UINT_16 = 'uint16',
    INT_32 = 'int32',
    UINT_32 = 'uint32',
    INT_64 = 'int64',
    UINT_64 = 'uint64',
    FLOAT_32 = 'float32',
    FLOAT_64 = 'float64',
}

const aliases: Record<string, CanonicalType> = {
    void: 'void',
    char: 'i8',
    bool: 'u8',
    i8: 'i8', int8: 'i8',
    u8: 'u8', uint8: 'u8',
    i16: 'i16', int16: 'i16',
    u16: 'u16', uint16: 'u16',
    i32: 'i32', int32: 'i32',
    u32: 'u32', uint32: 'u32',
    i64: 'i64', int64: 'i64',
    u64: 'u64', uint64: 'u64',
    float: 'f32', f32: 'f32', float32: 'f32',
    double: 'f64', f64: 'f64', float64: 'f64',
    pointer: 'pointer', ptr: 'pointer', function: 'pointer', buffer: 'pointer',
    arraybuffer: 'pointer', string: 'pointer', str: 'pointer',
};

const nativeTypes: Record<CanonicalType, CModuleFFI.TypeToken> = {
    void: ffi.types.void,
    i8: ffi.types.i8,
    u8: ffi.types.u8,
    i16: ffi.types.i16,
    u16: ffi.types.u16,
    i32: ffi.types.i32,
    u32: ffi.types.u32,
    i64: ffi.types.i64,
    u64: ffi.types.u64,
    f32: ffi.types.f32,
    f64: ffi.types.f64,
    pointer: ffi.types.pointer,
};

function invalidArg(name: string, message: string): never {
    const error = new TypeError(`The "${name}" argument ${message}`) as TypeError & { code?: string };
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
}

function normalizeType(value: unknown, name: string, allowVoid: boolean): CanonicalType {
    if (typeof value !== 'string' || !(value in aliases)) {
        invalidArg(name, 'must be a supported FFI data type');
    }
    const type = aliases[value as ReturnType];
    if (!allowVoid && type === 'void') invalidArg(name, 'must not be void');
    return type;
}

function normalizeSignature(value: unknown): NormalizedSignature {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        invalidArg('signature', 'must be an object');
    }
    const signature = value as FunctionSignature;
    const rawArgs = signature.arguments ?? [];
    if (!Array.isArray(rawArgs)) invalidArg('signature.arguments', 'must be an array');
    const args = rawArgs.map((type, index) => normalizeType(type, `signature.arguments[${index}]`, false));
    const result = normalizeType(signature.return ?? 'void', 'signature.return', true);
    return { args, result, key: `${result}(${args.join(',')})` };
}

function viewBytes(value: ArrayBufferLike | ArrayBufferView<ArrayBufferLike>): Uint8Array {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (!ArrayBuffer.isView(value)) return new Uint8Array(value);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function pointerAddress(pointer: CModuleFFI.Pointer | null): bigint {
    return pointer === null ? 0n : ffi.unsafe.address(pointer);
}

function pointerFromAddress(address: bigint): CModuleFFI.Pointer | null {
    return ffi.unsafe.fromAddress(address);
}

function normalizeInteger(type: CanonicalType, value: unknown): number | bigint {
    switch (type) {
        case 'i8': return (Number(value) << 24) >> 24;
        case 'u8': return Number(value) & 0xff;
        case 'i16': return (Number(value) << 16) >> 16;
        case 'u16': return Number(value) & 0xffff;
        case 'i32': return Number(value) | 0;
        case 'u32': return Number(value) >>> 0;
        case 'i64': return BigInt.asIntN(64, BigInt(value as bigint | number));
        case 'u64': return BigInt.asUintN(64, BigInt(value as bigint | number));
        default: throw new TypeError('Internal FFI integer conversion error');
    }
}

function toNativeScalarArgument(type: CanonicalType, value: unknown): unknown {
    switch (type) {
        case 'void': return undefined;
        case 'pointer': throw new TypeError('Internal FFI pointer conversion error');
        case 'i8':
        case 'u8':
        case 'i16':
        case 'u16':
        case 'i32':
        case 'u32':
        case 'i64':
        case 'u64':
            return normalizeInteger(type, value);
        default:
            return Number(value);
    }
}

function validatePointerArgument(value: unknown): void {
    if (
        value !== null
        && typeof value !== 'bigint'
        && typeof value !== 'string'
        && !(value instanceof ArrayBuffer)
        && !ArrayBuffer.isView(value)
    ) {
        invalidArg('value', 'must be a bigint, string, ArrayBuffer, ArrayBufferView, or null for a pointer');
    }
}

function toNativePointerArgument(
    value: unknown,
    keepalive: unknown[],
): CModuleFFI.Pointer | null {
    if (value === null) return null;
    if (typeof value === 'bigint') return getActiveCallback(value)?.pointer ?? pointerFromAddress(value);
    if (typeof value === 'string') {
        const bytes = Buffer.from(`${value}\0`, 'utf8');
        keepalive.push(bytes);
        return ffi.unsafe.pointerOf(bytes);
    }
    const source = value as ArrayBuffer | ArrayBufferView<ArrayBufferLike>;
    keepalive.push(source);
    return ffi.unsafe.pointerOf(source);
}

function toNativeArguments(
    types: readonly CanonicalType[],
    args: readonly FfiArgument[],
    keepalive: unknown[],
): unknown[] {
    for (let index = 0; index < types.length; index++) {
        if (types[index] === 'pointer') validatePointerArgument(args[index]);
    }

    const result = args.map((arg, index) =>
        types[index] === 'pointer' ? undefined : toNativeScalarArgument(types[index], arg)
    );
    for (let index = 0; index < types.length; index++) {
        if (types[index] === 'pointer') {
            result[index] = toNativePointerArgument(args[index], keepalive);
        }
    }
    return result;
}

function fromNativeValue(type: CanonicalType, value: unknown): FfiReturn {
    if (type === 'void') return undefined;
    if (type === 'pointer') return pointerAddress(value as CModuleFFI.Pointer | null);
    return value as number | bigint;
}

function toNativeCallbackResult(type: CanonicalType, value: unknown): unknown {
    if (type === 'pointer') {
        if (typeof value !== 'bigint') {
            invalidArg('callback result', 'must be a bigint for a pointer return type');
        }
        return pointerFromAddress(value);
    }
    if (type === 'void') return undefined;
    if (
        type === 'i8' || type === 'u8'
        || type === 'i16' || type === 'u16'
        || type === 'i32' || type === 'u32'
        || type === 'i64' || type === 'u64'
    ) {
        return normalizeInteger(type, value);
    }
    return Number(value);
}

function zeroNativeResult(type: CanonicalType): unknown {
    switch (type) {
        case 'void': return undefined;
        case 'pointer': return null;
        case 'i64':
        case 'u64': return 0n;
        default: return 0;
    }
}

function assertDefinitions(value: unknown): asserts value is FunctionDefinitions {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        invalidArg('definitions', 'must be an object');
    }
}

export class DynamicLibrary {
    readonly path: string;
    readonly symbols: Record<string, bigint> = Object.create(null);

    #lib: CModuleFFI.Library;
    #closed = false;
    #nativeSymbols = new Map<string, CModuleFFI.Pointer>();
    #functions = new Map<string, FunctionRecord>();
    #callbacks = new Map<bigint, CallbackRecord>();

    constructor(path: string | null) {
        if (path === null) {
            const error = new Error('Loading symbols from the current process is not supported by this runtime') as Error & { code?: string };
            error.code = 'ERR_NOT_SUPPORTED';
            throw error;
        }
        if (typeof path !== 'string') invalidArg('path', 'must be a string or null');
        this.path = path;
        this.#lib = ffi.open(path);
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error('Dynamic library is closed');
    }

    #resolve(name: string): CModuleFFI.Pointer {
        this.#assertOpen();
        if (typeof name !== 'string') invalidArg('symbol', 'must be a string');
        let symbol = this.#nativeSymbols.get(name);
        if (!symbol) {
            symbol = this.#lib.symbol(name);
            this.#nativeSymbols.set(name, symbol);
            this.symbols[name] = pointerAddress(symbol);
        }
        return symbol;
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#functions.clear();
        this.#nativeSymbols.clear();
        for (const [pointer, record] of this.#callbacks) {
            // Check identity so a stale owner can never delete a newer callback
            // if a native closure address is eventually reused.
            deleteActiveCallback(pointer, record);
            record.callback.close();
        }
        this.#callbacks.clear();
        this.#lib.close();
    }

    [Symbol.dispose](): void {
        this.close();
    }

    getSymbol(name: string): bigint {
        return pointerAddress(this.#resolve(name));
    }

    getSymbols(): Record<string, bigint> {
        this.#assertOpen();
        return Object.assign(Object.create(null), this.symbols);
    }

    getFunction(name: string, signature: FunctionSignature): WrappedFunction {
        this.#assertOpen();
        const normalized = normalizeSignature(signature);
        const cached = this.#functions.get(name);
        if (cached) {
            if (cached.signature.key !== normalized.key) {
                throw new TypeError(`Symbol "${name}" was already resolved with a different signature`);
            }
            return cached.fn;
        }

        this.#resolve(name);
        /* Runtime-built signature: bind()'s literal-tuple generics cannot
         * express it, so the method's type is widened (receiver preserved via
         * .call — the native side reads `this` as the FfiLibrary). */
        const runtimeBind = (this.#lib.bind as unknown as (
            this: CModuleFFI.Library,
            signature: readonly [CModuleFFI.TypeToken, string, ...CModuleFFI.TypeToken[]],
        ) => ((...args: unknown[]) => FfiReturn) & { readonly pointer: CModuleFFI.Pointer });
        const nativeFunction = runtimeBind.call(
            this.#lib,
            [nativeTypes[normalized.result], name, ...normalized.args.map(type => nativeTypes[type])],
        );
        const library = this;
        const fn = function(this: unknown, ...args: FfiArgument[]): FfiReturn {
            library.#assertOpen();
            if (args.length !== normalized.args.length) {
                throw new RangeError(`Expected ${normalized.args.length} arguments but got ${args.length}`);
            }
            const keepalive: unknown[] = [];
            const nativeArgs = toNativeArguments(normalized.args, args, keepalive);
            try {
                return fromNativeValue(normalized.result, nativeFunction(...nativeArgs));
            } finally {
                keepalive.length = 0;
            }
        } as unknown as WrappedFunction;
        Object.defineProperty(fn, 'pointer', {
            value: pointerAddress(nativeFunction.pointer),
            writable: false,
            enumerable: true,
            configurable: false,
        });
        this.#functions.set(name, { signature: normalized, fn });
        return fn;
    }

    getFunctions(definitions?: FunctionDefinitions): Record<string, WrappedFunction> {
        this.#assertOpen();
        if (definitions !== undefined) {
            assertDefinitions(definitions);
            for (const [name, signature] of Object.entries(definitions)) {
                this.getFunction(name, signature);
            }
        }
        const functions: Record<string, WrappedFunction> = Object.create(null);
        for (const [name, record] of this.#functions) functions[name] = record.fn;
        return functions;
    }

    registerCallback(
        signatureOrCallback: FunctionSignature | CallbackFunction,
        callback?: CallbackFunction,
    ): bigint {
        this.#assertOpen();
        const signature = typeof signatureOrCallback === 'function'
            ? normalizeSignature({})
            : normalizeSignature(signatureOrCallback);
        const target = typeof signatureOrCallback === 'function' ? signatureOrCallback : callback;
        if (typeof target !== 'function') invalidArg('callback', 'must be a function');

        const nativeSignature = [
            nativeTypes[signature.result],
            ...signature.args.map(type => nativeTypes[type]),
        ];
        let record!: CallbackRecord;
        const weakCallback = new WeakRef(target);
        const wrapped = (...args: unknown[]): unknown => {
            const current = record.strongCallback ?? weakCallback.deref();
            if (!current) return zeroNativeResult(signature.result);
            const values = args.map((arg, index) =>
                fromNativeValue(signature.args[index], arg) as FfiArgument
            );
            return toNativeCallbackResult(signature.result, current(...values));
        };
        /* node26 builds signatures at runtime; callback()'s generic contract
         * (typed per-signature args, no-Promise returns) cannot be expressed
         * here — conversion happens in fromNativeValue/toNativeCallbackResult. */
        const createCallback = ffi.callback as unknown as (
            signature: readonly CModuleFFI.TypeToken[],
            callback: (...args: unknown[]) => unknown,
        ) => CModuleFFI.Callback;
        const nativeCallback = createCallback(nativeSignature, wrapped);
        const nativePointer = nativeCallback.pointer;
        const pointer = pointerAddress(nativePointer);
        record = {
            callback: nativeCallback,
            pointer: nativePointer,
            strongCallback: target,
            weakCallback,
        };
        if (getActiveCallback(pointer)) {
            nativeCallback.close();
            throw new Error('FFI callback address collides with an active callback');
        }
        this.#callbacks.set(pointer, record);
        activeCallbacks.set(pointer, new WeakRef(record));
        return pointer;
    }

    #getCallback(pointer: bigint): CallbackRecord {
        this.#assertOpen();
        if (typeof pointer !== 'bigint') invalidArg('pointer', 'must be a bigint');
        const record = this.#callbacks.get(pointer);
        if (!record) throw new RangeError('Unknown callback pointer');
        return record;
    }

    unregisterCallback(pointer: bigint): void {
        const record = this.#getCallback(pointer);
        this.#callbacks.delete(pointer);
        deleteActiveCallback(pointer, record);
        record.callback.close();
    }

    refCallback(pointer: bigint): void {
        const record = this.#getCallback(pointer);
        if (record.strongCallback) return;
        const callback = record.weakCallback.deref();
        if (!callback) throw new Error('Callback has already been garbage collected');
        record.strongCallback = callback;
    }

    unrefCallback(pointer: bigint): void {
        const record = this.#getCallback(pointer);
        record.strongCallback = undefined;
    }
}

export interface DynamicLibraryResult extends Disposable {
    lib: DynamicLibrary;
    functions: Record<string, WrappedFunction>;
}

export function dlopen(path: string | null, definitions: FunctionDefinitions = {}): DynamicLibraryResult {
    assertDefinitions(definitions);
    const lib = new DynamicLibrary(path);
    try {
        const result: DynamicLibraryResult = {
            lib,
            functions: lib.getFunctions(definitions),
            [Symbol.dispose]() { lib.close(); },
        };
        return result;
    } catch (error) {
        lib.close();
        throw error;
    }
}

export function dlclose(handle: DynamicLibrary): void {
    if (!(handle instanceof DynamicLibrary)) invalidArg('handle', 'must be a DynamicLibrary');
    handle.close();
}

export function dlsym(handle: DynamicLibrary, symbol: string): bigint {
    if (!(handle instanceof DynamicLibrary)) invalidArg('handle', 'must be a DynamicLibrary');
    return handle.getSymbol(symbol);
}

function pointerView(pointer: bigint, offset: number, size: number): DataView {
    if (typeof pointer !== 'bigint') invalidArg('pointer', 'must be a bigint');
    if (!Number.isSafeInteger(offset)) invalidArg('offset', 'must be an integer');
    const nativePointer = pointerFromAddress(pointer + BigInt(offset));
    if (nativePointer === null && size !== 0) throw new RangeError('Cannot access memory through a null pointer');
    const bytes = nativePointer === null ? new Uint8Array(0) : ffi.unsafe.view(nativePointer, size);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function getInt8(pointer: bigint, offset = 0): number { return pointerView(pointer, offset, 1).getInt8(0); }
export function getUint8(pointer: bigint, offset = 0): number { return pointerView(pointer, offset, 1).getUint8(0); }
export function getInt16(pointer: bigint, offset = 0): number { return pointerView(pointer, offset, 2).getInt16(0, nativeLittleEndian); }
export function getUint16(pointer: bigint, offset = 0): number { return pointerView(pointer, offset, 2).getUint16(0, nativeLittleEndian); }
export function getInt32(pointer: bigint, offset = 0): number { return pointerView(pointer, offset, 4).getInt32(0, nativeLittleEndian); }
export function getUint32(pointer: bigint, offset = 0): number { return pointerView(pointer, offset, 4).getUint32(0, nativeLittleEndian); }
export function getInt64(pointer: bigint, offset = 0): bigint { return pointerView(pointer, offset, 8).getBigInt64(0, nativeLittleEndian); }
export function getUint64(pointer: bigint, offset = 0): bigint { return pointerView(pointer, offset, 8).getBigUint64(0, nativeLittleEndian); }
export function getFloat32(pointer: bigint, offset = 0): number { return pointerView(pointer, offset, 4).getFloat32(0, nativeLittleEndian); }
export function getFloat64(pointer: bigint, offset = 0): number { return pointerView(pointer, offset, 8).getFloat64(0, nativeLittleEndian); }

export function setInt8(pointer: bigint, offset: number, value: number): void { pointerView(pointer, offset, 1).setInt8(0, value); }
export function setUint8(pointer: bigint, offset: number, value: number): void { pointerView(pointer, offset, 1).setUint8(0, value); }
export function setInt16(pointer: bigint, offset: number, value: number): void { pointerView(pointer, offset, 2).setInt16(0, value, nativeLittleEndian); }
export function setUint16(pointer: bigint, offset: number, value: number): void { pointerView(pointer, offset, 2).setUint16(0, value, nativeLittleEndian); }
export function setInt32(pointer: bigint, offset: number, value: number): void { pointerView(pointer, offset, 4).setInt32(0, value, nativeLittleEndian); }
export function setUint32(pointer: bigint, offset: number, value: number): void { pointerView(pointer, offset, 4).setUint32(0, value, nativeLittleEndian); }
export function setInt64(pointer: bigint, offset: number, value: number | bigint): void { pointerView(pointer, offset, 8).setBigInt64(0, BigInt(value), nativeLittleEndian); }
export function setUint64(pointer: bigint, offset: number, value: number | bigint): void { pointerView(pointer, offset, 8).setBigUint64(0, BigInt(value), nativeLittleEndian); }
export function setFloat32(pointer: bigint, offset: number, value: number): void { pointerView(pointer, offset, 4).setFloat32(0, value, nativeLittleEndian); }
export function setFloat64(pointer: bigint, offset: number, value: number): void { pointerView(pointer, offset, 8).setFloat64(0, value, nativeLittleEndian); }

export function toString(pointer: bigint): string | null {
    if (pointer === 0n) return null;
    const native = pointerFromAddress(pointer);
    if (native === null) throw new TypeError('cannot read a null pointer');
    return ffi.unsafe.readCString(native);
}

function memoryView(pointer: bigint, length: number): Uint8Array {
    if (typeof pointer !== 'bigint') invalidArg('pointer', 'must be a bigint');
    if (!Number.isSafeInteger(length) || length < 0) {
        const error = new RangeError('The "length" argument must be a non-negative safe integer');
        (error as RangeError & { code?: string }).code = 'ERR_OUT_OF_RANGE';
        throw error;
    }
    const nativePointer = pointerFromAddress(pointer);
    if (nativePointer === null) {
        if (length === 0) return new Uint8Array(0);
        throw new RangeError('Cannot access memory through a null pointer');
    }
    return ffi.unsafe.view(nativePointer, length);
}

export function toBuffer(pointer: bigint, length: number, copy = true): Buffer {
    const view = memoryView(pointer, length);
    return copy
        ? Buffer.from(view)
        : Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
}

export function toArrayBuffer(pointer: bigint, length: number, copy = true): ArrayBuffer {
    const view = memoryView(pointer, length);
    if (!copy) {
        if (view.byteOffset !== 0 || view.byteLength !== view.buffer.byteLength) {
            throw new Error('The native binding cannot expose this pointer range as a zero-copy ArrayBuffer');
        }
        return view.buffer as ArrayBuffer;
    }
    const result = new Uint8Array(length);
    result.set(view);
    return result.buffer;
}

function copyToNative(source: Uint8Array, pointer: bigint, length: number): void {
    if (!Number.isSafeInteger(length) || length < source.byteLength) {
        const error = new RangeError('The "length" argument is smaller than the source data');
        (error as RangeError & { code?: string }).code = 'ERR_OUT_OF_RANGE';
        throw error;
    }
    memoryView(pointer, length).set(source);
}

export function exportString(value: string, pointer: bigint, length: number, encoding: BufferEncoding = 'utf8'): void {
    if (typeof value !== 'string') invalidArg('string', 'must be a string');
    if (typeof encoding !== 'string') invalidArg('encoding', 'must be a string');
    const data = Buffer.from(value, encoding);
    const terminator = encoding === 'utf16le' || encoding === 'utf-16le' || encoding === 'ucs2' || encoding === 'ucs-2'
        ? 2
        : 1;
    const output = new Uint8Array(data.byteLength + terminator);
    output.set(data);
    copyToNative(output, pointer, length);
}

export function exportBuffer(buffer: Buffer, pointer: bigint, length: number): void {
    if (!Buffer.isBuffer(buffer)) invalidArg('buffer', 'must be a Buffer');
    copyToNative(buffer, pointer, length);
}

export function exportArrayBuffer(arrayBuffer: ArrayBuffer, pointer: bigint, length: number): void {
    if (!(arrayBuffer instanceof ArrayBuffer)) invalidArg('arrayBuffer', 'must be an ArrayBuffer');
    copyToNative(new Uint8Array(arrayBuffer), pointer, length);
}

export function exportArrayBufferView(arrayBufferView: ArrayBufferView<ArrayBufferLike>, pointer: bigint, length: number): void {
    if (!ArrayBuffer.isView(arrayBufferView)) invalidArg('arrayBufferView', 'must be an ArrayBufferView');
    copyToNative(viewBytes(arrayBufferView), pointer, length);
}

export function getRawPointer(source: ArrayBuffer | ArrayBufferView<ArrayBufferLike>): bigint {
    if (!(source instanceof ArrayBuffer) && !ArrayBuffer.isView(source)) {
        invalidArg('source', 'must be an ArrayBuffer or ArrayBufferView');
    }
    return pointerAddress(ffi.unsafe.pointerOf(source));
}

export function getCurrentEventLoop(): bigint {
    return pointerAddress(ffi.unsafe.currentEventLoop());
}
