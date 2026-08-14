/**
 * node:http2 stream classes: ClientHttp2Stream and ServerHttp2Stream, the Duplex
 * facades over @cnojs/http/h2's protocol streams.
 */

const engine = import.meta.use('engine');

import { Duplex } from '../stream';
import { Buffer } from '../buffer';
import { type H2Stream as ProtocolH2Stream } from '@cnojs/http/h2';
import type { H2Header } from '@cnojs/http/h2-native';
import { constants } from './constants';
import { contentLengthMismatch, declaredContentLength, headerObject, toHeaderPairs } from './headers';

/* ── Client stream ────────────────────────────────────────────── */

export class ClientHttp2Stream extends Duplex {
    readonly id: number;
    private readonly h2Stream: ProtocolH2Stream;
    private readonly requestMethod: string;
    private bodyPumpStarted = false;
    private drainWaiter: (() => void) | null = null;

    constructor(h2Stream: ProtocolH2Stream, requestMethod = 'GET') {
        super({ allowHalfOpen: true });
        this.h2Stream = h2Stream;
        this.id = h2Stream.id;
        this.requestMethod = requestMethod.toUpperCase();
        h2Stream.whenError(error => this.destroy(error));
        h2Stream.whenHeaders((headers, _ended) => {
            this.emit('response', headerObject(headers), 0);
            // EOF is pushed by pumpBody alone. bodyChunks() returns immediately
            // when the stream is already ended, so an `ended` HEADERS still
            // reaches EOF — and routing every end through one place keeps the
            // content-length check below authoritative instead of racing a
            // second push(null) that would emit a clean `end` first.
            void this.pumpBody();
        });
    }

    /** Responses that carry no body regardless of content-length (RFC 9110 §8.6). */
    private expectsNoBody(): boolean {
        if (this.requestMethod === 'HEAD' || this.requestMethod === 'CONNECT') return true;
        const pairs = this.h2Stream.headerList;
        if (!pairs) return false;
        for (const [name, value] of pairs) {
            if (name !== ':status') continue;
            const status = Number(value);
            return status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);
        }
        return false;
    }

    private async pumpBody(): Promise<void> {
        if (this.bodyPumpStarted) return;
        this.bodyPumpStarted = true;
        let received = 0;
        try {
            for await (const chunk of this.h2Stream.bodyChunks()) {
                received += chunk.byteLength;
                if (!this.push(Buffer.from(chunk)) && !this.destroyed) {
                    // Stop pulling until _read() asks again. Draining regardless
                    // would move unbounded growth into this Readable's buffer.
                    await new Promise<void>(resolve => { this.drainWaiter = resolve; });
                }
            }
            // See declaredContentLength: a response truncated by RST_STREAM(0) is
            // otherwise delivered as a complete one, which silently corrupts any
            // caller that trusts the body it just read.
            const declared = this.expectsNoBody()
                ? null
                : declaredContentLength(this.h2Stream.headerList);
            if (declared !== null && declared !== received) {
                this.destroy(contentLengthMismatch(this.id, declared, received));
                return;
            }
            this.push(null);
        } catch (e) {
            this.destroy(e instanceof Error ? e : new Error(String(e)));
        }
    }

    private releaseDrain(): void {
        const waiter = this.drainWaiter;
        this.drainWaiter = null;
        waiter?.();
    }

    _read(): void {
        if (this.drainWaiter) this.releaseDrain();
        else void this.pumpBody();
    }

    _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
        this.releaseDrain();
        cb(err);
    }

    _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        try {
            const buf = typeof chunk === 'string'
                ? engine.encodeString(chunk)
                : chunk instanceof Uint8Array
                    ? chunk
                    : Buffer.from(String(chunk));
            this.h2Stream.sendData(buf, false);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    _final(cb: (e?: Error | null) => void): void {
        try {
            this.h2Stream.sendData(new Uint8Array(0), true);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    close(code?: number): void {
        this.h2Stream.abort(code ?? 0);
        this.destroy();
    }
}

/* ── Server stream (Node Http2Stream-ish) ─────────────────────── */

export class ServerHttp2Stream extends Duplex {
    readonly id: number;
    private readonly h2Stream: ProtocolH2Stream;
    private responded = false;
    private bodyPumpStarted = false;
    private drainWaiter: (() => void) | null = null;

    constructor(h2Stream: ProtocolH2Stream) {
        super({ allowHalfOpen: true });
        this.h2Stream = h2Stream;
        this.id = h2Stream.id;
        h2Stream.whenError(error => this.destroy(error));
        void this.pumpBody();
    }

    private async pumpBody(): Promise<void> {
        if (this.bodyPumpStarted) return;
        this.bodyPumpStarted = true;
        let received = 0;
        try {
            for await (const chunk of this.h2Stream.bodyChunks()) {
                received += chunk.byteLength;
                if (!this.push(Buffer.from(chunk)) && !this.destroyed) {
                    // Load-bearing: h2.ts has no transport backpressure, so its
                    // 16 MiB server body cap only fires while bytes stay buffered
                    // there. Draining unconditionally would defeat that cap and
                    // grow this Readable without bound instead.
                    await new Promise<void>(resolve => { this.drainWaiter = resolve; });
                }
            }
            // bodyChunks() returned without throwing, which h2.ts does for a real
            // END_STREAM and for acceptClose(0) alike. A declared length that does
            // not match what arrived is the only way to tell a truncated body from
            // a complete one, so fail the stream rather than emit a clean `end`.
            const declared = declaredContentLength(this.h2Stream.headerList);
            if (declared !== null && declared !== received) {
                this.destroy(contentLengthMismatch(this.id, declared, received));
                return;
            }
            this.push(null);
        } catch (e) {
            this.destroy(e instanceof Error ? e : new Error(String(e)));
        }
    }

    private releaseDrain(): void {
        const waiter = this.drainWaiter;
        this.drainWaiter = null;
        waiter?.();
    }

    _read(): void {
        if (this.drainWaiter) this.releaseDrain();
        else void this.pumpBody();
    }

    _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
        this.releaseDrain();
        cb(err);
    }

    _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        try {
            if (!this.responded) {
                this.respond({ ':status': 200 });
            }
            const buf = typeof chunk === 'string'
                ? engine.encodeString(chunk)
                : chunk instanceof Uint8Array
                    ? chunk
                    : Buffer.from(String(chunk));
            this.h2Stream.sendData(buf, false);
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    _final(cb: (e?: Error | null) => void): void {
        try {
            if (!this.responded) {
                this.respond({ ':status': 200 }, { endStream: true });
            } else {
                this.h2Stream.sendData(new Uint8Array(0), true);
            }
            cb();
        } catch (e) {
            cb(e instanceof Error ? e : new Error(String(e)));
        }
    }

    respond(headers: Record<string, unknown>, options?: { endStream?: boolean }): void {
        this.respondPairs(toHeaderPairs(headers), options);
    }

    respondPairs(pairs: H2Header[], options?: { endStream?: boolean }): void {
        if (this.responded) throw new Error('HTTP/2 headers already sent');
        this.responded = true;
        if (!pairs.some(([n]) => n === ':status' || n === constants.HTTP2_HEADER_STATUS)) {
            pairs.unshift([':status', '200']);
        }
        this.h2Stream.respond(pairs, options?.endStream === true);
    }

    end(chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
        return Duplex.prototype.end.call(this, chunk, encodingOrCb, cb) as this;
    }

    close(code?: number): void {
        this.h2Stream.abort(code ?? 0);
        this.destroy();
    }
}
