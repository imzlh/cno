/**
 * node:http2 — real HTTP/2 via @cnojs/http h2 adapter (nghttp2 Session).
 * Cleartext prior-knowledge (h2c) and TLS+ALPN h2 when the socket is already TLS.
 *
 * This file is a facade: the implementation lives in the sibling modules listed
 * below, and the export list here IS the public API. It is deliberately spelled
 * out name by name rather than using `export *`, because the submodules also
 * export internals to each other (error factories, header validators, transport
 * adoption) and `export *` would silently publish those as `node:http2` exports.
 *
 *   constants.ts   http2.constants, sensitiveHeaders, SETTINGS id tables
 *   errors.ts      Node-shaped error factories, ensureH2, warn-once flags
 *   headers.ts     header validation, header<->pair conversion, content-length
 *   transport.ts   Socket/TLSSocket adoption for nghttp2, req.socket proxy
 *   stream.ts      ClientHttp2Stream / ServerHttp2Stream
 *   message.ts     Http2ServerRequest / Http2ServerResponse (compat views)
 *   session.ts     Http2Session / ClientHttp2Session
 *   server.ts      Http2Server / Http2SecureServer, createServer(+Secure),
 *                  performServerHandshake
 *   connect.ts     connect(), __resolveConnectTarget
 *   settings.ts    getDefaultSettings / getPackedSettings / getUnpackedSettings
 */

export { constants, sensitiveHeaders } from './constants';

export { createServer, createSecureServer, performServerHandshake } from './server';

export { connect, __resolveConnectTarget } from './connect';
export type { ResolvedConnectTarget } from './connect';

export { getDefaultSettings, getPackedSettings, getUnpackedSettings } from './settings';

export type { ClientHttp2Session } from './session';
export type { Http2Server, Http2SecureServer } from './server';
export type { ClientHttp2Stream, ServerHttp2Stream } from './stream';

// Node exports these as values (subclassable / instanceof-checkable), not just types.
export { Http2ServerRequest, Http2ServerResponse } from './message';
