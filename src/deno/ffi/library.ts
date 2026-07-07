/**
 * Deno FFI Library Implementation
 * DynamicLibrary and dlopen function
 */
const ffi = import.meta.use('ffi');

import {
    ForeignFunction,
    ForeignStatic,
    ForeignLibraryInterface,
    DynamicLibrary,
    StaticForeignLibraryInterface,
    NativeType,
    NativeResultType,
    PointerValue,
    getTypeSize,
    isForeignFunction,
    isForeignStatic,
} from './types';
import { UnsafePointer, bufferSourceBytes, createPointerObject } from './pointer';

const nativeTypes = new Set([
    'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64',
    'f32', 'f64', 'bool', 'pointer', 'buffer', 'function', 'usize', 'isize',
]);

function validateNativeType(type: unknown, allowVoid: boolean): void {
    if (type === 'void') {
        if (allowVoid) return;
        throw new TypeError('Invalid native type: void');
    }
    if (typeof type === 'string') {
        if (!nativeTypes.has(type)) throw new TypeError(`Invalid native type: ${type}`);
        return;
    }
    if (type && typeof type === 'object' && 'struct' in type) {
        const members = Reflect.get(type, 'struct');
        if (!Array.isArray(members)) throw new TypeError('Invalid native struct type');
        for (const member of members) validateNativeType(member, false);
        return;
    }
    throw new TypeError(`Invalid native type: ${String(type)}`);
}

function validateForeignLibraryInterface(symbols: unknown): asserts symbols is ForeignLibraryInterface {
    if (symbols === null || typeof symbols !== 'object') {
        throw new TypeError('DynamicLibrary symbols must be an object');
    }
    for (const sym of Object.values(symbols)) {
        if (sym === null || typeof sym !== 'object') {
            throw new TypeError('ForeignFunction or ForeignStatic must be an object');
        }
        if ('parameters' in sym) {
            const parameters = Reflect.get(sym, 'parameters');
            if (!Array.isArray(parameters)) throw new TypeError('ForeignFunction parameters must be an array');
            for (const type of parameters) validateNativeType(type, false);
            validateNativeType(Reflect.get(sym, 'result'), true);
            continue;
        }
        if ('type' in sym) {
            validateNativeType(Reflect.get(sym, 'type'), false);
            continue;
        }
        throw new TypeError('Invalid foreign symbol definition');
    }
}

function toNumberArg(value: unknown): number {
    return Number(value);
}

function toBigIntArg(value: unknown): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return BigInt(value);
    return BigInt(Number(value));
}

class DynamicLibraryImpl<S extends ForeignLibraryInterface> implements DynamicLibrary<S> {
    private lib: CModuleFFI.UvLib;
    private _symbols: StaticForeignLibraryInterface<S>;
    private closed = false;
    private cifCache = new Map<string, CModuleFFI.FfiCif>();

    get symbols(): StaticForeignLibraryInterface<S> {
        return this._symbols;
    }

    constructor(filename: string | URL, symbolsDef: S) {
        const path = typeof filename === 'string' ? filename : filename.pathname;
        const native = ffi;
        this.lib = new native.UvLib(path);
        this._symbols = this.createSymbols(symbolsDef);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.cifCache.clear();
    }

    private createSymbols(def: S): StaticForeignLibraryInterface<S> {
        const result: Partial<Record<keyof S, unknown>> = {};
        
        for (const [name, sym] of Object.entries(def)) {
            const symbolName = sym.name ?? name;
            const key = name as keyof S;
            
            try {
                const symPtr = this.lib.symbol(symbolName);
                
                if (isForeignFunction(sym)) {
                    result[key] = this.createFunction(symPtr, sym);
                } else if (isForeignStatic(sym)) {
                    result[key] = this.createStatic(symPtr, sym);
                }
            } catch (err) {
                if (sym.optional) {
                    result[key] = null;
                } else {
                    throw err;
                }
            }
        }
        
        return result as StaticForeignLibraryInterface<S>;
    }

    private createFunction(symPtr: CModuleFFI.UvDlSym, def: ForeignFunction): (...args: unknown[]) => unknown {
        const cif = this.createCif(def.parameters, def.result);
        
        const fn = (...args: unknown[]): unknown => {
            if (this.closed) {
                throw new Error('Library is closed');
            }
            
            const ffiArgs = args.map((arg, i) => {
                const type = def.parameters[i];
                return this.toFfiArg(arg, type);
            });
            
            const result = cif.call(symPtr, ...ffiArgs);
            
            if (def.nonblocking) {
                return Promise.resolve(this.fromFfiResult(result, def.result));
            }
            return this.fromFfiResult(result, def.result);
        };
        
        return fn;
    }

    private createStatic(symPtr: CModuleFFI.UvDlSym, def: ForeignStatic): unknown {
        const native = ffi;
        const size = getTypeSize(def.type);
        const buf = native.ptrToBuffer(symPtr.addr, size);
        return this.fromFfiResult(buf, def.type);
    }

    private createCif(
        parameters: readonly NativeType[],
        result: NativeResultType
    ): CModuleFFI.FfiCif {
        const cacheKey = `${this.typeCacheKey(result)}(${parameters.map(p => this.typeCacheKey(p)).join(',')})`;
        let cif = this.cifCache.get(cacheKey);
        if (!cif) {
            const retType = this.toFfiType(result);
            const argTypes = parameters.map(p => this.toFfiType(p));
            cif = new ffi.FfiCif(retType, ...argTypes);
            this.cifCache.set(cacheKey, cif);
        }
        return cif;
    }

    private typeCacheKey(type: NativeType | 'void'): string {
        return typeof type === 'string'
            ? type
            : `struct(${type.struct.map(member => this.typeCacheKey(member)).join(',')})`;
    }

    private toFfiType(
        type: NativeType | 'void'
    ): CModuleFFI.FfiType {
        if (type === 'void') return ffi.type_void;
        if (typeof type !== 'string') {
            if ('struct' in type) {
                const memberTypes = type.struct.map(t => this.toFfiType(t));
                return new ffi.FfiType(...memberTypes);
            }
        }
        
        const typeMap: Record<Extract<NativeType, string>, keyof typeof ffi> = {
            'u8': 'type_uint8',
            'i8': 'type_sint8',
            'u16': 'type_uint16',
            'i16': 'type_sint16',
            'u32': 'type_uint32',
            'i32': 'type_sint32',
            'u64': 'type_uint64',
            'i64': 'type_sint64',
            'f32': 'type_float',
            'f64': 'type_double',
            'bool': 'type_uint8',
            'pointer': 'type_pointer',
            'buffer': 'type_pointer',
            'function': 'type_pointer',
            'usize': 'type_size',
            'isize': 'type_ssize',
        };
        
        const propName = typeMap[type];
        if (!propName) {
            throw new TypeError(`Unknown type: ${type}`);
        }
        
        return ffi[propName] as CModuleFFI.FfiType;
    }

    private toFfiArg(
        value: unknown,
        type: NativeType
    ): Uint8Array | bigint {
        if (typeof type === 'string') {
            switch (type) {
                case 'u8':
                case 'i8': {
                    const buf = new Uint8Array(1);
                    const num = toNumberArg(value);
                    buf[0] = num;
                    return buf;
                }
                case 'u16':
                case 'i16': {
                    const buf = new ArrayBuffer(2);
                    const num = toNumberArg(value);
                    new DataView(buf).setUint16(0, num, true);
                    return new Uint8Array(buf);
                }
                case 'u32':
                case 'i32': {
                    const buf = new ArrayBuffer(4);
                    const num = toNumberArg(value);
                    new DataView(buf).setUint32(0, num, true);
                    return new Uint8Array(buf);
                }
                case 'u64':
                case 'i64':
                case 'usize':
                case 'isize': {
                    const buf = new ArrayBuffer(8);
                    const num = toBigIntArg(value);
                    new DataView(buf).setBigUint64(0, num, true);
                    return new Uint8Array(buf);
                }
                case 'f32': {
                    const buf = new ArrayBuffer(4);
                    const num = toNumberArg(value);
                    new DataView(buf).setFloat32(0, num, true);
                    return new Uint8Array(buf);
                }
                case 'f64': {
                    const buf = new ArrayBuffer(8);
                    const num = toNumberArg(value);
                    new DataView(buf).setFloat64(0, num, true);
                    return new Uint8Array(buf);
                }
                case 'bool': {
                    const buf = new Uint8Array(1);
                    buf[0] = value ? 1 : 0;
                    return buf;
                }
                case 'pointer':
                case 'buffer':
                case 'function': {
                    if (value === null) return 0n;
                    if (typeof value === 'object' && 'pointer' in value) {
                        return UnsafePointer.value(value.pointer as PointerValue);
                    }
                    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                        const buf = bufferSourceBytes(value);
                        return ffi.getArrayBufPtr(buf);
                    }
                    return UnsafePointer.value(value as PointerValue);
                }
            }
        }
        
        if (typeof type === 'object' && 'struct' in type) {
            if (value instanceof Uint8Array) return value;
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return bufferSourceBytes(value);
        }
        
        return new Uint8Array(0);
    }

    private fromFfiResult(buf: Uint8Array, type: NativeResultType): unknown {
        if (type === 'void') return undefined;
        
        if (typeof type === 'string') {
            switch (type) {
                case 'u8': return buf[0];
                case 'i8': return buf[0] > 127 ? buf[0] - 256 : buf[0];
                case 'u16': return new DataView(buf.buffer, buf.byteOffset).getUint16(0, true);
                case 'i16': return new DataView(buf.buffer, buf.byteOffset).getInt16(0, true);
                case 'u32': return new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
                case 'i32': return new DataView(buf.buffer, buf.byteOffset).getInt32(0, true);
                case 'u64': return new DataView(buf.buffer, buf.byteOffset).getBigUint64(0, true);
                case 'i64': return new DataView(buf.buffer, buf.byteOffset).getBigInt64(0, true);
                case 'f32': return new DataView(buf.buffer, buf.byteOffset).getFloat32(0, true);
                case 'f64': return new DataView(buf.buffer, buf.byteOffset).getFloat64(0, true);
                case 'bool': return buf[0] !== 0;
                case 'pointer':
                case 'buffer':
                case 'function': {
                    const addr = new DataView(buf.buffer, buf.byteOffset).getBigUint64(0, true);
                    return addr === 0n ? null : createPointerObject(addr);
                }
                case 'usize': return new DataView(buf.buffer, buf.byteOffset).getBigUint64(0, true);
                case 'isize': return new DataView(buf.buffer, buf.byteOffset).getBigInt64(0, true);
            }
        }
        
        if (typeof type === 'object' && 'struct' in type) {
            return buf.slice();
        }
        
        return undefined;
    }
}

export function dlopen<const S extends ForeignLibraryInterface>(
    filename: string | URL,
    symbols: S,
): DynamicLibrary<S> {
    validateForeignLibraryInterface(symbols);
    return new DynamicLibraryImpl(filename, symbols);
}

export { DynamicLibraryImpl };
