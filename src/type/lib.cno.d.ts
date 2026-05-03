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
}
