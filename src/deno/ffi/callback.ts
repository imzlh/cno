/**
 * Deno FFI Callback Implementation
 * UnsafeCallback class for passing JS functions to C code
 */

import {
    UnsafeCallbackDefinition,
    NativeType,
    NativeResultType,
    PointerObject,
    PointerValue,
    UnsafeCallbackFunction,
    getTypeSize,
} from './types';
import { UnsafePointer, createPointerObject } from './pointer';

const ffi = import.meta.use('ffi');
const console = import.meta.use('console');

interface CallbackInternal {
    closure: CModuleFFI.FfiClosure;
    refCount: number;
    closed: boolean;
    definition: UnsafeCallbackDefinition;
    callback: UnsafeCallbackFunction;
}

const callbackRegistry = new Map<PointerObject, CallbackInternal>();

export class UnsafeCallback<
    const Definition extends UnsafeCallbackDefinition = UnsafeCallbackDefinition,
> {
    readonly pointer: PointerObject<Definition>;
    readonly definition: Definition;
    readonly callback: UnsafeCallbackFunction<
        Definition['parameters'],
        Definition['result']
    >;
    
    private internal: CallbackInternal;
    private static cifCache = new Map<string, CModuleFFI.FfiCif>();

    constructor(
        definition: Definition,
        callback: UnsafeCallbackFunction<
            Definition['parameters'],
            Definition['result']
        >
    ) {
        this.definition = definition;
        this.callback = callback;
        
        const cif = this.createCif(definition.parameters, definition.result);
        const wrappedCallback = this.wrapCallback(callback, definition);
        
        const closure = new ffi.FfiClosure(cif, wrappedCallback);
        this.pointer = createPointerObject(closure.addr);
        
        this.internal = {
            closure,
            refCount: 0,
            closed: false,
            definition,
            callback,
        };
        
        callbackRegistry.set(this.pointer, this.internal);
    }

    static threadSafe<
        Definition extends UnsafeCallbackDefinition = UnsafeCallbackDefinition,
    >(
        definition: Definition,
        callback: UnsafeCallbackFunction<
            Definition['parameters'],
            Definition['result']
        >,
    ): UnsafeCallback<Definition> {
        const cb = new UnsafeCallback(definition, callback);
        cb.ref();
        return cb;
    }

    ref(): number {
        if (this.internal.closed) {
            throw new Error('Callback is closed');
        }
        return ++this.internal.refCount;
    }

    unref(): number {
        if (this.internal.closed) {
            return 0;
        }
        this.internal.refCount = Math.max(0, this.internal.refCount - 1);
        return this.internal.refCount;
    }

    close(): void {
        if (this.internal.closed) return;
        
        this.internal.closed = true;
        this.internal.refCount = 0;
        callbackRegistry.delete(this.pointer);
    }

    private createCif(
        parameters: readonly NativeType[],
        result: NativeResultType
    ): CModuleFFI.FfiCif {
        const cacheKey = `${this.typeCacheKey(result)}(${parameters.map(p => this.typeCacheKey(p)).join(',')})`;
        let cif = UnsafeCallback.cifCache.get(cacheKey);
        if (!cif) {
            const retType = this.toFfiType(result);
            const argTypes = parameters.map(p => this.toFfiType(p));
            cif = new ffi.FfiCif(retType, ...argTypes);
            UnsafeCallback.cifCache.set(cacheKey, cif);
        }
        return cif;
    }

    private typeCacheKey(type: NativeType | 'void'): string {
        return typeof type === 'string'
            ? type
            : `struct(${type.struct.map(member => this.typeCacheKey(member)).join(',')})`;
    }

    private toFfiType(type: NativeType | 'void'): CModuleFFI.FfiType {
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

    private wrapCallback(
        callback: UnsafeCallbackFunction,
        definition: UnsafeCallbackDefinition
    ): (...args: ArrayBuffer[]) => Uint8Array {
        return (...args: ArrayBuffer[]): Uint8Array => {
            try {
                const buffers = args.map(arg => new Uint8Array(arg));
                const convertedArgs = this.convertArgs(buffers, definition.parameters);
                const result = Reflect.apply(callback, null, convertedArgs);
                return this.convertResult(result, definition.result);
            } catch (err) {
                console.error('UnsafeCallback error:', err);
                const size = definition.result === 'void' ? 0 : getTypeSize(definition.result as NativeType);
                return new Uint8Array(size);
            }
        };
    }

    private convertArgs(args: Uint8Array[], parameters: readonly NativeType[]): unknown[] {
        return parameters.map((type, i) => {
            const buf = args[i];
            if (buf === undefined) return null;
            
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
                    case 'usize':
                    case 'isize': return new DataView(buf.buffer, buf.byteOffset).getBigUint64(0, true);
                }
            }
            
            return buf;
        });
    }

    private convertResult(result: unknown, type: NativeResultType): Uint8Array {
        if (type === 'void') return new Uint8Array(0);
        
        const size = getTypeSize(type as NativeType);
        const buf = new ArrayBuffer(size);
        const view = new DataView(buf);
        
        if (typeof type === 'string') {
            switch (type) {
                case 'u8':
                case 'i8':
                    view.setUint8(0, Number(result));
                    break;
                case 'u16':
                case 'i16':
                    view.setUint16(0, Number(result), true);
                    break;
                case 'u32':
                case 'i32':
                    view.setUint32(0, Number(result), true);
                    break;
                case 'u64':
                case 'usize':
                    view.setBigUint64(0, result as bigint, true);
                    break;
                case 'i64':
                case 'isize':
                    view.setBigInt64(0, result as bigint, true);
                    break;
                case 'f32':
                    view.setFloat32(0, Number(result), true);
                    break;
                case 'f64':
                    view.setFloat64(0, Number(result), true);
                    break;
                case 'bool':
                    view.setUint8(0, result ? 1 : 0);
                    break;
                case 'pointer':
                case 'buffer':
                case 'function': {
                    const addr = result === null ? 0n : UnsafePointer.value(result as PointerValue);
                    view.setBigUint64(0, addr, true);
                    break;
                }
            }
        } else if (typeof type === 'object' && 'struct' in type) {
            return result instanceof Uint8Array ? result : new Uint8Array(size);
        }
        
        return new Uint8Array(buf);
    }
}

export function callRegisteredCallback(pointer: PointerValue, args: readonly unknown[]): { found: boolean; value?: unknown } {
    if (pointer === null) return { found: false };
    const internal = callbackRegistry.get(pointer);
    if (!internal || internal.closed) return { found: false };
    return {
        found: true,
        value: internal.callback(...args as []),
    };
}
