/**
 * `Bun.ArrayBufferSink`: an incremental byte writer that becomes an
 * `ArrayBuffer` (or `Uint8Array`) on `end()`.
 *
 * The contract follows `bun-types` 1.4.4:
 * - `start(options)` configures `asUint8Array`, `highWaterMark` and `stream`.
 * - `write()` accepts strings (UTF-8), ArrayBuffer, SharedArrayBuffer and
 *   ArrayBufferView, copies the bytes immediately and returns the byte count.
 * - `flush()` returns the buffered bytes and restarts from an empty buffer
 *   when `stream` is set, and otherwise returns the number of bytes written
 *   since the previous flush without draining anything.
 * - `end()` returns everything not yet flushed and resets the sink.
 */

import type { ArrayBufferSink as BunArrayBufferSink } from 'bun';

const engine = import.meta.use('engine');

export type ArrayBufferSinkStartOptions = NonNullable<Parameters<BunArrayBufferSink['start']>[0]>;

/** Preallocation is only a hint; cap it so a huge value cannot throw or exhaust memory. */
const MAX_PREALLOCATION = 16 * 1024 * 1024;
const MIN_GROWTH = 64;

// Brand checks through the intrinsic getters work across realms, unlike instanceof.
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!
    : undefined;

function hasBrand(getter: (() => number) | undefined, value: object): boolean {
    if (!getter) return false;
    try {
        Reflect.apply(getter, value, []);
        return true;
    } catch {
        return false;
    }
}

const invalidChunk = 'ArrayBufferSink.write() expects a string, ArrayBufferView, ArrayBuffer or SharedArrayBuffer';

export class ArrayBufferSink {
    #bytes: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    #length = 0;
    #sinceFlush = 0;
    #asUint8Array = false;
    #stream = false;

    /**
     * (Re)initializes the sink. Pending data is discarded, a closed sink is
     * reset, and every option is reset to its default unless given.
     * A non-object `options` is treated as no options.
     */
    start(options?: ArrayBufferSinkStartOptions): void {
        // Validate the receiver before touching user-supplied getters.
        void this.#length;
        let asUint8Array = false;
        let stream = false;
        let capacity = 0;
        if (typeof options === 'object' && options !== null) {
            // Only real booleans count; other values are ignored rather than coerced.
            if (options.asUint8Array === true) asUint8Array = true;
            if (options.stream === true) stream = true;
            const highWaterMark: unknown = options.highWaterMark;
            if (typeof highWaterMark === 'number' && highWaterMark > 0) {
                capacity = Math.min(Math.trunc(highWaterMark), MAX_PREALLOCATION);
            }
        }
        this.#bytes = new Uint8Array(capacity);
        this.#length = 0;
        this.#sinceFlush = 0;
        this.#asUint8Array = asUint8Array;
        this.#stream = stream;
    }

    /** Appends a copy of `chunk` and returns the number of bytes written (UTF-8 length for strings). */
    write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): number {
        let source: Uint8Array;
        if (typeof chunk === 'string') {
            source = engine.encodeString(chunk);
        } else if (typeof chunk === 'object' && chunk !== null) {
            if (ArrayBuffer.isView(chunk)) {
                source = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            } else if (hasBrand(arrayBufferByteLength, chunk) || hasBrand(sharedArrayBufferByteLength, chunk)) {
                source = new Uint8Array(chunk as ArrayBuffer);
            } else {
                throw new TypeError(invalidChunk);
            }
        } else {
            throw new TypeError(invalidChunk);
        }
        const count = source.byteLength;
        if (count === 0) return 0;
        this.#reserve(count);
        this.#bytes.set(source, this.#length);
        this.#length += count;
        this.#sinceFlush += count;
        return count;
    }

    /**
     * With `stream`, returns the buffered bytes (ArrayBuffer, or Uint8Array
     * with `asUint8Array`) and empties the buffer. Otherwise returns the
     * number of bytes written since the last flush and keeps the data.
     */
    flush(): number | Uint8Array<ArrayBuffer> | ArrayBuffer {
        if (!this.#stream) {
            const written = this.#sinceFlush;
            this.#sinceFlush = 0;
            return written;
        }
        // Copy out: the internal buffer, including any preallocation, is reused.
        const copy = this.#bytes.slice(0, this.#length);
        this.#length = 0;
        this.#sinceFlush = 0;
        return this.#asUint8Array ? copy : copy.buffer;
    }

    /**
     * Returns the data not yet flushed and resets the sink. Further writes are
     * accepted with the same options, matching Bun's reusable sink behavior.
     */
    end(): ArrayBuffer | Uint8Array<ArrayBuffer> {
        void this.#length;
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
        this.#sinceFlush = 0;
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
