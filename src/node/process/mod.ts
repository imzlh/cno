/**
 * Node.js process module
 * Provides current Node.js process information and control
 */

import { EventEmitter } from '../events';
import { IPCChannel } from '../ipc_channel';
import { stdout, stderr, stdin } from './streams';
import { hrtime, memoryUsage, cpuUsage, resourceUsage } from './metrics';
import { normalizeErrnoError } from '../_internal/errno';

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const sig = import.meta.use('signals');
const proc = import.meta.use('process');
const streams = import.meta.use('streams');
const console = import.meta.use('console');

// argv shapes come from cno/src/utils/args via the os shared namespace — node
// modules must not import across the node/ boundary (AGENT.md). Read once here;
// cno-cli sets argv before any user code runs, so the snapshot is stable and
// stays mutable like Node's real process.argv.
// @ts-ignore - ns
const cno_args = os.__cno_args;

// Re-export streams and metrics under their original names
export { stdout, stderr, stdin };
export { hrtime, memoryUsage, cpuUsage, resourceUsage };

// Helper functions

function safeGetEnv(env: string): string | undefined {
    try {
        return os.getenv(env) ?? undefined;
    } catch {
        return undefined;
    }
}

// Signal handling

const signalMap: Map<NodeJS.Signals, Map<() => void, CModuleSignals.SignalHandler>> = new Map();

// Signals that are not supported on this platform
const UNSUPPORTED_SIGNALS = new Set(['SIGBREAK', 'SIGIOT', 'SIGPOLL', 'SIGSTKFLT', 'SIGUNUSED', 'SIGLOST', 'SIGINFO']);

function throwIfUnsupportedSignal(signalName: NodeJS.Signals): void {
    if (UNSUPPORTED_SIGNALS.has(signalName))
        throw new Error('The requested signal is not supported.');
}

function addSignalListener(signalName: NodeJS.Signals, listener: () => void): void {
    throwIfUnsupportedSignal(signalName);
    if (!sig) throw new Error('signal handling is unavailable outside the main thread');
    const sigint = (sig.signals as any)[signalName];
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
    throwIfUnsupportedSignal(signalName);
    if (!sig) throw new Error('signal handling is unavailable outside the main thread');
    const sigint = (sig.signals as any)[signalName];
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

// Environment variables

const envProxy = new Proxy({} as NodeJS.ProcessEnv, {
    get(target, key: string | symbol, receiver: any): any {
        if (typeof key !== 'string') {
            return Reflect.get(target, key, receiver);
        }
        const value = safeGetEnv(key);
        if (value !== undefined) return value;
        return Reflect.get(target, key, receiver);
    },
    set(target, key: string | symbol, value: string, receiver: any): boolean {
        if (typeof key !== 'string') {
            return Reflect.set(target, key, value, receiver);
        }
        os.setenv(key, value);
        return true;
    },
    has(target, key: string | symbol): boolean {
        if (typeof key !== 'string') return Reflect.has(target, key);
        return safeGetEnv(key) !== undefined || Reflect.has(target, key);
    },
    deleteProperty(target, key: string | symbol): boolean {
        if (typeof key !== 'string') return Reflect.deleteProperty(target, key);
        os.unsetenv(key);
        return true;
    },
    ownKeys(): string[] {
        return os.envKeys();
    },
    getOwnPropertyDescriptor(target, key: string | symbol): PropertyDescriptor | undefined {
        if (typeof key !== 'string') {
            return Reflect.getOwnPropertyDescriptor(target, key);
        }
        const value = safeGetEnv(key);
        if (value === undefined) return Reflect.getOwnPropertyDescriptor(target, key);
        return {
            enumerable: true,
            configurable: true,
            value,
        };
    },
});

// Process EventEmitter

class ProcessEventEmitter extends EventEmitter {
    override emit(event: string | Symbol, ...args: any[]): boolean {
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
            // Register with the native signal system using a wrapper that cleans
            // itself up AND removes the super.once listener to avoid double-fire.
            const onceListener = () => {
                removeSignalListener(event as NodeJS.Signals, onceListener);
                // Remove the super.once wrapper so it doesn't fire again
                super.off(event, wrappedListener);
                listener();
            };
            const wrappedListener = onceListener;
            addSignalListener(event as NodeJS.Signals, onceListener);
            // Register with super.once only so EventEmitter tracks the listener,
            // but we intercept via onceListener above and remove it before it fires.
            return super.once(event, wrappedListener);
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

// Process object

const uname = os.uname();

export const argv: string[] = cno_args.nodeArgv();
export const argv0: string = cno_args.nodeArgv0();
export const execArgv: string[] = cno_args.nodeExecArgv();

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
        case 'FreeBSD':
            return 'freebsd';
        case 'OpenBSD':
            return 'openbsd';
        case 'SunOS':
            return 'sunos';
        case 'AIX':
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
    const exitCode_ = code ?? exitCode ?? 0;
    _exiting = true;
    processEE.emit('exit', exitCode_);
    os.exit(exitCode_);
    throw new Error('unreachable');
}

export let exitCode: number | undefined = undefined;
export let _exiting: boolean = false;

export const execPath: string = os.exePath;

export let title: string = 'node';

export const version: string = 'v24.1.0';
export const versions: NodeJS.ProcessVersions = {
    node: '24.1.0',
    v8: engine.versions.quickjs,
    modules: '127',
    http_parser: engine.versions.llhttp ?? '9.2.1',
    uv: engine.versions.uv,
    zlib: engine.versions.zlib,
    ares: '1.34.4',
    openssl: engine.versions.openssl,
    napi: '9',
    icu: '76.1',
    unicode: '16.0',
    nghttp2: '1.62.1',
    acorn: '8.14.0',
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

function unsupported(name: string): never {
    throw new Error(`${name} is not supported`);
}

export function setuid(): void { unsupported('setuid'); }

export function setgid(): void { unsupported('setgid'); }

export function seteuid(): void { unsupported('seteuid'); }

export function setegid(): void { unsupported('setegid'); }

export function setgroups(): void { unsupported('setgroups'); }

export function umask(mask?: number | string): number {
    const readMask = () => { try { return (os as any).umask?.() ?? 0o022; } catch { return 0o022; } };
    const prev = readMask();
    if (mask !== undefined) {
        try { (os as any).umask?.(typeof mask === 'string' ? parseInt(mask, 8) : mask); } catch {}
    }
    return prev;
}

export function nextTick(callback: Function, ...args: any[]): void {
    queueMicrotask(() => callback(...args));
}

export let connected: boolean = false;

export let channel: any = null;

export function kill(pid: number, signal?: string | number): boolean {
    try {
        proc.kill(pid, signal as any);
    } catch (e) {
        const err = normalizeErrnoError(e, 'kill');
        if ((err as NodeJS.ErrnoException).code === 'UNKNOWN(-3)') {
            (err as NodeJS.ErrnoException).code = 'ESRCH';
            (err as NodeJS.ErrnoException).errno = -4043;
        }
        throw err;
    }
    return true;
}

export function abort(): never {
    os.exit(134);
    throw new Error('unreachable');
}

export const mainModule: NodeJS.Module | undefined = undefined;

export const debugPort: number = 5858;

export function dlopen(module: object, filename: string, flags?: number): void {
    unsupported('process.dlopen');
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
    unsupported('process.loadEnvFile');
}

export const sourceMapsEnabled: boolean = false;

export function setSourceMapsEnabled(value: boolean): void { }

export const domain: null = null;

export const moduleLoadList: string[] = [];

export function binding(id: string): any {
    throw new Error(`process.binding('${id}') is not supported`);
}

export function _getActiveHandles(): object[] {
    return [];
}

export function _getActiveRequests(): object[] {
    return [];
}

export function openStdin(): typeof stdin {
    stdin.resume();
    return stdin;
}

export function getgroups(): number[] {
    try { return (os as any).getgroups?.() ?? []; } catch { return []; }
}

export function initgroups(): void { unsupported('initgroups'); }

export function threadCpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
    return cpuUsage(previousValue);
}

export function constrainedMemory(): number {
    const mem = os.memoryUsage();
    return mem["os.total"] || 0;
}

export function availableMemory(): number {
    const mem = os.memoryUsage();
    return mem["os.free"] || 0;
}

export function setUncaughtExceptionCaptureCallback(cb: ((err: Error) => void) | null): void { }

export function hasUncaughtExceptionCaptureCallback(): boolean {
    return false;
}

export const traceProcessWarnings: boolean = false;

// IPC Channel support (for child_process)

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
