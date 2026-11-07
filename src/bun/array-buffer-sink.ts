/**
 * `Bun.ArrayBufferSink`: an incremental byte writer that becomes an
 * `ArrayBuffer` (or `Uint8Array`) on `end()`.
 *
 * The contract follows `bun-types` 1.4.4:
 * - `start(options)` configures `asUint8Array`, `highWaterMark` and `stream`.
 * - `write()` accepts strings (UTF-8), ArrayBuffer, SharedArrayBuffer and
 *   ArrayBufferView, copies the bytes immediately and returns the byte count.
 * - `flush()` returns the buffered bytes and restarts from an empty buffer
 *   when `stream` is set, and otherwise returns zero without draining.
 * - `end()` returns everything not yet flushed and ends normal collection
 *   until the next `start()`.
 */

import type { ArrayBufferSink as BunArrayBufferSink } from 'bun';
import { sanitizeSurrogates } from '../utils/bytes';

const engine = import.meta.use('engine');

export type ArrayBufferSinkStartOptions = NonNullable<Parameters<BunArrayBufferSink['start']>[0]>;

/** Preallocation is only a hint; cap it so a huge value cannot throw or exhaust memory. */
const MAX_PREALLOCATION = 16 * 1024 * 1024;
const MIN_GROWTH = 64;

// Brand checks through the intrinsic getters work across realms, unlike
// `instanceof`. They also keep arbitrary array-like objects out of the binary
// input path (`new Uint8Array(value)` would otherwise silently coerce them).
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const arrayBufferIsView = ArrayBuffer.isView;
const numberIsFinite = Number.isFinite;
const mathTrunc = Math.trunc;
const mathMin = Math.min;
const emptyBytes = new Uint8Array(0);

function brandedByteLength(getter: (() => number) | undefined, value: object): number | undefined {
    if (!getter) return undefined;
    try {
        return Reflect.apply(getter, value, []);
    } catch {
        return undefined;
    }
}

function viewBytes(value: ArrayBufferView): Uint8Array<ArrayBufferLike> {
    let buffer: ArrayBufferLike;
    let byteOffset: number;
    let byteLength: number;
    try {
        buffer = Reflect.apply(typedArrayBuffer, value, []);
        byteOffset = Reflect.apply(typedArrayByteOffset, value, []);
        byteLength = Reflect.apply(typedArrayByteLength, value, []);
    } catch {
        try {
            buffer = Reflect.apply(dataViewBuffer, value, []);
            byteOffset = Reflect.apply(dataViewByteOffset, value, []);
            byteLength = Reflect.apply(dataViewByteLength, value, []);
        } catch {
            // Bun treats detached and out-of-bounds views as empty writes.
            return emptyBytes;
        }
    }
    return byteLength === 0 ? emptyBytes : new Uint8Array(buffer, byteOffset, byteLength);
}

const invalidChunk = 'write() expects a string, ArrayBufferView, or ArrayBuffer';

export class ArrayBufferSink {
    #bytes: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    #length = 0;
    #asUint8Array = false;
    #stream = false;
    #ended = false;

    /**
     * (Re)initializes the sink and discards pending data. Empty/invalid options
     * preserve the previous configuration. A typed option updates the whole
     * configuration, with omitted typed options taking their defaults.
     */
    start(options?: ArrayBufferSinkStartOptions): void {
        // Validate the receiver before touching user-supplied getters.
        void this.#length;
        let asUint8Array = this.#asUint8Array;
        let stream = this.#stream;
        let capacity = 0;
        if (typeof options === 'object' && options !== null) {
            // Read in Bun's observable order before changing any sink state.
            const asUint8ArrayOption: unknown = options.asUint8Array;
            const streamOption: unknown = options.stream;
            const highWaterMark: unknown = options.highWaterMark;
            const hasTypedOption = typeof asUint8ArrayOption === 'boolean'
                || typeof streamOption === 'boolean'
                || typeof highWaterMark === 'number';
            if (hasTypedOption) {
                asUint8Array = typeof asUint8ArrayOption === 'boolean' ? asUint8ArrayOption : false;
                stream = typeof streamOption === 'boolean' ? streamOption : false;
            }
            if (typeof highWaterMark === 'number' && numberIsFinite(highWaterMark) && highWaterMark > 0) {
                capacity = mathMin(mathTrunc(highWaterMark), MAX_PREALLOCATION);
            }
        }
        this.#bytes = new Uint8Array(capacity);
        this.#length = 0;
        this.#asUint8Array = asUint8Array;
        this.#stream = stream;
        this.#ended = false;
    }

    /** Appends a copy of `chunk` and returns the number of bytes written (UTF-8 length for strings). */
    write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): number {
        // Brand the receiver before encoding or inspecting the input.
        void this.#length;
        let source: Uint8Array<ArrayBufferLike>;
        if (typeof chunk === 'string') {
            // Lone surrogates become U+FFFD, matching the WHATWG UTF-8 encode
            // every other Bun string input uses.
            source = engine.encodeString(sanitizeSurrogates(chunk));
        } else if (typeof chunk === 'object' && chunk !== null) {
            if (arrayBufferIsView(chunk)) {
                source = viewBytes(chunk);
            } else {
                const byteLength = brandedByteLength(arrayBufferByteLength, chunk)
                    ?? brandedByteLength(sharedArrayBufferByteLength, chunk);
                if (byteLength === undefined) throw new TypeError(invalidChunk);
                source = byteLength === 0
                    ? emptyBytes
                    : new Uint8Array(chunk as ArrayBuffer | SharedArrayBuffer, 0, byteLength);
            }
        } else {
            throw new TypeError(invalidChunk);
        }
        const count = source.byteLength;
        if (count === 0) return 0;
        // Bun keeps accepting writes after end(). Only streaming sinks retain
        // those bytes, and they are then observable through flush(), not end().
        if (this.#ended && !this.#stream) return count;
        this.#reserve(count);
        this.#bytes.set(source, this.#length);
        this.#length += count;
        return count;
    }

    /**
     * With `stream`, returns the buffered bytes (ArrayBuffer, or Uint8Array
     * with `asUint8Array`) and empties the buffer. Otherwise returns zero and
     * keeps the data.
     */
    flush(_force?: boolean): number | Uint8Array<ArrayBuffer> | ArrayBuffer {
        if (!this.#stream) return 0;
        // Copy out: the internal buffer, including any preallocation, is reused.
        const copy = this.#bytes.slice(0, this.#length);
        this.#length = 0;
        return this.#asUint8Array ? copy : copy.buffer;
    }

    /**
     * Returns the data not yet flushed and ends normal collection. A later
     * `start()` reopens the sink; repeated `end()` calls return ArrayBuffer(0).
     */
    end(): ArrayBuffer | Uint8Array<ArrayBuffer> {
        void this.#length;
        if (this.#ended) return new ArrayBuffer(0);
        let buffer: ArrayBuffer;
        if (this.#length === 0) {
            buffer = new ArrayBuffer(0);
        } else if (this.#length === this.#bytes.byteLength) {
            buffer = this.#bytes.buffer;
        } else {
            buffer = this.#bytes.buffer.slice(0, this.#length);
        }
        this.#bytes = new Uint8Array(0);
        this.#length = 0;
        this.#ended = true;
        return this.#asUint8Array ? new Uint8Array(buffer) : buffer;
    }

    #reserve(extra: number): void {
        const needed = this.#length + extra;
        const capacity = this.#bytes.byteLength;
        if (needed <= capacity) return;
        const grown = new Uint8Array(Math.max(needed, capacity * 2, MIN_GROWTH));
        grown.set(this.#bytes.subarray(0, this.#length));
        this.#bytes = grown;
    }
}

Object.defineProperties(ArrayBufferSink.prototype, {
    start: { enumerable: true, writable: false, configurable: false },
    write: { enumerable: true, writable: false, configurable: false },
    flush: { enumerable: true, writable: false, configurable: false },
    end: { enumerable: true, writable: false, configurable: false },
    [Symbol.toStringTag]: { value: 'ArrayBufferSink', configurable: true },
});
