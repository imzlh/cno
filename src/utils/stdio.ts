// stdio.ts — the stdio subsystem owner.
//
// Owns the fd-backed `Stream` abstraction (pipe / tty / file), the
// stdin/stdout/stderr singletons, and the fd locking. deno/04_stdio.ts wraps
// these into the `Deno.stdin/stdout/stderr` facade; the singletons are also
// injected onto the native `streams` namespace so the node polyfill can reach
// them via import.meta.use('streams') without crossing the node/ boundary.

import { malloc } from "./malloc";
import { isPosixCompatible, isWindows } from "./platform";
import { wrapFsClassDec as wrap, wrapFSErr } from "./wrap";
import { errors } from "../deno/01_errors";

const os = import.meta.use('os');
const pipe = import.meta.use('streams');
const sfs = import.meta.use('fs');
const sysError = import.meta.use('error');
const timers = import.meta.use('timers');
const worker = import.meta.use('worker');

type AnyStream = CModuleStreams.Pipe | CModuleStreams.TTY | FileStdio | NullStdio;

const lockings: Record<number, boolean> = {
    [os.STDIN_FILENO]: false,
    [os.STDOUT_FILENO]: false,
    [os.STDERR_FILENO]: false,
};

const asyncQueues: Record<number, Promise<void> | undefined> = {};
const pendingReadCancels: Record<number, Set<() => void> | undefined> = {};

function registerReadCancel(fd: number, cancel: () => void): () => void {
    const entries = pendingReadCancels[fd] ?? (pendingReadCancels[fd] = new Set());
    entries.add(cancel);
    return () => {
        entries.delete(cancel);
        if (entries.size === 0) delete pendingReadCancels[fd];
    };
}

function cancelReads(fd: number): void {
    const entries = pendingReadCancels[fd];
    if (!entries) return;
    for (const cancel of [...entries]) cancel();
}

function lock(fd: number) {
    if (lockings[fd]) throw new errors.Busy("File is already locked");
    lockings[fd] = true;
}

function unlock(fd: number) {
    lockings[fd] = false;
}

function tryLock(fd: number) {
    if (lockings[fd]) throw new errors.Busy("File is already locked");
}

function queueFd<T>(fd: number, op: () => Promise<T>): Promise<T> {
    const previous = asyncQueues[fd];
    const runOp = (): Promise<T> => {
        let operation: Promise<T>;
        try { operation = Promise.resolve(op()); }
        catch (e) { operation = Promise.reject(e); }
        void operation.catch(() => {});
        return operation;
    };
    const result = previous ? previous.then(runOp) : runOp();
    const tail = result.then(() => {}, () => {});
    asyncQueues[fd] = tail;
    void tail.then(() => {
        if (asyncQueues[fd] === tail) delete asyncQueues[fd];
    });
    void result.catch(() => {});
    return result;
}

function assertUint8Array(value: unknown): asserts value is Uint8Array {
    if (!(value instanceof Uint8Array)) throw new TypeError('expected typed ArrayBufferView');
}

function isTransientTtyEio(value: unknown): value is Error {
    return value instanceof Error &&
        Reflect.get(value, 'code') === sysError.errno.EIO &&
        Reflect.get(value, '_cnoTransientTtyEio') === true;
}

/**
 * Blocking synchronous read of a stdio stream. libuv keeps the stdin fd
 * non-blocking, so a raw readSync returns EAGAIN when no input is buffered
 * (e.g. inside prompt(), especially after Deno.stdin.readable touched the fd).
 *   - POSIX  : flip the uv stream to blocking for the read, then restore. The
 *              caller pauses until input arrives (Deno/Node prompt semantics).
 *              Toggling via the uv stream keeps libuv's state consistent.
 *   - Windows: native stream.readSync throws; the fd is a real CONIN$ handle
 *              that blocks natively, so read it with fs.read.
 */
function readSyncBlocking(stream: CModuleStreams.Stream, fd: number, buf: Uint8Array): number | null {
    if (isWindows && !isPosixCompatible) {
        return sfs.read(fd, buf) || null;   // CONIN$ blocks natively
    }
    let restore = false;
    try {
        try {
            stream.setBlocking(true);
            restore = true;
        } catch {}
        return stream.readSync(buf);
    } finally {
        if (restore) {
            try {
                stream.setBlocking(false);
            } catch {}
        }
    }
}

/**
 * File-backed stdio uses the descriptor cursor shared with console and Node.
 * The methods stay synchronous so sync calls cannot overtake async calls.
 */
class FileStdio {
    #fd: number;

    constructor(fd: number) {
        this.#fd = fd;
    }

    async read(buf: Uint8Array): Promise<number | null> {
        return this.readSync(buf);
    }

    readSync(buf: Uint8Array): number | null {
        const n = sfs.read(this.#fd, buf);
        return n === 0 ? null : n;
    }

    async write(data: Uint8Array): Promise<number> {
        return this.writeSync(data);
    }

    writeSync(data: Uint8Array): number {
        return sfs.write(this.#fd, data);
    }

    close() {
        sfs.close(this.#fd);
    }
}

class NullStdio {
    async read(_buf: Uint8Array): Promise<number | null> {
        return null;
    }

    readSync(_buf: Uint8Array): number | null {
        return null;
    }

    async write(data: Uint8Array): Promise<number> {
        return data.byteLength;
    }

    writeSync(data: Uint8Array): number {
        return data.byteLength;
    }

    close() {}
}

export class Stream {
    protected type: 'pipe' | 'tty' | 'file' | 'null';
    protected stream: AnyStream;
    readonly fd: number;
    #closed = false;
    #syncReadFd: number | undefined;

    constructor(fd: number, read = true, allowInvalid = false) {
        this.fd = fd;
        if (allowInvalid) {
            try {
                sfs.fstat(fd);
            } catch {
                this.stream = new NullStdio();
                this.type = 'null';
                return;
            }
        }
        try {
            const type = os.guessHandle(fd);
            switch (type) {
                // normal pipe
                case "udp":
                case "pipe":
                case "tcp":
                case "unknown":
                    {
                        const stream = new pipe.Pipe();
                        stream.open(fd);
                        this.stream = stream;
                    }
                    this.type = 'pipe';
                break;
                case "tty":
                    {
                        const stream = new pipe.TTY(fd, read);
                        this.stream = stream;
                        try {
                            stream.mode = pipe.TTY_MODE_NORMAL;
                        } catch {}
                    }
                    this.type = 'tty';
                    if (read && isWindows && !isPosixCompatible) {
                        this.#syncReadFd = sfs.open('CONIN$', 'r', 0);
                    }
                break;
                case "file":
                    this.stream = new FileStdio(fd);
                    this.type = 'file';
                break;
            }
        } catch (e) {
            if (!allowInvalid) throw e;
            this.stream = new NullStdio();
            this.type = 'null';
        }
    }

    @wrap
    async write(data: Uint8Array) {
        assertUint8Array(data);
        this.assertOpen();
        if (data.byteLength === 0) return 0;
        if (this.type === 'file' || this.type === 'null') {
            lock(this.fd);
            try { return this.stream.writeSync(data); }
            finally { unlock(this.fd); }
        }
        return queueFd(this.fd, async () => {
            lock(this.fd);
            try { return await this.stream.write(data); }
            finally { unlock(this.fd); }
        });
    }

    @wrap
    async read(buf: Uint8Array<ArrayBuffer>): Promise<number | null> {
        return await this.readImpl(buf);
    }

    private async readImpl(
        buf: Uint8Array<ArrayBuffer>,
        signal?: AbortSignal
    ): Promise<number | null> {
        assertUint8Array(buf);
        if (buf.byteLength === 0) return 0;
        this.assertOpen();
        if (signal?.aborted) return null;
        if (this.type === 'file' || this.type === 'null') {
            lock(this.fd);
            try { return this.stream.readSync(buf); }
            finally { unlock(this.fd); }
        }
        const state: {
            canceled: boolean;
            started: boolean;
            wake: (() => void) | undefined;
        } = { canceled: false, started: false, wake: undefined };
        let nativeStream: CModuleStreams.Stream | undefined;
        let unregister = () => {};
        const cancel = () => {
            if (state.canceled) return;
            state.canceled = true;
            state.wake?.();
            if (state.started) {
                try { nativeStream?.cancelRead(); } catch {}
            }
        };
        unregister = registerReadCancel(this.fd, cancel);
        return queueFd(this.fd, async () => {
            try {
                if (state.canceled || signal?.aborted) {
                    if (signal) return null;
                    throw new errors.Interrupted('operation canceled');
                }
                this.assertOpen();
                lock(this.fd);
                nativeStream = this.stream as CModuleStreams.Stream;
                state.started = true;
                signal?.addEventListener('abort', cancel, { once: true });
                try {
                    while (true) {
                        if (state.canceled || signal?.aborted) {
                            cancel();
                            if (signal) return null;
                            throw new errors.Interrupted('operation canceled');
                        }
                        let transientError: Error;
                        try {
                            const n = await nativeStream.read(buf);
                            return n === 0 ? null : n;
                        } catch (e) {
                            if (!isTransientTtyEio(e) || this.type !== 'tty') throw e;
                            transientError = e;
                        }
                        while (true) {
                            if (state.canceled || signal?.aborted) {
                                if (signal) return null;
                                throw new errors.Interrupted('operation canceled');
                            }
                            try {
                                if ((nativeStream as CModuleStreams.TTY).isForeground()) break;
                            } catch {
                                throw transientError;
                            }
                            let wake = () => {};
                            await new Promise<void>((resolve) => {
                                const timer = timers.setTimeout(resolve, 50);
                                wake = () => {
                                    timers.clearTimeout(timer);
                                    resolve();
                                };
                                state.wake = wake;
                            });
                            if (state.wake === wake) state.wake = undefined;
                        }
                    }
                } finally {
                    signal?.removeEventListener('abort', cancel);
                    state.wake = undefined;
                    unlock(this.fd);
                }
            } finally {
                unregister();
            }
        });
    }

    @wrap
    readSync(buf: Uint8Array): number | null {
        assertUint8Array(buf);
        if (buf.byteLength === 0) return 0;
        this.assertOpen();
        if (this.type == 'file') {
            tryLock(this.fd);
            return (this.stream as FileStdio).readSync(buf);
        } else if (this.type === 'null') {
            return null;
        } else {
            return readSyncBlocking(
                this.stream as CModuleStreams.Stream,
                this.#syncReadFd ?? this.fd,
                buf
            );
        }
    }

    @wrap
    writeSync(data: Uint8Array): number {
        assertUint8Array(data);
        this.assertOpen();
        if (data.byteLength === 0) return 0;
        tryLock(this.fd);
        if (this.type == 'file') {
            return (this.stream as FileStdio).writeSync(data);
        } else if (this.type == 'null') {
            return (this.stream as NullStdio).writeSync(data);
        } else {
            return sfs.write(this.fd, data);
        }
    }

    get size(){
        if (!this.isTTY) throw new Error('Only TTY streams have a size');
        return (this.stream as CModuleStreams.TTY).size;
    }

    @wrap
    createReadStream(): ReadableStream {
        const abort = new AbortController();
        return new ReadableStream({
            type: 'bytes',
            pull: async controller => {
                try {
                    const buf = malloc(controller);
                    const n = await this.readImpl(buf, abort.signal);
                    if (n === null) {
                        controller.close();
                    } else {
                        controller.enqueue(buf.slice(0, n));
                    }
                } catch (e) {
                    controller.error(wrapFSErr(e));
                }
            },
            cancel: () => {
                cancelReads(this.fd);
                abort.abort();
            },
        });
    }

    @wrap
    createWriteStream(): WritableStream {
        return new WritableStream<Uint8Array>({
            write: async (chunk, control) => {
                try {
                    const written = await this.write(chunk);
                    if (chunk.byteLength > 0 && written === 0) {
                        throw new errors.WriteZero('failed to write to stdio');
                    }
                } catch (e) {
                    control.error(e);
                    throw e;
                }
            },
            close: () => this.close(),
            abort: () => {
                if (!this.#closed) this.close();
            },
        });
    }

    close() {
        if (this.#closed) throw new errors.BadResource('Bad resource ID');
        cancelReads(this.fd);
        this.#closed = true;
        try {
            this.stream.close();
        } finally {
            if (this.#syncReadFd !== undefined) {
                sfs.close(this.#syncReadFd);
                this.#syncReadFd = undefined;
            }
        }
    }

    get isTTY(){
        return !this.#closed && this.type == 'tty';
    }

    get isClosed() {
        return this.#closed;
    }

    @wrap
    setRaw(mode: boolean, cbreak = false) {
        if (!this.isTTY) throw new errors.BadResource('ENOTTY: Not a typewriter');
        (this.stream as CModuleStreams.TTY).setRaw(mode, cbreak);
    }

    get __stream() {
        return this.stream;
    }

    private assertOpen() {
        if (this.#closed) throw new errors.BadResource('Bad resource ID');
    }
}

// stdio singletons — the single owner of fds 0/1/2.
export const stdin = new Stream(os.STDIN_FILENO, true, true);
export const stdout = new Stream(os.STDOUT_FILENO, false, true);
export const stderr = new Stream(os.STDERR_FILENO, false, true);

if (worker.isWorker) {
    for (const standardStream of [stdin, stdout, stderr]) {
        const nativeStream = standardStream.__stream as { unref?: () => void };
        nativeStream.unref?.();
    }
}

// Expose to the node polyfill via the native `streams` namespace (node reaches
// them with import.meta.use('streams') instead of importing across the boundary).
Object.defineProperties(pipe, {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr }
});
