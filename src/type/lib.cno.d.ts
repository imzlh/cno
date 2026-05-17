/**
 * CNO private api
 * Access to private functions and variables powered by circu.js
 * Only exposes capabilities NOT covered by Deno API or Web API.
 */

declare namespace CNO {
    /* ================================================================ */
    /*  Signal                                                          */
    /* ================================================================ */

    export type Signal =
        | 'SIGHUP' | 'SIGINT' | 'SIGQUIT' | 'SIGILL' | 'SIGTRAP'
        | 'SIGABRT' | 'SIGBUS' | 'SIGFPE' | 'SIGKILL' | 'SIGUSR1'
        | 'SIGSEGV' | 'SIGUSR2' | 'SIGPIPE' | 'SIGALRM' | 'SIGTERM'
        | 'SIGCHLD' | 'SIGCONT' | 'SIGSTOP' | 'SIGTSTP' | 'SIGTTIN'
        | 'SIGTTOU' | 'SIGURG' | 'SIGXCPU' | 'SIGXFSZ' | 'SIGVTALRM'
        | 'SIGPROF' | 'SIGWINCH' | 'SIGPWR' | 'SIGSYS';

    /* ================================================================ */
    /*  PTY  (no Deno equivalent)                                       */
    /* ================================================================ */

    export interface OpenptyOptions {
        cols?: number;
        rows?: number;
        name?: string;
        cwd?: string;
        env?: Record<string, string>;
        argv?: string[];
    }

    export interface PtyPipe {
        readonly pid: number;
        readonly readable: ReadableStream<Uint8Array>;
        readonly writable: WritableStream<Uint8Array>;
        wait(): Promise<ExitInfo>;
        kill(signal?: Signal | number): void;
        resize(cols: number, rows: number): void;
        getwinsize(): WinSize;
    }

    export function openpty(options?: OpenptyOptions): Promise<PtyPipe>;

    /* ================================================================ */
    /*  Engine  (JS engine internals, no Deno equivalent)               */
    /* ================================================================ */

    export namespace engine {
        function serialize(obj: any): Uint8Array;
        function deserialize<T = any>(buf: Uint8Array<ArrayBuffer>): T;
        function evalModule(code: string, importMeta?: Record<string, any>): Promise<any>;
        function compileModule(code: string, importMeta?: Record<string, any>): Uint8Array;
        function encodeString(str: string): Uint8Array;
        function decodeString(buf: Uint8Array | ArrayBuffer): string;
        function setMemoryLimit(limit: number): void;
        function setMaxStackSize(size: number): void;

        export interface EngineVersions {
            quickjs: string;
            tjs: string;
            uv: string;
            curl: string;
            sqlite3: string;
            zlib: string;
            openssl: string;
            expat: string;
            core: string;
            llhttp?: string;
            wasm3?: string;
            mimalloc?: number;
        }

        export interface GarbageCollector {
            run(): void;
            setThreshold(threshold: number): void;
            getThreshold(): number;
        }

        export const versions: EngineVersions;
        export const gc: GarbageCollector;
    }

    /* ================================================================ */
    /*  Process                                                         */
    /* ================================================================ */

    export interface SpawnOptions {
        stdin?: number | 'inherit' | 'pipe' | 'ignore';
        stdout?: number | 'inherit' | 'pipe' | 'ignore';
        stderr?: number | 'inherit' | 'pipe' | 'ignore';
        cwd?: string;
        env?: Record<string, string>;
        uid?: number;
        gid?: number;
        detached?: boolean;
        /** When true, spawn the process in a PTY */
        pty?: boolean;
        /** PTY columns (default 80) */
        cols?: number;
        /** PTY rows (default 24) */
        rows?: number;
        /** Command arguments (used when pty: true, first element is the command) */
        argv?: string[];
    }

    export interface ExitInfo {
        exitStatus: number;
        termSignal: string | null;
    }

    export interface WinSize {
        cols: number;
        rows: number;
        xpixel?: number;
        ypixel?: number;
    }

    export interface ChildProcess {
        readonly pid: number;
        readonly stdin: WritableStream<Uint8Array> | null;
        readonly stdout: ReadableStream<Uint8Array> | null;
        readonly stderr: ReadableStream<Uint8Array> | null;
        /** PTY readable pipe (only when pty: true) */
        readonly readable?: ReadableStream<Uint8Array>;
        /** PTY writable pipe (only when pty: true) */
        readonly writable?: WritableStream<Uint8Array>;
        wait(): Promise<ExitInfo>;
        kill(signal?: Signal | number): void;
        /** Resize PTY window (only when pty: true) */
        resize(cols: number, rows: number): void;
        /** Get PTY window size (only when pty: true) */
        getwinsize(): WinSize;
    }

    export namespace process {
        function spawn(args: string | string[], options?: SpawnOptions): ChildProcess;
        function kill(pid: number, signal?: Signal | number): void;
        function signal(sigNum: number, handler: () => void): { close(): void };
    }

    /* ================================================================ */
    /*  Compress  (no Deno/Web API equivalent)                          */
    /* ================================================================ */

    export interface DeflateStream {
        deflate(data: Uint8Array | ArrayBuffer, flush?: number): ArrayBuffer;
        flush(flush?: number): ArrayBuffer;
        finish(data?: Uint8Array | ArrayBuffer): ArrayBuffer;
        reset(): void;
    }

    export interface InflateStream {
        inflate(data: Uint8Array | ArrayBuffer): ArrayBuffer;
        flush(): ArrayBuffer;
        reset(): void;
    }

    export namespace compress {
        function deflate(data: Uint8Array | ArrayBuffer, level?: number): ArrayBuffer;
        function inflate(data: Uint8Array | ArrayBuffer): ArrayBuffer;
        function gzip(data: Uint8Array | ArrayBuffer, level?: number): ArrayBuffer;
        function gunzip(data: Uint8Array | ArrayBuffer): ArrayBuffer;

        function createDeflate(level?: number): DeflateStream;
        function createGzip(level?: number): DeflateStream;
        function createInflate(): InflateStream;
        function createGunzip(): InflateStream;

        function crc32(data: Uint8Array | ArrayBuffer, crc?: number): number;
        function adler32(data: Uint8Array | ArrayBuffer, adler?: number): number;
    }

    /* ================================================================ */
    /*  SSL  (self-signed cert, no Deno equivalent)                     */
    /* ================================================================ */

    export interface SelfSignedCertResult {
        cert: string;
        key: string;
    }

    export namespace ssl {
        function createSelfSignedCert(options?: { commonName?: string; days?: number }): SelfSignedCertResult;
        function loadPEM(data: string, type?: string): { subject?: string; type?: string; bits?: number } | null;
    }

    /* ================================================================ */
    /*  LLHTTP  (HTTP/1.x parser + formatter, no Deno/Web equivalent)   */
    /* ================================================================ */

    export type HttpMethod =
        | 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'CONNECT'
        | 'OPTIONS' | 'TRACE' | 'COPY' | 'LOCK' | 'MKCOL' | 'MOVE'
        | 'PROPFIND' | 'PROPPATCH' | 'SEARCH' | 'UNLOCK' | 'BIND'
        | 'REBIND' | 'UNBIND' | 'ACL' | 'REPORT' | 'MKACTIVITY'
        | 'CHECKOUT' | 'MERGE' | 'MSEARCH' | 'NOTIFY' | 'SUBSCRIBE'
        | 'UNSUBSCRIBE' | 'PATCH' | 'PURGE' | 'MKCALENDAR' | 'LINK' | 'UNLINK';

    export interface HttpParserResult {
        errno: number;
        name: string;
        reason: string | null;
        bytesConsumed: number;
    }

    export interface HttpParserState {
        type: 'request' | 'response';
        httpMajor: number;
        httpMinor: number;
        statusCode: number;
        method: HttpMethod;
        upgrade: boolean;
        keepAlive: boolean;
    }

    export interface HttpParserEvents {
        onUrl?(url: string): void;
        onStatus?(status: string): void;
        onHeaderField?(field: string): void;
        onHeaderValue?(value: string): void;
        onHeadersComplete?(state: HttpParserState): void;
        onBody?(chunk: Uint8Array): void;
        onMessageComplete?(): void;
        onChunkHeader?(length: number): void;
        onChunkComplete?(): void;
    }

    export interface HttpParser {
        execute(data: Uint8Array | ArrayBuffer): HttpParserResult;
        finish(): HttpParserResult;
        pause(): void;
        resume(): void;
        reset(type?: 'request' | 'response'): void;
        readonly state: HttpParserState;
    }

    /** Structured HTTP request with streaming body */
    export interface HttpRequestMessage {
        method: HttpMethod;
        url: string;
        httpVersion: string;
        headers: Headers;
        body: ReadableStream<Uint8Array> | null;
        upgrade: boolean;
        keepAlive: boolean;
    }

    /** Structured HTTP response with streaming body */
    export interface HttpResponseMessage {
        statusCode: number;
        statusText: string;
        httpVersion: string;
        headers: Headers;
        body: ReadableStream<Uint8Array> | null;
        keepAlive: boolean;
    }

    /** Streaming HTTP/1.x parser — feed bytes, get complete messages via onMessage */
    export interface StreamingHttpParser {
        feed(data: Uint8Array | ArrayBuffer): void;
        pause(): void;
        resume(): void;
        reset(): void;
        readonly expectContinue: boolean;
    }

    /** Format options for HTTP message serialization */
    export interface HttpFormatOptions {
        httpVersion?: string;
        noContentLength?: boolean;
    }

    export namespace llhttp {
        // Low-level: event-driven parser
        function createRequestParser(events: HttpParserEvents): HttpParser;
        function createResponseParser(events: HttpParserEvents): HttpParser;

        // High-level: streaming parser with structured output
        function createRequestStreamParser(onMessage: (msg: HttpRequestMessage) => void, onError?: (err: Error) => void): StreamingHttpParser;
        function createResponseStreamParser(onMessage: (msg: HttpResponseMessage) => void, onError?: (err: Error) => void): StreamingHttpParser;

        // One-shot parse
        function parseRequest(data: Uint8Array | ArrayBuffer): HttpRequestMessage;
        function parseResponse(data: Uint8Array | ArrayBuffer): HttpResponseMessage;

        // Format: structured data → raw bytes
        function formatRequestHead(method: HttpMethod, url: string, headers: Headers, options?: HttpFormatOptions): Uint8Array;
        function formatResponseHead(statusCode: number, statusText: string, headers: Headers, options?: HttpFormatOptions): Uint8Array;
        function formatRequest(method: HttpMethod, url: string, headers: Headers, body?: Uint8Array | string, options?: HttpFormatOptions): Uint8Array;
        function formatResponse(statusCode: number, statusText: string, headers: Headers, body?: Uint8Array | string, options?: HttpFormatOptions): Uint8Array;

        // Web API interop
        function toWebRequest(msg: HttpRequestMessage, base?: string | URL): Request;
        function toWebResponse(msg: HttpResponseMessage): Response;
        function fromWebRequest(req: Request): HttpRequestMessage;
        function fromWebResponse(res: Response): HttpResponseMessage;

        // Utilities
        function strerr(errno: number): string;
        function strstatus(statusCode: number): string;

        const METHODS: HttpMethod[];
    }
}
