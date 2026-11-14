/**
 * Deno FFI pointer and foreign-memory views.
 */

import { bytesToArrayBuffer } from '../../utils/bytes';
import {
    brand,
    bufferSourceBytes,
    type DenoBufferSource,
    getNativePointer,
    isBufferSource,
} from './utils';
import { nativeLittleEndian, viewBytes } from '../../utils/bytes';

const ffi = import.meta.use('ffi');

type PointerCarrier<T = unknown> = { pointer: Deno.PointerObject<T> };

/** The opaque Deno object retains the native Pointer, including its owner and
 * validity state. Numeric addresses are exposed only through UnsafePointer. */
function createPointerObject<T = unknown>(pointer: CModuleFFI.Pointer): Deno.PointerObject<T> {
    const obj = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(obj, brand, {
        value: pointer,
        writable: false,
        configurable: false,
        enumerable: false,
    });
    Object.preventExtensions(obj);
    return obj as unknown as Deno.PointerObject<T>;
}

function hasPointer(value: unknown): value is PointerCarrier {
    return value !== null && typeof value === 'object' && Reflect.get(value, 'pointer') !== undefined;
}

function offsetPointer(pointer: CModuleFFI.Pointer, offset: number): CModuleFFI.Pointer | null {
    return offset === 0 ? pointer : ffi.unsafe.offset(pointer, offset);
}

function requireOffsetPointer(pointer: CModuleFFI.Pointer, offset: number): CModuleFFI.Pointer {
    const result = offsetPointer(pointer, offset);
    if (result === null) throw new TypeError('Pointer offset resolves to null');
    return result;
}

export class UnsafePointer {
    static create<T = unknown>(value: bigint): Deno.PointerValue<T> {
        const pointer = ffi.unsafe.fromAddress(value);
        return pointer === null ? null : createPointerObject<T>(pointer);
    }

    static equals<T = unknown>(a: Deno.PointerValue<T>, b: Deno.PointerValue<T>): boolean {
        if (a === null || b === null) return a === b;
        return ffi.unsafe.address(getNativePointer(a)!) === ffi.unsafe.address(getNativePointer(b)!);
    }

    static of<T = unknown>(value: DenoBufferSource | PointerCarrier): Deno.PointerValue<T> {
        if (hasPointer(value)) return value.pointer as Deno.PointerValue<T>;
        if (!isBufferSource(value)) return null;

        const pointer = ffi.unsafe.pointerOf(bufferSourceBytes(value) as CModuleFFI.BufferSource);
        return pointer === null ? null : createPointerObject<T>(pointer);
    }

    static offset<T = unknown>(value: Deno.PointerObject, offset: number): Deno.PointerValue<T> {
        // The native operation represents address zero as `null`. This can
        // happen with a negative offset even though the input is non-null.
        const pointer = ffi.unsafe.offset(getNativePointer(value)!, offset);
        return pointer === null ? null : createPointerObject<T>(pointer);
    }

    static value(value: Deno.PointerValue): bigint {
        if (value === null) return 0n;
        return ffi.unsafe.address(getNativePointer(value)!);
    }
}

export class UnsafePointerView {
    pointer: Deno.PointerObject;
    private nativePointer: CModuleFFI.Pointer;

    constructor(pointer: Deno.PointerObject) {
        this.pointer = pointer;
        this.nativePointer = getNativePointer(pointer)!;
    }

    private readAt(offset: number, size: number): Uint8Array {
        return ffi.unsafe.view(requireOffsetPointer(this.nativePointer, offset), size);
    }

    getBool(offset: number = 0): boolean {
        return this.readAt(offset, 1)[0] !== 0;
    }

    getUint8(offset: number = 0): number {
        return this.readAt(offset, 1)[0];
    }

    getInt8(offset: number = 0): number {
        const buf = this.readAt(offset, 1);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt8(0);
    }

    getUint16(offset: number = 0): number {
        const buf = this.readAt(offset, 2);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(0, nativeLittleEndian);
    }

    getInt16(offset: number = 0): number {
        const buf = this.readAt(offset, 2);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt16(0, nativeLittleEndian);
    }

    getUint32(offset: number = 0): number {
        const buf = this.readAt(offset, 4);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, nativeLittleEndian);
    }

    getInt32(offset: number = 0): number {
        const buf = this.readAt(offset, 4);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(0, nativeLittleEndian);
    }

    getBigUint64(offset: number = 0): bigint {
        const buf = this.readAt(offset, 8);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(0, nativeLittleEndian);
    }

    getBigInt64(offset: number = 0): bigint {
        const buf = this.readAt(offset, 8);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigInt64(0, nativeLittleEndian);
    }

    getFloat32(offset: number = 0): number {
        const buf = this.readAt(offset, 4);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat32(0, nativeLittleEndian);
    }

    getFloat64(offset: number = 0): number {
        const buf = this.readAt(offset, 8);
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(0, nativeLittleEndian);
    }

    getPointer<T = unknown>(offset: number = 0): Deno.PointerValue<T> {
        const pointer = ffi.unsafe.deref(requireOffsetPointer(this.nativePointer, offset));
        return pointer === null ? null : createPointerObject<T>(pointer);
    }

    getCString(offset: number = 0): string {
        return ffi.unsafe.readCString(requireOffsetPointer(this.nativePointer, offset));
    }

    static getCString(pointer: Deno.PointerObject, offset: number = 0): string {
        return ffi.unsafe.readCString(requireOffsetPointer(getNativePointer(pointer)!, offset));
    }

    getArrayBuffer(byteLength: number, offset: number = 0): ArrayBuffer {
        return bytesToArrayBuffer(this.readAt(offset, byteLength), byteLength);
    }

    static getArrayBuffer(
        pointer: Deno.PointerObject,
        byteLength: number,
        offset: number = 0,
    ): ArrayBuffer {
        const nativePointer = requireOffsetPointer(getNativePointer(pointer)!, offset);
        return bytesToArrayBuffer(ffi.unsafe.view(nativePointer, byteLength), byteLength);
    }

    copyInto(destination: DenoBufferSource, offset: number = 0): void {
        const destBuffer = bufferSourceBytes(destination);
        destBuffer.set(this.readAt(offset, destBuffer.byteLength));
    }

    static copyInto(
        pointer: Deno.PointerObject,
        destination: DenoBufferSource,
        offset: number = 0,
    ): void {
        const destBuffer = bufferSourceBytes(destination);
        const nativePointer = requireOffsetPointer(getNativePointer(pointer)!, offset);
        destBuffer.set(ffi.unsafe.view(nativePointer, destBuffer.byteLength));
    }
}

export { bufferSourceBytes, createPointerObject, getNativePointer };
