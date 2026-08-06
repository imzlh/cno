/**
 * Node.js wasi module
 * Based on CModuleWASM WASI support + circu.js fs/stdio
 */

const wasm = import.meta.use('wasm');
const os = import.meta.use('os');
const syncfs = import.meta.use('fs');
const engine = import.meta.use('engine');

export interface WASIOptions {
    version?: string;
    args?: string[];
    env?: Record<string, string>;
    preopens?: Record<string, string>;
    returnOnExit?: boolean;
    stdin?: number;
    stdout?: number;
    stderr?: number;
}

const WASI_MODULE = 'wasi_snapshot_preview1';
type WasiBinding = (...args: never[]) => number;

function createWasiError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

function errorInfo(error: unknown): { code?: unknown; message?: unknown } {
    return typeof error === 'object' && error !== null
        ? { code: Reflect.get(error, 'code'), message: Reflect.get(error, 'message') }
        : {};
}

function isWebAssemblyInstance(value: unknown): value is WebAssembly.Instance {
    return typeof value === 'object'
        && value !== null
        && typeof Reflect.get(value, 'exports') === 'object';
}

function isReturnOnExit(error: unknown): boolean {
    const info = errorInfo(error);
    return typeof info.message === 'string' && info.message.includes('exit');
}

/* WASI errnos used by the path-resolution guard. */
const WASI_EBADF = 8;
const WASI_ENOENT = 44;
const WASI_ENOTCAPABLE = 76;

/* The first directory file descriptor handed to a WASI guest. 0/1/2 are stdio. */
const FIRST_PREOPEN_FD = 3;

function isAbsolutePath(p: string): boolean {
    /* POSIX root, Windows drive letter, and UNC/backslash-root forms. */
    return p.startsWith('/')
        || p.startsWith('\\')
        || /^[A-Za-z]:[\\/]/.test(p);
}

/*
 * Resolve a guest-supplied path against a preopened host directory, rejecting
 * anything that leaves that directory. WASI capability semantics say a guest
 * may only name paths reachable from a directory fd it was granted, so an
 * absolute path or a ".." that climbs above the root must be refused rather
 * than passed to the host fs.
 *
 * Returns the host path to use, or a WASI errno on refusal.
 */
function resolveWithinRoot(root: string, guestPath: string): { path: string } | { errno: number } {
    if (isAbsolutePath(guestPath)) {
        return { errno: WASI_ENOTCAPABLE };
    }
    /* Walk the components, tracking depth, so ".." can never escape the root. */
    const segments = guestPath.split(/[\\/]+/);
    const stack: string[] = [];
    for (const seg of segments) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (stack.length === 0) {
                return { errno: WASI_ENOTCAPABLE };
            }
            stack.pop();
            continue;
        }
        /* A NUL byte would truncate the path inside the host C layer. */
        if (seg.includes('\0')) {
            return { errno: WASI_ENOENT };
        }
        stack.push(seg);
    }
    const suffix = stack.join('/');
    const base = root.replace(/[\\/]+$/, '');
    return { path: suffix ? `${base}/${suffix}` : base };
}

/*
 * Canonicalise `p`, falling back to the deepest ancestor that exists so a path
 * being created (O_CREAT) can still be checked. Returns null if nothing on the
 * chain resolves. The unresolved tail is returned separately because it has
 * already been validated as plain segments by resolveWithinRoot.
 */
function canonicalisePrefix(p: string): string | null {
    let candidate = p.replace(/[\\/]+$/, '');
    for (let i = 0; i < 64; i++) {
        try {
            const real = syncfs.realpath(candidate);
            if (typeof real === 'string' && real.length > 0) return real;
        } catch { /* try the parent */ }
        const cut = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\'));
        if (cut <= 0) return null;
        candidate = candidate.slice(0, cut);
    }
    return null;
}

function normaliseForCompare(p: string): string {
    /* Windows paths are case-insensitive and mix separators. */
    return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/*
 * True when `child` is the root itself or lies beneath it. Compares whole path
 * segments so a sibling like "/jail-evil" is not accepted as being under "/jail".
 */
function isContainedIn(root: string, child: string): boolean {
    const r = normaliseForCompare(root);
    const c = normaliseForCompare(child);
    return c === r || c.startsWith(r + '/');
}

export class WASI {
    private _args: string[];
    private _env: Record<string, string>;
    private _preopens: Record<string, string>;
    private _returnOnExit: boolean;
    private _stdin: number;
    private _stdout: number;
    private _stderr: number;

    private _memory: DataView | null = null;
    private _memBuf: ArrayBuffer | SharedArrayBuffer | null = null;
    private _started = false;
    /* dirfd -> { guest mount name, host directory }. Populated from _preopens. */
    private _preopenFds = new Map<number, { guestName: string; hostPath: string }>();
    public wasiImport: Record<string, WasiBinding>;

    private _bindMemory(instance: WebAssembly.Instance): void {
        const native = this._getNativeInstance(instance);
        if (native) {
            if (!wasm) throw createWasiError('ERR_WASI_NO_WASM', 'WASM support is not available in this build');
            this._memBuf = wasm.getMemoryBuffer(native);
        } else {
            const mem = instance.exports.memory;
            this._memBuf = mem instanceof WebAssembly.Memory ? mem.buffer : null;
        }
        this._memory = this._memBuf ? new DataView(this._memBuf) : null;
    }

    private _refresh(): void {
        if (this._memBuf && this._memory?.buffer !== this._memBuf) {
            this._memory = new DataView(this._memBuf);
        }
    }

    private _memoryView(): DataView {
        this._refresh();
        if (!this._memory) throw createWasiError('ERR_WASI_MEMORY_NOT_SET', 'WASI memory has not been bound');
        return this._memory;
    }

    private _memoryBuffer(): SharedArrayBuffer | ArrayBuffer {
        this._refresh();
        if (!this._memBuf) throw createWasiError('ERR_WASI_MEMORY_NOT_SET', 'WASI memory has not been bound');
        return this._memBuf;
    }

    private _u32(ptr: number): number { return this._memoryView().getUint32(ptr, true); }
    private _wu32(ptr: number, v: number): void { this._memoryView().setUint32(ptr, v, true); }
    private _u8(ptr: number): number { return this._memoryView().getUint8(ptr); }
    private _bytes(ptr: number, len: number): Uint8Array {
        return new Uint8Array(this._memoryBuffer(), ptr, len);
    }
    private _str(ptr: number, len: number): string {
        return engine.decodeString(this._bytes(ptr, len));
    }

    private _startFallback(instance: WebAssembly.Instance): number {
        try {
            const startFn = instance.exports._start;
            if (typeof startFn === 'function') {
                try {
                    startFn();
                } catch (e: unknown) {
                    if (this._returnOnExit && isReturnOnExit(e)) {
                        const code = errorInfo(e).code;
                        return typeof code === 'number' ? code : 0;
                    }
                    throw e;
                }
            }
            return 0;
        } catch {
            return 0;
        }
    }

    private _closeFd(fd: number): number {
        if (fd <= 2) return 0;
        try {
            syncfs.close(fd);
            return 0;
        } catch {
            return 8;
        }
    }

    constructor(options?: WASIOptions) {
        if (typeof options?.version !== 'string') {
            throw createWasiError('ERR_INVALID_ARG_TYPE', 'The "options.version" property must be of type string.');
        }
        if (options.version !== 'preview1') {
            throw createWasiError('ERR_INVALID_ARG_VALUE', `The property 'options.version' must be 'preview1'. Received '${options.version}'`);
        }
        this._args = options?.args ?? [];
        this._env = options?.env ?? {};
        this._preopens = options?.preopens ?? {};
        /* Assign a directory fd to each preopen, in declaration order, starting
         * at 3. path_open/path_filestat_get resolve a guest dirfd through this
         * table, so a fd that is not here has no filesystem capability at all. */
        {
            let fd = FIRST_PREOPEN_FD;
            for (const guestName of Object.keys(this._preopens)) {
                this._preopenFds.set(fd, { guestName, hostPath: this._preopens[guestName] });
                fd++;
            }
        }
        this._returnOnExit = options?.returnOnExit ?? false;
        this._stdin = options?.stdin ?? os.STDIN_FILENO;
        this._stdout = options?.stdout ?? os.STDOUT_FILENO;
        this._stderr = options?.stderr ?? os.STDERR_FILENO;
        this.wasiImport = this._createWasiBindings();
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
        if (this._started) {
            throw createWasiError('ERR_WASI_ALREADY_STARTED', 'WASI instance has already started');
        }
        this._started = true;
        if (!isWebAssemblyInstance(instance)) {
            throw createWasiError('ERR_INVALID_ARG_TYPE', 'The "instance" argument must be an instance of WebAssembly.Instance.');
        }
        this._bindMemory(instance);
        const nativeInstance = this._getNativeInstance(instance);
        if (!nativeInstance) {
            return this._startFallback(instance);
        }
        try {
            nativeInstance.callFunction('_start');
            return 0;
        } catch (e: unknown) {
            if (this._returnOnExit) {
                const code = errorInfo(e).code;
                return typeof code === 'number' ? code : 1;
            }
            throw e;
        }
    }

    initialize(instance: WebAssembly.Instance): void {
        if (this._started) {
            throw createWasiError('ERR_WASI_ALREADY_STARTED', 'WASI instance has already started');
        }
        if (!isWebAssemblyInstance(instance)) {
            throw createWasiError('ERR_INVALID_ARG_TYPE', 'The "instance" argument must be an instance of WebAssembly.Instance.');
        }
        this._bindMemory(instance);
        const nativeInstance = this._getNativeInstance(instance);
        if (!nativeInstance) {
            const initFn = instance.exports._initialize;
            if (typeof initFn === 'function') initFn();
            return;
        }
        try {
            nativeInstance.callFunction('_initialize');
        } catch {}
    }

    getImportObject(): Record<string, Record<string, WasiBinding>> {
        return { [WASI_MODULE]: this.wasiImport };
    }

    getImports(): Record<string, Record<string, WasiBinding>> {
        return { [WASI_MODULE]: this.wasiImport };
    }

    private _getNativeInstance(instance: WebAssembly.Instance): CModuleWASM.Instance | null {
        return Reflect.get(instance, '_instance') as CModuleWASM.Instance | null ?? null;
    }

    private _createWasiBindings(): Record<string, WasiBinding> {
        const bindings: Record<string, WasiBinding> = {};

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
            return this._closeFd(fd);
        };
        bindings.fd_seek = (_fd: number, _offset: number | bigint, _whence: number, _newoffsetPtr: number): number => {
            return 52; // ENOSYS
        };
        bindings.fd_fdstat_get = (fd: number, statPtr: number): number => {
            const memory = this._memoryView();
            let filetype = 4;
            if (fd > 2) {
                try {
                    const st = syncfs.fstat(fd);
                    filetype = st.isDirectory ? 2 : 3;
                } catch { filetype = 4; }
            }
            memory.setUint8(statPtr, filetype);
            memory.setUint16(statPtr + 2, 0, true);
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
                const str = engine.encodeString(`${entries[i][0]}=${entries[i][1]}\0`);
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
                const str = engine.encodeString(`${this._args[i]}\0`);
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
            this._memoryView().setBigUint64(timePtr, now, true);
            return 0;
        };
        bindings.path_open = (dirfd: number, _dirflags: number, pathPtr: number, pathLen: number, oflags: number, _fsRightsBase: number, _fsRightsInheriting: number, fdflags: number, fdPtr: number): number => {
            try {
                const guestPath = this._str(pathPtr, pathLen);
                const resolved = this._resolvePreopenPath(dirfd, guestPath);
                if ('errno' in resolved) return resolved.errno;
                let flag = syncfs.OPEN_RDONLY;
                if (oflags & 1) flag = syncfs.OPEN_WRONLY | syncfs.OPEN_CREAT; // CREATE
                if (oflags & 4) flag |= syncfs.OPEN_EXCL; // EXCLUSIVE
                if (oflags & 8) flag |= syncfs.OPEN_TRUNC; // TRUNCATE
                if (fdflags & 1) flag = syncfs.OPEN_APPEND | syncfs.OPEN_CREAT; // APPEND
                const fd = syncfs.open(resolved.path, flag);
                this._wu32(fdPtr, fd);
                return 0;
            } catch { return WASI_ENOENT; }
        };
        bindings.path_filestat_get = (dirfd: number, _flags: number, pathPtr: number, pathLen: number, statPtr: number): number => {
            try {
                const guestPath = this._str(pathPtr, pathLen);
                const resolved = this._resolvePreopenPath(dirfd, guestPath);
                if ('errno' in resolved) return resolved.errno;
                const st = syncfs.stat(resolved.path);
                const memory = this._memoryView();
                memory.setBigUint64(statPtr, BigInt(st.dev), true);
                memory.setBigUint64(statPtr + 8, BigInt(st.ino), true);
                memory.setUint8(statPtr + 16, st.isDirectory ? 2 : st.isFile ? 3 : 4); // filetype
                memory.setBigUint64(statPtr + 24, BigInt(st.nlink), true);
                memory.setBigUint64(statPtr + 32, BigInt(st.size), true);
                memory.setBigUint64(statPtr + 40, BigInt(st.atim.getTime()) * 1000000n, true);
                memory.setBigUint64(statPtr + 48, BigInt(st.mtim.getTime()) * 1000000n, true);
                memory.setBigUint64(statPtr + 56, BigInt(st.ctim.getTime()) * 1000000n, true);
                return 0;
            } catch { return WASI_ENOENT; }
        };

        /* Advertise the preopens so guest runtimes can discover their roots. */
        bindings.fd_prestat_get = (fd: number, prestatPtr: number): number => {
            const entry = this._preopenFds.get(fd);
            if (!entry) return WASI_EBADF;
            /* prestat: u8 tag (0 = dir) + u32 name length, at offset 4 for alignment. */
            this._memoryView().setUint8(prestatPtr, 0);
            this._wu32(prestatPtr + 4, this._utf8len(entry.guestName));
            return 0;
        };
        bindings.fd_prestat_dir_name = (fd: number, pathPtr: number, pathLen: number): number => {
            const entry = this._preopenFds.get(fd);
            if (!entry) return WASI_EBADF;
            const bytes = new TextEncoder().encode(entry.guestName);
            if (bytes.length > pathLen) return WASI_ENOTCAPABLE;
            this._bytes(pathPtr, bytes.length).set(bytes);
            return 0;
        };

        return bindings;
    }

    private _utf8len(s: string): number {
        return new TextEncoder().encode(s).length;
    }

    /*
     * Map a guest (dirfd, path) pair onto a host path, or refuse.
     * A dirfd that was never granted yields EBADF; a path that escapes its
     * preopen yields ENOTCAPABLE. This is the WASI capability boundary --
     * without it a guest can name any file on the host.
     */
    private _resolvePreopenPath(dirfd: number, guestPath: string): { path: string } | { errno: number } {
        const entry = this._preopenFds.get(dirfd);
        if (!entry) return { errno: WASI_EBADF };
        const lexical = resolveWithinRoot(entry.hostPath, guestPath);
        if ('errno' in lexical) return lexical;

        /*
         * The lexical check above cannot see symlinks or directory junctions: a
         * link sitting inside the preopen names no ".." and is not absolute, yet
         * resolves to an arbitrary host location. Canonicalise both sides and
         * re-check containment so the link target -- not the link path -- decides.
         *
         * Note this does NOT contain hard links. A hard link is not a reference
         * to another path but a second name for the same file, so it canonicalises
         * to itself inside the preopen and no path-based check can detect it.
         * Granting a directory that contains attacker-planted hard links is
         * outside what preopen confinement can express.
         */
        const rootReal = canonicalisePrefix(entry.hostPath);
        if (rootReal === null) return { errno: WASI_ENOENT };
        const targetReal = canonicalisePrefix(lexical.path);
        if (targetReal === null) return { errno: WASI_ENOENT };
        if (!isContainedIn(rootReal, targetReal)) return { errno: WASI_ENOTCAPABLE };

        return lexical;
    }
}
