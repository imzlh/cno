/**
 * Node.js wasi module
 * Based on CModuleWASM WASI support + circu.js fs/stdio
 */

const wasm = import.meta.use('wasm');
const os = import.meta.use('os');
const syncfs = import.meta.use('fs');

export interface WASIOptions {
    args?: string[];
    env?: Record<string, string>;
    preopens?: Record<string, string>;
    returnOnExit?: boolean;
    stdin?: number;
    stdout?: number;
    stderr?: number;
}

const WASI_MODULE = 'wasi_snapshot_preview1';

export class WASI {
    private _args: string[];
    private _env: Record<string, string>;
    private _preopens: Record<string, string>;
    private _returnOnExit: boolean;
    private _stdin: number;
    private _stdout: number;
    private _stderr: number;

    private _memory: DataView | null = null;
    private _memBuf: ArrayBuffer | null = null;

    private _bindMemory(instance: WebAssembly.Instance): void {
        const native = this._getNativeInstance(instance);
        if (native) {
            this._memBuf = wasm!.getMemoryBuffer(native) as ArrayBuffer;
        } else {
            const mem = instance.exports.memory as WebAssembly.Memory;
            this._memBuf = (mem?.buffer ?? null) as ArrayBuffer | null;
        }
        this._memory = this._memBuf ? new DataView(this._memBuf) : null;
    }

    private _refresh(): void {
        if (this._memBuf && this._memory!.buffer !== this._memBuf) {
            this._memory = new DataView(this._memBuf);
        }
    }

    private _u32(ptr: number): number { this._refresh(); return this._memory!.getUint32(ptr, true); }
    private _wu32(ptr: number, v: number): void { this._refresh(); this._memory!.setUint32(ptr, v, true); }
    private _u8(ptr: number): number { this._refresh(); return this._memory!.getUint8(ptr); }
    private _bytes(ptr: number, len: number): Uint8Array {
        this._refresh();
        return new Uint8Array(this._memBuf!, ptr, len);
    }
    private _str(ptr: number, len: number): string {
        return new TextDecoder().decode(this._bytes(ptr, len));
    }

    constructor(options?: WASIOptions) {
        this._args = options?.args ?? [];
        this._env = options?.env ?? {};
        this._preopens = options?.preopens ?? {};
        this._returnOnExit = options?.returnOnExit ?? false;
        this._stdin = options?.stdin ?? os.STDIN_FILENO;
        this._stdout = options?.stdout ?? os.STDOUT_FILENO;
        this._stderr = options?.stderr ?? os.STDERR_FILENO;
    }

    private _configureWasi(nativeModule: CModuleWASM.Module): void {
        if (!wasm) return;
        wasm.setWasiOptions(
            nativeModule,
            this._args,
            this._env,
            this._preopens,
        );
    }

    start(instance: WebAssembly.Instance): number {
        this._bindMemory(instance);
        const nativeInstance = this._getNativeInstance(instance);
        if (!nativeInstance) {
            try {
                const startFn = instance.exports._start as Function;
                if (typeof startFn === 'function') {
                    try { startFn(); } catch (e: any) {
                        if (this._returnOnExit && e?.message?.includes('exit')) {
                            return e.code ?? 0;
                        }
                        throw e;
                    }
                }
                return 0;
            } catch { return 0; }
        }
        try {
            nativeInstance.callFunction('_start');
            return 0;
        } catch (e: any) {
            if (this._returnOnExit) return e?.code ?? 1;
            throw e;
        }
    }

    initialize(instance: WebAssembly.Instance): void {
        this._bindMemory(instance);
        const nativeInstance = this._getNativeInstance(instance);
        if (!nativeInstance) {
            const initFn = instance.exports._initialize as Function;
            if (typeof initFn === 'function') initFn();
            return;
        }
        try {
            nativeInstance.callFunction('_initialize');
        } catch {}
    }

    getImportObject(): Record<string, Record<string, Function>> {
        return { [WASI_MODULE]: this._createWasiBindings() };
    }

    getImports(): Record<string, Record<string, Function>> {
        return { [WASI_MODULE]: this._createWasiBindings() };
    }

    private _getNativeInstance(instance: WebAssembly.Instance): CModuleWASM.Instance | null {
        return (instance as any)._instance ?? null;
    }

    private _createWasiBindings(): Record<string, Function> {
        const bindings: Record<string, Function> = {};

        bindings.fd_write = (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number => {
            let written = 0;
            for (let i = 0; i < iovsLen; i++) {
                const ptr = this._u32(iovsPtr + i * 8);
                const len = this._u32(iovsPtr + i * 8 + 4);
                const data = this._bytes(ptr, len);
                if (fd === 1 || fd === 2) {
                    const target = fd === 1 ? this._stdout : this._stderr;
                    syncfs.write(target, data);
                } else {
                    syncfs.write(fd, data);
                }
                written += len;
            }
            this._wu32(nwrittenPtr, written);
            return 0;
        };
        bindings.fd_read = (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number => {
            let totalRead = 0;
            const buf = new Uint8Array(65536);
            for (let i = 0; i < iovsLen; i++) {
                const ptr = this._u32(iovsPtr + i * 8);
                const len = this._u32(iovsPtr + i * 8 + 4);
                const targetBuf = buf.length >= len ? buf.subarray(0, len) : new Uint8Array(len);
                const n = syncfs.read(fd, targetBuf);
                if (n > 0) {
                    this._bytes(ptr, n).set(targetBuf.subarray(0, n));
                    totalRead += n;
                }
                if (n < len) break;
            }
            this._wu32(nreadPtr, totalRead);
            return 0;
        };
        bindings.fd_close = (fd: number): number => {
            if (fd <= 2) return 0;
            try { syncfs.close(fd); return 0; } catch { return 8; }
        };
        bindings.fd_seek = (_fd: number, _offset: number | bigint, _whence: number, _newoffsetPtr: number): number => {
            return 52; // ENOSYS
        };
        bindings.fd_fdstat_get = (fd: number, statPtr: number): number => {
            this._refresh();
            let filetype = 4;
            if (fd > 2) {
                try {
                    const st = syncfs.fstat(fd);
                    filetype = st.isDirectory ? 2 : 3;
                } catch { filetype = 4; }
            }
            this._memory!.setUint8(statPtr, filetype);
            this._memory!.setUint16(statPtr + 2, 0, true);
            return 0;
        };
        bindings.fd_fdstat_set_flags = (fd: number, flags: number): number => {
            return 0; // no-op, acceptable for basic WASI
        };
        bindings.environ_get = (environPtr: number, environBufPtr: number): number => {
            let offset = environBufPtr;
            const entries = Object.entries(this._env);
            for (let i = 0; i < entries.length; i++) {
                this._wu32(environPtr + i * 4, offset);
                const str = new TextEncoder().encode(`${entries[i][0]}=${entries[i][1]}\0`);
                this._bytes(offset, str.length).set(str);
                offset += str.length;
            }
            this._wu32(environPtr + entries.length * 4, 0);
            return 0;
        };
        bindings.environ_sizes_get = (environCountPtr: number, environBufSizePtr: number): number => {
            const entries = Object.entries(this._env);
            this._wu32(environCountPtr, entries.length);
            this._wu32(environBufSizePtr, entries.reduce((s, [k, v]) => s + k.length + 1 + v.length + 1, 0));
            return 0;
        };
        bindings.args_get = (argvPtr: number, argvBufPtr: number): number => {
            let offset = argvBufPtr;
            for (let i = 0; i < this._args.length; i++) {
                this._wu32(argvPtr + i * 4, offset);
                const str = new TextEncoder().encode(`${this._args[i]}\0`);
                this._bytes(offset, str.length).set(str);
                offset += str.length;
            }
            this._wu32(argvPtr + this._args.length * 4, 0);
            return 0;
        };
        bindings.args_sizes_get = (argcPtr: number, argvBufSizePtr: number): number => {
            this._wu32(argcPtr, this._args.length);
            this._wu32(argvBufSizePtr, this._args.reduce((s, a) => s + a.length + 1, 0));
            return 0;
        };
        bindings.proc_exit = (code: number): never => {
            if (this._returnOnExit) throw { code, message: `exit with code ${code}` };
            os.exit(code);
            throw 0;    // fallback, unreachable
        };
        bindings.random_get = (bufPtr: number, bufLen: number): number => {
            const crypto = globalThis.crypto;
            if (crypto?.getRandomValues) {
                crypto.getRandomValues(this._bytes(bufPtr, bufLen));
            } else {
                this._bytes(bufPtr, bufLen).fill(0);
            }
            return 0;
        };
        bindings.clock_time_get = (clockId: number, precision: number, timePtr: number): number => {
            const now = BigInt(Date.now()) * 1000000n; // ms → ns
            this._refresh();
            this._memory!.setBigUint64(timePtr, now, true);
            return 0;
        };
        bindings.path_open = (_dirfd: number, _dirflags: number, pathPtr: number, pathLen: number, oflags: number, _fsRightsBase: number, _fsRightsInheriting: number, fdflags: number, fdPtr: number): number => {
            try {
                const relPath = this._str(pathPtr, pathLen);
                let flag = syncfs.OPEN_RDONLY;
                if (oflags & 1) flag = syncfs.OPEN_WRONLY | syncfs.OPEN_CREAT; // CREATE
                if (oflags & 4) flag |= syncfs.OPEN_EXCL; // EXCLUSIVE
                if (oflags & 8) flag |= syncfs.OPEN_TRUNC; // TRUNCATE
                if (fdflags & 1) flag = syncfs.OPEN_APPEND | syncfs.OPEN_CREAT; // APPEND
                const fd = syncfs.open(relPath, flag);
                this._wu32(fdPtr, fd);
                return 0;
            } catch { return 44; }
        };
        bindings.path_filestat_get = (_dirfd: number, _flags: number, pathPtr: number, pathLen: number, statPtr: number): number => {
            try {
                const relPath = this._str(pathPtr, pathLen);
                const st = syncfs.stat(relPath);
                this._refresh();
                this._memory!.setBigUint64(statPtr, BigInt(st.dev), true);
                this._memory!.setBigUint64(statPtr + 8, BigInt(st.ino), true);
                this._memory!.setUint8(statPtr + 16, st.isDirectory ? 2 : st.isFile ? 3 : 4); // filetype
                this._memory!.setBigUint64(statPtr + 24, BigInt(st.nlink), true);
                this._memory!.setBigUint64(statPtr + 32, BigInt(st.size), true);
                this._memory!.setBigUint64(statPtr + 40, BigInt(st.atim.getTime()) * 1000000n, true);
                this._memory!.setBigUint64(statPtr + 48, BigInt(st.mtim.getTime()) * 1000000n, true);
                this._memory!.setBigUint64(statPtr + 56, BigInt(st.ctim.getTime()) * 1000000n, true);
                return 0;
            } catch { return 44; }
        };

        return bindings;
    }
}
