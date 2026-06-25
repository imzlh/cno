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
 * User messages are transmitted verbatim as any JSON value (object, array,
 * string, number, boolean or null). Internal control messages are objects
 * whose `cmd` field begins with "NODE_" (e.g. NODE_HANDLE); these are kept off
 * the user 'message' stream. This is exactly Node's framing, so a circu
 * process and a real node process can exchange IPC messages over the same
 * channel (e.g. node parent <-> circu child via NODE_CHANNEL_FD, or vice versa).
 */

import { EventEmitter } from '../events';

const engine = import.meta.use('engine');

const NEWLINE = 0x0a;
// Guard against unbounded buffering from a peer that never sends a delimiter.
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;

function isInternalMessage(message: any): boolean {
    return (
        message !== null &&
        typeof message === 'object' &&
        typeof message.cmd === 'string' &&
        message.cmd.length > 5 &&
        message.cmd.slice(0, 5) === 'NODE_'
    );
}

// ============================================================================
// MessageDecoder: accumulates incoming bytes and yields one parsed JSON value
// per newline-delimited frame.
// ============================================================================

export class MessageDecoder extends EventEmitter {
    private _buffer: Uint8Array = new Uint8Array(0);

    feed(data: Uint8Array): void {
        if (!data || data.length === 0) return;
        if (this._buffer.length + data.length > MAX_BUFFER_BYTES) {
            this.emit('error', new RangeError('IPC receive buffer overflow'));
            this.reset();
            return;
        }
        const merged = new Uint8Array(this._buffer.length + data.length);
        merged.set(this._buffer);
        merged.set(data, this._buffer.length);
        this._buffer = merged;
        this._processBuffer();
    }

    private _processBuffer(): void {
        let start = 0;
        for (let i = 0; i < this._buffer.length; i++) {
            if (this._buffer[i] !== NEWLINE) continue;
            // Bytes [start, i) are one complete UTF-8 JSON message (skip empty).
            if (i > start) {
                const lineBytes = this._buffer.subarray(start, i);
                let parsed: unknown;
                let ok = true;
                try {
                    parsed = JSON.parse(engine.decodeString(lineBytes as Uint8Array<ArrayBuffer>));
                } catch {
                    ok = false;
                }
                if (ok) this.emit('message', parsed);
                else this.emit('error', new Error('Invalid IPC message'));
            }
            start = i + 1;
        }
        // Retain any trailing bytes belonging to a not-yet-terminated message.
        if (start > 0) {
            this._buffer = this._buffer.slice(start);
        }
    }

    reset(): void {
        this._buffer = new Uint8Array(0);
    }
}

// ============================================================================
// IPCChannel: wraps a bidirectional pipe with Node-compatible JSON framing.
// ============================================================================

type Pipe = CModuleStreams.Pipe;

export class IPCChannel extends EventEmitter {
    private _pipe: Pipe | null;
    private _decoder: MessageDecoder;
    private _connected: boolean = false;

    constructor(pipe: Pipe) {
        super();
        this._pipe = pipe;
        this._decoder = new MessageDecoder();

        this._decoder.on('message', (msg: any) => {
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

        this._pipe.startRead();
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
        const json = JSON.stringify(message);
        if (json === undefined) {
            throw new TypeError('IPC message could not be serialized');
        }
        const frame = engine.encodeString(json + '\n');
        // pipe.write returns a promise; surface async write failures as channel
        // errors instead of leaving an unhandled rejection.
        const result = this._pipe.write(frame) as unknown as Promise<number> | undefined;
        if (result && typeof (result as Promise<number>).catch === 'function') {
            (result as Promise<number>).catch((err: Error) => this.emit('error', err));
        }
    }

    close(): void {
        if (this._pipe) {
            try {
                this._pipe.close();
            } catch { /* ignore */ }
            this._pipe = null;
        }
        this._decoder.reset();
        if (this._connected) {
            this._connected = false;
            this.emit('close');
        }
    }

    get connected(): boolean {
        return this._connected;
    }
}
