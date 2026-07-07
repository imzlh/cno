/**
 * Deno FFI Pointer Implementation
 * UnsafePointer and UnsafePointerView classes
 */

import { brand, PointerObject, PointerValue } from './types';
import { bytesToArrayBuffer } from '../../utils/bytes';
const ffi = import.meta.use('ffi');

type FfiBufferSource = ArrayBuffer | ArrayBufferView<ArrayBufferLike>;
type PointerCarrier<T = unknown> = { pointer: PointerObject<T> };

function createPointerObject<T = unknown>(addr: bigint): PointerObject<T> {
    const obj: PointerObject<T> = { [brand]: null as T };
    Object.setPrototypeOf(obj, null);
    Object.defineProperty(obj, brand, {
        value: addr,
        writable: false,
        configurable: false,
        enumerable: false,
    });
    return obj;
}

function getPointerAddress(ptr: PointerObject): bigint {
    return Reflect.get(ptr, brand) as bigint;
}

function hasPointer(value: unknown): value is PointerCarrier {
    return value !== null && typeof value === 'object' && Reflect.get(value, 'pointer') !== undefined;
}

function bufferSourceBytes(value: FfiBufferSource): Uint8Array {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof Uint8Array) return value;
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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

    static of<T = unknown>(value: BufferSource | PointerCarrier): PointerValue<T> {
        if (value === null || value === undefined) return null;
        
        if (hasPointer(value) && value.pointer) {
            return value.pointer as PointerValue<T>;
        }
        if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) return null;
        
        const buf = bufferSourceBytes(value);
        
        const addr = ffi.getArrayBufPtr(buf);
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

    constructor(pointer: PointerObject) {
        this.pointer = pointer;
        this.addr = getPointerAddress(pointer);
    }

    private readAt(offset: number, size: number): Uint8Array {
        return ffi.ptrToBuffer(this.addr + BigInt(offset), size);
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
        return ffi.getCString(this.addr + BigInt(offset));
    }

    static getCString(pointer: PointerObject, offset: number = 0): string {
        const addr = getPointerAddress(pointer);
        return ffi.getCString(addr + BigInt(offset));
    }

    getArrayBuffer(byteLength: number, offset: number = 0): ArrayBuffer {
        const buf = this.readAt(offset, byteLength);
        return bytesToArrayBuffer(buf, byteLength);
    }

    static getArrayBuffer(
        pointer: PointerObject,
        byteLength: number,
        offset: number = 0
    ): ArrayBuffer {
        const addr = getPointerAddress(pointer);
        const buf = ffi.ptrToBuffer(addr + BigInt(offset), byteLength);
        return bytesToArrayBuffer(buf, byteLength);
    }

    copyInto(destination: BufferSource, offset: number = 0): void {
        const destBuffer = bufferSourceBytes(destination);
        
        const src = this.readAt(offset, destBuffer.length);
        destBuffer.set(src);
    }

    static copyInto(
        pointer: PointerObject,
        destination: BufferSource,
        offset: number = 0
    ): void {
        const addr = getPointerAddress(pointer);
        const destBuffer = bufferSourceBytes(destination);
        
        const src = ffi.ptrToBuffer(addr + BigInt(offset), destBuffer.length);
        destBuffer.set(src);
    }
}

export { getPointerAddress, createPointerObject, bufferSourceBytes };
