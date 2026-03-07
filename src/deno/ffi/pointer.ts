/**
 * Deno FFI Pointer Implementation
 * UnsafePointer and UnsafePointerView classes
 */

import { PointerObject, PointerValue } from './types';

const { ffi_load_native } = import.meta.use('ffi');
const brand = Symbol('brand');

function createPointerObject<T = unknown>(addr: bigint): PointerObject<T> {
    const obj = { [brand]: null as T };
    Object.setPrototypeOf(obj, null);
    Object.defineProperty(obj, brand, {
        value: addr,
        writable: false,
        configurable: false,
        enumerable: false,
    });
    return obj as unknown as PointerObject<T>;
}

function getPointerAddress(ptr: PointerObject): bigint {
    return (ptr as any)[brand] as bigint;
}

export class UnsafePointer {
    static create<T = unknown>(value: bigint): PointerValue<T> {
        if (value === 0n) return null;
        return createPointerObject<T>(value);
    }

    static equals<T = unknown>(a: PointerValue<T>, b: PointerValue<T>): boolean {
        if (a === null && b === null) return true;
        if (a === null || b === null) return false;
        return getPointerAddress(a) === getPointerAddress(b);
    }

    static of<T = unknown>(value: BufferSource | { pointer: PointerObject }): PointerValue<T> {
        if (value === null || value === undefined) return null;
        
        if ('pointer' in value && value.pointer) {
            return value.pointer as PointerValue<T>;
        }
        
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
        
        const native = ffi_load_native();
        const addr = native.getArrayBufPtr(buf);
        if (addr === 0n) return null;
        return createPointerObject<T>(addr);
    }

    static offset<T = unknown>(value: PointerObject, offset: number): PointerValue<T> {
        const addr = getPointerAddress(value);
        const newAddr = addr + BigInt(offset);
        if (newAddr === 0n) return null;
        return createPointerObject<T>(newAddr);
    }

    static value(value: PointerValue): bigint {
        if (value === null) return 0n;
        return getPointerAddress(value);
    }
}

export class UnsafePointerView {
    pointer: PointerObject;
    private addr: bigint;
    private native: ReturnType<typeof ffi_load_native>;

    constructor(pointer: PointerObject) {
        this.pointer = pointer;
        this.addr = getPointerAddress(pointer);
        this.native = ffi_load_native();
    }

    private readAt(offset: number, size: number): Uint8Array {
        return this.native.ptrToBuffer(this.addr + BigInt(offset), size);
    }

    getBool(offset: number = 0): boolean {
        const buf = this.readAt(offset, 1);
        return buf[0] !== 0;
    }

    getUint8(offset: number = 0): number {
        const buf = this.readAt(offset, 1);
        return buf[0];
    }

    getInt8(offset: number = 0): number {
        const buf = this.readAt(offset, 1);
        return buf[0] > 127 ? buf[0] - 256 : buf[0];
    }

    getUint16(offset: number = 0): number {
        const buf = this.readAt(offset, 2);
        return new DataView(buf.buffer, buf.byteOffset).getUint16(0, true);
    }

    getInt16(offset: number = 0): number {
        const buf = this.readAt(offset, 2);
        return new DataView(buf.buffer, buf.byteOffset).getInt16(0, true);
    }

    getUint32(offset: number = 0): number {
        const buf = this.readAt(offset, 4);
        return new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
    }

    getInt32(offset: number = 0): number {
        const buf = this.readAt(offset, 4);
        return new DataView(buf.buffer, buf.byteOffset).getInt32(0, true);
    }

    getBigUint64(offset: number = 0): bigint {
        const buf = this.readAt(offset, 8);
        return new DataView(buf.buffer, buf.byteOffset).getBigUint64(0, true);
    }

    getBigInt64(offset: number = 0): bigint {
        const buf = this.readAt(offset, 8);
        return new DataView(buf.buffer, buf.byteOffset).getBigInt64(0, true);
    }

    getFloat32(offset: number = 0): number {
        const buf = this.readAt(offset, 4);
        return new DataView(buf.buffer, buf.byteOffset).getFloat32(0, true);
    }

    getFloat64(offset: number = 0): number {
        const buf = this.readAt(offset, 8);
        return new DataView(buf.buffer, buf.byteOffset).getFloat64(0, true);
    }

    getPointer<T = unknown>(offset: number = 0): PointerValue<T> {
        const addr = this.getBigUint64(offset);
        return UnsafePointer.create<T>(addr);
    }

    getCString(offset: number = 0): string {
        return this.native.getCString(this.addr + BigInt(offset));
    }

    static getCString(pointer: PointerObject, offset: number = 0): string {
        const addr = getPointerAddress(pointer);
        const native = ffi_load_native();
        return native.getCString(addr + BigInt(offset));
    }

    getArrayBuffer(byteLength: number, offset: number = 0): ArrayBuffer {
        const buf = this.readAt(offset, byteLength);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + byteLength) as ArrayBuffer;
    }

    static getArrayBuffer(
        pointer: PointerObject,
        byteLength: number,
        offset: number = 0
    ): ArrayBuffer {
        const addr = getPointerAddress(pointer);
        const native = ffi_load_native();
        const buf = native.ptrToBuffer(addr + BigInt(offset), byteLength);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + byteLength) as ArrayBuffer;
    }

    copyInto(destination: BufferSource, offset: number = 0): void {
        const destBuffer = destination instanceof ArrayBuffer
            ? new Uint8Array(destination)
            : new Uint8Array(
                (destination as ArrayBufferView).buffer,
                (destination as ArrayBufferView).byteOffset,
                (destination as ArrayBufferView).byteLength
            );
        
        const src = this.readAt(offset, destBuffer.length);
        destBuffer.set(src);
    }

    static copyInto(
        pointer: PointerObject,
        destination: BufferSource,
        offset: number = 0
    ): void {
        const addr = getPointerAddress(pointer);
        const native = ffi_load_native();
        const destBuffer = destination instanceof ArrayBuffer
            ? new Uint8Array(destination)
            : new Uint8Array(
                (destination as ArrayBufferView).buffer,
                (destination as ArrayBufferView).byteOffset,
                (destination as ArrayBufferView).byteLength
            );
        
        const src = native.ptrToBuffer(addr + BigInt(offset), destBuffer.length);
        destBuffer.set(src);
    }
}

export { getPointerAddress, createPointerObject };
