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
            return 0;
        };
        bindings.fd_read = (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number => {
            return 0;
        };
        bindings.fd_close = (fd: number): number => {
            return 0;
        };
        bindings.fd_seek = (fd: number, offset: number | bigint, whence: number, newoffsetPtr: number): number => {
            return 0;
        };
        bindings.fd_fdstat_get = (fd: number, statPtr: number): number => {
            return 0;
        };
        bindings.fd_fdstat_set_flags = (fd: number, flags: number): number => {
            return 0;
        };
        bindings.environ_get = (environPtr: number, environBufPtr: number): number => {
            return 0;
        };
        bindings.environ_sizes_get = (environCountPtr: number, environBufSizePtr: number): number => {
            const entries = Object.entries(this._env);
            const bufSize = entries.reduce((s, [k, v]) => s + k.length + v.length + 2, 0);
            return 0;
        };
        bindings.args_get = (argvPtr: number, argvBufPtr: number): number => {
            return 0;
        };
        bindings.args_sizes_get = (argcPtr: number, argvBufSizePtr: number): number => {
            const bufSize = this._args.reduce((s, a) => s + a.length + 1, 0);
            return 0;
        };
        bindings.proc_exit = (code: number): never => {
            if (this._returnOnExit) throw { code, message: `exit with code ${code}` };
            os.exit(code);
            throw 0;    // fallback, unreachable
        };
        bindings.random_get = (bufPtr: number, bufLen: number): number => {
            return 0;
        };
        bindings.clock_time_get = (clockId: number, precision: number, timePtr: number): number => {
            return 0;
        };
        bindings.path_open = (dirfd: number, dirflags: number, pathPtr: number, pathLen: number, oflags: number, fsRightsBase: number, fsRightsInheriting: number, fdflags: number, fdPtr: number): number => {
            return 0;
        };
        bindings.path_filestat_get = (dirfd: number, flags: number, pathPtr: number, pathLen: number, statPtr: number): number => {
            return 0;
        };

        return bindings;
    }
}
