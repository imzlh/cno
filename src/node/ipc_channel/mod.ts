/**
 * Internal IPC Channel module
 * Used by child_process and process modules for inter-process communication.
 *
 * Users should NOT import this module directly.
 * Instead use:
 *   - child.send() / child.on('message') in parent
 *   - process.send() / process.on('message') in child
 *
 * Wire protocol (Node.js-compatible, serialization: 'json')
 * --------------------------------------------------------
 * Each message is `JSON.stringify(value)` followed by a single newline byte
 * (0x0A), encoded as UTF-8. Messages are delimited by that newline byte.
 * Because JSON.stringify never emits a raw 0x0A (newlines inside strings are
 * escaped), the 0x0A byte is an unambiguous delimiter even across multi-byte
 * UTF-8 sequences (continuation bytes are 0x80-0xBF and can never be 0x0A).
 *
 * User messages are transmitted verbatim as arbitrary JSON values (object, array,
 * string, number, boolean or null). Internal control messages are objects
 * whose `cmd` field begins with "NODE_" (e.g. NODE_HANDLE); these are kept off
 * the user 'message' stream. This is exactly Node's framing, so a circu
 * process and a real node process can exchange IPC messages over the same
 * channel (e.g. node parent <-> circu child via NODE_CHANNEL_FD, or vice versa).
 */

import { EventEmitter } from '../events';
import { getMemoryTier } from '../_internal/memory';
import { toOwnedBytes } from '../_internal/buffer';

const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');
const timers = import.meta.use('timers');

const NEWLINE = 0x0a;
const ADVANCED_HEADER_BYTES = 4;
// Guard against unbounded buffering — tier-aware cap
const MAX_BUFFER_BYTES = getMemoryTier() === 'low' ? 4 * 1024 * 1024
                       : getMemoryTier() === 'normal' ? 64 * 1024 * 1024
                       : 256 * 1024 * 1024;

export type IPCSerialization = 'json' | 'advanced';

function isInternalMessage(message: unknown): boolean {
    const cmd = message !== null && typeof message === 'object'
        ? Reflect.get(message, 'cmd')
        : undefined;
    return (
        typeof cmd === 'string' &&
        cmd.length > 5 &&
        cmd.slice(0, 5) === 'NODE_'
    );
}

function arrayBufferViewToJsonArray(value: ArrayBufferView): unknown[] {
    if (value instanceof DataView) {
        return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    if (value instanceof BigInt64Array || value instanceof BigUint64Array) {
        return Array.from(value, (entry) => entry.toString());
    }
    if (
        value instanceof Int8Array ||
        value instanceof Uint8Array ||
        value instanceof Uint8ClampedArray ||
        value instanceof Int16Array ||
        value instanceof Uint16Array ||
        value instanceof Int32Array ||
        value instanceof Uint32Array ||
        value instanceof Float32Array ||
        value instanceof Float64Array
    ) {
        return Array.from(value);
    }
    return [];
}

// ============================================================================
// MessageDecoder: accumulates incoming bytes and yields one parsed JSON value
// per newline-delimited frame.
// ============================================================================

export class MessageDecoder extends EventEmitter {
    private _chunks: Uint8Array[] = [];
    private _bufferedBytes = 0;
    private _discardUntilDelimiter = false;
    private _serialization: IPCSerialization;

    constructor(serialization: IPCSerialization = 'json') {
        super();
        this._serialization = serialization;
    }

    feed(data: Uint8Array): void {
        if (!data || data.length === 0) return;
        if (this._serialization === 'json' && this._discardUntilDelimiter) {
            const newline = algorithm.bytesIndexOf(data, NEWLINE);
            if (newline === -1) return;
            this._discardUntilDelimiter = false;
            data = data.subarray(newline + 1);
            if (data.length === 0) return;
        }
        if (this._bufferedBytes + data.length > MAX_BUFFER_BYTES) {
            this.emit('error', new RangeError('IPC receive buffer overflow'));
            this.reset();
            return;
        }
        this._chunks.push(data);
        this._bufferedBytes += data.length;
        this._processBuffer();
    }

    private _processBuffer(): void {
        if (this._serialization === 'advanced') {
            this._processAdvancedBuffer();
            return;
        }

        for (;;) {
            let chunkIndex = -1;
            let newline = -1;
            let bytesBefore = 0;
            for (let i = 0; i < this._chunks.length; i++) {
                const chunk = this._chunks[i];
                if (!chunk) continue;
                newline = algorithm.bytesIndexOf(chunk, NEWLINE);
                if (newline !== -1) {
                    chunkIndex = i;
                    break;
                }
                bytesBefore += chunk.length;
            }
            if (chunkIndex === -1) break;

            // Bytes before the delimiter are one complete UTF-8 JSON message.
            const frameLength = bytesBefore + newline;
            const lineBytes = frameLength > 0 ? this._readFrame(chunkIndex, newline) : undefined;
            this._consumeFrame(chunkIndex, newline, frameLength + 1);
            if (lineBytes) {
                let parsed: unknown;
                let ok = true;
                try {
                    parsed = JSON.parse(engine.decodeString(lineBytes));
                } catch {
                    ok = false;
                }
                if (ok) this.emit('message', parsed);
                else this.emit('error', new Error('Invalid IPC message'));
            }
        }
    }

    private _processAdvancedBuffer(): void {
        for (;;) {
            if (this._bufferedBytes < ADVANCED_HEADER_BYTES) return;
            const data = algorithm.bytesConcat(this._chunks);
            const frameLength = (
                (data[0] << 24) |
                (data[1] << 16) |
                (data[2] << 8) |
                data[3]
            ) >>> 0;
            if (frameLength > MAX_BUFFER_BYTES) {
                this.emit('error', new RangeError('IPC receive buffer overflow'));
                this.reset();
                return;
            }
            const totalLength = ADVANCED_HEADER_BYTES + frameLength;
            if (data.length < totalLength) return;

            const frame = toOwnedBytes(data.subarray(ADVANCED_HEADER_BYTES, totalLength));
            const rest = data.subarray(totalLength);
            this._chunks = rest.length > 0 ? [toOwnedBytes(rest)] : [];
            this._bufferedBytes = rest.length;

            try {
                this.emit('message', engine.deserialize(frame));
            } catch {
                this.emit('error', new Error('Invalid IPC message'));
            }
        }
    }

    private _readFrame(chunkIndex: number, newline: number): Uint8Array<ArrayBuffer> {
        const chunk = this._chunks[chunkIndex];
        if (!chunk) return new Uint8Array(0);
        if (chunkIndex === 0) return toOwnedBytes(chunk.subarray(0, newline));
        const parts = this._chunks.slice(0, chunkIndex);
        parts.push(chunk.subarray(0, newline));
        return toOwnedBytes(algorithm.bytesConcat(parts));
    }

    private _consumeFrame(chunkIndex: number, newline: number, consumed: number): void {
        const chunk = this._chunks[chunkIndex];
        if (!chunk) return;
        const restOffset = newline + 1;
        if (restOffset < chunk.length) {
            if (chunkIndex > 0) this._chunks.splice(0, chunkIndex);
            this._chunks[0] = chunk.subarray(restOffset);
        } else {
            this._chunks.splice(0, chunkIndex + 1);
        }
        this._bufferedBytes -= consumed;
    }

    reset(): void {
        this._discardUntilDelimiter = this._bufferedBytes > 0;
        this._chunks = [];
        this._bufferedBytes = 0;
    }
}

// IPCChannel: wraps a bidirectional pipe with Node-compatible JSON framing.

type Pipe = CModuleStreams.Pipe;

export class IPCChannel extends EventEmitter {
    private _pipe: Pipe | null;
    private _decoder: MessageDecoder;
    private _connected: boolean = false;
    /** False when the platform gave us a send-only endpoint (see _setupRead). */
    private _readable: boolean = true;
    private _serialization: IPCSerialization;
    private _pendingWrites = 0;
    private _closeAfterWrites = false;
    private _unrefWhenIdle = false;

    constructor(pipe: Pipe, serialization: IPCSerialization = 'json') {
        super();
        this._pipe = pipe;
        this._serialization = serialization;
        this._decoder = new MessageDecoder(serialization);

        this._decoder.on('message', (msg: unknown) => {
            if (isInternalMessage(msg)) {
                // Control traffic (e.g. NODE_HANDLE). Handle/socket passing is not
                // supported over this channel; expose it for observers but keep it
                // out of the user 'message' stream, matching Node.
                this.emit('internalMessage', msg);
            } else {
                this.emit('message', msg);
            }
        });
        this._decoder.on('error', (err: Error) => this.emit('error', err));

        this._setupRead();
    }

    private _setupRead(): void {
        if (!this._pipe) return;

        this._pipe.onread = (result: Uint8Array<ArrayBuffer> | null | undefined, error: CModuleError.Error | undefined) => {
            if (error) {
                this.emit('error', error);
                return;
            }
            if (result === null || result === undefined) {
                if (this._connected) {
                    this._connected = false;
                    this.emit('close');
                }
                return;
            }
            this._decoder.feed(result);
        };

        // Windows spawns the IPC pair with _pipe() (anonymous, unidirectional),
        // so a child adopting its inherited endpoint gets a write-only handle
        // and startRead() fails with ENOTCONN. Send-only is still a usable
        // channel — stay connected instead of throwing out of the constructor.
        try {
            this._pipe.startRead();
        } catch {
            this._readable = false;
        }
        this._connected = true;
    }

    /** Send a user message. Accepts any JSON-serializable value (Node-compatible). */
    send(message: unknown): void {
        if (message === undefined) {
            throw new TypeError('The "message" argument must be specified');
        }
        this._writeRaw(message);
    }

    /** Send an internal control message (an object whose cmd starts with NODE_). */
    sendInternal(message: object): void {
        this._writeRaw(message);
    }

    private _writeRaw(message: unknown): void {
        if (!this._connected || !this._pipe) {
            throw new Error('IPC channel is not connected');
        }
        const frame = this._serialization === 'advanced'
            ? this._encodeAdvancedFrame(message)
            : this._encodeJsonFrame(message);
        // pipe.write returns a promise; surface async write failures as channel
        // errors instead of leaving an unhandled rejection.
        this._pendingWrites++;
        if (this._unrefWhenIdle) this._pipe.ref();
        this._pipe.write(frame)
            .catch((err: Error) => this.emit('error', err))
            .finally(() => {
                this._pendingWrites--;
                if (this._pendingWrites !== 0) return;
                if (this._closeAfterWrites) {
                    this._closeNow();
                    return;
                }
                if (this._unrefWhenIdle) {
                    const pipe = this._pipe;
                    timers.setTimeout(() => {
                        if (this._pendingWrites === 0 && this._unrefWhenIdle && this._pipe === pipe) {
                            pipe?.unref();
                        }
                    }, 0);
                }
            });
    }

    private _encodeJsonFrame(message: unknown): Uint8Array {
        const json = JSON.stringify(message, (_key, value) => {
            if (ArrayBuffer.isView(value)) return arrayBufferViewToJsonArray(value);
            return value;
        });
        if (json === undefined) {
            throw new TypeError('IPC message could not be serialized');
        }
        return engine.encodeString(json + '\n');
    }

    private _encodeAdvancedFrame(message: unknown): Uint8Array {
        const payload = engine.serialize(message);
        const length = payload.byteLength;
        if (length > 0xffffffff) throw new RangeError('IPC message is too large');
        const frame = new Uint8Array(ADVANCED_HEADER_BYTES + length);
        frame[0] = (length >>> 24) & 0xff;
        frame[1] = (length >>> 16) & 0xff;
        frame[2] = (length >>> 8) & 0xff;
        frame[3] = length & 0xff;
        frame.set(payload, ADVANCED_HEADER_BYTES);
        return frame;
    }

    close(): void {
        if (this._pendingWrites > 0) {
            this._closeAfterWrites = true;
            this._connected = false;
            return;
        }
        this._closeNow();
    }

    private _closeNow(): void {
        const pipe = this._pipe;
        if (pipe) {
            this._pipe = null;
            try {
                pipe.ref();
                pipe.shutdown()
                    .catch(() => undefined)
                    .finally(() => {
                        try { pipe.close(); } catch { /* ignore */ }
                    });
            } catch {
                try { pipe.close(); } catch { /* ignore */ }
            }
        }
        this._closeAfterWrites = false;
        this._decoder.reset();
        if (this._connected) {
            this._connected = false;
            this.emit('close');
        }
    }

    ref(): void {
        this._unrefWhenIdle = false;
        this._pipe?.ref();
    }

    unref(): void {
        this._unrefWhenIdle = true;
        if (this._pendingWrites === 0) this._pipe?.unref();
    }

    get connected(): boolean {
        return this._connected;
    }

    /** False when the endpoint is send-only (no 'message'/'close' will arrive). */
    get readable(): boolean {
        return this._readable;
    }
}
