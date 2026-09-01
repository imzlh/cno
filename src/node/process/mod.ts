/**
 * Node.js process module
 * Provides current Node.js process information and control
 */

import { EventEmitter } from '../events';
import { IPCChannel, type IPCSerialization } from '../ipc_channel';
import { stdout, stderr, stdin } from './streams';
import { hrtime, memoryUsage, cpuUsage, resourceUsage } from './metrics';
import { normalizeErrnoError } from '../_internal/errno';
import {
    loadNodeEnvFile,
    resolveEnvFilePath,
    type EnvFilePath,
} from '../_internal/envfile';
import path from '../path';

const { basename, isAbsolute: isAbsolutePath, join } = path;

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const sig = import.meta.use('signals');
const proc = import.meta.use('process');
const streams = import.meta.use('streams');
const console = import.meta.use('console');
const errMod = import.meta.use('error');
const napi = import.meta.use('nodeapi');
// import.meta.use is transformed statically and must remain at module scope.
const workerBinding = import.meta.use('worker');

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
const nativeUmask = processOs.umask;
const isWindows = os.platform === 'windows' || os.platform === 'win32';
const emulatedUmaskBits = isWindows ? 0o600 : 0o777;
let emulatedUmask = isWindows ? 0 : 0o022;

const cno_args = processOs.__cno_args;

export { stdout, stderr, stdin };
export { hrtime, memoryUsage, cpuUsage, resourceUsage };

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

function codeError<T extends Error>(error: T, code: string): T {
    Reflect.set(error, 'code', code);
    return error;
}

function normalizeUmask(mask: unknown): number {
    let value: number;
    if (typeof mask === 'string') {
        if (!/^[0-7]+$/.test(mask)) {
            throw codeError(new TypeError(
                `The argument 'mask' must be a 32-bit unsigned integer or an octal string. Received '${mask}'`,
            ), 'ERR_INVALID_ARG_VALUE');
        }
        value = Number.parseInt(mask, 8);
    } else if (typeof mask !== 'number') {
        throw codeError(new TypeError(
            `The "mask" argument must be of type number. Received ${String(mask)}`,
        ), 'ERR_INVALID_ARG_TYPE');
    } else {
        value = mask;
    }

    if (!Number.isInteger(value)) {
        throw codeError(new RangeError(
            `The value of "mask" is out of range. It must be an integer. Received ${String(value)}`,
        ), 'ERR_OUT_OF_RANGE');
    }
    if (value < 0 || value > 0xffff_ffff) {
        throw codeError(new RangeError(
            `The value of "mask" is out of range. It must be >= 0 && <= 4294967295. Received ${String(value)}`,
        ), 'ERR_OUT_OF_RANGE');
    }
    return value;
}

function processGroups(): number[] {
    try {
        return processOs.getgroups?.() ?? [];
    } catch {
        return [];
    }
}

function normalizeKillPid(pid: unknown): number {
    if (typeof pid === 'boolean') return pid ? 1 : 0;
    if (typeof pid === 'string') {
        if (pid === '') return 0;
        if (/^[+-]?\d+$/.test(pid)) return Number(pid);
    } else if (typeof pid === 'number' && Number.isInteger(pid) && Number.isFinite(pid)) {
        return pid;
    }
    throw codeError(new TypeError(
        `The "pid" argument must be of type number. Received ${String(pid)}`,
    ), 'ERR_INVALID_ARG_TYPE');
}

function normalizeSignal(signal?: string | number | null): CModuleProcess.Signal | number | undefined {
    if (signal === undefined || signal === null || signal === '') return undefined;
    if (typeof signal === 'number') {
        // Signal 0 is a liveness probe. Preserve it for the native binding;
        // passing `undefined` would select the default terminating signal.
        if (signal === 0) return 0;
        if (Number.isNaN(signal)) return undefined;
        if (Number.isInteger(signal)) return signal;
        throw codeError(new TypeError(`Unknown signal: ${String(signal)}`), 'ERR_UNKNOWN_SIGNAL');
    }
    const signals = sig?.signals;
    if (signals && typeof signals[signal] === 'number') return signals[signal];
    throw codeError(new TypeError(`Unknown signal: ${signal}`), 'ERR_UNKNOWN_SIGNAL');
}

const signalMap: Map<string, Map<() => void, CModuleSignals.SignalHandler>> = new Map();

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

// Retry bridge installation when a relevant listener is registered late.
function needsEventBridge(event: string | symbol): boolean {
    return event === 'exit' ||
        event === 'beforeExit' ||
        event === 'uncaughtException' ||
        event === 'uncaughtExceptionMonitor';
}

function retryEventBridge(event: string | symbol): void {
    if (needsEventBridge(event)) ensureEventBridge();
}

function hasIpcRefListener(emitter: EventEmitter): boolean {
    return emitter.listenerCount('message') > 0 || emitter.listenerCount('disconnect') > 0;
}

function syncIpcRef(emitter: EventEmitter): void {
    if (!_ipcChannel) return;
    if (hasIpcRefListener(emitter)) _ipcChannel.ref();
    else _ipcChannel.unref();
}

// The proxy target stays empty because ownKeys is backed by the OS environment.
const envTarget = Object.create(null) as NodeJS.ProcessEnv;

// ToString rejects symbols; String(symbol) would incorrectly accept them.
function envToString(value: unknown): string {
    if (typeof value === 'symbol') {
        throw new TypeError('Cannot convert a Symbol value to a string');
    }
    return `${value as string}`;
}

// Node treats invalid environment names as no-ops.
function setEnvQuietly(key: string, value: string): void {
    try {
        os.setenv(key, value);
    } catch {
    }
}

function invalidDefineProperty(message: string): TypeError {
    const e = new TypeError(message) as TypeError & { code?: string };
    e.code = 'ERR_INVALID_OBJECT_DEFINE_PROPERTY';
    return e;
}

const envProxy = new Proxy(envTarget, {
    get(target, key: string | symbol, receiver: unknown): unknown {
        if (typeof key !== 'string') {
            return Reflect.get(target, key, receiver);
        }
        const value = safeGetEnv(key);
        if (value !== undefined) return value;
        return Reflect.get(target, key, receiver);
    },
    set(_target, key: string | symbol, value: unknown): boolean {
        const name = envToString(key);
        setEnvQuietly(name, envToString(value));
        return true;
    },
    has(target, key: string | symbol): boolean {
        if (typeof key !== 'string') return Reflect.has(target, key);
        return safeGetEnv(key) !== undefined || Reflect.has(target, key);
    },
    deleteProperty(_target, key: string | symbol): boolean {
        if (typeof key !== 'string') return true;
        unsetEnvQuietly(key);
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
        if (value === undefined) return undefined;
        return {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
        };
    },
    defineProperty(_target, key: string | symbol, desc: PropertyDescriptor): boolean {
        const name = envToString(key);
        if ('get' in desc || 'set' in desc) {
            throw invalidDefineProperty(
                "'process.env' does not accept an accessor(getter/setter) descriptor",
            );
        }
        if (desc.configurable !== true || desc.writable !== true || desc.enumerable !== true) {
            throw invalidDefineProperty(
                "'process.env' only accepts a configurable, writable, and enumerable data descriptor",
            );
        }
        setEnvQuietly(name, envToString(desc.value));
        return true;
    },
    preventExtensions(): boolean {
        throw new TypeError('Cannot prevent extensions');
    },
});

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
        retryEventBridge(event);
        const result = super.on(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override once(event: string | symbol, listener: ProcessListener): this {
        retryEventBridge(event);
        if (typeof event === 'string' && (event.startsWith('SIG') || event.startsWith('sig'))) {
            // Keep native and EventEmitter once listeners in sync.
            const onceListener = () => {
                removeSignalListener(event, onceListener);
                super.off(event, wrappedListener);
                listener();
            };
            const wrappedListener = onceListener;
            addSignalListener(event, onceListener);
            return super.once(event, wrappedListener);
        }
        const result = super.once(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override prependListener(event: string | symbol, listener: ProcessListener): this {
        retryEventBridge(event);
        const result = super.prependListener(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override prependOnceListener(event: string | symbol, listener: ProcessListener): this {
        retryEventBridge(event);
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

// The baked and cache copies can coexist; share their emitter through Symbol.for().
const PROCESS_EE_SLOT = Symbol.for('cno.node.process.emitter');
const PROCESS_DEFAULT_SINGLETON = Symbol.for('cno.node.process.default');

function getExistingProcessDefault(): NodeJS.Process & Record<string, unknown> | null {
    const existing = Reflect.get(globalThis, PROCESS_DEFAULT_SINGLETON);
    if (existing && (typeof existing === 'object' || typeof existing === 'function')) {
        return existing as NodeJS.Process & Record<string, unknown>;
    }
    return null;
}

const existingProcessDefault = getExistingProcessDefault();

function isEmitterLike(value: unknown): value is EventEmitter {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.on === 'function' &&
        typeof v.emit === 'function' &&
        typeof v.listenerCount === 'function';
}

// Older singleton copies lack the slot; probe a no-op EventEmitter method to recover it.
function probeSingletonEmitter(): EventEmitter | null {
    if (!existingProcessDefault) return null;
    try {
        const removeAll = Reflect.get(existingProcessDefault, 'removeAllListeners');
        if (typeof removeAll !== 'function') return null;
        const probe = (removeAll as (e: symbol) => unknown).call(
            existingProcessDefault,
            Symbol('cno.process.emitter.probe'),
        );
        if (isEmitterLike(probe) && (probe as unknown) !== existingProcessDefault) return probe;
    } catch { /* treat an exotic singleton as unavailable */ }
    return null;
}

function resolveProcessEmitter(): ProcessEventEmitter {
    const slotted = Reflect.get(globalThis, PROCESS_EE_SLOT);
    if (isEmitterLike(slotted)) return slotted as ProcessEventEmitter;

    const probed = probeSingletonEmitter();
    if (probed) {
        Reflect.set(globalThis, PROCESS_EE_SLOT, probed);
        return probed as ProcessEventEmitter;
    }

    const created = new ProcessEventEmitter();
    Reflect.set(globalThis, PROCESS_EE_SLOT, created);
    return created;
}

const processEE: ProcessEventEmitter = resolveProcessEmitter();
type NextTickCallback = (...args: unknown[]) => void;
type UncaughtCaptureCallback = (error: Error) => void;
type UncaughtCaptureState = {
    callback: UncaughtCaptureCallback | null;
    dispatchInstalled: boolean;
    listenerInstalled: boolean;
    listener: () => void;
    rawEmit: ProcessEventEmitter['emit'] | null;
};
const UNCAUGHT_CAPTURE_SLOT = Symbol.for('cno.node.process.uncaughtCapture.v1');

function resolveUncaughtCaptureState(): UncaughtCaptureState {
    const fresh: UncaughtCaptureState = {
        callback: null,
        dispatchInstalled: false,
        listenerInstalled: false,
        listener: () => void 0,
        rawEmit: null,
    };
    try {
        const slots = globalThis as unknown as Record<symbol, UncaughtCaptureState | undefined>;
        const existing = slots[UNCAUGHT_CAPTURE_SLOT];
        if (existing && 'callback' in existing) return existing;
        slots[UNCAUGHT_CAPTURE_SLOT] = fresh;
    } catch { /* fall back to per-copy state */ }
    return fresh;
}

const uncaughtCaptureState = resolveUncaughtCaptureState();

function installUncaughtCaptureDispatch(): void {
    if (uncaughtCaptureState.dispatchInstalled) return;
    const emit = processEE.emit;
    uncaughtCaptureState.rawEmit = emit;
    Reflect.set(processEE, 'emit', function (event: string | symbol, ...args: unknown[]): boolean {
        if (event === 'uncaughtException' && uncaughtCaptureState.callback) {
            Reflect.apply(uncaughtCaptureState.callback, undefined, [args[0]]);
            return true;
        }
        return Reflect.apply(emit, processEE, [event, ...args]);
    });
    uncaughtCaptureState.dispatchInstalled = true;
}

function syncUncaughtCaptureListener(): void {
    if (uncaughtCaptureState.callback && !uncaughtCaptureState.listenerInstalled) {
        processEE.prependListener('uncaughtException', uncaughtCaptureState.listener);
        uncaughtCaptureState.listenerInstalled = true;
    } else if (!uncaughtCaptureState.callback && uncaughtCaptureState.listenerInstalled) {
        processEE.off('uncaughtException', uncaughtCaptureState.listener);
        uncaughtCaptureState.listenerInstalled = false;
    }
}

installUncaughtCaptureDispatch();

function emitUserProcessEvent(event: string | symbol, ...args: unknown[]): boolean {
    const emit = uncaughtCaptureState.rawEmit ?? processEE.emit;
    return Reflect.apply(emit, processEE, [event, ...args]);
}
// Baked and cache copies share one queue because the native drain hook is single-slot.
const NEXT_TICK_SLOT = Symbol.for('cno.node.process.nextTickQueue.v1');

type NextTickEntry = { callback: NextTickCallback; args: unknown[] };
type NextTickState = {
    queue: NextTickEntry[];
    scheduled: boolean;
    draining: boolean;
    nativeInstalled: boolean;
};

function resolveNextTickState(): NextTickState {
    const fresh: NextTickState = {
        queue: [],
        scheduled: false,
        draining: false,
        nativeInstalled: false,
    };
    try {
        const slots = globalThis as unknown as Record<symbol, NextTickState | undefined>;
        const existing = slots[NEXT_TICK_SLOT];
        if (existing && Array.isArray(existing.queue)) return existing;
        slots[NEXT_TICK_SLOT] = fresh;
    } catch {
        // A frozen global falls back to per-copy scheduling.
    }
    return fresh;
}

const tickState: NextTickState = resolveNextTickState();

const nextTickQueue: NextTickEntry[] = tickState.queue;

function drainNextTickQueue(): void {
    tickState.draining = true;
    try {
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
    } finally {
        tickState.draining = false;
        tickState.scheduled = false;
    }
}

const nativeTickDrain: boolean = installNativeTickDrain();

function handleUncaughtException(error: unknown): void {
    processEE.emit('uncaughtExceptionMonitor', error, 'uncaughtException');
    if (uncaughtCaptureState.callback) {
        Reflect.apply(uncaughtCaptureState.callback, undefined, [error]);
        return;
    }
    if (processEE.listenerCount('uncaughtException') > 0) {
        processEE.emit('uncaughtException', error, 'uncaughtException');
        return;
    }
    throw error;
}

// engine.onEvent() is single-slot. Node modules cannot import CTS because they
// are copied independently into the polyfill cache, so use its Symbol registry.

const EVENT_MUX_SLOT = Symbol.for('cno.engine.eventMux.v1');

type MuxEventContext = { handled: boolean; dispatched: boolean };
type MuxReceiver = (name: number, data: unknown, ctx: MuxEventContext) => boolean | undefined;
type MuxRegistry = {
    install(role: string, fn: MuxReceiver, priority?: number): () => void;
    has?(role: string): boolean;
};

function eventMux(): MuxRegistry | null {
    try {
        const slot = (globalThis as unknown as Record<symbol, unknown>)[EVENT_MUX_SLOT];
        if (slot && typeof (slot as MuxRegistry).install === 'function') return slot as MuxRegistry;
    } catch { /* treat an exotic global as absent */ }
    return null;
}

let exitEmitted = false;

// The CLI reads this slot to avoid rearming deferred exit during teardown.
const IN_TEARDOWN_SLOT = Symbol.for('cno.runtime.inTeardown');

function withTeardownFlag<T>(fn: () => T): T {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const previous = g[IN_TEARDOWN_SLOT];
    try {
        g[IN_TEARDOWN_SLOT] = true;
    } catch {
        return fn();
    }
    try {
        return fn();
    } finally {
        try { g[IN_TEARDOWN_SLOT] = previous; } catch { /* ignore an unwritable global */ }
    }
}

function emitProcessExit(code: number): void {
    if (exitEmitted) return;
    exitEmitted = true;
    _exiting = true;
    try {
        withTeardownFlag(() => processEE.emit('exit', code));
    } catch {
        // Preserve the exit path when a listener throws.
    }
}

// Older cores lack this enum member; -1 leaves the branch inactive.
function beforeExitEventId(): number {
    try {
        const v = (engine.EventType as unknown as Record<string, unknown>)?.BEFORE_EXIT;
        return typeof v === 'number' ? v : -1;
    } catch {
        return -1;
    }
}

// beforeExit may repeat while listeners keep scheduling work; listener errors propagate.
function emitBeforeExit(code: number): void {
    if (exitEmitted) return;
    if (processEE.listenerCount('beforeExit') === 0) return;
    withTeardownFlag(() => processEE.emit('beforeExit', code));
}

// Keep natural-drain exit status synchronized when the native binding supports it.
function pushExitCodeToRuntime(value: number | undefined): void {
    const setExitCode = (os as unknown as Record<string, unknown>).setExitCode;
    if (typeof setExitCode !== 'function') return;
    try {
        (setExitCode as (v?: number) => void)(value);
    } catch {
    }
}

let eventBridgeInstalled = false;

const NODE_PROCESS_ROLE = 'node-process';

function ensureEventBridge(): void {
    if (eventBridgeInstalled) return;
    const mux = eventMux();
    if (!mux) return;

    if (mux.has?.(NODE_PROCESS_ROLE)) {
        eventBridgeInstalled = true;
        return;
    }
    eventBridgeInstalled = true;

    mux.install(NODE_PROCESS_ROLE, (name, data, ctx) => {
        const ET = engine.EventType;

        if (name === ET.EXIT) {
            emitProcessExit(typeof data === 'number' ? data : (exitCode ?? 0));
            return undefined;
        }

        if (name === beforeExitEventId()) {
            emitBeforeExit(typeof data === 'number' ? data : (exitCode ?? 0));
            return undefined;
        }

        if (name === ET.JOB_EXCEPTION) {
            processEE.emit('uncaughtExceptionMonitor', data, 'uncaughtException');
            if (uncaughtCaptureState.callback) {
                try {
                    Reflect.apply(uncaughtCaptureState.callback, undefined, [data]);
                } catch {
                    return undefined;
                }
                ctx.handled = true;
                return true;
            }
            if (processEE.listenerCount('uncaughtException') === 0) {
                return undefined;
            }
            try {
                processEE.emit('uncaughtException', data, 'uncaughtException');
            } catch {
            }
            ctx.handled = true;
            return true;
        }

        return undefined;
    }, 50);
}

// The native hook gives nextTick priority over promise jobs; older cores use a
// queueMicrotask fallback rather than dropping callbacks.
type NextTickEngineHook = {
    setNextTickDrain?: (fn: () => void) => void;
    notifyNextTick?: () => void;
};

function installNativeTickDrain(): boolean {
    if (tickState.nativeInstalled) return true;
    try {
        const hook = engine as unknown as NextTickEngineHook;
        if (typeof hook.setNextTickDrain !== 'function') return false;
        if (typeof hook.notifyNextTick !== 'function') return false;
        hook.setNextTickDrain(drainNextTickQueue);
        tickState.nativeInstalled = true;
        return true;
    } catch {
        return false;
    }
}

function scheduleNextTickDrain(): void {
    if (tickState.scheduled) return;
    tickState.scheduled = true;
    if (nativeTickDrain) {
        if (!tickState.draining) {
            (engine as unknown as NextTickEngineHook).notifyNextTick!();
        }
        return;
    }
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

// Re-pointed to the singleton's live proxy when a second module copy loads.
export let env: NodeJS.ProcessEnv = envProxy;

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

// Report worker exit status even when the worker does not import worker_threads.
// Duplicate reports are harmless because Worker._finish() accepts only the first.
function installWorkerExitReporter(): void {
    if (!workerBinding?.isWorker || !workerBinding.pipe) return;
    const pipe = workerBinding.pipe;
    processEE.on('exit', (code?: unknown) => {
        try {
            pipe.postMessage({ __cno_node_worker_exit__: { code: typeof code === 'number' ? code : 0 } });
        } catch { /* pipe already closed */ }
    });
}

export function exit(code?: number): never {
    if (existingProcessDefault) {
        const activeExit = Reflect.get(processDefault, 'exit');
        if (typeof activeExit === 'function' && activeExit !== exit) {
            Reflect.apply(activeExit, processDefault, [code]);
            throw new Error('unreachable');
        }
    }
    const exitCode_ = normalizeExitCodeValue(code) ?? exitCode ?? 0;
    emitProcessExit(exitCode_);
    os.exit(exitCode_);
    throw new Error('unreachable');
}

export let exitCode: number | undefined = undefined;
export let _exiting: boolean = false;

ensureEventBridge();

installWorkerExitReporter();

export const execPath: string = os.exePath;

export let title: string = 'node';

export const version: string = 'v24.1.0';
type CnoProcessVersions = NodeJS.ProcessVersions & {
    typescript: string;
    deno: string;
};

const llhttpVersion = engine.versions.llhttp ?? '9.2.1';
const cnoDenoVersion = '2.9.3';

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
    typescript: '5.9.2',
    deno: cnoDenoVersion,
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
    emitUserProcessEvent(event, ...args);
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

let reportSeq = 0;

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
    return join(dir, name);
}

function isAbsoluteReportPath(p: string): boolean {
    return isAbsolutePath(p);
}

function collectEnvForReport(): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    for (const key of os.envKeys()) {
        try {
            const v = os.getenv(key);
            if (v !== undefined) out[key] = v;
        } catch { /* environment changed while collecting */ }
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
            processId: os.pid,
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
            return { path: file, name: basename(file) || file };
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
    const name = `report.${stamp.file}.${os.pid}.0.${String(reportSeq).padStart(3, '0')}.json`;
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
        } catch { /* reporting output is unavailable */ }
        return resolved.path;
    },
};

function formatWarning(warning: ProcessWarning): string {
    const code = warning.code === undefined ? '' : ` [${String(warning.code)}]`;
    let out = `(node:${os.pid})${code} ${warning.name}: ${warning.message}`;
    if (warning.detail !== undefined) out += `\n${String(warning.detail)}`;
    const flag = warning.name === 'DeprecationWarning' ? 'trace-deprecation' : 'trace-warnings';
    out += `\n(Use \`node --${flag} ...\` to show where the warning was created while cno is not supported)`;
    return out;
}

export function emitWarning(warning: string | Error, options?: ProcessWarningOptions): void {
    const normalized = createProcessWarning(warning, options);
    nextTick(() => {
        processEE.emit('warning', normalized);
        if (normalized.name === 'DeprecationWarning' && noDeprecation) return;
        console.error(formatWarning(normalized));
    });
}

function getuidImpl(): number {
    return os.userInfo.userId;
}

function getgidImpl(): number {
    return os.userInfo.groupId;
}

function geteuidImpl(): number {
    return os.userInfo.userId;
}

function getegidImpl(): number {
    return os.userInfo.groupId;
}

function unsupported(name: string): never {
    throw new Error(`${name} is not supported`);
}

function setuidImpl(): void { unsupported('setuid'); }

function setgidImpl(): void { unsupported('setgid'); }

function seteuidImpl(): void { unsupported('seteuid'); }

function setegidImpl(): void { unsupported('setegid'); }

function setgroupsImpl(): void { unsupported('setgroups'); }

function getgroupsImpl(): number[] {
    return processGroups();
}

function initgroupsImpl(): void { unsupported('initgroups'); }

const hasCredentialApi = platform !== 'win32';

export const getuid: (() => number) | undefined = hasCredentialApi ? getuidImpl : undefined;
export const getgid: (() => number) | undefined = hasCredentialApi ? getgidImpl : undefined;
export const geteuid: (() => number) | undefined = hasCredentialApi ? geteuidImpl : undefined;
export const getegid: (() => number) | undefined = hasCredentialApi ? getegidImpl : undefined;
export const setuid: (() => void) | undefined = hasCredentialApi ? setuidImpl : undefined;
export const setgid: (() => void) | undefined = hasCredentialApi ? setgidImpl : undefined;
export const seteuid: (() => void) | undefined = hasCredentialApi ? seteuidImpl : undefined;
export const setegid: (() => void) | undefined = hasCredentialApi ? setegidImpl : undefined;
export const setgroups: (() => void) | undefined = hasCredentialApi ? setgroupsImpl : undefined;

export function umask(mask?: number | string): number {
    const value = mask === undefined ? undefined : normalizeUmask(mask);
    if (nativeUmask) return Reflect.apply(nativeUmask, processOs, value === undefined ? [] : [value]);

    const previous = emulatedUmask;
    if (value !== undefined) emulatedUmask = value & emulatedUmaskBits;
    return previous;
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

export function kill(pid: number, signal?: string | number | null): boolean {
    try {
        proc.kill(normalizeKillPid(pid), normalizeSignal(signal));
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

export function dlopen(module: { exports?: unknown }, filename: string, _flags?: number): void {
    if (module === null || typeof module !== 'object') {
        throw new TypeError('The "module" argument must be of type object');
    }
    if (typeof filename !== 'string' || filename.length === 0) {
        throw new TypeError('The "filename" argument must be a non-empty string');
    }
    if (!napi || typeof napi.dlopen !== 'function') {
        throw new Error('Node-API native addons are unavailable in this runtime context');
    }
    try {
        module.exports = napi.dlopen(filename);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const err = new Error(`Error loading shared library ${filename}: ${msg}`);
        Reflect.set(err, 'code', 'ERR_DLOPEN_FAILED');
        throw err;
    }
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
    if (typeof id !== 'string') {
        throw codeError(new TypeError(
            `The "id" argument must be of type string. Received ${String(id)}`,
        ), 'ERR_INVALID_ARG_TYPE');
    }
    try {
        const specifier = id.startsWith('node:') ? id : `node:${id}`;
        return require(specifier) as NodeJS.Module;
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

export function ref(maybeRefable: unknown): void {
    if (maybeRefable === null || maybeRefable === undefined) return;
    const method = Reflect.get(Object(maybeRefable), 'ref');
    if (typeof method === 'function') Reflect.apply(method, maybeRefable, []);
}

export function unref(maybeRefable: unknown): void {
    if (maybeRefable === null || maybeRefable === undefined) return;
    const method = Reflect.get(Object(maybeRefable), 'unref');
    if (typeof method === 'function') Reflect.apply(method, maybeRefable, []);
}

export function loadEnvFile(path?: string | URL): void {
    const input: unknown = path;
    let normalized: EnvFilePath;
    if (input === undefined || input === null) {
        normalized = '.env';
    } else if (typeof input === 'string' || input instanceof Uint8Array) {
        normalized = input;
    } else if (input instanceof URL) {
        if (input.protocol !== 'file:') {
            throw codeError(new TypeError('The URL must be of scheme file'), 'ERR_INVALID_URL_SCHEME');
        }
        normalized = input;
    } else {
        throw codeError(new TypeError(
            `The "path" argument must be of type string or an instance of Buffer or URL. Received ${String(input)}`,
        ), 'ERR_INVALID_ARG_TYPE');
    }

    const errorPath = input === undefined || input === null ? '.env' : resolveEnvFilePath(normalized);
    try {
        loadNodeEnvFile(normalized);
    } catch (e) {
        const error = normalizeErrnoError(e, 'open', errorPath);
        const code = Reflect.get(error, 'code');
        const errno = Reflect.get(error, 'errno');
        if (typeof code === 'string' && typeof errno === 'number') {
            const detail = errMod.strerror(errno).replace(new RegExp(`^${code}:\\s*`), '');
            error.message = `${code}: ${detail}, open '${errorPath}'`;
        }
        throw error;
    }
}

export let sourceMapsEnabled: boolean = true;

export function setSourceMapsEnabled(value: boolean): void {
    if (typeof value !== 'boolean') {
        throw codeError(new TypeError(
            `The "enabled" argument must be of type boolean. Received ${String(value)}`,
        ), 'ERR_INVALID_ARG_TYPE');
    }
    sourceMapsEnabled = value;
    Reflect.set(processDefault, 'sourceMapsEnabled', value);
}

export const domain: null = null;

export const moduleLoadList: string[] = [];

type UvBinding = {
    errname(code: number): string;
    getErrorMessage(code: number): string;
    getErrorMap(): Map<number, [string, string]>;
    getCodeMap(): Map<string, number>;
} & Record<string, unknown>;

let uvBinding: UvBinding | undefined;

function createUvBinding(): UvBinding {
    const errorMap = new Map<number, [string, string]>();
    const codeMap = new Map<string, number>();
    const constants: Record<string, number> = {};
    for (const [name, code] of Object.entries(errMod.errno)) {
        if (name === 'OK') continue;
        if (typeof code !== 'number') continue;
        const errno = code;
        const message = errMod.strerror(errno).replace(new RegExp(`^${name}:\\s*`), '');
        errorMap.set(errno, [name, message]);
        codeMap.set(name, errno);
        constants[`UV_${name}`] = errno;
    }

    return {
        ...constants,
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

export const getgroups: (() => number[]) | undefined = hasCredentialApi ? getgroupsImpl : undefined;

export const initgroups: (() => void) | undefined = hasCredentialApi ? initgroupsImpl : undefined;

export function threadCpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
    return cpuUsage(previousValue);
}

export function constrainedMemory(): number {
    try {
        const constrained = os.memoryUsage()['os.constrained'];
        return typeof constrained === 'number' && constrained > 0 ? constrained : 0;
    } catch {
        return 0;
    }
}

export function availableMemory(): number {
    const mem = os.memoryUsage();
    return mem["os.free"] || 0;
}

export function setUncaughtExceptionCaptureCallback(cb: ((err: Error) => void) | null): void {
    if (cb !== null && typeof cb !== 'function') {
        throw codeError(new TypeError(
            `The "fn" argument must be of type function or null. Received ${String(cb)}`,
        ), 'ERR_INVALID_ARG_TYPE');
    }
    if (cb !== null && uncaughtCaptureState.callback !== null) {
        throw codeError(new Error(
            '`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active',
        ), 'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET');
    }
    uncaughtCaptureState.callback = cb;
    syncUncaughtCaptureListener();
}

export function hasUncaughtExceptionCaptureCallback(): boolean {
    return uncaughtCaptureState.callback !== null;
}

export const traceProcessWarnings: boolean = false;

function Process(this: object): void { }

const processDefault = existingProcessDefault ?? {
    stdout,
    stderr,
    stdin,
    env,
    argv,
    get argv0() { return argv0; },
    execArgv,
    get pid() { return os.pid; },
    get ppid() { return os.ppid; },
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

try {
    Object.defineProperties(processDefault, {
        pid: {
            enumerable: true,
            configurable: true,
            get: () => os.pid,
        },
        ppid: {
            enumerable: true,
            configurable: true,
            get: () => os.ppid,
        },
    });
} catch {
    // Preserve a sealed embedding-provided process singleton.
}

if (!existingProcessDefault && hasCredentialApi) Object.assign(processDefault, {
    getuid: getuidImpl,
    getgid: getgidImpl,
    geteuid: geteuidImpl,
    getegid: getegidImpl,
    setuid: setuidImpl,
    setgid: setgidImpl,
    seteuid: seteuidImpl,
    setegid: setegidImpl,
    getgroups: getgroupsImpl,
    setgroups: setgroupsImpl,
    initgroups: initgroupsImpl,
});

if (existingProcessDefault) {
    Reflect.set(processDefault, 'versions', versions);
    Reflect.set(processDefault, 'report', report);
    Reflect.set(processDefault, 'umask', umask);
    Reflect.set(processDefault, 'getBuiltinModule', getBuiltinModule);
    Reflect.set(processDefault, 'loadEnvFile', loadEnvFile);
    Reflect.set(processDefault, 'ref', ref);
    Reflect.set(processDefault, 'unref', unref);
    Reflect.set(processDefault, 'setSourceMapsEnabled', setSourceMapsEnabled);
    Reflect.set(processDefault, 'sourceMapsEnabled', sourceMapsEnabled);
    Reflect.set(processDefault, 'kill', kill);
    Reflect.set(processDefault, 'setUncaughtExceptionCaptureCallback', setUncaughtExceptionCaptureCallback);
    Reflect.set(processDefault, 'hasUncaughtExceptionCaptureCallback', hasUncaughtExceptionCaptureCallback);
    Reflect.set(processDefault, 'emit', emit);
    Reflect.set(processDefault, 'constrainedMemory', constrainedMemory);
    const activeEnv = Reflect.get(processDefault, 'env');
    if (activeEnv && typeof activeEnv === 'object') env = activeEnv as NodeJS.ProcessEnv;
}

if (!existingProcessDefault) Object.defineProperties(processDefault, {
    exitCode: {
        enumerable: true,
        configurable: true,
        get: () => exitCode,
        set: (value: unknown) => {
            exitCode = normalizeExitCodeValue(value);
            pushExitCodeToRuntime(exitCode);
        },
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

let _ipcChannel: IPCChannel | null = null;

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

    _ipcChannel.send(message);
    if (cb) queueMicrotask(() => cb(null));
    return true;
}

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
        unsetEnvQuietly('NODE_CHANNEL_FD');
        unsetEnvQuietly('CNO_IPC_SERIALIZATION');
    } catch {
        // IPC bootstrap failed; the child simply has no usable channel.
    }
})();
