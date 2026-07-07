// stdio.ts — the stdio subsystem owner.
//
// Owns the fd-backed `Stream` abstraction (pipe / tty / file), the
// stdin/stdout/stderr singletons, and the fd locking. deno/04_stdio.ts wraps
// these into the `Deno.stdin/stdout/stderr` facade; the singletons are also
// injected onto the native `streams` namespace so the node polyfill can reach
// them via import.meta.use('streams') without crossing the node/ boundary.

import { malloc } from "./malloc";
import { isPosixCompatible, isWindows } from "./platform";
import { wrapFsClassDec as wrap } from "./wrap";
import { arrayBufferBackedBytes } from "./bytes";

const os = import.meta.use('os');
const pipe = import.meta.use('streams');
const asyncfs = import.meta.use('asyncfs');
const sfs = import.meta.use('fs');

type AnyStream = CModuleStreams.Pipe | CModuleStreams.TTY | FileStdio | NullStdio;

const lockings: Record<number, boolean> = {
    [os.STDIN_FILENO]: false,
    [os.STDOUT_FILENO]: false,
    [os.STDERR_FILENO]: false,
};

const asyncQueues: Record<number, Promise<void>> = {
    [os.STDIN_FILENO]: Promise.resolve(),
    [os.STDOUT_FILENO]: Promise.resolve(),
    [os.STDERR_FILENO]: Promise.resolve(),
};

function lock(fd: number) {
    if (lockings[fd]) throw new Error("File is already locked");
    lockings[fd] = true;
}

function unlock(fd: number) {
    lockings[fd] = false;
}

function tryLock(fd: number) {
    if (lockings[fd]) throw new Error("File is already locked");
}

async function queueFd<T>(fd: number, op: () => Promise<T>): Promise<T> {
    const previous = asyncQueues[fd] ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>(resolve => { release = resolve; });
    asyncQueues[fd] = previous.then(() => current, () => current);
    await previous.catch(() => {});
    try {
        return await op();
    } finally {
        release();
    }
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
 * Minimal file-backed stdio handle (replaces the FSFile dependency for the
 * rare case of stdin/stdout redirected to a regular file). Tracks its own
 * offset and reads/writes positionally, matching FSFile's behaviour.
 */
class FileStdio {
    #h: CModuleAsyncFS.FileHandle;
    #pos = 0;

    constructor(fd: number) {
        this.#h = asyncfs.newStdioFile('stdio', fd);
    }

    async read(buf: Uint8Array): Promise<number | null> {
        if (buf.byteLength === 0) return 0;
        const n = await this.#h.read(arrayBufferBackedBytes(buf), this.#pos);
        if (n === null || n === 0) return null;
        this.#pos += n;
        return n;
    }

    readSync(buf: Uint8Array): number | null {
        if (buf.byteLength === 0) return 0;
        const n = sfs.pread(this.#h.fileno(), buf, this.#pos);
        if (n === 0) return null;
        this.#pos += n;
        return n;
    }

    async write(data: Uint8Array): Promise<number> {
        const n = await this.#h.write(arrayBufferBackedBytes(data), this.#pos);
        this.#pos += n;
        return n;
    }

    writeSync(data: Uint8Array): number {
        const n = sfs.pwrite(this.#h.fileno(), data, this.#pos);
        this.#pos += n;
        return n;
    }

    close() {
        this.#h.close();
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
                    if (isWindows && !isPosixCompatible) {
                        // Sync should use $CONIN instead
                        this.fd = sfs.open('CONIN$', 'r', 0);
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
        if (data.byteLength === 0) return 0;
        return queueFd(this.fd, () => this.stream.write(data));
    }

    @wrap
    async read(buf: Uint8Array<ArrayBuffer>): Promise<number | null> {
        if (buf.byteLength === 0) return 0;
        return queueFd(this.fd, async () => {
            if (this.type == 'file') {
                return await (this.stream as FileStdio).read(buf);
            } else {
                const stream = (this.stream as CModuleStreams.Stream);
                try {
                    const n = await stream.read(buf);
                    return n === 0 ? null : n;
                } catch {
                    return null;
                }
            }
        });
    }

    @wrap
    readSync(buf: Uint8Array): number | null {
        if (buf.byteLength === 0) return 0;
        if (this.type == 'file') {
            tryLock(this.fd);
            try { return (this.stream as FileStdio).readSync(buf); }
            finally { unlock(this.fd); }
        } else {
            // TTY/pipe fd is non-blocking (libuv) — a raw read would EAGAIN.
            // readSyncBlocking flips the stream to blocking for the read (or
            // uses the CONIN$ handle on Windows), then restores.
            return readSyncBlocking(this.stream as CModuleStreams.Stream, this.fd, buf);
        }
    }

    @wrap
    writeSync(data: Uint8Array): number {
        if (data.byteLength === 0) return 0;
        if (this.type == 'file') {
            tryLock(this.fd);
            try { return (this.stream as FileStdio).writeSync(data); }
            finally { unlock(this.fd); }
        } else if (this.type == 'null') {
            return (this.stream as NullStdio).writeSync(data);
        } else {
            return sfs.write(this.fd, data);
        }
    }

    get size(){
        if (this.type != 'tty') throw new Error('Only TTY streams have a size');
        return (this.stream as CModuleStreams.TTY).size;
    }

    @wrap
    createReadStream(): ReadableStream {
        const stream = this.stream as CModuleStreams.Stream;
        if (this.type == 'file') return new ReadableStream({
            pull: async ctrl => {
                try{
                    const buf = malloc(ctrl);
                    lock(this.fd);
                    const readed = await (this.stream as FileStdio).read(buf);
                    if (!readed) ctrl.close();
                    else ctrl.enqueue(buf.slice(0, readed));
                }catch(e){
                    ctrl.error(e);
                } finally {
                    unlock(this.fd);
                }
            }
        });
        else return new ReadableStream({
            async pull(controller) {
                try {
                    const buf = malloc(controller);
                    const n = await stream.read(buf);
                    if (n === 0) {
                        controller.close();
                    } else {
                        controller.enqueue(buf.slice(0, n));
                    }
                } catch (e) {
                    controller.error(e);
                }
            }
        });
    }

    @wrap
    createWriteStream(): WritableStream {
        return  new WritableStream({
            write: async (chunk, control) => {
                try {
                    lock(this.fd);
                    if (!await this.write(chunk)) control.error(new Error('EOF'));
                } catch (e) {
                    control.error(e);
                } finally {
                    unlock(this.fd);
                }
            }
        });
    }

    close() {
        this.stream.close();
    }

    get isTTY(){
        return this.type == 'tty';
    }

    @wrap
    setRaw(mode: boolean) {
        if (this.type != 'tty') throw new Error('Only TTY streams can be set raw');
        (this.stream as CModuleStreams.TTY).mode =
            mode ? pipe.TTY_MODE_RAW_VT : pipe.TTY_MODE_NORMAL;
    }

    get __stream() {
        return this.stream;
    }
}

// stdio singletons — the single owner of fds 0/1/2.
export const stdin = new Stream(os.STDIN_FILENO, true, true);
export const stdout = new Stream(os.STDOUT_FILENO, false, true);
export const stderr = new Stream(os.STDERR_FILENO, false, true);

// Expose to the node polyfill via the native `streams` namespace (node reaches
// them with import.meta.use('streams') instead of importing across the boundary).
Object.defineProperties(pipe, {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr }
});
