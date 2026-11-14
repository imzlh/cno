/**
 * Shared Deno-to-native FFI type and value conversion.
 */

import { viewBytes } from '../../utils/bytes';

export const brand = Symbol('Deno.PointerObject.nativePointer');

const ffi = import.meta.use('ffi');

type NativeStructType = Extract<Deno.NativeType, { readonly struct: readonly Deno.NativeType[] }>;
export type DenoBufferSource = ArrayBufferLike | ArrayBufferView;
type FfiCallValue = number | bigint | boolean | CModuleFFI.Pointer | CModuleFFI.BufferSource | Uint8Array | null;

const ffiTypeNames = {
    u8: 'u8',
    i8: 'i8',
    u16: 'u16',
    i16: 'i16',
    u32: 'u32',
    i32: 'i32',
    u64: 'u64',
    i64: 'i64',
    f32: 'f32',
    f64: 'f64',
    bool: 'bool',
    pointer: 'pointer',
    function: 'function',
    usize: 'usize',
    isize: 'isize',
} as const satisfies Record<Exclude<Extract<Deno.NativeType, string>, 'buffer'>, keyof CModuleFFI.Types>;

const structTypes = new WeakMap<object, CModuleFFI.StructType>();

function primitiveType(type: Exclude<Extract<Deno.NativeType, string>, 'buffer'>): CModuleFFI.FieldType {
    const name = ffiTypeNames[type];
    if (!name) throw new TypeError(`Unknown native type: ${String(type)}`);
    return ffi.types[name] as CModuleFFI.FieldType;
}

function structType(type: NativeStructType): CModuleFFI.StructType {
    const cached = structTypes.get(type);
    if (cached) return cached;

    const result = ffi.types.struct(type.struct.map(toFfiFieldType));
    structTypes.set(type, result);
    return result;
}

/** Convert a Deno type used inside an aggregate to its ABI type. */
export function toFfiFieldType(type: Deno.NativeType): CModuleFFI.FieldType {
    if (typeof type !== 'string') return structType(type as NativeStructType);
    // Deno models buffer fields as pointer-sized values. Native `buffer` is an
    // input calling convention and therefore cannot be an aggregate field.
    if (type === 'buffer') return ffi.types.pointer;
    return primitiveType(type);
}

/** Convert a Deno function parameter type. */
export function toFfiArgumentType(type: Deno.NativeType): CModuleFFI.ArgumentType {
    if (type === 'buffer') return ffi.types.buffer;
    return toFfiFieldType(type) as CModuleFFI.ArgumentType;
}

/** Convert a Deno result/static type. Deno `buffer` results are pointers. */
export function toFfiResultType(type: Deno.NativeResultType): CModuleFFI.ResultType {
    if (type === 'void') return ffi.types.void;
    if (type === 'buffer') return ffi.types.pointer;
    return toFfiFieldType(type) as CModuleFFI.ResultType;
}

export function toFfiReadableType(type: Deno.NativeType): CModuleFFI.ReadableType {
    if (type === 'buffer') return ffi.types.pointer;
    return toFfiFieldType(type);
}

export function toFfiFunctionSignature(
    parameters: readonly Deno.NativeType[],
    result: Deno.NativeResultType,
): CModuleFFI.FunctionSignature {
    return [toFfiResultType(result), ...parameters.map(toFfiArgumentType)];
}

export function toFfiLibrarySignature(
    symbol: string,
    parameters: readonly Deno.NativeType[],
    result: Deno.NativeResultType,
): CModuleFFI.LibrarySignature {
    return [toFfiResultType(result), symbol, ...parameters.map(toFfiArgumentType)];
}

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
    return value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);
}

export function isBufferSource(value: unknown): value is DenoBufferSource {
    return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}

export function bufferSourceBytes(value: DenoBufferSource): Uint8Array {
    return viewBytes(value);
}

/** Extract the native pointer hidden inside a Deno opaque pointer. */
export function getNativePointer(value: Deno.PointerValue): CModuleFFI.Pointer | null {
    if (value === null) return null;
    if (typeof value !== 'object') throw new TypeError('Invalid Deno.PointerObject');
    const pointer = Reflect.get(value, brand) as CModuleFFI.Pointer | undefined;
    if (!pointer) throw new TypeError('Invalid Deno.PointerObject');
    return pointer;
}

function pointerFromCarrier(value: unknown): CModuleFFI.Pointer | null {
    if (value === null) return null;
    if (value !== null && typeof value === 'object' && Reflect.get(value, 'pointer') !== undefined) {
        return getNativePointer(Reflect.get(value, 'pointer') as Deno.PointerValue);
    }
    return getNativePointer(value as Deno.PointerValue);
}

/** Convert one Deno call argument without allocating scalar byte buffers. */
export function toFfiArgument(value: unknown, type: Deno.NativeType): FfiCallValue {
    if (typeof type !== 'string') {
        if (!isBufferSource(value)) throw new TypeError('A struct argument must be a BufferSource');
        return bufferSourceBytes(value);
    }

    switch (type) {
        case 'pointer':
        case 'function':
            return pointerFromCarrier(value);
        case 'buffer':
            if (value === null) return null;
            if (!isBufferSource(value)) throw new TypeError('A buffer argument must be a BufferSource or null');
            // A byte view preserves the caller's byteOffset without copying.
            return bufferSourceBytes(value) as CModuleFFI.BufferSource;
        default:
            return value as number | bigint | boolean;
    }
}

/** Convert a Deno callback result to the value expected by the native API. */
export function toFfiCallbackResult(value: unknown, type: Deno.NativeResultType): FfiCallValue | void {
    if (type === 'void') return undefined;
    if (typeof type !== 'string') {
        if (!isBufferSource(value)) throw new TypeError('A struct callback result must be a BufferSource');
        return bufferSourceBytes(value);
    }

    switch (type) {
        case 'pointer':
        case 'function':
            return pointerFromCarrier(value);
        case 'buffer': {
            if (value === null) return null;
            if (!isBufferSource(value)) throw new TypeError('A buffer callback result must be a BufferSource or null');
            return ffi.unsafe.pointerOf(bufferSourceBytes(value) as CModuleFFI.BufferSource);
        }
        default:
            return value as number | bigint | boolean;
    }
}

/** Convert a native return/callback argument back into Deno's public shape. */
export function fromFfiValue(
    value: unknown,
    type: Deno.NativeResultType,
    wrapPointer: (pointer: CModuleFFI.Pointer) => Deno.PointerObject,
): unknown {
    if (type === 'void') return undefined;
    if (typeof type !== 'string') {
        if (!(value instanceof Uint8Array)) throw new TypeError('Native struct value is not a Uint8Array');
        // Aggregate results returned by native FFI already own their exact-size
        // ArrayBuffer. Passing it through avoids a redundant second copy.
        return value;
    }

    switch (type) {
        case 'pointer':
        case 'buffer':
        case 'function':
            return value === null ? null : wrapPointer(value as CModuleFFI.Pointer);
        default:
            return value;
    }
}

export function isForeignFunction(
    sym: Deno.ForeignFunction | Deno.ForeignStatic,
): sym is Deno.ForeignFunction {
    return 'parameters' in sym;
}

export function isForeignStatic(
    sym: Deno.ForeignFunction | Deno.ForeignStatic,
): sym is Deno.ForeignStatic {
    return 'type' in sym;
}
