/**
 * Deno FFI Utils
 * Type utils for Foreign Function Interface
 */

export const brand = Symbol('brand');

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
