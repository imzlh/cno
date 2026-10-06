/**
 * Deno FFI Utils
 * Type utils for Foreign Function Interface
 */

export const brand = Symbol('brand');

const ffi = import.meta.use('ffi');
const ffiTypeNames = {
    u8: 'type_uint8', i8: 'type_sint8',
    u16: 'type_uint16', i16: 'type_sint16',
    u32: 'type_uint32', i32: 'type_sint32',
    u64: 'type_uint64', i64: 'type_sint64',
    f32: 'type_float', f64: 'type_double',
    bool: 'type_uint8', pointer: 'type_pointer',
    buffer: 'type_pointer', function: 'type_pointer',
    usize: 'type_size', isize: 'type_ssize',
} as const satisfies Record<Extract<Deno.NativeType, string>, keyof typeof ffi>;

function toFfiType(type: Deno.NativeResultType): CModuleFFI.FfiType {
    if (type === 'void') return ffi.type_void;
    if (typeof type !== 'string' && 'struct' in type) {
        return new ffi.FfiType(...type.struct.map(toFfiType));
    }
    const name = ffiTypeNames[type];
    if (!name) throw new TypeError(`Unknown type: ${type}`);
    return ffi[name];
}

function typeCacheKey(type: Deno.NativeResultType): string {
    return typeof type === 'string'
        ? type
        : `struct(${type.struct.map(typeCacheKey).join(',')})`;
}

export function cachedCif(
    cache: Map<string, CModuleFFI.FfiCif>,
    parameters: readonly Deno.NativeType[],
    result: Deno.NativeResultType,
): CModuleFFI.FfiCif {
    const key = `${typeCacheKey(result)}(${parameters.map(typeCacheKey).join(',')})`;
    let cif = cache.get(key);
    if (!cif) {
        cif = new ffi.FfiCif(toFfiType(result), ...parameters.map(toFfiType));
        cache.set(key, cif);
    }
    return cif;
}

const TYPE_SIZES: Record<string, number> = {
    'u8': 1, 'i8': 1,
    'u16': 2, 'i16': 2,
    'u32': 4, 'i32': 4,
    'u64': 8, 'i64': 8,
    'f32': 4, 'f64': 8,
    'bool': 1,
    'pointer': 8,
    'usize': 8, 'isize': 8,
};

export function getTypeSize(type: Deno.NativeType): number {
    if (typeof type === 'string') {
        return TYPE_SIZES[type] ?? 8;
    }
    if (typeof type === 'object' && 'struct' in type) {
        let size = 0;
        for (const member of type.struct) {
            size += getTypeSize(member);
        }
        return size;
    }
    return 8;
}

export function isNativeNumberType(type: Deno.NativeType): type is Deno.NativeNumberType {
    return typeof type === 'string' && [
        'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
        'f32', 'f64', 'usize', 'isize'
    ].includes(type);
}

export function isNativeBigIntType(type: Deno.NativeType): type is Deno.NativeBigIntType {
    return type === 'u64' || type === 'i64';
}

export function isNativeBooleanType(type: Deno.NativeType): type is Deno.NativeBooleanType {
    return type === 'bool';
}

export function isNativePointerType(type: Deno.NativeType): type is Deno.NativePointerType {
    return type === 'pointer';
}

export function isNativeVoidType(type: Deno.NativeResultType): type is Deno.NativeVoidType {
    return type === 'void';
}

export function isNativeStructType(type: Deno.NativeType): type is Deno.NativeStructType {
    return typeof type === 'object' && 'struct' in type;
}

export function isForeignFunction(sym: Deno.ForeignFunction | Deno.ForeignStatic): sym is Deno.ForeignFunction {
    return 'parameters' in sym;
}

export function isForeignStatic(sym: Deno.ForeignFunction | Deno.ForeignStatic): sym is Deno.ForeignStatic {
    return 'type' in sym;
}
