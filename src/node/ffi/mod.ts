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
    closure: CModuleFFI.FfiClosure;
    strongCallback?: CallbackFunction;
    weakCallback: WeakRef<CallbackFunction>;
}

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

const nativeTypes: Record<CanonicalType, CModuleFFI.FfiType> = {
    void: ffi.type_void,
    i8: ffi.type_sint8,
    u8: ffi.type_uint8,
    i16: ffi.type_sint16,
    u16: ffi.type_uint16,
    i32: ffi.type_sint32,
    u32: ffi.type_uint32,
    i64: ffi.type_sint64,
    u64: ffi.type_uint64,
    f32: ffi.type_float,
    f64: ffi.type_double,
    pointer: ffi.type_pointer,
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

function encodeScalar(type: CanonicalType, value: unknown, keepalive?: unknown[]): Uint8Array | bigint {
    if (type === 'pointer') {
        if (value === null) return 0n;
        if (typeof value === 'bigint') return value;
        if (typeof value === 'string') {
            const bytes = Buffer.from(`${value}\0`, 'utf8');
            keepalive?.push(bytes);
            return ffi.getArrayBufPtr(bytes);
        }
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const bytes = viewBytes(value);
            keepalive?.push(value, bytes);
            return ffi.getArrayBufPtr(bytes);
        }
        invalidArg('value', 'must be a bigint, string, ArrayBuffer, ArrayBufferView, or null for a pointer');
    }

    const size = nativeTypes[type].size;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (type) {
        case 'void': return bytes;
        case 'i8': view.setInt8(0, Number(value)); break;
        case 'u8': view.setUint8(0, Number(value)); break;
        case 'i16': view.setInt16(0, Number(value), nativeLittleEndian); break;
        case 'u16': view.setUint16(0, Number(value), nativeLittleEndian); break;
        case 'i32': view.setInt32(0, Number(value), nativeLittleEndian); break;
        case 'u32': view.setUint32(0, Number(value), nativeLittleEndian); break;
        case 'i64': view.setBigInt64(0, BigInt(value as bigint | number), nativeLittleEndian); break;
        case 'u64': view.setBigUint64(0, BigInt(value as bigint | number), nativeLittleEndian); break;
        case 'f32': view.setFloat32(0, Number(value), nativeLittleEndian); break;
        case 'f64': view.setFloat64(0, Number(value), nativeLittleEndian); break;
    }
    return bytes;
}

function decodeScalar(type: CanonicalType, bytes: Uint8Array): FfiReturn {
    if (type === 'void') return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (type) {
        case 'i8': return view.getInt8(0);
        case 'u8': return view.getUint8(0);
        case 'i16': return view.getInt16(0, nativeLittleEndian);
        case 'u16': return view.getUint16(0, nativeLittleEndian);
        case 'i32': return view.getInt32(0, nativeLittleEndian);
        case 'u32': return view.getUint32(0, nativeLittleEndian);
        case 'i64': return view.getBigInt64(0, nativeLittleEndian);
        case 'u64': return view.getBigUint64(0, nativeLittleEndian);
        case 'f32': return view.getFloat32(0, nativeLittleEndian);
        case 'f64': return view.getFloat64(0, nativeLittleEndian);
        case 'pointer': return nativeTypes.pointer.size === 4
            ? BigInt(view.getUint32(0, nativeLittleEndian))
            : view.getBigUint64(0, nativeLittleEndian);
    }
}

function encodeCallbackResult(type: CanonicalType, value: unknown): Uint8Array {
    if (type === 'void') return new Uint8Array(0);
    if (type !== 'pointer') return encodeScalar(type, value) as Uint8Array;

    if (typeof value !== 'bigint') {
        invalidArg('callback result', 'must be a bigint for a pointer return type');
    }
    const bytes = new Uint8Array(nativeTypes.pointer.size);
    const view = new DataView(bytes.buffer);
    if (bytes.byteLength === 4) {
        view.setUint32(0, Number(value), nativeLittleEndian);
    } else {
        view.setBigUint64(0, value, nativeLittleEndian);
    }
    return bytes;
}

function assertDefinitions(value: unknown): asserts value is FunctionDefinitions {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        invalidArg('definitions', 'must be an object');
    }
}

export class DynamicLibrary {
    readonly path: string;
    readonly symbols: Record<string, bigint> = Object.create(null);

    #lib: CModuleFFI.UvLib;
    #closed = false;
    #nativeSymbols = new Map<string, CModuleFFI.UvDlSym>();
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
        this.#lib = new ffi.UvLib(path);
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error('Dynamic library is closed');
    }

    #resolve(name: string): CModuleFFI.UvDlSym {
        this.#assertOpen();
        if (typeof name !== 'string') invalidArg('symbol', 'must be a string');
        let symbol = this.#nativeSymbols.get(name);
        if (!symbol) {
            symbol = this.#lib.symbol(name);
            this.#nativeSymbols.set(name, symbol);
            this.symbols[name] = symbol.addr;
        }
        return symbol;
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#functions.clear();
        this.#nativeSymbols.clear();
        this.#callbacks.clear();
        this.#lib.close();
    }

    [Symbol.dispose](): void {
        this.close();
    }

    getSymbol(name: string): bigint {
        return this.#resolve(name).addr;
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

        const symbol = this.#resolve(name);
        const cif = new ffi.FfiCif(
            nativeTypes[normalized.result],
            ...normalized.args.map(type => nativeTypes[type]),
        );
        const library = this;
        const fn = function(this: unknown, ...args: FfiArgument[]): FfiReturn {
            library.#assertOpen();
            if (args.length !== normalized.args.length) {
                throw new RangeError(`Expected ${normalized.args.length} arguments but got ${args.length}`);
            }
            const keepalive: unknown[] = [];
            const nativeArgs = args.map((arg, index) => encodeScalar(normalized.args[index], arg, keepalive));
            try {
                return decodeScalar(normalized.result, cif.call(symbol, ...nativeArgs));
            } finally {
                keepalive.length = 0;
            }
        } as unknown as WrappedFunction;
        Object.defineProperty(fn, 'pointer', {
            value: symbol.addr,
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

        const cif = new ffi.FfiCif(
            nativeTypes[signature.result],
            ...signature.args.map(type => nativeTypes[type]),
        );
        let record!: CallbackRecord;
        const weakCallback = new WeakRef(target);
        const wrapped = (...args: ArrayBuffer[]): Uint8Array => {
            const current = record.strongCallback ?? weakCallback.deref();
            if (!current) return new Uint8Array(nativeTypes[signature.result].size);
            const values = args.map((arg, index) =>
                decodeScalar(signature.args[index], new Uint8Array(arg)) as FfiArgument
            );
            return encodeCallbackResult(signature.result, current(...values));
        };
        const closure = new ffi.FfiClosure(cif, wrapped);
        record = {
            closure,
            strongCallback: target,
            weakCallback,
        };
        this.#callbacks.set(closure.addr, record);
        return closure.addr;
    }

    #getCallback(pointer: bigint): CallbackRecord {
        this.#assertOpen();
        if (typeof pointer !== 'bigint') invalidArg('pointer', 'must be a bigint');
        const record = this.#callbacks.get(pointer);
        if (!record) throw new RangeError('Unknown callback pointer');
        return record;
    }

    unregisterCallback(pointer: bigint): void {
        this.#getCallback(pointer);
        this.#callbacks.delete(pointer);
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
    const bytes = ffi.ptrToBuffer(pointer + BigInt(offset), size);
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
    return ffi.getCString(pointer);
}

function memoryView(pointer: bigint, length: number): Uint8Array {
    if (typeof pointer !== 'bigint') invalidArg('pointer', 'must be a bigint');
    if (!Number.isSafeInteger(length) || length < 0) {
        const error = new RangeError('The "length" argument must be a non-negative safe integer');
        (error as RangeError & { code?: string }).code = 'ERR_OUT_OF_RANGE';
        throw error;
    }
    return ffi.ptrToBuffer(pointer, length);
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
    return ffi.getArrayBufPtr(viewBytes(source));
}

export function getCurrentEventLoop(): bigint {
    return ffi.getCurrentEventLoop();
}
