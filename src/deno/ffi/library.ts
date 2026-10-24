const ffi = import.meta.use('ffi');

import { UnsafePointer, bufferSourceBytes, createPointerObject } from './pointer';
import { cachedCif, getTypeSize, isForeignFunction, isForeignStatic } from './utils';
import { toFsPath } from '../../utils/path';

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

function validateForeignLibraryInterface(symbols: unknown): asserts symbols is Deno.ForeignLibraryInterface {
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

class DynamicLibrary<S extends Deno.ForeignLibraryInterface> implements Deno.DynamicLibrary<S> {
    private lib: CModuleFFI.UvLib;
    private _symbols: Deno.StaticForeignLibraryInterface<S>;
    private closed = false;
    private cifCache = new Map<string, CModuleFFI.FfiCif>();

    get symbols(): Deno.StaticForeignLibraryInterface<S> {
        return this._symbols;
    }

    constructor(filename: string | URL, symbolsDef: S) {
        const path = toFsPath(filename);
        const native = ffi;
        this.lib = new native.UvLib(path);
        try {
            this._symbols = this.createSymbols(symbolsDef);
        } catch (error) {
            this.lib.close();
            throw error;
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.lib.close();
        this.cifCache.clear();
    }

    private createSymbols(def: S): Deno.StaticForeignLibraryInterface<S> {
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
        
        return result as Deno.StaticForeignLibraryInterface<S>;
    }

    private createFunction(symPtr: CModuleFFI.UvDlSym, def: Deno.ForeignFunction): (...args: unknown[]) => unknown {
        const cif = cachedCif(this.cifCache, def.parameters, def.result);
        
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

    private createStatic(symPtr: CModuleFFI.UvDlSym, def: Deno.ForeignStatic): unknown {
        const native = ffi;
        const size = getTypeSize(def.type);
        const buf = native.ptrToBuffer(symPtr.addr, size);
        return this.fromFfiResult(buf, def.type);
    }

    private toFfiArg(
        value: unknown,
        type: Deno.NativeType
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
                case 'usize': {
                    const buf = new ArrayBuffer(8);
                    const num = toBigIntArg(value);
                    new DataView(buf).setBigUint64(0, num, true);
                    return new Uint8Array(buf);
                }
                case 'i64':
                case 'isize': {
                    const buf = new ArrayBuffer(8);
                    const num = toBigIntArg(value);
                    new DataView(buf).setBigInt64(0, num, true);
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
                        return UnsafePointer.value(value.pointer as Deno.PointerValue);
                    }
                    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                        const buf = bufferSourceBytes(value);
                        return ffi.getArrayBufPtr(buf);
                    }
                    return UnsafePointer.value(value as Deno.PointerValue);
                }
            }
        }
        
        if (typeof type === 'object' && 'struct' in type) {
            if (value instanceof Uint8Array) return value;
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return bufferSourceBytes(value);
        }
        
        return new Uint8Array(0);
    }

    private fromFfiResult(buf: Uint8Array, type: Deno.NativeResultType): unknown {
        if (type === 'void') return undefined;
        
        if (typeof type === 'string') {
            const view = new DataView(buf.buffer, buf.byteOffset);
            switch (type) {
                case 'u8': return buf[0];
                case 'i8': return buf[0] > 127 ? buf[0] - 256 : buf[0];
                case 'u16': return view.getUint16(0, true);
                case 'i16': return view.getInt16(0, true);
                case 'u32': return view.getUint32(0, true);
                case 'i32': return view.getInt32(0, true);
                case 'u64': return view.getBigUint64(0, true);
                case 'i64': return view.getBigInt64(0, true);
                case 'f32': return view.getFloat32(0, true);
                case 'f64': return view.getFloat64(0, true);
                case 'bool': return buf[0] !== 0;
                case 'pointer':
                case 'buffer':
                case 'function': {
                    const addr = view.getBigUint64(0, true);
                    return addr === 0n ? null : createPointerObject(addr);
                }
                case 'usize': return view.getBigUint64(0, true);
                case 'isize': return view.getBigInt64(0, true);
            }
        }
        
        if (typeof type === 'object' && 'struct' in type) {
            return buf.slice();
        }
        
        return undefined;
    }
}

export function dlopen<const S extends Deno.ForeignLibraryInterface>(
    filename: string | URL,
    symbols: S,
): Deno.DynamicLibrary<S> {
    validateForeignLibraryInterface(symbols);
    return new DynamicLibrary(filename, symbols);
}

export { DynamicLibrary };
