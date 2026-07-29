/**
 * Minimal Node ambients for type-checking cno's node polyfills.
 * Full @types/node is intentionally NOT loaded (web-globals clash with webapi).
 */

type BufferEncoding =
    | 'ascii'
    | 'utf8'
    | 'utf-8'
    | 'utf16le'
    | 'utf-16le'
    | 'ucs2'
    | 'ucs-2'
    | 'base64'
    | 'base64url'
    | 'latin1'
    | 'binary'
    | 'hex';

/**
 * Global Buffer name used by polyfills without importing node:buffer.
 * Typed as Uint8Array so values assign to ByteView / module Buffer params;
 * runtime inject installs the real Buffer class on globalThis.
 */
type Buffer = Uint8Array;

interface BufferConstructor {
    readonly prototype: Uint8Array;
    new (str: string, encoding?: BufferEncoding): Buffer;
    new (size: number): Buffer;
    new (array: ArrayLike<number> | ArrayBufferLike): Buffer;
    from(arrayBuffer: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
    from(data: ArrayLike<number> | string | Uint8Array): Buffer;
    from(str: string, encoding?: BufferEncoding): Buffer;
    of(...items: number[]): Buffer;
    alloc(size: number, fill?: string | Uint8Array | number, encoding?: BufferEncoding): Buffer;
    allocUnsafe(size: number): Buffer;
    allocUnsafeSlow(size: number): Buffer;
    isBuffer(obj: unknown): obj is Buffer;
    isEncoding(encoding: string): encoding is BufferEncoding;
    byteLength(string: string | ArrayBufferView | ArrayBufferLike, encoding?: BufferEncoding): number;
    concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
    compare(buf1: Uint8Array, buf2: Uint8Array): number;
    poolSize: number;
}

declare var Buffer: BufferConstructor;

declare namespace NodeJS {
    interface Dict<T> {
        [key: string]: T | undefined;
    }

    interface ErrnoException extends Error {
        errno?: number;
        code?: string;
        path?: string;
        syscall?: string;
        dest?: string;
    }

    interface ReadableStream {
        readable: boolean;
        read(size?: number): string | Buffer;
        setEncoding(encoding: BufferEncoding): this;
        pause(): this;
        resume(): this;
        isPaused(): boolean;
        pipe<T extends WritableStream>(destination: T, options?: { end?: boolean }): T;
        unpipe(destination?: WritableStream): this;
        unshift(chunk: string | Uint8Array, encoding?: BufferEncoding): void;
        wrap(oldStream: ReadableStream): this;
        [Symbol.asyncIterator](): AsyncIterableIterator<string | Buffer>;
        on(event: string, listener: (...args: unknown[]) => void): this;
    }

    interface WritableStream {
        writable: boolean;
        write(buffer: Uint8Array | string, cb?: (err?: Error | null) => void): boolean;
        write(str: string, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean;
        end(cb?: () => void): this;
        end(data: string | Uint8Array, cb?: () => void): this;
        end(str: string, encoding?: BufferEncoding, cb?: () => void): this;
    }

    interface ReadWriteStream extends ReadableStream, WritableStream {}

    interface ReadStream extends ReadableStream {
        close(cb?: (err?: Error | null) => void): void;
        bytesRead: number;
        path?: string | Buffer;
        pending: boolean;
        fd: number | null;
    }

    interface WriteStream extends WritableStream {
        close(cb?: (err?: Error | null) => void): void;
        bytesWritten: number;
        path?: string | Buffer;
        pending: boolean;
        fd: number | null;
        columns?: number;
        rows?: number;
        isTTY?: boolean;
    }

    type Signals =
        | 'SIGABRT' | 'SIGALRM' | 'SIGBUS' | 'SIGCHLD' | 'SIGCONT' | 'SIGFPE' | 'SIGHUP'
        | 'SIGILL' | 'SIGINT' | 'SIGIO' | 'SIGIOT' | 'SIGKILL' | 'SIGPIPE' | 'SIGPOLL'
        | 'SIGPROF' | 'SIGPWR' | 'SIGQUIT' | 'SIGSEGV' | 'SIGSTKFLT' | 'SIGSTOP' | 'SIGSYS'
        | 'SIGTERM' | 'SIGTRAP' | 'SIGTSTP' | 'SIGTTIN' | 'SIGTTOU' | 'SIGUNUSED' | 'SIGURG'
        | 'SIGUSR1' | 'SIGUSR2' | 'SIGVTALRM' | 'SIGWINCH' | 'SIGXCPU' | 'SIGXFSZ'
        | 'SIGBREAK' | 'SIGLOST' | 'SIGINFO';

    type Platform =
        | 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd'
        | 'sunos' | 'win32' | 'cygwin' | 'netbsd';

    type Architecture =
        | 'arm' | 'arm64' | 'ia32' | 'loong64' | 'mips' | 'mipsel' | 'ppc' | 'ppc64'
        | 'riscv64' | 's390' | 's390x' | 'x64';

    interface ProcessEnv {
        [key: string]: string | undefined;
    }

    interface ProcessVersions {
        node: string;
        v8: string;
        modules?: string;
        http_parser?: string;
        llhttp?: string;
        uv?: string;
        zlib?: string;
        brotli?: string;
        ares?: string;
        openssl?: string;
        napi?: string;
        cldr?: string;
        icu?: string;
        tz?: string;
        unicode?: string;
        nghttp2?: string;
        acorn?: string;
        [key: string]: string | undefined;
    }

    interface ProcessConfig {
        target_defaults: {
            cflags: unknown[];
            default_configuration: string;
            defines: unknown[];
            include_dirs: unknown[];
            libraries: unknown[];
        };
        variables: Record<string, unknown>;
    }

    interface ProcessRelease {
        name: string;
        lts?: string;
        sourceUrl?: string;
        headersUrl?: string;
        libUrl?: string;
    }

    interface ProcessFeatures {
        debug: boolean;
        uv: boolean;
        ipv6: boolean;
        tls: boolean;
        tls_alpn?: boolean;
        tls_ocsp?: boolean;
        tls_sni?: boolean;
        cached_builtins?: boolean;
        inspector?: boolean;
        require_module?: boolean;
        typescript?: boolean | string;
        [key: string]: unknown;
    }

    interface ProcessPermission {
        has(scope?: string, reference?: string): boolean;
    }

    interface ProcessReport {
        compact?: boolean;
        directory?: string;
        filename?: string;
        getReport(err?: Error): object;
        reportOnFatalError?: boolean;
        reportOnSignal?: boolean;
        reportOnUncaughtException?: boolean;
        excludeEnv?: boolean;
        signal?: Signals;
        writeReport(fileName?: string, err?: Error): string;
        writeReport(error?: Error): string;
    }

    interface MemoryUsage {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
        arrayBuffers: number;
    }

    interface CpuUsage {
        user: number;
        system: number;
    }

    interface ResourceUsage {
        fsRead: number;
        fsWrite: number;
        involuntaryContextSwitches: number;
        ipcReceived: number;
        ipcSent: number;
        majorPageFault: number;
        maxRSS: number;
        minorPageFault: number;
        sharedMemorySize: number;
        signalsCount: number;
        swappedOut: number;
        systemCPUTime: number;
        unsharedDataSize: number;
        unsharedStackSize: number;
        userCPUTime: number;
        voluntaryContextSwitches: number;
    }

    interface Module {
        exports: unknown;
        require: NodeRequire;
        id: string;
        filename: string;
        loaded: boolean;
        parent: Module | null | undefined;
        children: Module[];
        path: string;
        paths: string[];
    }

    interface Process {
        stdout: WriteStream;
        stderr: WriteStream;
        stdin: ReadStream;
        argv: string[];
        argv0: string;
        execArgv: string[];
        execPath: string;
        env: ProcessEnv;
        pid: number;
        ppid: number;
        title: string;
        arch: Architecture;
        platform: Platform;
        version: string;
        versions: ProcessVersions;
        config: ProcessConfig;
        release: ProcessRelease;
        features: ProcessFeatures;
        permission?: ProcessPermission;
        report?: ProcessReport;
        mainModule?: Module;
        cwd(): string;
        chdir(directory: string): void;
        exit(code?: number | string | null): never;
        exitCode?: number | string | null;
        nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
        on(event: string | symbol, listener: (...args: unknown[]) => void): this;
        once(event: string | symbol, listener: (...args: unknown[]) => void): this;
        off(event: string | symbol, listener: (...args: unknown[]) => void): this;
        emit(event: string | symbol, ...args: unknown[]): boolean;
        memoryUsage(): MemoryUsage;
        cpuUsage(previousValue?: CpuUsage): CpuUsage;
        resourceUsage(): ResourceUsage;
        uptime(): number;
        hrtime: {
            (time?: [number, number]): [number, number];
            bigint(): bigint;
        };
        dlopen(module: { exports?: unknown }, filename: string, flags?: number): void;
        [key: string]: unknown;
    }
}

interface NodeRequire {
    (id: string): unknown;
    resolve: {
        (id: string, options?: { paths?: string[] }): string;
        paths(request: string): string[] | null;
    };
    cache: Record<string, NodeJS.Module | undefined>;
    extensions: NodeRequireExtensions;
    main: NodeJS.Module | undefined;
}

interface NodeRequireExtensions {
    [ext: string]: (module: NodeJS.Module, filename: string) => unknown;
}

/** Present when type-checking polyfill sources that reference host process. */
declare var process: NodeJS.Process;
declare var require: NodeRequire;
