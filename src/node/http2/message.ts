/**
 * node:http2 compat classes: Http2ServerRequest / Http2ServerResponse, the
 * node:http-shaped views layered over a ServerHttp2Stream.
 */

import { Readable, Writable } from '../stream';
import type { H2Header } from '@cnojs/http/h2-native';
import { invalidArgType, invalidArgValue } from './errors';
import { headerObject } from './headers';
import { sessionSocketFor } from './transport';
import type { ServerHttp2Stream } from './stream';

/**
 * Node-compatible request view layered over the protocol stream.
 *
 * Prototype accessors, not instance fields. Node exposes all of these as
 * getters on Http2ServerRequest.prototype, and the difference is observable in
 * three ways real code depends on:
 *   - `'method' in Object.getPrototypeOf(req)` — how some libraries feature-test
 *     an incoming-message-alike before deciding which adapter to use;
 *   - enumerability: instance fields land in Object.keys(req) / spreads /
 *     JSON.stringify(req), so a plain `{...req}` picked up a frozen snapshot of
 *     the headers instead of nothing;
 *   - write-through: Node backs `method`/`url` with `headers[':method']` and
 *     `headers[':path']`, so connect/express rewriting `req.url` is visible to
 *     anything that later reads the header object. With independent fields the
 *     two silently disagreed.
 */
export class Http2ServerRequest extends Readable {
    /** Backing state. Non-enumerable so it stays out of Object.keys/spread. */
    private readonly _s!: {
        stream: ServerHttp2Stream;
        headers: Record<string, string | string[]>;
        rawHeaders: string[];
        trailers: Record<string, string | string[]>;
        rawTrailers: string[];
        aborted: boolean;
        closed: boolean;
        socket: unknown;
    };

    /**
     * Accepts Node's documented 4-arg form `(stream, headers, options,
     * rawHeaders)` as well as this module's original `(stream, pairs)` where
     * `pairs` is an iterable of [name, value]. Discriminated on Array.isArray:
     * Node's 2nd argument is always a plain object, so the two never collide.
     */
    constructor(
        stream: ServerHttp2Stream,
        headers: H2Header[] | Record<string, string | string[]>,
        _options?: unknown,
        rawHeaders?: string[],
    ) {
        super();
        let headerObj: Record<string, string | string[]>;
        let raw: string[];
        if (Array.isArray(headers)) {
            headerObj = headerObject(headers as H2Header[]);
            // Node's rawHeaders includes the pseudo-headers; the previous
            // implementation stripped them, which lost :method/:path/:authority.
            raw = [];
            for (const [name, value] of headers as H2Header[]) raw.push(name, value);
        } else {
            headerObj = headers ?? {};
            if (Array.isArray(rawHeaders)) {
                raw = rawHeaders;
            } else {
                raw = [];
                for (const k of Object.keys(headerObj)) {
                    const v = headerObj[k];
                    if (Array.isArray(v)) for (const item of v) raw.push(k, item);
                    else raw.push(k, v as string);
                }
            }
        }
        Object.defineProperty(this, '_s', {
            value: {
                stream,
                headers: headerObj,
                rawHeaders: raw,
                trailers: {},
                rawTrailers: [],
                aborted: false,
                closed: false,
                socket: undefined,
            },
            enumerable: false, writable: false, configurable: false,
        });
        stream.on('data', (chunk: unknown) => this.push(chunk));
        stream.on('end', () => this.push(null));
        stream.on('error', (error: unknown) =>
            this.destroy(error instanceof Error ? error : new Error(String(error))));
        stream.on('close', () => {
            this._s.closed = true;
            if (!this.readableEnded) {
                this._s.aborted = true;
                this.emit('aborted');
            }
        });
        // Trailers arrive after the body; mirror them onto the request the way
        // node:http does, so `req.trailers` is populated by the time 'end' fires.
        stream.on('trailers', (trailers: Record<string, string | string[]>) => {
            Object.assign(this._s.trailers, trailers);
            for (const k of Object.keys(trailers)) {
                const v = trailers[k];
                if (Array.isArray(v)) for (const item of v) this._s.rawTrailers.push(k, item);
                else this._s.rawTrailers.push(k, v as string);
            }
        });
    }

    get stream(): ServerHttp2Stream { return this._s.stream; }
    get headers(): Record<string, string | string[]> { return this._s.headers; }
    get rawHeaders(): string[] { return this._s.rawHeaders; }
    get trailers(): Record<string, string | string[]> { return this._s.trailers; }
    get rawTrailers(): string[] { return this._s.rawTrailers; }
    get httpVersion(): string { return '2.0'; }
    get httpVersionMajor(): number { return 2; }
    get httpVersionMinor(): number { return 0; }
    get aborted(): boolean { return this._s.aborted; }

    get complete(): boolean {
        return this._s.aborted || this.readableEnded || this._s.closed
            || this._s.stream.destroyed === true;
    }

    get method(): string { return this._s.headers[':method'] as string; }

    set method(method: string) {
        if (typeof method !== 'string') throw invalidArgType('method', 'of type string', method);
        if (method.trim() === '') throw invalidArgValue('method', method);
        this._s.headers[':method'] = method;
    }

    get url(): string { return this._s.headers[':path'] as string; }
    set url(url: string) { this._s.headers[':path'] = url; }

    /** HTTP/2's replacement for the Host header: `:authority`, else `host`. */
    get authority(): string | string[] | undefined {
        return this._s.headers[':authority'] ?? this._s.headers.host;
    }

    get scheme(): string | string[] | undefined { return this._s.headers[':scheme']; }

    get socket(): unknown { return sessionSocketFor(this._s); }
    get connection(): unknown { return this.socket; }

    setTimeout(msecs: number, callback?: () => void): this {
        if (!this._s.closed) {
            const setTimeout = Reflect.get(this._s.stream, 'setTimeout');
            if (typeof setTimeout === 'function') setTimeout.call(this._s.stream, msecs, callback);
        }
        return this;
    }

    _read(): void {
        // The protocol stream is push-driven by nghttp2 callbacks.
    }
}


/** Node-compatible response view layered over the protocol stream. */
export class Http2ServerResponse extends Writable {
    readonly stream: ServerHttp2Stream;
    statusCode = 200;
    statusMessage = '';
    headersSent = false;
    finished = false;
    private bodyless = false;
    private headers = new Map<string, { name: string; values: string[] }>();

    constructor(stream: ServerHttp2Stream) {
        super();
        this.stream = stream;
    }

    setHeader(name: string, value: string | number | readonly string[]): this {
        if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
        const values = Array.isArray(value) ? value.map(String) : [String(value)];
        this.headers.set(name.toLowerCase(), { name, values });
        return this;
    }

    getHeader(name: string): string | string[] | undefined {
        const entry = this.headers.get(name.toLowerCase());
        if (!entry) return undefined;
        return entry.values.length === 1 ? entry.values[0] : [...entry.values];
    }

    removeHeader(name: string): void {
        if (this.headersSent) throw new Error('Cannot remove headers after they are sent to the client');
        this.headers.delete(name.toLowerCase());
    }

    writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | Record<string, unknown>,
        headers?: Record<string, unknown>,
    ): this {
        if (this.headersSent) throw new Error('Cannot write headers after they are sent to the client');
        this.statusCode = statusCode;
        this.bodyless = (statusCode >= 100 && statusCode < 200)
            || statusCode === 204 || statusCode === 205 || statusCode === 304;
        if (typeof statusMessageOrHeaders === 'string') {
            this.statusMessage = statusMessageOrHeaders;
        } else if (statusMessageOrHeaders) {
            headers = statusMessageOrHeaders;
        }
        if (headers) {
            for (const [name, value] of Object.entries(headers)) {
                if (value === undefined || value === null) continue;
                this.setHeader(name, Array.isArray(value) ? value.map(String) : String(value));
            }
        }
        const pairs: H2Header[] = [[':status', String(statusCode)]];
        for (const { name, values } of this.headers.values()) {
            const lower = name.toLowerCase();
            if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive'
                || lower === 'proxy-connection' || lower === 'upgrade') continue;
            for (const value of values) pairs.push([name, value]);
        }
        this.stream.respondPairs(pairs, { endStream: false });
        this.headersSent = true;
        return this;
    }

    _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            if (!this.headersSent) this.writeHead(this.statusCode, this.statusMessage || undefined);
            if (this.bodyless) {
                callback();
                return;
            }
            this.stream.write(chunk, encoding, callback);
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    _final(callback: (error?: Error | null) => void): void {
        try {
            if (!this.headersSent) {
                this.writeHead(this.statusCode, this.statusMessage || undefined);
                this.stream.end(() => {
                    this.finished = true;
                    callback();
                });
                return;
            }
            if (this.bodyless) {
                this.stream.end(() => {
                    this.finished = true;
                    callback();
                });
                return;
            }
            this.stream.end(() => {
                this.finished = true;
                callback();
            });
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    destroy(error?: Error | null): this {
        try {
            this.stream.close();
        } catch {
            /* already closed */
        }
        return super.destroy(error) as this;
    }
}
