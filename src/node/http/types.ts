import { Readable, Writable } from "../stream";
import { Socket, Server as NetServer } from "../net";

export interface IncomingHttpHeaders extends NodeJS.Dict<string | string[]> {
    accept?: string | undefined;
    'accept-encoding'?: string | undefined;
    'accept-language'?: string | undefined;
    'accept-patch'?: string | undefined;
    'accept-ranges'?: string | undefined;
    'access-control-allow-credentials'?: string | undefined;
    'access-control-allow-headers'?: string | undefined;
    'access-control-allow-methods'?: string | undefined;
    'access-control-allow-origin'?: string | undefined;
    'access-control-expose-headers'?: string | undefined;
    'access-control-max-age'?: string | undefined;
    'access-control-request-headers'?: string | undefined;
    'access-control-request-method'?: string | undefined;
    age?: string | undefined;
    allow?: string | undefined;
    'alt-svc'?: string | undefined;
    authorization?: string | undefined;
    'cache-control'?: string | undefined;
    connection?: string | undefined;
    'content-disposition'?: string | undefined;
    'content-encoding'?: string | undefined;
    'content-language'?: string | undefined;
    'content-length'?: string | undefined;
    'content-location'?: string | undefined;
    'content-range'?: string | undefined;
    'content-type'?: string | undefined;
    cookie?: string | undefined;
    date?: string | undefined;
    etag?: string | undefined;
    expect?: string | undefined;
    expires?: string | undefined;
    forwarded?: string | undefined;
    from?: string | undefined;
    host?: string | undefined;
    'if-match'?: string | undefined;
    'if-modified-since'?: string | undefined;
    'if-none-match'?: string | undefined;
    'if-unmodified-since'?: string | undefined;
    'last-modified'?: string | undefined;
    location?: string | undefined;
    origin?: string | undefined;
    pragma?: string | undefined;
    'proxy-authenticate'?: string | undefined;
    'proxy-authorization'?: string | undefined;
    range?: string | undefined;
    referer?: string | undefined;
    'retry-after'?: string | undefined;
    'sec-websocket-accept'?: string | undefined;
    'sec-websocket-extensions'?: string | undefined;
    'sec-websocket-key'?: string | undefined;
    'sec-websocket-protocol'?: string | undefined;
    'sec-websocket-version'?: string | undefined;
    'set-cookie'?: string[] | undefined;
    'strict-transport-security'?: string | undefined;
    trailer?: string | undefined;
    'transfer-encoding'?: string | undefined;
    upgrade?: string | undefined;
    'user-agent'?: string | undefined;
    vary?: string | undefined;
    via?: string | undefined;
    warning?: string | undefined;
    'www-authenticate'?: string | undefined;
}

export type OutgoingHttpHeader = number | string | string[];
export interface OutgoingHttpHeaders extends NodeJS.Dict<OutgoingHttpHeader> {
    [header: string]: OutgoingHttpHeader | undefined;
}


export interface IncomingMessage extends Readable {
    socket: Socket | null;
    connection: Socket | null;
    httpVersion: string;
    httpVersionMajor: number;
    httpVersionMinor: number;
    complete: boolean;
    headers: IncomingHttpHeaders;
    headersDistinct: NodeJS.Dict<string[]>;
    rawHeaders: string[];
    trailers: NodeJS.Dict<string>;
    trailersDistinct: NodeJS.Dict<string[]>;
    rawTrailers: string[];
    aborted: boolean;
    method?: string;
    url?: string;
    statusCode?: number;
    statusMessage?: string;
    setTimeout(msecs: number, callback?: () => void): this;
    destroy(error?: Error): this;
}

export interface OutgoingMessage extends Writable {
    socket: Socket | null;
    connection: Socket | null;
    writableEnded: boolean;
    writableFinished: boolean;
    headersSent: boolean;
    sendDate: boolean;
    finished: boolean;
    chunkedEncoding: boolean;
    shouldKeepAlive: boolean;
    useChunkedEncodingByDefault: boolean;
    setTimeout(msecs: number, callback?: () => void): this;
    setHeader(name: string, value: number | string | readonly string[]): this;
    setHeaders(headers: Headers | Map<string, number | string | readonly string[]>): this;
    appendHeader(name: string, value: string | readonly string[]): this;
    getHeader(name: string): number | string | string[] | undefined;
    getHeaders(): OutgoingHttpHeaders;
    getHeaderNames(): string[];
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    flushHeaders(): void;
    addTrailers(headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void;
}

export interface ServerResponse extends OutgoingMessage {
    statusCode: number;
    statusMessage: string;
    strictContentLength: boolean;
    writeHead(statusCode: number, statusMessage?: string, headers?: OutgoingHttpHeaders | readonly string[]): this;
    writeHead(statusCode: number, headers?: OutgoingHttpHeaders | readonly string[]): this;
    writeProcessingContinue(): void;
    writeEarlyHints(hints: Record<string, string | string[]>, callback?: () => void): void;
}

export interface ListenOptions {
    port?: number;
    host?: string;
    path?: string;
    backlog?: number;
    exclusive?: boolean;
    readableAll?: boolean;
    writableAll?: boolean;
    ipv6Only?: boolean;
    signal?: AbortSignal;
}

export interface Server extends NetServer {
    maxHeadersCount: number | null;
    maxRequestsPerSocket: number | null;
    timeout: number;
    headersTimeout: number;
    keepAliveTimeout: number;
    keepAliveTimeoutBuffer: number;
    requestTimeout: number;
    setTimeout(msecs?: number, callback?: (socket: Socket) => void): this;
    closeAllConnections(): void;
    closeIdleConnections(): void;
}

export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;
