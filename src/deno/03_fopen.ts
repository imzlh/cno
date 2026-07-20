import { malloc } from "../utils/malloc";
import { toDenoStat, toString } from "./02_fs";
import { wrapFsClassDec as wrap, wrapFSns, wrapFSErr } from "../utils/wrap";
import { errors } from "./01_errors";
import { isWindows } from "../utils/platform";

const fs = import.meta.use('fs');
const asfs = import.meta.use('asyncfs');
const error = import.meta.use('error');
const os = import.meta.use('os');
const streams = import.meta.use('streams');
const fsFileToken = Symbol('Deno.FsFile');

export function optionsToMode(options: Deno.OpenOptions): CModuleFS.OpenFlags {
    const {
        read = false,
        write = false,  // Default: not writable
        append = false,
        truncate = false,
        create = false,
        createNew = false
    } = options;

    if (truncate && !write) throw new Error("'truncate' option requires 'write' to be true");
    if ((create || createNew) && !(write || append))
        throw new Error("'create' or 'createNew' options require 'write' or 'append' to be true");
    if (!(read || write || append)) throw new Error("'options' requires at least one option to be true");

    let flags = read && (write || append) ? fs.OPEN_RDWR
        : (write || append) ? fs.OPEN_WRONLY
        : fs.OPEN_RDONLY;
    if (append) flags |= fs.OPEN_APPEND;
    if (create || createNew) flags |= fs.OPEN_CREAT;
    if (createNew) flags |= fs.OPEN_EXCL;
    if (truncate) flags |= fs.OPEN_TRUNC;
    return flags;
}

const toEpochMilliseconds = (t: number | bigint | Date) => {
    if (typeof t === "number" || typeof t === "bigint") {
        return Number(t) * 1000;
    } else {
        return t.getTime();
    }
};

const seekPosition = (size: number, current: number, offset: number | bigint, whence: Deno.SeekMode): number => {
    const off = Number(offset);
    if (whence === Deno.SeekMode.Start) return Math.max(0, off);
    if (whence === Deno.SeekMode.Current) return Math.max(0, current + off);
    if (whence === Deno.SeekMode.End) return Math.max(0, size + off);
    throw new TypeError("Invalid seek mode");
};

function assertUint8Array(value: unknown): asserts value is Uint8Array<ArrayBuffer> {
    if (!(value instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
}

function hasErrno(value: unknown, code: number): boolean {
    return typeof value === 'object' && value !== null
        && Reflect.get(value, 'code') === code;
}

export class FsFile implements Deno.FsFile {
    readable: ReadableStream<Uint8Array<ArrayBuffer>>;
    writable: WritableStream<Uint8Array<ArrayBufferLike>>;
    fpointer = 0;
    private $handle: CModuleAsyncFS.FileHandle;
    private $append: boolean;
    private $tty: CModuleStreams.TTY | undefined;
    private $closed = false;

    constructor(
        $handle?: CModuleAsyncFS.FileHandle,
        $append = false,
        token?: symbol,
        $tty?: CModuleStreams.TTY,
    ) {
        if (token !== fsFileToken || !$handle) {
            throw new TypeError("'Deno.FsFile' cannot be constructed, use 'Deno.open()' or 'Deno.openSync()' instead");
        }
        this.$handle = $handle;
        this.$append = $append;
        this.$tty = $tty;
        this.readable = new ReadableStream({
            pull: async (controller) => {
                try {
                    const buf = malloc(controller);
                    const n = this.$tty
                        ? await this.$tty.read(buf)
                        : await $handle.read(buf, this.fpointer);
                    if (n === null || n === 0) {
                        controller.close();
                        this.close();
                        return;
                    }
                    controller.enqueue(buf.slice(0, n));
                    this.fpointer += n;
                } catch (e) {
                    controller.error(wrapFSErr(e));
                }
            },
            cancel: () => this.close(),
            type: "bytes"
        });
        this.writable = new WritableStream<Uint8Array<ArrayBuffer>>({
            write: async (chunk, control) => {
                try {
                    this.assertOpen();
                    const offset = this.$tty ? undefined : await this.writeOffset();
                    let written = 0;
                    while (written < chunk.length) {
                        const n = this.$tty
                            ? await this.$tty.write(chunk.subarray(written))
                            : await $handle.write(chunk.subarray(written), offset! + written);
                        written += n;
                    }
                    this.fpointer = (offset ?? this.fpointer) + written;
                } catch (e) {
                    control.error(e);
                }
            },
            close: () => this.close(),
            abort: () => this.close(),
        });
    }

    private assertOpen(): void {
        if (this.$closed) throw new errors.BadResource('File closed');
    }

    private async writeOffset(): Promise<number> {
        this.assertOpen();
        if (!this.$append) return this.fpointer;
        return (await this.$handle.stat()).size;
    }

    private writeOffsetSync(): number {
        this.assertOpen();
        if (!this.$append) return this.fpointer;
        return fs.lstat(this.$handle.path).size;
    }

    private readTtySync(p: Uint8Array): number | null {
        if (isWindows) {
            const n = fs.read(this.$handle.fileno(), p);
            return n === 0 ? null : n;
        }
        const tty = this.$tty!;
        let restore = false;
        try {
            tty.setBlocking(true);
            restore = true;
            return tty.readSync(p);
        } finally {
            if (restore) {
                try { tty.setBlocking(false); } catch {}
            }
        }
    }

    @wrap
    async write(data: Uint8Array<ArrayBuffer>) {
        assertUint8Array(data);
        this.assertOpen();
        const offset = this.$tty ? undefined : await this.writeOffset();
        // libuv's async zero-length write path can report an allocation error
        // instead of the descriptor's real errno. Use the synchronous native
        // operation for this edge case so /dev/full still reports ENOSPC.
        const n = data.byteLength === 0
            ? (this.$tty
                ? (isWindows ? fs.write(this.$handle.fileno(), data) : this.$tty.writeSync(data))
                : fs.pwrite(this.$handle.fileno(), data, offset!))
            : (this.$tty ? await this.$tty.write(data) : await this.$handle.write(data, offset!));
        this.fpointer = (offset ?? this.fpointer) + n;
        return n;
    }

    @wrap
    writeSync(p: Uint8Array): number {
        assertUint8Array(p);
        this.assertOpen();
        const fno = this.$handle.fileno();
        const offset = this.$tty ? undefined : this.writeOffsetSync();
        const n = this.$tty
            ? (isWindows ? fs.write(fno, p) : this.$tty.writeSync(p))
            : fs.pwrite(fno, p, offset!);
        this.fpointer = (offset ?? this.fpointer) + n;
        return n;
    }

    @wrap
    async read(p: Uint8Array<ArrayBuffer>): Promise<number | null> {
        assertUint8Array(p);
        if (p.byteLength === 0) return 0;
        this.assertOpen();
        const n = this.$tty
            ? await this.$tty.read(p)
            : await this.$handle.read(p, this.fpointer);
        if (n === null || n === 0) return null;
        this.fpointer += n;
        return n;
    }

    @wrap
    readSync(p: Uint8Array): number | null {
        assertUint8Array(p);
        if (p.byteLength === 0) return 0;
        this.assertOpen();
        const fno = this.$handle.fileno();
        const n = this.$tty ? this.readTtySync(p) : fs.pread(fno, p, this.fpointer);
        if (n === null || n === 0) return null;
        this.fpointer += n;
        return n;
    }

    @wrap
    truncate(len?: number): Promise<void> {
        this.assertOpen();
        return this.$handle.truncate(Math.max(0, len ?? 0));
    }

    @wrap
    truncateSync(len?: number): void {
        this.assertOpen();
        fs.ftruncate(this.$handle.fileno(), Math.max(0, len ?? 0));
    }

    @wrap
    async stat(): Promise<Deno.FileInfo> {
        this.assertOpen();
        return toDenoStat(await this.$handle.stat());
    }

    @wrap
    statSync(): Deno.FileInfo {
        this.assertOpen();
        const stat = fs.stat(this.$handle.path);
        return toDenoStat(stat);
    }

    @wrap
    async seek(offset: number | bigint, whence: Deno.SeekMode): Promise<number> {
        this.assertOpen();
        const size = (await this.$handle.stat()).size;
        this.fpointer = seekPosition(size, this.fpointer, offset, whence);
        return this.fpointer;
    }

    @wrap
    seekSync(offset: number | bigint, whence: Deno.SeekMode): number {
        this.assertOpen();
        const size = fs.lstat(this.$handle.path).size;
        this.fpointer = seekPosition(size, this.fpointer, offset, whence);
        return this.fpointer;
    }

    @wrap
    sync(): Promise<void> {
        this.assertOpen();
        return this.$handle.sync();
    }

    @wrap
    syncData(): Promise<void> {
        this.assertOpen();
        return this.$handle.datasync();
    }

    @wrap
    syncSync(): void {
        this.assertOpen();
        fs.fsync(this.$handle.fileno());
    }

    @wrap
    syncDataSync(): void {
        this.assertOpen();
        fs.fdatasync(this.$handle.fileno());
    }

    lock(exclusive?: boolean): Promise<void> {
        return Promise.resolve().then(() => this.lockSync(exclusive));
    }

    @wrap
    lockSync(exclusive?: boolean): void {
        this.assertOpen();
        const fd = this.$handle.fileno();
        fs.flock(fd, exclusive ? (fs.LOCK_EX | fs.LOCK_NB) : (fs.LOCK_SH | fs.LOCK_NB));
    }

    unlock(): Promise<void> {
        return Promise.resolve().then(() => this.unlockSync());
    }

    @wrap
    unlockSync(): void {
        this.assertOpen();
        const fd = this.$handle.fileno();
        fs.flock(fd, fs.LOCK_UN);
    }

    async tryLock(exclusive?: boolean): Promise<boolean> {
        return this.tryLockSync(exclusive);
    }

    tryLockSync(exclusive?: boolean): boolean {
        this.assertOpen();
        const fd = this.$handle.fileno();
        try{
            fs.flock(fd, exclusive ? (fs.LOCK_EX | fs.LOCK_NB) : (fs.LOCK_SH | fs.LOCK_NB));
            return true;
        } catch (e) {
            if (hasErrno(e, error.errno.EAGAIN)) {
                return false;
            }
            throw e;
        }
    }

    @wrap
    utime(atime: number | Date, mtime: number | Date): Promise<void> {
        this.assertOpen();
        return this.$handle.utime(toEpochMilliseconds(atime), toEpochMilliseconds(mtime));
    }

    @wrap
    utimeSync(atime: number | Date, mtime: number | Date): void {
        this.assertOpen();
        fs.futimes(this.$handle.fileno(), toEpochMilliseconds(atime) / 1000, toEpochMilliseconds(mtime) / 1000);
    }

    isTerminal(): boolean {
        return !this.$closed && this.$tty !== undefined;
    }

    setRaw(mode: boolean, options?: Deno.SetRawOptions): void {
        this.assertOpen();
        if (!this.$tty) throw new Deno.errors.NotSupported();
        this.$tty.setRaw(mode, options === undefined ? false : !!options.cbreak);
    }

    close(): void {
        if (this.$closed) return;
        this.$closed = true;
        try {
            this.$tty?.close();
        } finally {
            this.$handle.close();
        }
    }

    [Symbol.dispose]() {
        this.close();
    }
}

export { FsFile as FSFile };

function openFsFile(
    pathStr: string,
    fno: number,
    flag: CModuleFS.OpenFlags,
    mode: number | undefined,
    append: boolean,
    read: boolean,
): FsFile {
    let tty: CModuleStreams.TTY | undefined;
    let ttyFd: number | undefined;
    try {
        if (os.guessHandle(fno) === 'tty') {
            ttyFd = fs.open(pathStr, flag, mode);
            tty = new streams.TTY(ttyFd, read);
            if (!isWindows && tty.fileno !== ttyFd) {
                fs.close(ttyFd);
                ttyFd = undefined;
            }
        }
        const handle = asfs.newStdioFile(pathStr, fno);
        return new FsFile(handle, append, fsFileToken, tty);
    } catch (e) {
        try { tty?.close(); } catch {}
        if (!tty && ttyFd !== undefined) {
            try { fs.close(ttyFd); } catch {}
        }
        try { fs.close(fno); } catch {}
        throw e;
    }
}

Object.assign(Deno, wrapFSns({
    async open(path, opt) {
        let flag: CModuleFS.OpenFlags = "r";
        if (opt) flag = optionsToMode(opt);
        const pathStr = toString(path);
        const fno = fs.open(pathStr, flag, opt?.mode);
        return openFsFile(pathStr, fno, flag, opt?.mode, !!opt?.append, !opt || opt.read === true);
    },

    openSync(path, opt) {
        let flag: CModuleFS.OpenFlags = "r";
        if (opt) flag = optionsToMode(opt);
        const pathStr = toString(path);
        const fno = fs.open(pathStr, flag, opt?.mode);
        return openFsFile(pathStr, fno, flag, opt?.mode, !!opt?.append, !opt || opt.read === true);
    },

    create(path) {
        return Deno.open(path, { read: true, write: true, create: true, truncate: true });
    },

    createSync(path) {
        return Deno.openSync(path, { read: true, write: true, create: true, truncate: true });
    },
}))

Object.assign(Deno, { FsFile });
