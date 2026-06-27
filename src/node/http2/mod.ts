// Stub for node:http2 — delegates to HTTPS with allowHTTP1: true
// Only covers what Vite needs: createSecureServer + constants

import { createServer, type Server, type HttpsServerOptions } from '../https';

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

    // Settings
    NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
    NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
    NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 4,
    NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 5,
    NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 6,
    NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 7,

    // Flags
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
    [key: string]: any;
}

/**
 * Stub: creates an HTTPS server (h1 + TLS). When allowHTTP1 is true (Vite's
 * default), plain HTTP/1.1 over TLS is sufficient for the dev server.
 */
export function createSecureServer(
    options: Http2SecureServerOptions,
    requestListener?: (...args: any[]) => void,
): Server {
    const httpsOpts: HttpsServerOptions = {
        key: options.key as string,
        cert: options.cert as string,
        ca: options.ca as any,
        passphrase: options.passphrase,
        pfx: options.pfx as any,
    };
    return createServer(httpsOpts, requestListener as any) as any;
}

// Re-export types that consumers might reference
export type Http2Server = Server;
export type Http2SecureServer = Server;
