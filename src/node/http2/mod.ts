// node:http2 — redirects to h1. createSecureServer → https, createServer → http.

import { createServer as createHttpsServer, type Server, type HttpsServerOptions } from '../https';
import { createServer as createHttpServer, type ServerOptions } from '../http';
import type { RequestListener } from '../http/types';
import { EventEmitter } from '../events';
import { Buffer } from '../buffer';

export const constants = {
    NGHTTP2_NO_ERROR: 0,
    NGHTTP2_PROTOCOL_ERROR: 1,
    NGHTTP2_INTERNAL_ERROR: 2,
    NGHTTP2_FLOW_CONTROL_ERROR: 3,
    NGHTTP2_SETTINGS_TIMEOUT: 4,
    NGHTTP2_STREAM_CLOSED: 5,
    NGHTTP2_FRAME_SIZE_ERROR: 6,
    NGHTTP2_REFUSED_STREAM: 7,
    NGHTTP2_CANCEL: 8,
    NGHTTP2_COMPRESSION_ERROR: 9,
    NGHTTP2_CONNECT_ERROR: 10,
    NGHTTP2_ENHANCE_YOUR_CALM: 11,
    NGHTTP2_INADEQUATE_SECURITY: 12,
    NGHTTP2_HTTP_1_1_REQUIRED: 13,

    NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
    NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
    NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
    NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
    NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
    NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,

    HTTP2_HEADER_STATUS: ':status',
    HTTP2_HEADER_METHOD: ':method',
    HTTP2_HEADER_AUTHORITY: ':authority',
    HTTP2_HEADER_SCHEME: ':scheme',
    HTTP2_HEADER_PATH: ':path',
    HTTP2_HEADER_CONTENT_TYPE: 'content-type',
    HTTP2_HEADER_CONTENT_LENGTH: 'content-length',

    HTTP2_METHOD_GET: 'GET',
    HTTP2_METHOD_POST: 'POST',

    HTTP_STATUS_OK: 200,
    HTTP_STATUS_NOT_FOUND: 404,

    DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
    DEFAULT_SETTINGS_ENABLE_PUSH: 1,
    DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,

    NGHTTP2_SESSION_SERVER: 0,
    NGHTTP2_SESSION_CLIENT: 1,

    NGHTTP2_STREAM_STATE_IDLE: 1,
    NGHTTP2_STREAM_STATE_OPEN: 2,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
    NGHTTP2_STREAM_STATE_CLOSED: 7,

    NGHTTP2_FLAG_NONE: 0,
    NGHTTP2_FLAG_END_STREAM: 1,
    NGHTTP2_FLAG_END_HEADERS: 4,
    NGHTTP2_FLAG_ACK: 1,
    NGHTTP2_FLAG_PADDED: 8,
    NGHTTP2_FLAG_PRIORITY: 32,
};

export interface Http2SecureServerOptions {
    key?: string | Uint8Array;
    cert?: string | Uint8Array;
    ca?: string | Uint8Array | Array<string | Uint8Array>;
    passphrase?: string;
    pfx?: string | Uint8Array;
    allowHTTP1?: boolean;
    maxSessionMemory?: number;
    streamResetBurst?: number;
    streamResetRate?: number;
    [key: string]: unknown;
}

type Http2PemInput = string | Uint8Array;

function toTlsPemInput(value: Http2PemInput | undefined): string | Buffer | undefined {
    if (value === undefined || typeof value === 'string') return value;
    return value instanceof Buffer ? value : Buffer.from(value);
}

function toTlsCaInput(value: Http2SecureServerOptions['ca']): HttpsServerOptions['ca'] {
    if (Array.isArray(value)) return value.map(toTlsPemInput).filter(input => input !== undefined);
    return toTlsPemInput(value);
}

export function createSecureServer(
    options?: Http2SecureServerOptions | RequestListener,
    requestListener?: RequestListener,
): Server {
    if (typeof options === 'function') {
        requestListener = options;
        options = undefined;
    }
    const httpsOpts: HttpsServerOptions = {
        key: toTlsPemInput(options?.key),
        cert: toTlsPemInput(options?.cert),
        ca: toTlsCaInput(options?.ca),
        passphrase: options?.passphrase,
        pfx: toTlsPemInput(options?.pfx),
    };
    return createHttpsServer(httpsOpts, requestListener);
}

export function createServer(
    optionsOrListener?: ServerOptions | RequestListener,
    requestListener?: RequestListener,
): Server {
    if (typeof optionsOrListener === 'function') {
        return createHttpServer({}, optionsOrListener);
    }
    return createHttpServer(optionsOrListener ?? {}, requestListener);
}

export interface ClientHttp2Session extends EventEmitter {
    request(): never;
    close(cb?: () => void): void;
    destroy(): void;
    socket: null;
    alpnProtocol: 'h2';
    encrypted: false;
    remoteSettings: Record<string, never>;
    localSettings: Record<string, never>;
    pendingSettingsAck: false;
    type: 2;
}

export function connect(
    _authority: string | URL,
    _options?: Record<string, unknown>,
    listener?: (session: ClientHttp2Session, socket: ClientHttp2Session) => void,
): ClientHttp2Session {
    const session = new EventEmitter() as ClientHttp2Session;
    Object.assign(session, {
        request() { throw new Error('HTTP/2 client sessions are not supported'); },
        close(cb?: () => void) { cb?.(); },
        destroy() {},
        socket: null,
        alpnProtocol: 'h2',
        encrypted: false,
        remoteSettings: {},
        localSettings: {},
        pendingSettingsAck: false,
        type: 2,
    });
    if (listener) session.once('connect', listener);
    queueMicrotask(() => session.emit('connect', session, session));
    return session;
}

export type Http2Server = Server;
export type Http2SecureServer = Server;
