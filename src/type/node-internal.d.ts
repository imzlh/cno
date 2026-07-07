declare global {
    type BufferEncoding =
        | 'ascii'
        | 'utf8'
        | 'utf-8'
        | 'utf16le'
        | 'ucs2'
        | 'ucs-2'
        | 'base64'
        | 'base64url'
        | 'latin1'
        | 'binary'
        | 'hex'
        | 'buffer';

    interface Buffer extends Uint8Array<ArrayBufferLike> {}

    const Buffer: {
        new(length: number): Buffer;
        new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
        new(array: ArrayLike<number> | Iterable<number>): Buffer;
        prototype: Buffer;
        from(value: unknown, encodingOrOffset?: unknown, length?: number): Buffer;
        concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
        isBuffer(value: unknown): value is Buffer;
    };

    const process: NodeJS.Process;
    function require(id: string): unknown;

    namespace NodeJS {
        interface ErrnoException extends Error {
            code?: string | number;
            errno?: number;
            syscall?: string;
            path?: string;
        }

        interface ProcessEnv {
            [key: string]: string | undefined;
        }

        type Architecture = string;
        type Platform = string;

        interface CpuUsage {
            user: number;
            system: number;
        }

        interface MemoryUsage {
            rss: number;
            heapTotal: number;
            heapUsed: number;
            external: number;
            arrayBuffers: number;
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

        interface ProcessVersions {
            [key: string]: string | undefined;
        }

        interface ProcessConfig {
            [key: string]: unknown;
        }

        interface ProcessRelease {
            name: string;
            sourceUrl?: string;
            headersUrl?: string;
            libUrl?: string;
            lts?: string;
        }

        interface ProcessFeatures {
            [key: string]: boolean | undefined;
        }

        interface ProcessPermission {
            has(scope: string, reference?: string): boolean;
        }

        interface ProcessReport {
            [key: string]: unknown;
        }

        interface Module {
            [key: string]: unknown;
        }

        interface Process {
            [key: string]: unknown;
            env: ProcessEnv;
            ipc?: unknown;
            pid: number;
            platform: string;
            stderr?: WriteStream;
            stdin?: ReadStream;
            stdout?: WriteStream;
            emit(event: string, ...args: unknown[]): boolean;
            emitWarning?(warning: string | Error, type?: string, code?: string): void;
        }

    interface ReadableStream {
        on(event: string, listener: (...args: unknown[]) => void): this;
        once?(event: string, listener: (...args: unknown[]) => void): this;
        off?(event: string, listener: (...args: unknown[]) => void): this;
        removeListener?(event: string, listener: (...args: unknown[]) => void): this;
        resume(): void;
    }

        interface ReadStream extends ReadableStream {
            isTTY?: boolean;
        }

        interface WriteStream {
            isTTY?: boolean;
            write(chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean;
        }
    }
}

export {};
