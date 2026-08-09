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
const napi = import.meta.use('nodeapi');
// Module scope, not inside installWorkerExitReporter(): `import.meta.use` is a
// static form the transformer rewrites, and a call in a function body (with its
// return type referenced as `typeof import.meta.use`) failed to parse at all --
// OBSERVED as `TransformError: process/mod: Unexpected token, expected "("`,
// which surfaced on the parent as a worker 'error' event and exit code 1.
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

/**
 * Events whose delivery depends on the native engine-event bridge below.
 * Registering one is the cue to (re)attempt installation, in case this module
 * was evaluated before the multiplexer existed.
 */
function needsEventBridge(event: string | symbol): boolean {
    return event === 'exit' ||
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

// Environment variables

/**
 * `envTarget` must stay permanently EMPTY. `ownKeys` reports only the real OS
 * environment, so any own property parked on the target breaks the Proxy
 * invariant "ownKeys must include every own key of a non-extensible target /
 * every non-configurable own key" and makes `Object.keys(process.env)`,
 * `for..in`, spread and `JSON.stringify` throw *forever*. Every trap below
 * therefore routes through the OS and never falls back to Reflect.*et on it.
 */
const envTarget: NodeJS.ProcessEnv = {};

/**
 * Node converts env values with ToString, which THROWS for a symbol
 * ("Cannot convert a Symbol value to a string") rather than yielding
 * "Symbol(x)" the way `String(sym)` would. Same for a symbol used as a key.
 */
function envToString(value: unknown): string {
    if (typeof value === 'symbol') {
        throw new TypeError('Cannot convert a Symbol value to a string');
    }
    return `${value as string}`;
}

/**
 * Windows rejects a name containing `=` or an empty name; POSIX likewise.
 * Node's setenv/unsetenv fail SILENTLY there (the assignment is a no-op and the
 * read returns undefined) — verified on v24.18/win32. The native binding raises
 * EINVAL instead, so swallow it or a config loader iterating keys would crash.
 */
function setEnvQuietly(key: string, value: string): void {
    try {
        os.setenv(key, value);
    } catch {
        // Match Node: an unusable variable name is a silent no-op.
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
        // Inherited members (toString, hasOwnProperty, ...) still resolve, but
        // the target itself carries no own keys.
        return Reflect.get(target, key, receiver);
    },
    set(_target, key: string | symbol, value: unknown): boolean {
        // A symbol key must throw like Node rather than being parked on the
        // target, where it would also show up in getOwnPropertySymbols.
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
        // `writable` must be spelled out: omitting it defaults to false, which
        // makes the descriptor read-only and violates the ownKeys invariant.
        return {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
        };
    },
    defineProperty(_target, key: string | symbol, desc: PropertyDescriptor): boolean {
        // Node only accepts a fully configurable+writable+enumerable DATA
        // descriptor and forwards it to setenv; anything else is a TypeError.
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
        // Node throws instead of letting the env be sealed.
        throw new TypeError('Cannot prevent extensions');
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
        // Retry the native bridge: if this module was evaluated before the mux
        // existed, the eager install was a no-op and 'exit'/'uncaughtException'
        // would stay dead. Registering a listener is the point at which it
        // starts to matter.
        retryEventBridge(event);
        const result = super.on(event, listener);
        if (shouldRefIpcForProcessEvent(event)) syncIpcRef(this);
        return result;
    }

    override once(event: string | symbol, listener: ProcessListener): this {
        retryEventBridge(event);
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

/* ------------------------------------------------------------------ *
 * One emitter per process, not one per copy of this file
 * ------------------------------------------------------------------ *
 *
 * TWO copies of this module are live at once: the one baked into cno.exe and the
 * one `cno setup` writes to $CTS_CACHE_DIR/node/process/mod.ts. `import process
 * from 'node:process'` resolves to the baked copy's singleton (below), while
 * `import * as ns from 'node:process'` reaches the disk copy — so a
 * module-scoped `new ProcessEventEmitter()` gave each copy its own listener set
 * (OBSERVED: proc.emit('probe') was heard only by proc.on, procNS.emit('probe')
 * only by procNS.on, each reporting listenerCount === 1). The native 'exit'
 * bridge then emitted on whichever copy loaded last, so the portable
 * `process.on('exit')` form silently received nothing.
 *
 * The fix is the same order-independence trick the mux uses: the emitter lives on
 * a `Symbol.for()` slot, and a copy that finds one already there ADOPTS it
 * instead of creating a rival. Adoption (rather than migrating listeners across)
 * is what makes this work without a rebuild: whichever copy runs first owns the
 * emitter and all its listeners, and the second copy has none of its own to
 * move.
 */
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

/**
 * The emitter behind an already-installed singleton.
 *
 * A copy old enough to predate PROCESS_EE_SLOT publishes nothing, so the slot
 * alone is not enough to unify with the currently baked binary. Its exported
 * `removeAllListeners` returns `processEE` (EventEmitter methods return `this`),
 * and called with a private symbol it is a pure no-op: nothing listens on it,
 * and syncIpcRef() only reacts to `undefined`/'message'/'disconnect'. So this
 * recovers the emitter without a rebuild and without side effects.
 */
function probeSingletonEmitter(): EventEmitter | null {
    if (!existingProcessDefault) return null;
    try {
        // Reached through Reflect.get and a plain call signature: the declared
        // NodeJS.Process['removeAllListeners'] is an overloaded generic and
        // `?.()` on it does not typecheck (TS2349), even though the runtime call
        // is a straightforward one-argument invocation.
        const removeAll = Reflect.get(existingProcessDefault, 'removeAllListeners');
        if (typeof removeAll !== 'function') return null;
        const probe = (removeAll as (e: symbol) => unknown).call(
            existingProcessDefault,
            Symbol('cno.process.emitter.probe'),
        );
        if (isEmitterLike(probe) && (probe as unknown) !== existingProcessDefault) return probe;
    } catch { /* exotic singleton; fall through */ }
    return null;
}

function resolveProcessEmitter(): ProcessEventEmitter {
    const slotted = Reflect.get(globalThis, PROCESS_EE_SLOT);
    if (isEmitterLike(slotted)) return slotted as ProcessEventEmitter;

    const probed = probeSingletonEmitter();
    if (probed) {
        // Publish it so a third copy finds it on the slot directly.
        Reflect.set(globalThis, PROCESS_EE_SLOT, probed);
        return probed as ProcessEventEmitter;
    }

    const created = new ProcessEventEmitter();
    Reflect.set(globalThis, PROCESS_EE_SLOT, created);
    return created;
}

const processEE: ProcessEventEmitter = resolveProcessEmitter();
type NextTickCallback = (...args: unknown[]) => void;
/* ------------------------------------------------------------------ *
 * ONE nextTick queue per process, not one per copy of this file
 * ------------------------------------------------------------------ *
 *
 * TWO copies of this module are live at once (see the emitter note above): the
 * baked one and the $CTS_CACHE_DIR/node/process/mod.ts one. A module-scoped
 * queue therefore gave each copy its own -- MEASURED: `import process` and
 * `import * as ns` expose different nextTick functions
 * (`proc.nextTick === procNS.nextTick` is false) and each used to drain its own
 * array.
 *
 * That was survivable while the drain was scheduled with queueMicrotask, because
 * each copy independently scheduled its own. It is NOT survivable with the
 * native checkpoint below: engine.setNextTickDrain() is a SINGLE-SLOT setter
 * that frees the previous function, so the second copy to load would EVICT the
 * first copy's drain and silently orphan its queue -- every callback registered
 * through the other facade would never run at all. This is the same single-slot
 * trap the engine.onEvent() note further down describes.
 *
 * So the queue and its two flags live on a Symbol.for() slot and a copy that
 * finds one already there ADOPTS it. One queue, one registration, and ordering
 * that is consistent across both facades the way node's single queue is.
 */
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
        // Adopt only something that actually looks like the state, so an exotic
        // global cannot wedge nextTick into a permanently unusable shape.
        if (existing && Array.isArray(existing.queue)) return existing;
        slots[NEXT_TICK_SLOT] = fresh;
    } catch {
        // Frozen or exotic globalThis: fall back to per-copy state. Degrades to
        // the old per-copy behaviour rather than failing to schedule at all.
    }
    return fresh;
}

const tickState: NextTickState = resolveNextTickState();

// Same array object every copy pushes into; the three use sites below are
// ordinary array operations, so they need no further indirection.
const nextTickQueue: NextTickEntry[] = tickState.queue;

function drainNextTickQueue(): void {
    // `scheduled` stays TRUE for the whole drain and is cleared in the finally,
    // not on entry. A tick callback that queues another tick must not schedule a
    // second drain -- the loop below already picks it up -- but the flag must
    // still end up false, or the next nextTick() from a timer would see it set,
    // return early, and never be drained at all.
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

// Registered here, early in module evaluation, so a circular import that reaches
// process.nextTick while this module is still evaluating cannot hit the TDZ of a
// const declared further down. installNativeTickDrain() is a hoisted declaration;
// see its comment block below for why the checkpoint has to come from C.
const nativeTickDrain: boolean = installNativeTickDrain();

function handleUncaughtException(error: unknown): void {
    processEE.emit('uncaughtExceptionMonitor', error, 'uncaughtException');
    if (processEE.listenerCount('uncaughtException') > 0) {
        processEE.emit('uncaughtException', error, 'uncaughtException');
        return;
    }
    throw error;
}

/* ------------------------------------------------------------------ *
 * Native engine-event bridges: 'exit' and 'uncaughtException'
 * ------------------------------------------------------------------ *
 *
 * Neither existed. `processEE.emit('exit')` appeared in exactly one place —
 * inside process.exit() below — so `process.on('exit')` never fired for any
 * other termination path. And handleUncaughtException() was only ever reached
 * from the nextTick drain, so a throw from a timer, an I/O callback or a stray
 * socket 'error' produced no 'uncaughtException' at all (independently OBSERVED:
 * an unhandled socket 'error' event yielded nothing).
 *
 * Both are wired through the shared multiplexer in cts/src/runtime/event-mux.ts.
 * Not via engine.onEvent(): that is a single-slot setter which frees the
 * previous receiver (circu.js/src/mod_engine.c:871), so a direct call here would
 * destroy webapi's 'load'/'unload' bridge — trading one broken feature for
 * another. This module cannot *import* the mux (AGENT.md: node/ modules must not
 * import across the node/ boundary, and node/ is copied to the polyfill cache
 * dir where ../../../cts does not exist), so it reaches the registry through the
 * Symbol.for() slot the mux publishes for exactly this purpose.
 */

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
    } catch { /* exotic global; treat as absent */ }
    return null;
}

/** Node fires 'exit' exactly once. Both paths that can emit it go through here. */
let exitEmitted = false;

function emitProcessExit(code: number): void {
    if (exitEmitted) return;
    exitEmitted = true;
    _exiting = true;
    try {
        processEE.emit('exit', code);
    } catch {
        // A listener threw. Node prints and still exits; swallowing here keeps
        // teardown going rather than losing the exit path entirely.
    }
}

let eventBridgeInstalled = false;

const NODE_PROCESS_ROLE = 'node-process';

function ensureEventBridge(): void {
    if (eventBridgeInstalled) return;
    const mux = eventMux();
    // No mux yet (module load order, or a standalone cno without cts): stay off
    // the bus. Falling back to a raw engine.onEvent() here would displace
    // whatever receiver *is* installed, which is the very bug being fixed.
    // ensureEventBridge() is retried when a listener is registered.
    if (!mux) return;

    // mux.install() is ROLE-keyed and replaces same-role, so the second copy of
    // this module to load used to EVICT the first copy's receiver. With the
    // emitter now shared that eviction would be harmless for delivery, but it
    // would also swap in a receiver whose module-scoped `exitEmitted` flag is a
    // different variable — and the once-guard is per-copy. First install wins:
    // whichever copy is on the bus emits through the shared emitter, so every
    // listener is reached and exactly one flag governs the fire count.
    if (mux.has?.(NODE_PROCESS_ROLE)) {
        eventBridgeInstalled = true;
        return;
    }
    eventBridgeInstalled = true;

    // Above PRIORITY_DIAGNOSTICS (0) so setting ctx.handled can suppress the
    // cts "unhandled job exception" warning, the way a Node
    // 'uncaughtException' handler suppresses the default report. Below
    // PRIORITY_WEBAPI (100) so the web ErrorEvent still dispatches first.
    mux.install(NODE_PROCESS_ROLE, (name, data, ctx) => {
        const ET = engine.EventType;

        if (name === ET.EXIT) {
            // EV_EXIT carries the status as an int (mod_os.c:87, vm.c:282).
            emitProcessExit(typeof data === 'number' ? data : (exitCode ?? 0));
            // Return value is freed and ignored by the C for this event.
            return undefined;
        }

        if (name === ET.JOB_EXCEPTION) {
            processEE.emit('uncaughtExceptionMonitor', data, 'uncaughtException');
            if (processEE.listenerCount('uncaughtException') === 0) {
                // No handler: leave the outcome exactly as it was. Do NOT call
                // handleUncaughtException() — it rethrows, and the mux swallows
                // receiver exceptions, so the error would disappear instead of
                // being reported.
                return undefined;
            }
            try {
                processEE.emit('uncaughtException', data, 'uncaughtException');
            } catch {
                // A throw from inside the handler must not become a TJS_Stop.
            }
            // The program dealt with it: silence the runtime diagnostic.
            ctx.handled = true;
            // POLARITY: utils.c:180 calls TJS_Stop when the receiver returns
            // FALSE. So "handled, keep running" is `true` here — the opposite
            // constant from EV_UNHANDLED_REJECTION, where vm.c:242 aborts on any
            // non-false and "handled" is `false`. Returning false here would
            // kill the process on precisely the errors the program handled.
            return true;
        }

        return undefined;
    }, 50);
}

/* ------------------------------------------------------------------ *
 * process.nextTick priority
 * ------------------------------------------------------------------ *
 *
 * Node keeps the nextTick queue at HIGHER priority than promise microtasks and
 * drains it at the microtask checkpoint, so a nextTick callback runs before any
 * pending promise continuation REGARDLESS of registration order. MEASURED on
 * v24.18: registering `.then` first still yields nt>then, and queueMicrotask
 * first still yields nt>qmt.
 *
 * queueMicrotask() cannot express that. It appends to the very FIFO the promise
 * jobs use, so a drain scheduled from JS only won when it happened to be
 * enqueued first -- `.then`-first produced then>nt here, and qmt-first produced
 * qmt>nt. No JS primitive outranks queueMicrotask, so the checkpoint call has to
 * come from C: engine.setNextTickDrain() hands this drain to
 * tjs__execute_jobs(), which runs it before the pending-job loop and again after
 * that loop is exhausted (circu.js/src/vm.c). engine.notifyNextTick() only
 * raises the native "ticks are pending" flag so the checkpoint knows to call --
 * cheap, and it also keeps the loop awake for a nextTick with no promise in
 * sight, which JS_IsJobPending() cannot see.
 *
 * The queue, the argument handling and the uncaughtException semantics all stay
 * here. C decides only WHEN to drain.
 *
 * The fallback matters: this file is served to the runtime as SOURCE, so it
 * lands without a rebuild, while the C half does not. Against a binary that
 * predates the hook, feature detection keeps the old queueMicrotask behaviour
 * (FIFO ordering, as today) instead of dropping every callback on the floor.
 */
type NextTickEngineHook = {
    setNextTickDrain?: (fn: () => void) => void;
    notifyNextTick?: () => void;
};

function installNativeTickDrain(): boolean {
    // Only the first copy to get here registers. A second registration would
    // free this one and orphan the shared queue behind it.
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
        // Inside a drain the loop already sees the new entry; notifying again
        // would only buy a redundant checkpoint crossing.
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

// `let`, not `const`: a SECOND copy of this module must export the singleton's
// env proxy, not its own. Re-pointed next to the processDefault fixups below.
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

/**
 * Announce a worker's exit status to its parent, for workers that never import
 * node:worker_threads.
 *
 * A worker's exit code otherwise reaches the parent by exactly one route: the
 * process 'exit' listener installed by createParentPort() in
 * node/worker_threads/mod.ts:834. That function only runs when the WORKER ITSELF
 * imports node:worker_threads. MEASURED 2026-08-09 against node v24.18.0: a
 * worker whose whole body is `process.exit(42)` reported code 0 to the parent's
 * 'exit' event where node reports 42, so `process.exit(1)` to signal failure read
 * as clean success to any pool that checks the code. Adding
 * `require('node:worker_threads')` anywhere in the same worker made it report 42,
 * which is what isolated "no reporter installed" from "code lost in transit".
 *
 * This is a processEE listener rather than a line inside exit() below, because
 * that exit() is not what a worker calls: `require('node:process').exit`
 * stringifies as `function exit() { [native code] }` (MEASURED), so the TS
 * function is bypassed and a call placed there never ran. The native exit
 * dispatches EV_EXIT, ensureEventBridge() turns that into processEE 'exit', and a
 * listener therefore sees every code the native path carries. That is the same
 * mechanism the worker_threads reporter already relies on.
 *
 * When worker_threads IS loaded both reporters fire and the parent receives two
 * exit records. That is harmless: Worker._finish() (worker_threads/mod.ts:700-701)
 * returns early once _exited is set, so the first record wins. No cross-module
 * once-flag is needed for that reason.
 *
 * Deliberately NOT covering natural drain with `process.exitCode = N`: that needs
 * an EV_EXIT a worker never receives, because tjs__lifecycle_drain()
 * (circu.js/src/vm.c:948-955) returns early for qrt->is_worker. That is a C fix
 * and stays reported rather than worked around here.
 */
function installWorkerExitReporter(): void {
    if (!workerBinding?.isWorker || !workerBinding.pipe) return;
    const pipe = workerBinding.pipe;
    processEE.on('exit', (code?: unknown) => {
        try {
            pipe.postMessage({ __cno_node_worker_exit__: { code: typeof code === 'number' ? code : 0 } });
        } catch {
            // The pipe is already torn down; the parent falls back to 0 on EOF,
            // i.e. the previous behaviour.
        }
    });
}

export function exit(code?: number): never {
    // Forward to the singleton's exit when this is the SECOND copy of the module
    // (same pattern as _setupIPC/send/disconnect below). `exitEmitted` is
    // module-scoped and therefore per-copy: with the emitter now shared, a disk
    // copy running its own exit() would emit on the shared emitter, and the
    // baked copy's still-clear flag would let the native EV_EXIT bridge emit a
    // SECOND time — a double-fire that was previously invisible only because the
    // two emitters had disjoint listeners. Routing through the one live exit()
    // keeps a single flag in charge.
    if (existingProcessDefault) {
        const activeExit = Reflect.get(processDefault, 'exit');
        if (typeof activeExit === 'function' && activeExit !== exit) {
            Reflect.apply(activeExit, processDefault, [code]);
            throw new Error('unreachable');
        }
    }
    const exitCode_ = normalizeExitCodeValue(code) ?? exitCode ?? 0;
    // Via emitProcessExit, not a bare emit: os.exit() below dispatches native
    // EV_EXIT (mod_os.c:87), which the bridge above also turns into 'exit'.
    // Node guarantees the event fires exactly once, so both paths share one
    // once-flag.
    emitProcessExit(exitCode_);
    os.exit(exitCode_);
    throw new Error('unreachable');
}

export let exitCode: number | undefined = undefined;
export let _exiting: boolean = false;

// Installed here, not at the definition site: the receiver reads `exitCode` and
// writes `_exiting`, both `let` bindings declared just above. Attaching the
// bridge before they are initialised would leave a window in which a native
// EV_EXIT reaches emitProcessExit() and dies on a temporal-dead-zone error
// instead of emitting 'exit'.
ensureEventBridge();

// Arm the worker exit-status reporter in the same breath as the bridge that
// drives it: the reporter is a processEE 'exit' listener, and only a live bridge
// turns a native EV_EXIT into that event.
installWorkerExitReporter();

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

/**
 * Node's default warning printer, verified against v24.18:
 *   (node:PID) [CODE] Name: message
 *   <detail, when present>
 *   (Use `node --trace-warnings ...` to show where the warning was created)
 * The code is omitted when absent, and a DeprecationWarning gets the
 * --trace-deprecation hint instead. Tooling and CI greps depend on the
 * `Name:` prefix, so a bare message is not a cosmetic difference.
 */
function formatWarning(warning: ProcessWarning): string {
    const code = warning.code === undefined ? '' : ` [${String(warning.code)}]`;
    let out = `(node:${pid})${code} ${warning.name}: ${warning.message}`;
    if (warning.detail !== undefined) out += `\n${String(warning.detail)}`;
    const flag = warning.name === 'DeprecationWarning' ? 'trace-deprecation' : 'trace-warnings';
    out += `\n(Use \`node --${flag} ...\` to show where the warning was created)`;
    return out;
}

export function emitWarning(warning: string | Error, options?: ProcessWarningOptions): void {
    const normalized = createProcessWarning(warning, options);
    // Node defers BOTH the print and the event to the next tick, so a
    // synchronous console.log after emitWarning lands first. A user 'warning'
    // listener does NOT replace the default printer — v24.18 emits both.
    nextTick(() => {
        processEE.emit('warning', normalized);
        if (normalized.name === 'DeprecationWarning' && noDeprecation) return;
        console.error(formatWarning(normalized));
    });
}

// POSIX credential accessors. Real Node does not expose any of these on
// Windows — verified on v24.18/win32: getuid, getgid, geteuid, getegid,
// setuid, setgid, seteuid, setegid, getgroups, setgroups and initgroups are
// all absent (not even present as keys). They are declared unconditionally
// here and gated onto the exported surface below.

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

/** Windows has no POSIX uid/gid concept; match Node and expose nothing. */
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

/**
 * Load a Node-API `.node` into `module.exports` (same loader as CJS require).
 * Legacy V8/NAN addons fail closed inside nodeapi.
 */
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
} & Record<string, unknown>;

let uvBinding: UvBinding | undefined;

function createUvBinding(): UvBinding {
    const errorMap = new Map<number, [string, string]>();
    const codeMap = new Map<string, number>();
    const constants: Record<string, number> = {};
    for (const [name, code] of Object.entries(errMod.errno)) {
        // Real Node keeps UNKNOWN in the map (-4094 → 'unknown error'); only
        // the non-error OK sentinel is excluded.
        if (name === 'OK') continue;
        if (typeof code !== 'number') continue;
        const errno = code;
        const message = errMod.strerror(errno).replace(new RegExp(`^${name}:\\s*`), '');
        errorMap.set(errno, [name, message]);
        codeMap.set(name, errno);
        // Node exposes every errno as a UV_<NAME> constant on the binding.
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

// POSIX-only credential methods: added as own keys only where Node has them,
// so `'getgid' in process` is false on Windows exactly as in real Node.
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

// Re-evaluation (e.g. after `cno setup` refreshes cache) reuses the singleton
// but must pick up newly filled surfaces like report.
if (existingProcessDefault) {
    Reflect.set(processDefault, 'versions', versions);
    Reflect.set(processDefault, 'report', report);
    // The named export was this copy's own proxy while globalThis.process.env
    // stayed the first copy's — identity-only, but `process.env === env` is a
    // documented Node invariant. Derive it from the live singleton.
    const activeEnv = Reflect.get(processDefault, 'env');
    if (activeEnv && typeof activeEnv === 'object') env = activeEnv as NodeJS.ProcessEnv;
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
