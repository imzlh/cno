import { malloc } from "../utils/malloc";
import { toDenoStat, toString } from "./02_fs";
import { wrapFsClassDec as wrap, wrapFSns, wrapFSErr } from "../utils/wrap";

const fs = import.meta.use('fs');
const asfs = import.meta.use('asyncfs');
const error = import.meta.use('error');

export function optionsToMode(options: Deno.OpenOptions): CModuleFS.OpenFlags {
    const {
        read = true,    // Default: readable
        write = false,  // Default: not writable
        append = false,
        truncate = false,
        create = false,
        createNew = false
    } = options;

    // Handle exclusive creation first (has highest priority)
    if (createNew) {
        if (write || append) {
            // createNew with write = 'wx' mode (exclusive write)
            // createNew with append = 'ax' mode (exclusive append)
            // For simplicity, we return base mode without 'x' suffix
            return append ? 'a' : 'w';
        }
        throw new Error('createNew requires write or append mode');
    }

    // Append mode handling (append implies write)
    if (append) {
        return read ? 'a+' : 'a';
    }

    // Write mode handling
    if (write) {
        if (truncate && create) {
            // Write mode that truncates and creates file
            return read ? 'w+' : 'w';
        } else if (read) {
            // Read-write mode without truncation
            return 'r+';
        } else {
            // Write-only mode
            return truncate ? 'w' : 'r+'; // Fallback to r+ if no truncate
        }
    }

    // Default: read-only mode
    return 'r';
}

const toDate = (t: number | bigint | Date) => {
    if (typeof t === "number" || typeof t === "bigint") {
        return Number(t);
    } else {
        return t.getTime();
    }
};


export class FSFile implements Deno.FsFile {
    readable: ReadableStream<Uint8Array<ArrayBuffer>>;
    writable: WritableStream<Uint8Array<ArrayBufferLike>>;
    fpointer = 0;

    constructor(private $handle: CModuleAsyncFS.FileHandle) {
        this.readable = new ReadableStream({
            pull: async (controller) => {
                try {
                    const buf = malloc(controller);
                    const n = await $handle.read(buf, this.fpointer);
                    if (n === null || n === 0) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(buf.slice(0, n));
                    this.fpointer += n;
                } catch (e: any) {
                    // Wrap filesystem errors to Deno errors
                    try {
                        wrapFSErr(e);
                    } catch (wrappedErr) {
                        controller.error(wrappedErr);
                        return;
                    }
                }
            },
            type: "bytes"
        });
        this.writable = new WritableStream<Uint8Array<ArrayBuffer>>({
            write: async (chunk, control) => {
                try {
                    let written = 0;
                    while (written < chunk.length) {
                        const n = await $handle.write(chunk.subarray(written), this.fpointer);
                        written += n;
                        this.fpointer += n;
                    }
                } catch (e) {
                    control.error(e);
                }
            }
        });
    }

    @wrap
    async write(data: Uint8Array<ArrayBuffer>) {
        const n = await this.$handle.write(data, this.fpointer);
        this.fpointer += n;
        return n;
    }

    @wrap
    writeSync(p: Uint8Array): number {
        const fno = this.$handle.fileno();
        const n = fs.pwrite(fno, p, this.fpointer);
        this.fpointer += n;
        return n;
    }

    @wrap
    async read(p: Uint8Array<ArrayBuffer>): Promise<number | null> {
        const n = await this.$handle.read(p, this.fpointer);
        if (n === null) return null;
        this.fpointer += n;
        return n;
    }

    @wrap
    readSync(p: Uint8Array): number | null {
        const fno = this.$handle.fileno();
        const n = fs.pread(fno, p, this.fpointer);
        this.fpointer += n;
        return n;
    }

    @wrap
    truncate(len?: number): Promise<void> {
        return this.$handle.truncate(len);
    }

    truncateSync(len?: number): void {
        throw new Deno.errors.NotSupported();
    }

    @wrap
    async stat(): Promise<Deno.FileInfo> {
        return toDenoStat(await this.$handle.stat());
    }

    @wrap
    statSync(): Deno.FileInfo {
        const stat = fs.stat(this.$handle.path);
        return toDenoStat(stat);
    }

    @wrap
    async seek(offset: number | bigint, whence: Deno.SeekMode): Promise<number> {
        const fs = (await this.$handle.stat()).size;
        const off = Number(offset);
        if (whence === Deno.SeekMode.Start) {
            this.fpointer = Math.min(off, fs);
        } else if (whence === Deno.SeekMode.Current) {
            this.fpointer = Math.max(0, Math.min(this.fpointer + off, fs));
        } else if (whence === Deno.SeekMode.End) {
            this.fpointer = Math.max(fs - off, 0);
        }
        return this.fpointer;
    }

    @wrap
    seekSync(offset: number | bigint, whence: Deno.SeekMode): number {
        const fsize = fs.lstat(this.$handle.path).size;
        const off = Number(offset);
        if (whence === Deno.SeekMode.Start) {
            this.fpointer = Math.min(off, fsize);
        } else if (whence === Deno.SeekMode.Current) {
            this.fpointer = Math.max(0, Math.min(this.fpointer + off, fsize));
        } else if (whence === Deno.SeekMode.End) {
            this.fpointer = Math.max(fsize - off, 0);
        }
        return this.fpointer;
    }

    @wrap
    sync(): Promise<void> {
        return this.$handle.sync();
    }

    @wrap
    syncData(): Promise<void> {
        return this.$handle.datasync();
    }

    syncSync(): void {
        throw new Deno.errors.NotSupported();
    }

    syncDataSync(): void {
        throw new Deno.errors.NotSupported();
    }

    lock(exclusive?: boolean): Promise<void> {
        // fixme: implement lock asynchronously
        return Promise.resolve(this.lockSync(exclusive));
    }

    @wrap
    lockSync(exclusive?: boolean): void {
        const fd = this.$handle.fileno();
        fs.flock(fd, exclusive ? (fs.LOCK_EX | fs.LOCK_NB) : (fs.LOCK_SH | fs.LOCK_NB));
    }

    unlock(): Promise<void> {
        // fixme: implement unlock asynchronously
        return Promise.resolve(this.unlockSync());
    }

    @wrap
    unlockSync(): void {
        const fd = this.$handle.fileno();
        fs.flock(fd, fs.LOCK_UN);
    }

    async tryLock(exclusive?: boolean): Promise<boolean> {
        return this.tryLockSync(exclusive);
    }

    tryLockSync(exclusive?: boolean): boolean {
        const fd = this.$handle.fileno();
        try{
            fs.flock(fd, exclusive ? (fs.LOCK_EX | fs.LOCK_NB) : (fs.LOCK_SH | fs.LOCK_NB));
            return true;
        } catch (e) {
            if ((e as CModuleError.Error).code == error.errno.EAGAIN) {
                return false;
            }
            throw e;
        }
    }

    @wrap
    utime(atime: number | Date, mtime: number | Date): Promise<void> {
        return this.$handle.utime(toDate(atime), toDate(mtime));
    }

    @wrap
    utimeSync(atime: number | Date, mtime: number | Date): void {
        throw new Deno.errors.NotSupported();
    }

    isTerminal(): boolean {
        return false;
    }

    setRaw(mode: boolean, options?: Deno.SetRawOptions): void {
        throw new Deno.errors.NotSupported();
    }

    close(): void {
        this.$handle.close();
    }

    [Symbol.dispose]() {
        this.close();
    }
}

Object.assign(Deno, wrapFSns({
    async open(path, opt) {
        let flag: CModuleFS.OpenFlags = "r";
        if (opt) flag = optionsToMode(opt);
        const fh = await asfs.open(toString(path), flag as string, opt?.mode);
        return new FSFile(fh);
    },

    openSync(path, opt) {
        let flag: CModuleFS.OpenFlags = "r";
        if (opt) flag = optionsToMode(opt);
        const fno = fs.open(toString(path), flag, opt?.mode);
        return new FSFile(asfs.newStdioFile(toString(path), fno));
    },
}))