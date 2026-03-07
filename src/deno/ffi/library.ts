/**
 * Deno FFI Library Implementation
 * DynamicLibrary and dlopen function
 */

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
import { UnsafePointer, createPointerObject } from './pointer';

const { ffi_load_native } = import.meta.use('ffi');
let __ffi_cache: ReturnType<typeof ffi_load_native> | undefined;
const getNative = () => __ffi_cache ?? (__ffi_cache = ffi_load_native());

class DynamicLibraryImpl<S extends ForeignLibraryInterface> implements DynamicLibrary<S> {
    private lib: CModuleFFI.UvLib;
    private _symbols: StaticForeignLibraryInterface<S>;
    private closed = false;

    get symbols(): StaticForeignLibraryInterface<S> {
        return this._symbols;
    }

    constructor(filename: string | URL, symbolsDef: S) {
        const path = typeof filename === 'string' ? filename : filename.pathname;
        const native = getNative();
        this.lib = new native.UvLib(path);
        this._symbols = this.createSymbols(symbolsDef);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
    }

    private createSymbols(def: S): StaticForeignLibraryInterface<S> {
        const result: any = {};
        
        for (const [name, sym] of Object.entries(def)) {
            const symbolName = sym.name ?? name;
            
            try {
                const symPtr = this.lib.symbol(symbolName);
                
                if (isForeignFunction(sym)) {
                    result[name] = this.createFunction(symPtr, sym);
                } else if (isForeignStatic(sym)) {
                    result[name] = this.createStatic(symPtr, sym);
                }
            } catch (err) {
                if (sym.optional) {
                    result[name] = null;
                } else {
                    throw err;
                }
            }
        }
        
        return result;
    }

    private createFunction(symPtr: CModuleFFI.UvDlSym, def: ForeignFunction): Function {
        const native = getNative();
        const cif = this.createCif(native, def.parameters, def.result);
        
        const fn = (...args: any[]): any => {
            if (this.closed) {
                throw new Error('Library is closed');
            }
            
            const ffiArgs = args.map((arg, i) => {
                const type = def.parameters[i];
                return this.toFfiArg(native, arg, type);
            });
            
            const result = cif.call(symPtr, ...ffiArgs);
            
            if (def.nonblocking) {
                return Promise.resolve(this.fromFfiResult(result, def.result));
            }
            return this.fromFfiResult(result, def.result);
        };
        
        return fn;
    }

    private createStatic(symPtr: CModuleFFI.UvDlSym, def: ForeignStatic): any {
        const native = getNative();
        const size = getTypeSize(def.type);
        const buf = native.ptrToBuffer(symPtr.addr, size);
        return this.fromFfiResult(buf, def.type);
    }

    private createCif(
        native: ReturnType<typeof ffi_load_native>,
        parameters: readonly NativeType[],
        result: NativeResultType
    ): CModuleFFI.FfiCif {
        const retType = this.toFfiType(native, result);
        const argTypes = parameters.map(p => this.toFfiType(native, p));
        return new native.FfiCif(retType, ...argTypes);
    }

    private toFfiType(
        native: ReturnType<typeof ffi_load_native>,
        type: NativeType | 'void'
    ): CModuleFFI.FfiType {
        if (type === 'void') return native.type_void;
        if (typeof type !== 'string') {
            if ('struct' in type) {
                const memberTypes = type.struct.map(t => this.toFfiType(native, t));
                return new native.FfiType(...memberTypes);
            }
        }
        
        const typeMap: Record<string, keyof typeof native> = {
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
        
        const propName = typeMap[type as string];
        if (!propName) {
            throw new TypeError(`Unknown type: ${type}`);
        }
        
        return native[propName] as CModuleFFI.FfiType;
    }

    private toFfiArg(
        native: ReturnType<typeof ffi_load_native>,
        value: any,
        type: NativeType
    ): Uint8Array | bigint {
        if (typeof type === 'string') {
            switch (type) {
                case 'u8':
                case 'i8': {
                    const buf = new Uint8Array(1);
                    buf[0] = value;
                    return buf;
                }
                case 'u16':
                case 'i16': {
                    const buf = new ArrayBuffer(2);
                    new DataView(buf).setUint16(0, value, true);
                    return new Uint8Array(buf);
                }
                case 'u32':
                case 'i32': {
                    const buf = new ArrayBuffer(4);
                    new DataView(buf).setUint32(0, value, true);
                    return new Uint8Array(buf);
                }
                case 'u64':
                case 'i64':
                case 'usize':
                case 'isize': {
                    const buf = new ArrayBuffer(8);
                    new DataView(buf).setBigUint64(0, BigInt(value), true);
                    return new Uint8Array(buf);
                }
                case 'f32': {
                    const buf = new ArrayBuffer(4);
                    new DataView(buf).setFloat32(0, value, true);
                    return new Uint8Array(buf);
                }
                case 'f64': {
                    const buf = new ArrayBuffer(8);
                    new DataView(buf).setFloat64(0, value, true);
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
                        return UnsafePointer.value(value.pointer);
                    }
                    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                        let buf: Uint8Array;
                        if (value instanceof ArrayBuffer) {
                            buf = new Uint8Array(value);
                        } else if (value instanceof Uint8Array) {
                            buf = value;
                        } else {
                            buf = new Uint8Array(
                                (value as ArrayBufferView).buffer,
                                (value as ArrayBufferView).byteOffset,
                                (value as ArrayBufferView).byteLength
                            );
                        }
                        return native.getArrayBufPtr(buf);
                    }
                    return UnsafePointer.value(value as PointerValue);
                }
            }
        }
        
        if (typeof type === 'object' && 'struct' in type) {
            if (value instanceof Uint8Array) return value;
            if (ArrayBuffer.isView(value)) {
                return new Uint8Array(
                    (value as ArrayBufferView).buffer,
                    (value as ArrayBufferView).byteOffset,
                    (value as ArrayBufferView).byteLength
                );
            }
        }
        
        return new Uint8Array(0);
    }

    private fromFfiResult(buf: Uint8Array, type: NativeResultType): any {
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
    return new DynamicLibraryImpl(filename, symbols);
}

export { DynamicLibraryImpl };
