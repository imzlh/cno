/**
 * Node.js process module
 * Provides current Node.js process information and control
 */

import { EventEmitter } from '../events';
import { Readable, Writable } from '../stream';
import type { Stream as StdioStream } from '../../deno/04_stdio';

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const sig = import.meta.use('signals');
const proc = import.meta.use('process');
const streams = import.meta.use('streams');
const console = import.meta.use('console');
const { stdin: denoStdin, stdout: denoStdout, stderr: denoStderr } = streams as any as Record<string, StdioStream>;

// ============================================================================
// Command line arguments
// ============================================================================

const os_args = (function () {
    const { args } = os;
    for (let i = 0; i < args.length; i++) {
        if (args[i][0] == '-') {
            if (args[i][1] == '-') i++;
        } else {
            return args.slice(i);
        }
    }
    return [];
})();

// ============================================================================
// Helper functions
// ============================================================================

function safeGetEnv(env: string): string | undefined {
    try {
        return os.getenv(env) ?? undefined;
    } catch {
        return undefined;
    }
}

// ============================================================================
// Standard streams - reuse deno/04_stdio shared singleton
// ============================================================================

class ProcessWriteStream extends Writable {
    #stdio: StdioStream;

    constructor(stdio: StdioStream) {
        super({
            write: (chunk: any, encoding: string, callback: (error?: Error | null) => void) => {
                const data = typeof chunk === 'string' ? engine.encodeString(chunk) : chunk;
                stdio.write(data).then(() => callback(), callback);
            },
            final: (callback: (error?: Error | null) => void) => {
                callback();
            },
        });
        this.#stdio = stdio;
    }

    get fd(): number { return this.#stdio.fd; }

    get isTTY(): boolean { return this.#stdio.isTTY; }

    get columns(): number | undefined {
        if (!this.#stdio.isTTY) return undefined;
        try { return this.#stdio.size.width; } catch { return undefined; }
    }

    get rows(): number | undefined {
        if (!this.#stdio.isTTY) return undefined;
        try { return this.#stdio.size.height; } catch { return undefined; }
    }

    getColorDepth(env?: Record<string, string>): number {
        if (!this.isTTY) return 1;
        const forceColor = (env ?? process.env)['FORCE_COLOR'];
        if (forceColor === '0') return 1;
        if (forceColor === '1' || forceColor === '') return 4;
        if (forceColor === '2') return 8;
        if (forceColor === '3') return 24;
        const term = (env ?? process.env)['TERM'] ?? '';
        if (term === 'dumb') return 1;
        if (/screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(term)) return 16;
        if (/^tmux([0-9]+)?$/i.test(term)) return 16;
        return 4;
    }

    hasColors(depth?: number, env?: Record<string, string>): boolean {
        if (depth === undefined) return this.isTTY;
        return this.getColorDepth(env) >= depth;
    }

    writeSync(data: Uint8Array | string): number {
        const d = typeof data === 'string' ? engine.encodeString(data) : data;
        return this.#stdio.writeSync(d);
    }

    clearLine(dir: number, callback?: () => void): boolean {
        const codes = dir === -1 ? '\x1b[1K' : dir === 1 ? '\x1b[0K' : '\x1b[2K';
        this.write(codes, () => callback?.());
        return true;
    }

    cursorTo(x: number, y?: number, callback?: () => void): boolean {
        const code = y !== undefined ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`;
        this.write(code, () => callback?.());
        return true;
    }

    moveCursor(dx: number, dy: number, callback?: () => void): boolean {
        let code = '';
        if (dx > 0) code += `\x1b[${dx}C`;
        else if (dx < 0) code += `\x1b[${-dx}D`;
        if (dy > 0) code += `\x1b[${dy}B`;
        else if (dy < 0) code += `\x1b[${-dy}A`;
        this.write(code, () => callback?.());
        return true;
    }

    getWindowSize(): [number, number] {
        return [this.columns ?? 80, this.rows ?? 24];
    }
}

class ProcessReadStream extends Readable {
    #stdio: StdioStream;
    #isRaw: boolean = false;

    constructor(stdio: StdioStream) {
        super({ highWaterMark: 64 * 1024 });
        this.#stdio = stdio;
        this._read = this.#doRead.bind(this);
    }

    async #doRead(size: number): Promise<void> {
        try {
            const buf = new Uint8Array(size);
            const n = await this.#stdio.read(buf as Uint8Array<ArrayBuffer>);
            if (n === null) {
                this.push(null);
            } else {
                this.push(buf.subarray(0, n));
            }
        } catch (e) {
            this.destroy(e as any);
        }
    }

    get fd(): number { return this.#stdio.fd; }

    get isTTY(): boolean { return this.#stdio.isTTY; }

    get isRaw(): boolean { return this.#isRaw; }

    setRawMode(mode: boolean): this {
        this.#stdio.setRaw(mode);
        this.#isRaw = mode;
        return this;
    }

    readSync(buf: Uint8Array<ArrayBuffer>): number | null {
        return this.#stdio.readSync(buf);
    }
}

// ============================================================================
// hrtime implementation (high-precision based on performance.now)
// ============================================================================

const hrtimeOrigin = typeof performance !== 'undefined' ? performance.now() : Date.now();

export function hrtime(time?: [number, number]): [number, number] {
    const nowMicro = typeof performance !== 'undefined'
        ? performance.now() - hrtimeOrigin
        : Date.now() - hrtimeOrigin;
    const totalNs = Math.round(nowMicro * 1e6);
    const seconds = Math.floor(totalNs / 1e9);
    const nanoseconds = totalNs % 1e9;

    if (time) {
        let diffSeconds = seconds - time[0];
        let diffNanoseconds = nanoseconds - time[1];
        if (diffNanoseconds < 0) {
            diffSeconds -= 1;
            diffNanoseconds += 1e9;
        }
        return [diffSeconds, diffNanoseconds];
    }

    return [seconds, nanoseconds];
}

hrtime.bigint = function (): bigint {
    const [seconds, nanoseconds] = hrtime();
    return BigInt(seconds) * BigInt(1e9) + BigInt(nanoseconds);
};

// ============================================================================
// memoryUsage implementation
// ============================================================================

export function memoryUsage(): NodeJS.MemoryUsage {
    const memory = os.memoryUsage();
    return {
        rss: memory['os.rss'],
        heapTotal: memory['os.total'] - memory['os.free'],
        heapUsed: memory['used'],
        external: memory['vm.used'],
        arrayBuffers: memory['buffer.used'],
    };
}

memoryUsage.rss = function (): number {
    return os.memoryUsage()['os.rss'];
};

// ============================================================================
// cpuUsage implementation
// ============================================================================

let lastCpuUsage = { user: 0, system: 0 };

export function cpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
    const cpus = os.cpuInfo();
    if (cpus.length === 0) return { user: 0, system: 0 };

    // Aggregate across all cores
    let totalUser = 0, totalNice = 0, totalSys = 0, totalIdle = 0;
    for (const cpu of cpus) {
        totalUser += cpu.times.user;
        totalNice += cpu.times.nice;
        totalSys += cpu.times.sys;
        totalIdle += cpu.times.idle;
    }

    const current = {
        user: (totalUser + totalNice) * 1e6,  // ms → μs
        system: totalSys * 1e6,
    };

    if (previousValue) {
        return {
            user: current.user - (previousValue.user || 0),
            system: current.system - (previousValue.system || 0),
        };
    }

    // First call: return delta since last call, or zero if first ever
    const result = {
        user: current.user - lastCpuUsage.user,
        system: current.system - lastCpuUsage.system,
    };
    lastCpuUsage = { user: current.user, system: current.system };
    return result;
}

// ============================================================================
// Signal handling
// ============================================================================

const signalMap: Map<NodeJS.Signals, Map<() => void, CModuleSignals.SignalHandler>> = new Map();

function addSignalListener(signalName: NodeJS.Signals, listener: () => void): void {
    if (signalName == 'SIGBREAK' || signalName == 'SIGIOT' || signalName == 'SIGPOLL' || signalName == 'SIGSTKFLT' || signalName == 'SIGUNUSED' || signalName == 'SIGLOST' || signalName == 'SIGINFO')
        throw new Error('The requested signal is not supported.');
    const sigint = sig.signals[signalName];
    if (typeof sigint !== 'number') {
        throw new Error(`Invalid signal: ${signalName}`);
    }

    if (!signalMap.has(signalName)) {
        signalMap.set(signalName, new Map());
    }

    const map = signalMap.get(signalName)!;
    if (map.has(listener)) {
        return;
    }

    const ret = sig.signal(sigint, listener);
    map.set(listener, ret);
}

function removeSignalListener(signalName: NodeJS.Signals, listener: () => void): void {
    if (signalName == 'SIGBREAK' || signalName == 'SIGIOT' || signalName == 'SIGPOLL' || signalName == 'SIGSTKFLT' || signalName == 'SIGUNUSED' || signalName == 'SIGLOST' || signalName == 'SIGINFO')
        throw new Error('The requested signal is not supported.');
    const sigint = sig.signals[signalName];
    if (typeof sigint !== 'number') {
        throw new Error(`Invalid signal: ${signalName}`);
    }

    const map = signalMap.get(signalName);
    if (!map) return;

    const ret = map.get(listener);
    if (ret) {
        ret.close();
        map.delete(listener);
    }
}

// ============================================================================
// Environment variables
// ============================================================================

const envProxy = new Proxy({} as NodeJS.ProcessEnv, {
    get(_, key: string): string | undefined {
        return safeGetEnv(key);
    },
    set(_, key: string, value: string): boolean {
        os.setenv(key, value);
        return true;
    },
    has(_, key: string): boolean {
        return safeGetEnv(key) !== undefined;
    },
    deleteProperty(_, key: string): boolean {
        os.unsetenv(key);
        return true;
    },
    ownKeys(): string[] {
        return os.envKeys();
    },
    getOwnPropertyDescriptor(_, key: string): PropertyDescriptor | undefined {
        const value = safeGetEnv(key);
        if (value === undefined) return undefined;
        return {
            enumerable: true,
            configurable: true,
            value,
        };
    },
});

// ============================================================================
// Process EventEmitter
// ============================================================================

class ProcessEventEmitter extends EventEmitter {
    #exitListeners: (() => void)[] = [];
    #beforeExitListeners: (() => void)[] = [];

    override emit(event: string | Symbol, ...args: any[]): boolean {
        if (event === 'exit') {
            for (const cb of this.#exitListeners) {
                try { cb.apply(null, args as []); } catch { }
            }
            return this.#exitListeners.length > 0;
        }
        if (event === 'beforeExit') {
            for (const cb of this.#beforeExitListeners) {
                try { cb.apply(null, args as []); } catch { }
            }
            return this.#beforeExitListeners.length > 0;
        }
        if (typeof event == 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            return super.emit(event, ...args);
        }
        return super.emit(event.toString(), ...args);
    }

    override on(event: string | symbol, listener: any): this {
        if (typeof event === 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            addSignalListener(event as NodeJS.Signals, listener);
        }
        return super.on(event, listener);
    }

    override once(event: string | symbol, listener: any): this {
        if (typeof event === 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            const onceListener = () => {
                listener();
                removeSignalListener(event as NodeJS.Signals, onceListener);
            };
            addSignalListener(event as NodeJS.Signals, onceListener);
            return super.once(event, listener);
        }
        return super.once(event, listener);
    }

    override off(event: string | symbol, listener: any): this {
        if (typeof event === 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            removeSignalListener(event as NodeJS.Signals, listener);
        }
        return super.off(event, listener);
    }
}

const processEE = new ProcessEventEmitter();

// ============================================================================
// Standard stream instances
// ============================================================================

const stdoutStream = new ProcessWriteStream(denoStdout);
const stderrStream = new ProcessWriteStream(denoStderr);
const stdinStream = new ProcessReadStream(denoStdin);

// ============================================================================
// Process object
// ============================================================================
const uname = os.uname();

export const stdout: NodeJS.WriteStream = stdoutStream as any;
export const stderr: NodeJS.WriteStream = stderrStream as any;
export const stdin: NodeJS.ReadStream = stdinStream as any;

export const argv: string[] = [os.exePath, ...os_args.slice(1)];
export const argv0: string = os_args[0] ?? os.exePath;
export const execArgv: string[] = [];

export const pid: number = os.pid;
export const ppid: number = os.ppid;

export const arch: NodeJS.Architecture = (() => {
    const machine = uname.machine;
    switch (machine) {
        case 'x86_64':
        case 'amd64':
            return 'x64';
        case 'i386':
        case 'i686':
            return 'ia32';
        case 'aarch64':
        case 'arm64':
            return 'arm64';
        case 'arm':
            return 'arm';
        default:
            return machine as NodeJS.Architecture;
    }
})();

export const platform: NodeJS.Platform = (() => {
    const platform = os.uname().sysname;
    switch (platform) {
        case 'Linux':
            return 'linux';
        case 'Darwin':
            return 'darwin';
        case 'Windows_NT':
            return 'win32';
        case 'Freebsd':
            return 'freebsd';
        case 'Openbsd':
            return 'openbsd';
        case 'Sunos':
            return 'sunos';
        case 'Aix':
            return 'aix';
        default:
            return platform as NodeJS.Platform;
    }
})();

export const env: NodeJS.ProcessEnv = envProxy;

export function cwd(): string {
    return os.cwd;
}

export function chdir(directory: string): void {
    os.chdir(directory);
}

export function exit(code?: number): never {
    processEE.emit('exit', code ?? 0);
    os.exit(code ?? 0);
    throw new Error('unreachable');
}

export let exitCode: number | undefined = undefined;

export const execPath: string = os.exePath;

export const title: string = 'node';

export const version: string = 'v20.0.0';
export const versions: NodeJS.ProcessVersions = {
    node: '20.0.0',
    v8: engine.versions.quickjs,
    modules: '120',
    http_parser: '2.0',
    uv: engine.versions.uv,
    zlib: engine.versions.zlib,
    ares: '1.0',
    openssl: engine.versions.openssl,
};

export const config: NodeJS.ProcessConfig = {
    target_defaults: {
        cflags: [],
        default_configuration: 'Release',
        defines: [],
        include_dirs: [],
        libraries: [],
    },
    variables: {
        clang: 0,
        host_arch: os.uname().machine,
        node_install_npm: true,
        node_install_waf: false,
        node_prefix: '/usr/local',
        node_shared_openssl: false,
        node_shared_v8: false,
        node_shared_zlib: false,
        node_use_dtrace: false,
        node_use_etw: false,
        node_use_openssl: true,
        target_arch: os.uname().machine,
        v8_no_strict_aliasing: 0,
        v8_use_snapshot: true,
        visibility: 'default',
    },
};

export const release: NodeJS.ProcessRelease = {
    name: 'node',
    lts: 'Iron',
};

export const features: NodeJS.ProcessFeatures = {
    debug: false,
    uv: true,
    ipv6: true,
    tls: true,
    tls_alpn: true,
    tls_ocsp: true,
    tls_sni: true,
    cached_builtins: true,
    inspector: false,
    require_module: false,
    typescript: false,
};

export function uptime(): number {
    return os.uptime();
}

export const on = processEE.on.bind(processEE) as any;
export const off = processEE.off.bind(processEE) as any;
export const once = processEE.once.bind(processEE) as any;
export const emit = processEE.emit.bind(processEE) as any;
export const addListener = processEE.on.bind(processEE) as any;
export const removeListener = processEE.off.bind(processEE) as any;
export const removeAllListeners = processEE.removeAllListeners.bind(processEE) as any;
export const prependListener = processEE.prependListener.bind(processEE) as any;
export const prependOnceListener = processEE.prependOnceListener.bind(processEE) as any;

export function listenerCount(event: string | symbol): number {
    return processEE.listenerCount(event);
}

export function eventNames(): (string | symbol)[] {
    return processEE.eventNames();
}

export function listeners(event: string | symbol): Function[] {
    return processEE.listeners(event);
}

export function rawListeners(event: string | symbol): Function[] {
    return processEE.rawListeners(event);
}

export function getMaxListeners(): number {
    return processEE.getMaxListeners();
}

export function setMaxListeners(n: number): typeof process {
    processEE.setMaxListeners(n);
    return process;
}

export const permission: NodeJS.ProcessPermission = {
    has: () => true,
};

export const report: NodeJS.ProcessReport = {
    compact: false,
    directory: '',
    filename: '',
    getReport: () => ({}),
    reportOnFatalError: false,
    reportOnSignal: false,
    reportOnUncaughtException: false,
    excludeEnv: false,
    signal: 'SIGUSR2',
    writeReport: () => '',
};

export function resourceUsage(): NodeJS.ResourceUsage {
    const mem = os.memoryUsage();
    const cpus = os.cpuInfo();
    let totalUser = 0, totalSys = 0;
    for (const cpu of cpus) {
        totalUser += cpu.times.user + cpu.times.nice;
        totalSys += cpu.times.sys;
    }
    return {
        fsRead: 0,
        fsWrite: 0,
        involuntaryContextSwitches: 0,
        ipcReceived: 0,
        ipcSent: 0,
        majorPageFault: 0,
        maxRSS: mem['os.rss'],
        minorPageFault: 0,
        sharedMemorySize: 0,
        signalsCount: 0,
        swappedOut: 0,
        systemCPUTime: totalSys * 1e6,
        unsharedDataSize: 0,
        unsharedStackSize: 0,
        userCPUTime: totalUser * 1e6,
        voluntaryContextSwitches: 0,
    };
}

export function emitWarning(warning: string | Error, options?: any): void {
    console.warn(warning);
}

export function getuid(): number {
    return os.userInfo.userId;
}

export function getgid(): number {
    return os.userInfo.groupId;
}

export function geteuid(): number {
    return os.userInfo.userId;
}

export function getegid(): number {
    return os.userInfo.groupId;
}

export function setuid(): void {
    throw new Error('setuid is not supported');
}

export function setgid(): void {
    throw new Error('setgid is not supported');
}

export function seteuid(): void {
    throw new Error('seteuid is not supported');
}

export function setegid(): void {
    throw new Error('setegid is not supported');
}

export function setgroups(): void {
    throw new Error('setgroups is not supported');
}

export function umask(mask?: number | string): number {
    if (mask === undefined) return 0o022;
    const prev = 0o022;
    try {
        (os as any).umask?.(typeof mask === 'string' ? parseInt(mask, 8) : mask);
    } catch { }
    return prev;
}

export function nextTick(callback: Function, ...args: any[]): void {
    queueMicrotask(() => callback(...args));
}

export let connected: boolean = false;

export let channel: any = null;

export function kill(pid: number, signal?: string | number): boolean {
    proc.kill(pid, signal as any);
    return true;
}

export function abort(): never {
    os.exit(134);
    throw new Error('unreachable');
}

export const mainModule: NodeJS.Module | undefined = undefined;

export const debugPort: number = 5858;

export function dlopen(module: object, filename: string, flags?: number): void {
    throw new Error('process.dlopen is not supported');
}

export const finalization = {
    register: <T extends object>(ref: T, callback: (ref: T, event: "exit") => void) => { },
    registerBeforeExit: <T extends object>(ref: T, callback: (ref: T, event: "beforeExit") => void) => { },
    unregister: (ref: object) => { },
};

export function getActiveResourcesInfo(): string[] {
    return [];
}

export function getBuiltinModule(id: string): NodeJS.Module | undefined {
    try {
        return require(id);
    } catch {
        return undefined;
    }
}

export const allowedNodeEnvironmentFlags: Set<string> = new Set([
    '--require', '-r', '--import', '--loader', '--inspect', '--inspect-brk',
    '--inspect-port', '--abort-on-uncaught-exception', '--no-deprecation',
    '--trace-deprecation', '--throw-deprecation', '--enable-source-maps',
]);

export const throwDeprecation: boolean = false;
export const traceDeprecation: boolean = false;
export const noDeprecation: boolean | undefined = undefined;

export function ref(maybeRefable: any): void { }

export function unref(maybeRefable: any): void { }

export function loadEnvFile(path?: any): void {
    throw new Error('process.loadEnvFile is not supported');
}

export const sourceMapsEnabled: boolean = false;

export function setSourceMapsEnabled(value: boolean): void { }

export function threadCpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
    return cpuUsage(previousValue);
}

export function constrainedMemory(): number {
    return 0;
}

export function availableMemory(): number {
    return 0;
}

export function setUncaughtExceptionCaptureCallback(cb: ((err: Error) => void) | null): void { }

export function hasUncaughtExceptionCaptureCallback(): boolean {
    return false;
}

export const traceProcessWarnings: boolean = false;

// ============================================================================
// IPC Channel support (for child_process)
// ============================================================================

import { IPCChannel } from '../ipc_channel';

let _ipcChannel: IPCChannel | null = null;

/**
 * Set up IPC channel for child process (called by child_process module)
 */
export function _setupIPC(pipe: any): void {
    _ipcChannel = new IPCChannel(pipe);
    connected = true;
    channel = _ipcChannel;

    _ipcChannel.on('message', (msg) => {
        process.emit('message', msg);
    });

    _ipcChannel.on('error', (err: Error) => {
        process.emit('error', err);
    });

    _ipcChannel.on('close', () => {
        connected = false;
        channel = null;
        process.emit('disconnect');
    });
}

/**
 * Send a message to the parent process
 */
export function send(message: any, callback?: (error: Error | null) => void): boolean {
    if (!_ipcChannel || !_ipcChannel.connected) {
        const err = new Error('IPC channel is not established') as NodeJS.ErrnoException;
        err.code = 'ERR_IPC_CHANNEL_CLOSED';
        if (callback) { callback(err); return false; }
        return false;
    }

    try {
        // Node sends user messages verbatim (no wrapper) so that the peer —
        // including a real node process — receives exactly what was sent.
        _ipcChannel.send(message);
        if (callback) callback(null);
        return true;
    } catch (err) {
        if (callback) callback(err as Error);
        return false;
    }
}

/**
 * Disconnect the IPC channel
 */
export function disconnect(): void {
    if (_ipcChannel) {
        _ipcChannel.close();
        _ipcChannel = null;
    }
}
// ============================================================================
// Child-side IPC bootstrap
// ----------------------------------------------------------------------------
// When this process was forked by child_process with an IPC channel, the parent
// inherits the channel endpoint to this process as fd 3 and exports its number
// via NODE_CHANNEL_FD. Open that fd as a (now bidirectional, socketpair-backed)
// pipe and wire up the channel so process.send() and process.on('message') work
// in the child. This mirrors Node.js, where the child bootstraps its own channel.
// No-op for normally launched processes (NODE_CHANNEL_FD unset).
// ============================================================================
(function bootstrapChildIPC() {
    const fdStr = safeGetEnv('NODE_CHANNEL_FD');
    if (!fdStr) return;
    const fd = parseInt(fdStr, 10);
    if (!Number.isInteger(fd) || fd < 0) return;
    try {
        const pipe = new (streams as any).Pipe();
        pipe.open(fd);
        _setupIPC(pipe);
        // Prevent grandchildren from wrongly inheriting this channel fd.
        try { os.unsetenv('NODE_CHANNEL_FD'); } catch { /* ignore */ }
    } catch {
        // IPC bootstrap failed; the child simply has no usable channel.
    }
})();