/**
 * Deno FFI Types
 * Type definitions for Foreign Function Interface
 */

export const brand = Symbol('brand');

export type NativeNumberType =
    | 'u8' | 'i8'
    | 'u16' | 'i16'
    | 'u32' | 'i32'
    | 'f32' | 'f64'
    | 'usize' | 'isize';

export type NativeBigIntType = 'u64' | 'i64';

export type NativeBooleanType = 'bool';

export type NativePointerType = 'pointer';

export type NativeBufferType = 'buffer';

export type NativeVoidType = 'void';

export type NativeFunctionType = 'function';

export interface NativeStructType {
    struct: NativeType[];
}

export type NativeType =
    | NativeNumberType
    | NativeBigIntType
    | NativeBooleanType
    | NativePointerType
    | NativeBufferType
    | NativeFunctionType
    | NativeStructType;

export type NativeResultType = NativeType | NativeVoidType;

export interface PointerObject<T = unknown> {
    [brand]: T;
}

export type PointerValue<T = unknown> = null | PointerObject<T>;

export interface ForeignFunction<
    Parameters extends readonly NativeType[] = readonly NativeType[],
    Result extends NativeResultType = NativeResultType,
    NonBlocking extends boolean = boolean,
> {
    name?: string;
    parameters: Parameters;
    result: Result;
    nonblocking?: NonBlocking;
    optional?: boolean;
}

export interface ForeignStatic<Type extends NativeType = NativeType> {
    name?: string;
    type: Type;
    optional?: boolean;
}

export interface ForeignLibraryInterface {
    [name: string]: ForeignFunction | ForeignStatic;
}

export interface UnsafeCallbackDefinition<
    Parameters extends readonly NativeType[] = readonly NativeType[],
    Result extends NativeResultType = NativeResultType,
> {
    parameters: Parameters;
    result: Result;
}

export type ToNativeType<T extends NativeType = NativeType> =
    T extends NativeStructType ? BufferSource :
    T extends NativeNumberType ? number :
    T extends NativeBigIntType ? bigint :
    T extends NativeBooleanType ? boolean :
    T extends NativePointerType ? PointerValue :
    T extends NativeBufferType ? BufferSource | null :
    T extends NativeFunctionType ? PointerValue :
    never;

export type ToNativeResultType<T extends NativeResultType = NativeResultType> =
    T extends NativeVoidType ? void :
    T extends NativeType ? ToNativeType<T> :
    void;

export type FromNativeType<T extends NativeType = NativeType> =
    T extends NativeStructType ? Uint8Array :
    T extends NativeNumberType ? number :
    T extends NativeBigIntType ? bigint :
    T extends NativeBooleanType ? boolean :
    T extends NativePointerType ? PointerValue :
    T extends NativeBufferType ? PointerValue :
    T extends NativeFunctionType ? PointerValue :
    never;

export type FromNativeResultType<T extends NativeResultType = NativeResultType> =
    T extends NativeVoidType ? void :
    T extends NativeType ? FromNativeType<T> :
    void;

export type ToNativeParameterTypes<T extends readonly NativeType[]> =
    T extends readonly [...NativeType[]] ? {
        [K in keyof T]: ToNativeType<T[K]>;
    } : ToNativeType<T[number]>[];

export type FromNativeParameterTypes<T extends readonly NativeType[]> =
    T extends readonly [...NativeType[]] ? {
        [K in keyof T]: FromNativeType<T[K]>;
    } : FromNativeType<T[number]>[];

export type UnsafeCallbackFunction<
    Parameters extends readonly NativeType[] = readonly NativeType[],
    Result extends NativeResultType = NativeResultType,
> = Parameters extends readonly [] ? () => ToNativeResultType<Result>
    : (...args: FromNativeParameterTypes<Parameters>) => ToNativeResultType<Result>;

export type FromForeignFunction<T extends ForeignFunction> =
    T['parameters'] extends readonly [] ? () => StaticForeignSymbolReturnType<T>
    : (...args: ToNativeParameterTypes<T['parameters']>) => StaticForeignSymbolReturnType<T>;

export type StaticForeignSymbolReturnType<T extends ForeignFunction> =
    T['nonblocking'] extends true ? Promise<FromNativeResultType<T['result']>>
    : FromNativeResultType<T['result']>;

export type StaticForeignSymbol<T extends ForeignFunction | ForeignStatic> =
    T extends ForeignFunction ? FromForeignFunction<T>
    : T extends ForeignStatic ? FromNativeType<T['type']>
    : never;

export type StaticForeignLibraryInterface<T extends ForeignLibraryInterface> = {
    [K in keyof T]: T[K]['optional'] extends true
    ? StaticForeignSymbol<T[K]> | null
    : StaticForeignSymbol<T[K]>;
};

export interface DynamicLibrary<S extends ForeignLibraryInterface> {
    symbols: StaticForeignLibraryInterface<S>;
    close(): void;
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

export function getTypeSize(type: NativeType): number {
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

export function isNativeNumberType(type: NativeType): type is NativeNumberType {
    return typeof type === 'string' && [
        'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
        'f32', 'f64', 'usize', 'isize'
    ].includes(type);
}

export function isNativeBigIntType(type: NativeType): type is NativeBigIntType {
    return type === 'u64' || type === 'i64';
}

export function isNativeBooleanType(type: NativeType): type is NativeBooleanType {
    return type === 'bool';
}

export function isNativePointerType(type: NativeType): type is NativePointerType {
    return type === 'pointer';
}

export function isNativeVoidType(type: NativeResultType): type is NativeVoidType {
    return type === 'void';
}

export function isNativeStructType(type: NativeType): type is NativeStructType {
    return typeof type === 'object' && 'struct' in type;
}

export function isForeignFunction(sym: ForeignFunction | ForeignStatic): sym is ForeignFunction {
    return 'parameters' in sym;
}

export function isForeignStatic(sym: ForeignFunction | ForeignStatic): sym is ForeignStatic {
    return 'type' in sym;
}
