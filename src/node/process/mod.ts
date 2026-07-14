/**
 * Node.js process module
 * Provides current Node.js process information and control
 */

import { EventEmitter } from '../events';
import { IPCChannel, type IPCSerialization } from '../ipc_channel';
import { stdout, stderr, stdin } from './streams';
import { hrtime, memoryUsage, cpuUsage, resourceUsage } from './metrics';
import { normalizeErrnoError } from '../_internal/errno';
import { loadEnvFile as loadDotenvFile } from '../_internal/envfile';

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const sig = import.meta.use('signals');
const proc = import.meta.use('process');
const streams = import.meta.use('streams');
const console = import.meta.use('console');
const errMod = import.meta.use('error');

interface CnoProcessArgs {
    nodeArgv(): string[];
    nodeArgv0(): string;
    nodeExecArgv(): string[];
}

type ProcessOsModule = typeof os & {
    __cno_args: CnoProcessArgs;
    umask?: (mask?: number) => number;
    getgroups?: () => number[];
};

const processOs = os as ProcessOsModule;

// argv shapes come from cno/src/utils/args via the os shared namespace — node
// modules must not import across the node/ boundary (AGENT.md). Read once here;
// cno-cli sets argv before any user code runs, so the snapshot is stable and
// stays mutable like Node's real process.argv.
const cno_args = processOs.__cno_args;

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

function unsetEnvQuietly(name: string): void {
    try {
        os.unsetenv(name);
    } catch {
        // Best-effort cleanup for inherited child-process bootstrap variables.
    }
}

function readUmask(): number {
    try {
        return processOs.umask?.() ?? 0o022;
    } catch {
        return 0o022;
    }
}

function writeUmask(mask: number): void {
    try {
        processOs.umask?.(mask);
    } catch {
        // Some hosts do not expose a writable umask.
    }
}

function processGroups(): number[] {
    try {
        return processOs.getgroups?.() ?? [];
    } catch {
        return [];
    }
}

function normalizeSignal(signal?: string | number): CModuleProcess.Signal | number | undefined {
    if (signal === undefined || typeof signal === 'number') return signal;
    const signals = sig?.signals;
    if (!signals) return signal as CModuleProcess.Signal;
    if (typeof signals[signal] === 'number') return signal as CModuleProcess.Signal;
    return signal as CModuleProcess.Signal;
}

// Signal handling

const signalMap: Map<string, Map<() => void, CModuleSignals.SignalHandler>> = new Map();

// Signals that are not supported on this platform
const UNSUPPORTED_SIGNALS = new Set(['SIGBREAK', 'SIGIOT', 'SIGPOLL', 'SIGSTKFLT', 'SIGUNUSED', 'SIGLOST', 'SIGINFO']);

function throwIfUnsupportedSignal(signalName: string): void {
    if (UNSUPPORTED_SIGNALS.has(signalName))
        throw new Error('The requested signal is not supported.');
}

function addSignalListener(signalName: string, listener: () => void): void {
    throwIfUnsupportedSignal(signalName);
    if (!sig) throw new Error('signal handling is unavailable outside the main thread');
    const sigint = sig.signals[signalName];
    if (typeof sigint !== 'number') {
        throw new Error(`Invalid signal: ${signalName}`);
    }

    let map = signalMap.get(signalName);
    if (!map) {
        map = new Map();
        signalMap.set(signalName, map);
    }
    if (map.has(listener)) {
        return;
    }

    const ret = sig.signal(sigint, listener);
    map.set(listener, ret);
}

function removeSignalListener(signalName: string, listener: () => void): void {
    throwIfUnsupportedSignal(signalName);
    if (!sig) throw new Error('signal handling is unavailable outside the main thread');
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

function shouldRefIpcForProcessEvent(event: string | symbol): boolean {
    return event === 'message' || event === 'disconnect';
}

function hasIpcRefListener(emitter: EventEmitter): boolean {
    return emitter.listenerCount('message') > 0 || emitter.listenerCount('disconnect') > 0;
}

function syncIpcRef(emitter: EventEmitter): void {
    if (!_ipcChannel) return;
    if (hasIpcRefListener(emitter)) _ipcChannel.ref();
    else _ipcChannel.unref();
}

// Environment variables

const envTarget: NodeJS.ProcessEnv = {};
const envProxy = new Proxy(envTarget, {
    get(target, key: string | symbol, receiver: unknown): unknown {
        if (typeof key !== 'string') {
            return Reflect.get(target, key, receiver);
        }
        const value = safeGetEnv(key);
        if (value !== undefined) return value;
        return Reflect.get(target, key, receiver);
    },
    set(target, key: string | symbol, value: unknown, receiver: unknown): boolean {
        if (typeof key !== 'string') {
            return Reflect.set(target, key, value, receiver);
        }
        os.setenv(key, String(value));
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

type ProcessListener = (...args: unknown[]) => void;
type SendCallback = (error: Error | null) => void;

class ProcessEventEmitter extends EventEmitter {
    override emit(event: string | symbol, ...args: unknown[]): boolean {
        let emitted: boolean;
        if (typeof event == 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            emitted = super.emit(event, ...args);
        } else {
            emitted = super.emit(event.toString(), ...args);
        }
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return emitted;
    }

    override on(event: string | symbol, listener: ProcessListener): this {
        if (typeof event === 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            addSignalListener(event, listener);
        }
        const result = super.on(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override once(event: string | symbol, listener: ProcessListener): this {
        if (typeof event === 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            // Register with the native signal system using a wrapper that cleans
            // itself up AND removes the super.once listener to avoid double-fire.
            const onceListener = () => {
                removeSignalListener(event, onceListener);
                // Remove the super.once wrapper so it doesn't fire again
                super.off(event, wrappedListener);
                listener();
            };
            const wrappedListener = onceListener;
            addSignalListener(event, onceListener);
            // Register with super.once only so EventEmitter tracks the listener,
            // but we intercept via onceListener above and remove it before it fires.
            return super.once(event, wrappedListener);
        }
        const result = super.once(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override prependListener(event: string | symbol, listener: ProcessListener): this {
        const result = super.prependListener(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override prependOnceListener(event: string | symbol, listener: ProcessListener): this {
        const result = super.prependOnceListener(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override off(event: string | symbol, listener: ProcessListener): this {
        if (typeof event === 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            removeSignalListener(event, listener);
        }
        const result = super.off(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override removeAllListeners(event?: string | symbol): this {
        const result = super.removeAllListeners(event);
        if (
            event === undefined ||
            shouldRefIpcForProcessEvent(event)
        ) {
            syncIpcRef(this);
        }
        return result;
    }
}

const processEE = new ProcessEventEmitter();
type NextTickCallback = (...args: unknown[]) => void;
const nextTickQueue: Array<{ callback: NextTickCallback; args: unknown[] }> = [];
let nextTickScheduled = false;

function drainNextTickQueue(): void {
    nextTickScheduled = false;
    while (nextTickQueue.length > 0) {
        const batch = nextTickQueue.splice(0);
        for (const { callback, args } of batch) {
            try {
                callback(...args);
            } catch (error) {
                handleUncaughtException(error);
            }
        }
    }
}

function handleUncaughtException(error: unknown): void {
    processEE.emit('uncaughtExceptionMonitor', error, 'uncaughtException');
    if (processEE.listenerCount('uncaughtException') > 0) {
        processEE.emit('uncaughtException', error, 'uncaughtException');
        return;
    }
    throw error;
}

function scheduleNextTickDrain(): void {
    if (nextTickScheduled) return;
    nextTickScheduled = true;
    queueMicrotask(drainNextTickQueue);
}

type ProcessWarningOptions = string | { type?: string; code?: string; detail?: string };
type ProcessWarning = Error & { code?: string; detail?: string };

function normalizeExitCodeValue(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n)) {
        throw new TypeError('The "code" argument must be an integer');
    }
    return n;
}

function createProcessWarning(
    warning: string | Error,
    options?: ProcessWarningOptions,
): ProcessWarning {
    const detailOptions = typeof options === 'string' ? { type: options } : options ?? {};
    const out: ProcessWarning = warning instanceof Error ? warning : new Error(String(warning));
    out.name = detailOptions.type ?? (out.name === 'Error' ? 'Warning' : out.name);
    if (detailOptions.code !== undefined) out.code = detailOptions.code;
    if (detailOptions.detail !== undefined) out.detail = detailOptions.detail;
    return out;
}

// Process object

const uname = os.uname();

export const argv: string[] = [];
export let argv0: string = '';
export const execArgv: string[] = [];

function replaceArray(target: string[], values: string[]): void {
    target.length = 0;
    for (const value of values) target.push(value);
}

function refreshProcessArgs(): void {
    replaceArray(argv, cno_args.nodeArgv());
    replaceArray(execArgv, cno_args.nodeExecArgv());
    argv0 = cno_args.nodeArgv0();
}

refreshProcessArgs();
Reflect.set(os, '__cno_process_args_refresh', refreshProcessArgs);

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
    try {
        os.chdir(directory);
    } catch (e) {
        throw normalizeErrnoError(e, 'chdir', directory);
    }
}

export function exit(code?: number): never {
    const exitCode_ = normalizeExitCodeValue(code) ?? exitCode ?? 0;
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
type CnoProcessVersions = NodeJS.ProcessVersions & {
    deno: string;
    typescript: string;
};

const llhttpVersion = engine.versions.llhttp ?? '9.2.1';

export const versions: CnoProcessVersions = {
    node: '24.1.0',
    v8: engine.versions.quickjs,
    modules: '127',
    http_parser: llhttpVersion,
    llhttp: llhttpVersion,
    uv: engine.versions.uv,
    zlib: engine.versions.zlib,
    brotli: '1.1.0',
    ares: '1.34.4',
    openssl: engine.versions.openssl,
    napi: '9',
    cldr: '46.0',
    icu: '76.1',
    tz: '2025b',
    unicode: '16.0',
    nghttp2: '1.62.1',
    acorn: '8.14.0',
    deno: engine.versions.core,
    typescript: '5.9.2',
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

export const on = (event: string | symbol, listener: ProcessListener): ProcessEventEmitter =>
    processEE.on(event, listener);
export const off = (event: string | symbol, listener: ProcessListener): ProcessEventEmitter =>
    processEE.off(event, listener);
export const once = (event: string | symbol, listener: ProcessListener): ProcessEventEmitter =>
    processEE.once(event, listener);
export const emit = (event: string | symbol, ...args: unknown[]): boolean =>
    processEE.emit(event, ...args);
export const addListener = on;
export const removeListener = off;
export const removeAllListeners = (event?: string | symbol): ProcessEventEmitter =>
    processEE.removeAllListeners(event);
export const prependListener = (event: string | symbol, listener: ProcessListener): ProcessEventEmitter =>
    processEE.prependListener(event, listener);
export const prependOnceListener = (event: string | symbol, listener: ProcessListener): ProcessEventEmitter =>
    processEE.prependOnceListener(event, listener);

export function listenerCount(event: string | symbol): number {
    return processEE.listenerCount(event);
}

export function eventNames(): (string | symbol)[] {
    return processEE.eventNames();
}

export function listeners(event: string | symbol): ProcessListener[] {
    return processEE.listeners(event);
}

export function rawListeners(event: string | symbol): ProcessListener[] {
    return processEE.rawListeners(event);
}

export function getMaxListeners(): number {
    return processEE.getMaxListeners();
}

export function setMaxListeners(n: number): typeof process {
    processEE.setMaxListeners(n);
    return processDefault as typeof process;
}

export const permission: NodeJS.ProcessPermission = {
    has: () => true,
};

// process.report — diagnostic dump (Node-shaped; approximate heap/libuv fields)

let reportSeq = 0;

// glibc version for report.header (empty on musl/non-linux). Used by packages
// like rollup that branch optional natives via !glibcVersionRuntime.
let cachedGlibcRuntime: string | undefined;
function glibcVersionRuntime(): string {
    if (cachedGlibcRuntime !== undefined) return cachedGlibcRuntime;
    if (platform !== 'linux') {
        cachedGlibcRuntime = '';
        return cachedGlibcRuntime;
    }
    try {
        const r = proc.spawnSync(['ldd', '--version'], { stdout: 'pipe', stderr: 'pipe' });
        const raw = r.stdout ?? r.stderr;
        const text = raw ? engine.decodeString(raw) : '';
        const m = text.match(/GLIBC\s+([0-9.]+)/i) || text.match(/\b([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b/);
        cachedGlibcRuntime = m?.[1] ?? '';
    } catch {
        cachedGlibcRuntime = '';
    }
    return cachedGlibcRuntime;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function formatReportStamp(d: Date): { file: string; dumpEventTime: string; dumpEventTimeStamp: string } {
    const y = d.getFullYear();
    const mo = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    const h = pad2(d.getHours());
    const mi = pad2(d.getMinutes());
    const s = pad2(d.getSeconds());
    return {
        file: `${y}${mo}${day}.${h}${mi}${s}`,
        dumpEventTime: d.toString(),
        dumpEventTimeStamp: String(d.getTime()),
    };
}

function joinReportPath(dir: string, name: string): string {
    if (!dir) return name;
    const sep = platform === 'win32' ? '\\' : '/';
    const base = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir;
    return `${base}${sep}${name}`;
}

function isAbsoluteReportPath(p: string): boolean {
    if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
    return p.startsWith('/');
}

function collectEnvForReport(): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    for (const key of os.envKeys()) {
        try {
            const v = os.getenv(key);
            if (v !== undefined) out[key] = v;
        } catch {
            // skip unset/missing
        }
    }
    return out;
}

function buildJavascriptStack(err?: Error): {
    message: string;
    stack: string[];
    errorProperties: Record<string, unknown>;
} {
    const error = err ?? new Error('JavaScript Callstack');
    if (!err) error.name = 'Error';
    const message = err
        ? `${error.name}: ${error.message}`
        : `Error: JavaScript Callstack`;
    const raw = error.stack ?? '';
    const lines = raw.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    return { message, stack: lines, errorProperties: {} };
}

function buildJavascriptHeap(): Record<string, unknown> {
    const mem = memoryUsage();
    const free = os.memoryUsage()['os.free'] ?? 0;
    return {
        totalMemory: mem.heapTotal,
        executableMemory: 0,
        totalCommittedMemory: mem.heapTotal,
        availableMemory: free,
        totalGlobalHandlesMemory: 0,
        usedGlobalHandlesMemory: 0,
        usedMemory: mem.heapUsed,
        memoryLimit: 0,
        mallocedMemory: 0,
        externalMemory: mem.external,
        peakMallocedMemory: 0,
        nativeContextCount: 1,
        detachedContextCount: 0,
        doesZapGarbage: 0,
        heapSpaces: {
            new_space: {
                memorySize: mem.heapUsed,
                committedMemory: mem.heapUsed,
                capacity: mem.heapTotal,
                used: mem.heapUsed,
                available: Math.max(0, mem.heapTotal - mem.heapUsed),
            },
        },
    };
}

function buildResourceUsageSection(): Record<string, unknown> {
    const ru = resourceUsage();
    const mem = os.memoryUsage();
    const free = mem['os.free'] ?? 0;
    const total = mem['os.total'] ?? 0;
    const rss = mem['os.rss'] ?? 0;
    const userCpuSeconds = ru.userCPUTime / 1e6;
    const kernelCpuSeconds = ru.systemCPUTime / 1e6;
    const cpuConsumptionPercent = (userCpuSeconds + kernelCpuSeconds) * 100;
    return {
        free_memory: free,
        total_memory: total,
        rss,
        constrained_memory: constrainedMemory(),
        available_memory: availableMemory(),
        userCpuSeconds,
        kernelCpuSeconds,
        cpuConsumptionPercent,
        userCpuConsumptionPercent: userCpuSeconds * 100,
        kernelCpuConsumptionPercent: kernelCpuSeconds * 100,
        maxRss: ru.maxRSS,
        pageFaults: {
            IORequired: ru.majorPageFault,
            IONotRequired: ru.minorPageFault,
        },
        fsActivity: {
            reads: ru.fsRead,
            writes: ru.fsWrite,
        },
    };
}

function buildLibuvHandles(): Array<Record<string, unknown>> {
    // Approximate: expose stdio as pipe handles (full libuv walk needs native support).
    return [
        { type: 'tty', is_active: true, is_referenced: true, address: 'stdin' },
        { type: 'tty', is_active: true, is_referenced: true, address: 'stdout' },
        { type: 'tty', is_active: true, is_referenced: true, address: 'stderr' },
    ];
}

function buildProcessReport(err?: Error, filename: string | null = null): Record<string, unknown> {
    const now = new Date();
    const stamp = formatReportStamp(now);
    const u = os.uname();
    let cpus: unknown[] = [];
    try {
        cpus = os.cpuInfo().map((cpu) => ({
            model: cpu.model,
            speed: cpu.speed,
            user: cpu.times?.user ?? 0,
            nice: cpu.times?.nice ?? 0,
            sys: cpu.times?.sys ?? 0,
            idle: cpu.times?.idle ?? 0,
            irq: cpu.times?.irq ?? 0,
        }));
    } catch {
        cpus = [];
    }

    let networkInterfaces: unknown[] = [];
    try {
        networkInterfaces = os.networkInterfaces().map((iface) => ({
            name: iface.name,
            internal: iface.internal,
            mac: iface.mac,
            address: iface.address,
            netmask: iface.netmask,
            family: iface.scopeId ? 6 : 4,
        }));
    } catch {
        networkInterfaces = [];
    }

    const ru = resourceUsage();
    const userCpuSeconds = ru.userCPUTime / 1e6;
    const kernelCpuSeconds = ru.systemCPUTime / 1e6;

    return {
        header: {
            reportVersion: 5,
            event: err ? 'Exception' : 'JavaScript API',
            trigger: err ? 'Exception' : 'GetReport',
            filename,
            dumpEventTime: stamp.dumpEventTime,
            dumpEventTimeStamp: stamp.dumpEventTimeStamp,
            processId: pid,
            threadId: 0,
            cwd: os.cwd,
            commandLine: [...argv],
            nodejsVersion: version,
            glibcVersionRuntime: glibcVersionRuntime(),
            glibcVersionCompiler: '',
            wordSize: 64,
            arch,
            platform,
            componentVersions: { ...versions },
            release: { name: 'node', headersUrl: '', sourceUrl: '', libUrl: '' },
            osName: u.sysname,
            osRelease: u.release,
            osVersion: u.version,
            osMachine: u.machine,
            cpus,
            networkInterfaces,
            host: os.hostName,
        },
        javascriptStack: buildJavascriptStack(err),
        javascriptHeap: buildJavascriptHeap(),
        nativeStack: [] as unknown[],
        resourceUsage: buildResourceUsageSection(),
        uvthreadResourceUsage: {
            userCpuSeconds,
            kernelCpuSeconds,
            cpuConsumptionPercent: (userCpuSeconds + kernelCpuSeconds) * 100,
            userCpuConsumptionPercent: userCpuSeconds * 100,
            kernelCpuConsumptionPercent: kernelCpuSeconds * 100,
            fsActivity: { reads: ru.fsRead, writes: ru.fsWrite },
        },
        libuv: buildLibuvHandles(),
        workers: [] as unknown[],
        environmentVariables: reportState.excludeEnv ? {} : collectEnvForReport(),
        userLimits: {
            core_file_size_blocks: { soft: '', hard: '' },
            data_seg_size_bytes: { soft: '', hard: '' },
            file_size_blocks: { soft: '', hard: '' },
            max_locked_memory_bytes: { soft: '', hard: '' },
            max_memory_size_bytes: { soft: '', hard: '' },
            open_files: { soft: '', hard: '' },
            stack_size_bytes: { soft: '', hard: '' },
            cpu_time_seconds: { soft: '', hard: '' },
            max_user_processes: { soft: '', hard: '' },
            virtual_memory_bytes: { soft: '', hard: '' },
        },
        sharedObjects: [] as string[],
    };
}

function resolveReportFilename(file?: string): { path: string; name: string } {
    const configuredDir = reportState.directory || '';
    const configuredName = reportState.filename || '';

    if (file && typeof file === 'string' && file.length > 0) {
        if (isAbsoluteReportPath(file)) {
            const parts = file.replace(/\\/g, '/').split('/');
            return { path: file, name: parts[parts.length - 1] || file };
        }
        return { path: joinReportPath(configuredDir || os.cwd, file), name: file };
    }

    if (configuredName) {
        return {
            path: joinReportPath(configuredDir || os.cwd, configuredName),
            name: configuredName,
        };
    }

    reportSeq += 1;
    const stamp = formatReportStamp(new Date());
    const name = `report.${stamp.file}.${pid}.0.${String(reportSeq).padStart(3, '0')}.json`;
    return { path: joinReportPath(configuredDir || os.cwd, name), name };
}

const reportState = {
    compact: false,
    directory: '',
    filename: '',
    reportOnFatalError: false,
    reportOnSignal: false,
    reportOnUncaughtException: false,
    excludeEnv: false,
    signal: 'SIGUSR2' as NodeJS.Signals,
};

export const report: NodeJS.ProcessReport = {
    get compact() { return reportState.compact; },
    set compact(v: boolean) { reportState.compact = Boolean(v); },
    get directory() { return reportState.directory; },
    set directory(v: string) { reportState.directory = String(v ?? ''); },
    get filename() { return reportState.filename; },
    set filename(v: string) { reportState.filename = String(v ?? ''); },
    get reportOnFatalError() { return reportState.reportOnFatalError; },
    set reportOnFatalError(v: boolean) { reportState.reportOnFatalError = Boolean(v); },
    get reportOnSignal() { return reportState.reportOnSignal; },
    set reportOnSignal(v: boolean) { reportState.reportOnSignal = Boolean(v); },
    get reportOnUncaughtException() { return reportState.reportOnUncaughtException; },
    set reportOnUncaughtException(v: boolean) { reportState.reportOnUncaughtException = Boolean(v); },
    get excludeEnv() { return reportState.excludeEnv; },
    set excludeEnv(v: boolean) { reportState.excludeEnv = Boolean(v); },
    get signal() { return reportState.signal; },
    set signal(v: NodeJS.Signals) { reportState.signal = v; },
    getReport(err?: Error): object {
        return buildProcessReport(err instanceof Error ? err : undefined, null);
    },
    writeReport(file?: string | Error, err?: Error): string {
        let filenameArg: string | undefined;
        let errorArg: Error | undefined = err;
        if (typeof file === 'string') filenameArg = file;
        else if (file instanceof Error) errorArg = file;

        const resolved = resolveReportFilename(filenameArg);
        const payload = buildProcessReport(errorArg, resolved.name);
        const json = reportState.compact
            ? JSON.stringify(payload)
            : `${JSON.stringify(payload, null, 2)}\n`;
        try {
            const fs = import.meta.use('fs');
            fs.writeFile(resolved.path, engine.encodeString(json));
        } catch (e) {
            throw normalizeErrnoError(e, 'write', resolved.path);
        }
        try {
            console.error(`Writing Node.js report to file: ${resolved.path}`);
            console.error('Node.js report completed');
        } catch {
            // console may be redirected
        }
        return resolved.path;
    },
};

export function emitWarning(warning: string | Error, options?: ProcessWarningOptions): void {
    const normalized = createProcessWarning(warning, options);
    console.warn(normalized.message);
    nextTick(() => processEE.emit('warning', normalized));
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
    const prev = readUmask();
    if (mask !== undefined) {
        writeUmask(typeof mask === 'string' ? parseInt(mask, 8) : mask);
    }
    return prev;
}

export function nextTick(callback: NextTickCallback, ...args: unknown[]): void {
    if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be of type Function');
    }
    nextTickQueue.push({ callback, args });
    scheduleNextTickDrain();
}

export let connected: boolean = false;

export let channel: IPCChannel | null = null;

export function kill(pid: number, signal?: string | number): boolean {
    try {
        proc.kill(pid, normalizeSignal(signal));
    } catch (e) {
        throw normalizeErrnoError(e, 'kill');
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
        return require(id) as NodeJS.Module;
    } catch {
        return undefined;
    }
}

class AllowedNodeEnvironmentFlags extends Set<string> {
    override has(value: string): boolean {
        if (super.has(value)) return true;
        if (typeof value !== 'string') return false;
        const eq = value.indexOf('=');
        if (eq === -1) return false;
        return super.has(value.slice(0, eq));
    }
}

export const allowedNodeEnvironmentFlags: Set<string> = new AllowedNodeEnvironmentFlags([
    '--require', '-r', '--import', '--loader', '--inspect', '--inspect-brk',
    '--inspect-port', '--abort-on-uncaught-exception', '--no-deprecation',
    '--trace-deprecation', '--throw-deprecation', '--enable-source-maps',
]);

export const throwDeprecation: boolean = false;
export const traceDeprecation: boolean = false;
export let noDeprecation: boolean | undefined = undefined;

export function ref(maybeRefable: unknown): void { }

export function unref(maybeRefable: unknown): void { }

export function loadEnvFile(path?: string | URL): void {
    const loaded = loadDotenvFile(path ?? '.env');
    if (loaded === null) {
        throw new Error(`Failed to load env file: ${path === undefined ? '.env' : String(path)}`);
    }
}

export const sourceMapsEnabled: boolean = true;

export function setSourceMapsEnabled(value: boolean): void { }

export const domain: null = null;

export const moduleLoadList: string[] = [];

type UvBinding = {
    errname(code: number): string;
    getErrorMessage(code: number): string;
    getErrorMap(): Map<number, [string, string]>;
    getCodeMap(): Map<string, number>;
};

let uvBinding: UvBinding | undefined;

function createUvBinding(): UvBinding {
    const errorMap = new Map<number, [string, string]>();
    const codeMap = new Map<string, number>();
    for (const [name, code] of Object.entries(errMod.errno)) {
        if (name === 'OK' || name === 'UNKNOWN') continue;
        if (typeof code !== 'number') continue;
        const errno = code;
        const message = errMod.strerror(errno).replace(new RegExp(`^${name}:\\s*`), '');
        errorMap.set(errno, [name, message]);
        codeMap.set(name, errno);
    }

    return {
        errname(code: number): string {
            return errorMap.get(code)?.[0] ?? `Unknown system error ${code}`;
        },
        getErrorMessage(code: number): string {
            return errorMap.get(code)?.[1] ?? `Unknown system error ${code}`;
        },
        getErrorMap(): Map<number, [string, string]> {
            return new Map(errorMap);
        },
        getCodeMap(): Map<string, number> {
            return new Map(codeMap);
        },
    };
}

export function binding(id: string): UvBinding {
    if (id === 'uv') {
        uvBinding ??= createUvBinding();
        return uvBinding;
    }
    throw new Error(`process.binding('${id}') is not supported`);
}

export function _getActiveHandles(): object[] {
    return [];
}

export function _getActiveRequests(): object[] {
    return [];
}

export function openStdin(): typeof stdin {
    stdin.resume?.();
    return stdin;
}

export function getgroups(): number[] {
    return processGroups();
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

function Process(this: object): void { }

const PROCESS_DEFAULT_SINGLETON = Symbol.for('cno.node.process.default');

function getExistingProcessDefault(): NodeJS.Process & Record<string, unknown> | null {
    const existing = Reflect.get(globalThis, PROCESS_DEFAULT_SINGLETON);
    if (existing && (typeof existing === 'object' || typeof existing === 'function')) {
        return existing as NodeJS.Process & Record<string, unknown>;
    }
    return null;
}

const existingProcessDefault = getExistingProcessDefault();

const processDefault = existingProcessDefault ?? {
    stdout,
    stderr,
    stdin,
    env,
    argv,
    get argv0() { return argv0; },
    execArgv,
    pid,
    ppid,
    platform,
    arch,
    version,
    versions,
    config,
    release,
    features,
    permission,
    report,
    on,
    off,
    once,
    emit,
    addListener,
    removeListener,
    removeAllListeners,
    prependListener,
    prependOnceListener,
    listenerCount,
    eventNames,
    listeners,
    rawListeners,
    getMaxListeners,
    setMaxListeners,
    cwd,
    chdir,
    exit,
    uptime,
    hrtime,
    memoryUsage,
    cpuUsage,
    resourceUsage,
    emitWarning,
    getuid,
    getgid,
    geteuid,
    getegid,
    setuid,
    setgid,
    seteuid,
    setegid,
    setgroups,
    umask,
    nextTick,
    kill,
    abort,
    debugPort,
    dlopen,
    finalization,
    getActiveResourcesInfo,
    getBuiltinModule,
    allowedNodeEnvironmentFlags,
    ref,
    unref,
    loadEnvFile,
    setSourceMapsEnabled,
    domain,
    moduleLoadList,
    binding,
    _getActiveHandles,
    _getActiveRequests,
    openStdin,
    getgroups,
    initgroups,
    threadCpuUsage,
    constrainedMemory,
    availableMemory,
    setUncaughtExceptionCaptureCallback,
    hasUncaughtExceptionCaptureCallback,
    traceDeprecation,
    throwDeprecation,
	traceProcessWarnings,
	constructor: Process,
} as unknown as NodeJS.Process;

// Re-evaluation (e.g. after `cno setup` refreshes cache) reuses the singleton
// but must pick up newly filled surfaces like report.
if (existingProcessDefault) {
    Reflect.set(processDefault, 'versions', versions);
    Reflect.set(processDefault, 'report', report);
}

if (!existingProcessDefault) Object.defineProperties(processDefault, {
    exitCode: {
        enumerable: true,
        configurable: true,
        get: () => exitCode,
        set: (value: unknown) => { exitCode = normalizeExitCodeValue(value); },
    },
    _exiting: {
        enumerable: true,
        configurable: true,
        get: () => _exiting,
        set: (value: unknown) => { _exiting = Boolean(value); },
    },
    execPath: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: execPath,
    },
    title: {
        enumerable: true,
        configurable: true,
        get: () => title,
        set: (value: unknown) => { title = String(value); },
    },
    mainModule: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: mainModule,
    },
    connected: {
        enumerable: true,
        configurable: true,
        get: () => connected,
        set: (value: unknown) => { connected = Boolean(value); },
    },
    channel: {
        enumerable: true,
        configurable: true,
        get: () => channel,
        set: (value: unknown) => { channel = value as IPCChannel | null; },
    },
    noDeprecation: {
        enumerable: true,
        configurable: true,
        get: () => noDeprecation,
        set: (value: unknown) => { noDeprecation = value === undefined ? undefined : Boolean(value); },
    },
    sourceMapsEnabled: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: sourceMapsEnabled,
    },
});

if (!existingProcessDefault) Reflect.set(globalThis, PROCESS_DEFAULT_SINGLETON, processDefault);

export default processDefault;

// IPC Channel support (for child_process)

let _ipcChannel: IPCChannel | null = null;

/**
 * Set up IPC channel for child process (called by child_process module)
 */
export function _setupIPC(pipe: CModuleStreams.Pipe, serialization: IPCSerialization = 'json'): IPCChannel {
    if (existingProcessDefault) {
        const setup = Reflect.get(processDefault, '_setupIPC');
        if (typeof setup === 'function' && setup !== _setupIPC) {
            return Reflect.apply(setup, processDefault, [pipe, serialization]) as IPCChannel;
        }
    }

    _ipcChannel = new IPCChannel(pipe, serialization);
    connected = true;
    channel = _ipcChannel;

    _ipcChannel.on('message', (msg) => {
        processDefault.emit('message', msg);
    });

    _ipcChannel.on('error', (err: Error) => {
        processDefault.emit('error', err);
    });

    _ipcChannel.on('close', () => {
        connected = false;
        channel = null;
        processDefault.emit('disconnect');
    });

    return _ipcChannel;
}

/**
 * Send a message to the parent process
 */
export function send(message: unknown, sendHandleOrCallback?: unknown, optionsOrCallback?: unknown, callback?: SendCallback): boolean {
    if (existingProcessDefault) {
        const activeSend = Reflect.get(processDefault, 'send');
        if (typeof activeSend === 'function' && activeSend !== send) {
            return Boolean(Reflect.apply(activeSend, processDefault, [
                message,
                sendHandleOrCallback,
                optionsOrCallback,
                callback,
            ]));
        }
    }

    const cb = typeof sendHandleOrCallback === 'function'
        ? sendHandleOrCallback as SendCallback
        : typeof optionsOrCallback === 'function'
            ? optionsOrCallback as SendCallback
            : callback;

    if (!_ipcChannel || !_ipcChannel.connected) {
        const err = Object.assign(new Error('IPC channel is not established'), {
            code: 'ERR_IPC_CHANNEL_CLOSED',
        });
        if (cb) {
            queueMicrotask(() => cb(err));
            return false;
        }
        return false;
    }

    // Node sends user messages verbatim (no wrapper) so that the peer —
    // including a real node process — receives exactly what was sent.
    _ipcChannel.send(message);
    if (cb) queueMicrotask(() => cb(null));
    return true;
}

/**
 * Disconnect the IPC channel
 */
export function disconnect(): void {
    if (existingProcessDefault) {
        const activeDisconnect = Reflect.get(processDefault, 'disconnect');
        if (typeof activeDisconnect === 'function' && activeDisconnect !== disconnect) {
            Reflect.apply(activeDisconnect, processDefault, []);
            return;
        }
    }

    if (_ipcChannel) {
        _ipcChannel.close();
        _ipcChannel = null;
    }
}

if (!existingProcessDefault) Object.assign(processDefault, { _setupIPC, send, disconnect });

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
    if (existingProcessDefault) return;
    const fdStr = safeGetEnv('NODE_CHANNEL_FD');
    if (!fdStr) return;
    const fd = parseInt(fdStr, 10);
    if (!Number.isInteger(fd) || fd < 0) return;
    try {
        const serialization = safeGetEnv('CNO_IPC_SERIALIZATION') === 'advanced' ? 'advanced' : 'json';
        const pipe = new streams.Pipe();
        pipe.open(fd);
        const ipcChannel = _setupIPC(pipe, serialization);
        ipcChannel.unref();
        // Prevent grandchildren from wrongly inheriting this channel fd.
        unsetEnvQuietly('NODE_CHANNEL_FD');
        unsetEnvQuietly('CNO_IPC_SERIALIZATION');
    } catch {
        // IPC bootstrap failed; the child simply has no usable channel.
    }
})();
