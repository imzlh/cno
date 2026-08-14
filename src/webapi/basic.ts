import type { Stream } from "../deno/04_stdio";
import { structuredCloneWithTransfer } from "../node/_internal/structured-clone";
import type { SingleByteEncoding } from "../utils/bytes";
import { arrayBufferBackedBytes, decodeSingleByte, sanitizeSurrogates, utf8Decode, utf8PendingTail } from "../utils/bytes";
import { DOMException } from "./events";
import { messagePortTransferHooks } from "./messaging";
import { stdin, stdout } from "../utils/stdio";

type TimerOptions = { signal?: AbortSignal };

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const text = import.meta.use('text');
const os = import.meta.use('os');
const timer = import.meta.use('timers');
const streams = import.meta.use('streams');
const console = import.meta.use('console');

const NativeError = globalThis.Error;
const nativeCaptureStackTrace = NativeError.captureStackTrace;

/**
 * QuickJS exposes an error's frames through a `stack` CGETSET accessor on
 * `Error.prototype` (quickjs.c `js_error_proto_funcs`), reading the frames out
 * of the instance's internal `[[ErrorData]]` slot. Two consequences, both
 * measured against Node v24.18.0:
 *
 *  - No error instance has an *own* `stack`. V8 defines one on every error at
 *    construction, so `Object.getOwnPropertyNames(e)` includes `'stack'` there
 *    and not here — which breaks own-property walks and `inspect(showHidden)`.
 *  - The engine's frames are headerless. Node's `.stack` starts with
 *    `Name: message`.
 *
 * Capture the native accessor before anything below replaces it: it is the only
 * way back to the raw frames once our own getter shadows it.
 */
const nativeStackDescriptor = Object.getOwnPropertyDescriptor(NativeError.prototype, 'stack');
const nativeStackGetter = typeof nativeStackDescriptor?.get === 'function' ? nativeStackDescriptor.get : undefined;

function readNativeStack(error: object): unknown {
    if (!nativeStackGetter) return undefined;
    try {
        return nativeStackGetter.call(error);
    } catch {
        return undefined;
    }
}

function formatErrorStackHeader(error: { name?: unknown; message?: unknown }): string {
    const name = error.name === undefined ? 'Error' : String(error.name);
    const message = error.message === undefined ? '' : String(error.message);
    if (name === '') return message;
    if (message === '') return name;
    return `${name}: ${message}`;
}

/**
 * Errors whose `stack` value came out of an `Error.prepareStackTrace` hook.
 *
 * The hook's return value is the stack, whatever it is — Node never touches it.
 * A shape heuristic cannot decide this reliably (a hook returning `''` or a
 * frame-looking string is indistinguishable from engine output), so record it at
 * the point the hook runs instead. Populated by `prepareStackTraceWrapper`.
 */
const hookFormattedErrors = new WeakSet<object>();

/**
 * Prepend `Name: message` to headerless engine frames.
 *
 * Only engine frames get a header. A value produced by an
 * `Error.prepareStackTrace` hook is returned verbatim — re-heading it is the
 * specific mistake that a previous eager implementation made and had to revert,
 * and `tests/cts/sourcemap-stack-position.test.ts` pins it. (Before this, a hook
 * returning `'SENTINEL'` produced `'Error: m\nSENTINEL'` on `Error` but a correct
 * bare `'SENTINEL'` on `TypeError`, because only `Error` was wrapped.)
 *
 * Node's `.stack` has no trailing newline; QuickJS's frames always end in one.
 */
function headerizeErrorStack(error: object, raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    if (hookFormattedErrors.has(error)) return raw;
    const frames = stripInternalErrorProxyFrames(raw);
    if (frames !== '') {
        const nl = frames.indexOf('\n');
        const first = (nl === -1 ? frames : frames.slice(0, nl)).trimStart();
        if (!first.startsWith('at ')) return frames;
    }
    const header = formatErrorStackHeader(error as { name?: unknown; message?: unknown });
    return frames === '' ? header : `${header}\n${frames}`;
}

/**
 * True when the frame starting at `from` (after indentation) is one of the proxy
 * trap's own frames.
 *
 * Compared in place against the source string. The obvious version — slice the
 * line, `trimStart()`, then test four prefixes — cost 39us/op on its own, more
 * than the rest of the getter combined, because it allocated twice per call.
 */
function isInternalErrorProxyFrameAt(stack: string, from: number, lineEnd: number): boolean {
    let rest: number;
    if (stack.startsWith('at construct (', from)) {
        rest = from + 14;
    } else if (stack.startsWith('at apply (', from)) {
        rest = from + 10;
    } else {
        return false;
    }
    if (stack.startsWith('native)', rest)) return rest + 7 === lineEnd;
    return stack.startsWith('<core>:', rest);
}

/**
 * Strip the proxy trap's own frames off the front, and any trailing newline.
 *
 * Allocates nothing unless something is actually stripped: `.stack` is read on
 * error paths that are often already hot.
 */
function stripInternalErrorProxyFrames(stack: string): string {
    let end = stack.length;
    while (end > 0 && stack.charCodeAt(end - 1) === 10 /* \n */) end--;

    let start = 0;
    while (start < end) {
        let lineEnd = stack.indexOf('\n', start);
        if (lineEnd === -1 || lineEnd > end) lineEnd = end;
        let probe = start;
        while (probe < lineEnd && (stack.charCodeAt(probe) === 32 || stack.charCodeAt(probe) === 9)) probe++;
        // Every internal frame begins `at `, so reject on the first byte.
        if (stack.charCodeAt(probe) !== 97 /* a */) break;
        if (!isInternalErrorProxyFrameAt(stack, probe, lineEnd)) break;
        start = lineEnd + 1;
        if (start > end) start = end;
    }

    return start === 0 && end === stack.length ? stack : stack.slice(start, end);
}

/**
 * The same internal frames, on the `CallSite` side.
 *
 * `build_backtrace` (quickjs.c) has two branches: it builds a string, or — when a
 * `prepareStackTrace` hook is installed — an array of CallSite objects.
 * `stripInternalErrorProxyFrames` only cleans the string, so the proxy's trap
 * frames survived into the array as `sites[0]` and `sites[1]`, which is exactly
 * where every CallSite-consuming library looks for the throw site.
 *
 * This matters more now than it did: wrapping all ten error constructors would
 * otherwise spread a leak that previously only affected `Error`.
 */
function isInternalErrorProxyCallSite(site: unknown): boolean {
    if (!site || typeof site !== 'object') return false;
    const cs = site as { getFunctionName?: () => unknown; getFileName?: () => unknown };
    if (typeof cs.getFunctionName !== 'function' || typeof cs.getFileName !== 'function') return false;
    let fn: unknown;
    let file: unknown;
    try {
        fn = cs.getFunctionName();
        file = cs.getFileName();
    } catch {
        return false;
    }
    if (fn !== 'construct' && fn !== 'apply') return false;
    // `native` frames report a null filename; the trap body itself reports the
    // baked bundle. A user function named `construct` in real code has neither.
    return file === null || file === undefined || file === '<core>';
}

function stripInternalErrorProxyCallSites(sites: unknown): unknown {
    if (!Array.isArray(sites)) return sites;
    let start = 0;
    while (start < sites.length && isInternalErrorProxyCallSite(sites[start])) start++;
    return start === 0 ? sites : sites.slice(start);
}

/** Drop our lazy stack so native capture can write frames again. */
function clearLazyErrorStack(error: object): void {
    const own = Object.getOwnPropertyDescriptor(error, 'stack');
    if (own && typeof own.get === 'function' && own.configurable) {
        try { delete (error as { stack?: unknown }).stack; } catch { /* */ }
    }
}

/**
 * Give `error` an own, lazily-computed `stack` — matching V8's shape
 * (own accessor, non-enumerable, configurable) rather than QuickJS's
 * prototype-only one.
 *
 * Lazy is load-bearing in two directions. The getter must not run at
 * construction because reading + splitting frames for every error thrown is
 * expensive (measured: 95us/op eager vs 45us/op lazy for 20k constructions),
 * and the setter must latch a user-assigned value verbatim because Node does
 * not re-header an assigned stack.
 *
 * `mode` distinguishes the two callers, which need different sources:
 *  - `'construct'`: a brand-new error from a constructor trap. It cannot already
 *    carry an own `stack` (so the descriptor probe is skipped) and its frames live
 *    in the engine's `[[ErrorData]]` slot, read on demand.
 *  - `'capture'`: after native `Error.captureStackTrace`, which has just written
 *    an own *data* property. Those frames are headerless and still need a header,
 *    so they must NOT be latched as if a user had assigned them — doing that
 *    regressed `Error.captureStackTrace({name,message})` from `'N: M\n at …'` to
 *    bare frames. The target is often a plain object with no `[[ErrorData]]` slot
 *    at all, so the value has to be carried in the closure.
 */
function installLazyErrorStack<T>(error: T, mode: 'construct' | 'capture'): T {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
    const target = error as object;

    let customStack: unknown;
    let hasCustomStack = false;
    let capturedFrames: unknown;
    let hasCapturedFrames = false;
    let enumerable = false;

    if (mode === 'capture') {
        const own = Object.getOwnPropertyDescriptor(target, 'stack');
        if (own) {
            if (!own.configurable) return error;
            enumerable = own.enumerable ?? false;
            if ('value' in own) {
                if (own.value === undefined) return error;
                capturedFrames = own.value;
                hasCapturedFrames = true;
            } else if (typeof own.get === 'function') {
                // Already one of ours (or a user accessor): read it through and
                // keep the result verbatim rather than re-deriving a header.
                try {
                    customStack = own.get.call(target);
                    hasCustomStack = true;
                } catch {
                    return error; // hostile getter: leave it alone
                }
            }
        }
    }

    try {
        Object.defineProperty(target, 'stack', {
            configurable: true,
            enumerable,
            get() {
                if (hasCustomStack) return customStack;
                const self = (this && (typeof this === 'object' || typeof this === 'function')) ? this as object : target;
                const raw = hasCapturedFrames ? capturedFrames : readNativeStack(self);
                const computed = headerizeErrorStack(self, raw);
                if (self === target) {
                    // V8 formats the stack once, on first read, and caches it, so a
                    // later `err.name = …` does NOT re-header an already-read stack
                    // (measured: read-then-rename keeps `Error: m`, whereas
                    // rename-then-read yields `Renamed: m`). Latching through the
                    // same slot the setter uses reproduces both orders.
                    customStack = computed;
                    hasCustomStack = true;
                }
                return computed;
            },
            set(value) {
                customStack = value;
                hasCustomStack = true;
            },
        });
    } catch { /* frozen or sealed error: leave the prototype accessor to serve it */ }
    return error;
}

/**
 * Every native error constructor needs wrapping, not just `Error`. Wrapping only
 * `Error` left `new TypeError('m').stack` frames-only, so `util.inspect` rendered
 * `[    at <anonymous> (…)]` instead of `TypeError: m` — the dominant remaining
 * inspect-parity gap (76 of 105 fuzz failures). `src/node/vm/mod.ts` already
 * wraps the same list for sandbox realms; this mirrors it for the host realm.
 *
 * `InternalError` is QuickJS-only and has no Node counterpart, but it is a real
 * global here and errors thrown from it deserve the same header.
 */
const NATIVE_ERROR_CTOR_NAMES = [
    'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
    'TypeError', 'URIError', 'InternalError', 'AggregateError', 'SuppressedError',
] as const;

/** Anything constructible: the native error constructors and the proxies over them. */
type ErrorCtorLike = abstract new (...args: never[]) => object;

function wrapErrorConstructor<T extends ErrorCtorLike>(ctor: T): T {
    return new Proxy(ctor, {
        apply(target, thisArg, args) {
            return installLazyErrorStack(Reflect.apply(target as never, thisArg, args), 'construct');
        },
        construct(target, args, newTarget) {
            // newTarget is forwarded so subclasses keep their own prototype.
            return installLazyErrorStack(Reflect.construct(target as never, args, newTarget), 'construct') as object;
        },
    });
}

/** Point `C.prototype.constructor` at the proxy that replaced `C` as the global. */
function repointConstructorProperty(ctor: ErrorCtorLike, wrapped: ErrorCtorLike): void {
    const proto = (ctor as { prototype?: unknown }).prototype;
    if (!proto || typeof proto !== 'object') return;
    const own = Object.getOwnPropertyDescriptor(proto, 'constructor');
    if (!own || !own.configurable) return;
    try {
        Object.defineProperty(proto, 'constructor', {
            value: wrapped,
            writable: own.writable ?? true,
            enumerable: own.enumerable ?? false,
            configurable: true,
        });
    } catch { /* leave it naming the native ctor */ }
}

const ErrorProxy = wrapErrorConstructor(NativeError);

Object.defineProperty(ErrorProxy, 'captureStackTrace', {
    value(target: object, constructorOpt?: (...args: never[]) => unknown) {
        // Remove our lazy getter first so the native write is not swallowed by
        // our setter, then re-wrap whatever native capture produced.
        clearLazyErrorStack(target);
        nativeCaptureStackTrace?.(target, constructorOpt ?? NativeError.captureStackTrace);
        installLazyErrorStack(target, 'capture');
    },
    writable: true,
    enumerable: false,
    configurable: true,
});
Reflect.set(globalThis, 'Error', ErrorProxy);

/**
 * Intercept `Error.prepareStackTrace` so the hook sees a clean CallSite array and
 * its return value is recorded as authoritative.
 *
 * QuickJS keeps the hook in `ctx->error_prepare_stack` behind a CGETSET on the
 * `Error` constructor (quickjs.c `js_error_set_prepareStackTrace`) and calls it
 * from C with `(error_obj, sites)`. There is no way to filter the array from
 * inside the construct trap — the array is built after the trap returns — so the
 * hook itself is where it has to happen. Assigning a wrapper into the native slot
 * while reporting the user's own function back through the getter keeps the
 * substitution invisible: `Error.prepareStackTrace === myHook` stays true.
 */
if (nativeStackGetter) {
    const nativePrepareDescriptor = Object.getOwnPropertyDescriptor(NativeError, 'prepareStackTrace');
    const nativePrepareGet = nativePrepareDescriptor?.get;
    const nativePrepareSet = nativePrepareDescriptor?.set;
    if (typeof nativePrepareGet === 'function' && typeof nativePrepareSet === 'function'
        && nativePrepareDescriptor?.configurable) {
        let userPrepare: unknown;
        Object.defineProperty(NativeError, 'prepareStackTrace', {
            configurable: true,
            enumerable: nativePrepareDescriptor.enumerable ?? false,
            get() {
                // Report what the user assigned, never the wrapper.
                return userPrepare === undefined ? nativePrepareGet.call(NativeError) : userPrepare;
            },
            set(value: unknown) {
                userPrepare = value;
                if (typeof value !== 'function') {
                    try { nativePrepareSet.call(NativeError, value); } catch { /* */ }
                    return;
                }
                const hook = value as (error: unknown, sites: unknown) => unknown;
                const wrapper = function prepareStackTraceWrapper(error: unknown, sites: unknown): unknown {
                    const result = hook.call(NativeError, error, stripInternalErrorProxyCallSites(sites));
                    if (error && (typeof error === 'object' || typeof error === 'function')) {
                        // Mark it so headerizeErrorStack hands the value back
                        // untouched instead of synthesising a header over it.
                        try { hookFormattedErrors.add(error as object); } catch { /* */ }
                    }
                    return result;
                };
                try { nativePrepareSet.call(NativeError, wrapper); } catch { /* */ }
            },
        });
    }
}

for (const name of NATIVE_ERROR_CTOR_NAMES) {
    if (name === 'Error') continue;
    const ctor = Reflect.get(globalThis, name);
    if (typeof ctor !== 'function') continue;
    // `Object.getPrototypeOf(TypeError) === Error` is true in Node. Replacing the
    // `Error` global with a Proxy broke that, because the native subclass
    // constructors still inherit from the unwrapped native `Error`. Re-point them
    // at the proxy so the chain — and the patched `captureStackTrace` they inherit
    // through it — is the one user code sees.
    try { Object.setPrototypeOf(ctor, ErrorProxy); } catch { /* non-extensible: skip */ }
    const wrapped = wrapErrorConstructor(ctor as ErrorCtorLike);
    // `TypeError.prototype.constructor === TypeError` is also true in Node, and
    // `err.constructor === TypeError` is a common library type test. Without this
    // the prototype still names the unwrapped native ctor and both go false.
    repointConstructorProperty(ctor as ErrorCtorLike, wrapped);
    try { Reflect.set(globalThis, name, wrapped); } catch { /* non-writable in this realm: skip */ }
}
repointConstructorProperty(NativeError, ErrorProxy);

/**
 * Engine-thrown errors (`null.x`, a failed `JSON.parse`, anything raised from C)
 * never pass through a JS constructor, so the traps above cannot reach them.
 * Their frames are still headerless, so patch the prototype accessor they fall
 * back to. This fixes the *content* for that population; their own-property
 * shape still differs from Node and needs an engine fix (see quickjs.c
 * `build_backtrace`).
 */
if (nativeStackDescriptor && nativeStackDescriptor.configurable && nativeStackGetter) {
    const nativeStackSetter = nativeStackDescriptor.set;
    // Same format-once-then-cache semantics as the own accessor above. A WeakMap
    // rather than an own property: materialising one on read would make
    // `Object.getOwnPropertyNames(e)` depend on whether anything had already
    // touched `.stack`, and a stable shape is easier to reason about than an
    // intermittently-correct one. It also keeps frozen errors working.
    const headeredStackCache = new WeakMap<object, unknown>();
    Object.defineProperty(NativeError.prototype, 'stack', {
        configurable: true,
        enumerable: false,
        get(this: object) {
            if (!this || (typeof this !== 'object' && typeof this !== 'function')) return undefined;
            if (headeredStackCache.has(this)) return headeredStackCache.get(this);
            const raw = nativeStackGetter.call(this);
            // `Error.prototype` itself, and plain objects inheriting from it,
            // have no [[ErrorData]] frames; Node reports `undefined` there too.
            if (raw === undefined) return undefined;
            const computed = headerizeErrorStack(this, raw);
            try { headeredStackCache.set(this, computed); } catch { /* non-registerable key */ }
            return computed;
        },
        set(this: object, value: unknown) {
            // QuickJS's native setter throws on a non-string and, for genuine
            // Error instances, defines the own property *enumerable* — which
            // leaked the stack into `JSON.stringify(err)` and `Object.keys(err)`.
            // Node latches any value on a non-enumerable own property.
            if (!this || (typeof this !== 'object' && typeof this !== 'function')) return;
            if (readNativeStack(this) === undefined) {
                // Not an error instance (e.g. Object.create(Error.prototype)):
                // Node performs an ordinary assignment there, so match it.
                // `__proto__: null`: defineProperty resolves descriptor fields with
                // HasProperty, so a value-only literal would also inherit any
                // `get`/`set` polluted onto Object.prototype and throw.
                try {
                    Object.defineProperty(this, 'stack', {
                        __proto__: null,
                        value, writable: true, enumerable: true, configurable: true,
                    } as PropertyDescriptor);
                } catch { /* non-extensible */ }
                return;
            }
            try {
                Object.defineProperty(this, 'stack', {
                    __proto__: null,
                    value, writable: true, enumerable: false, configurable: true,
                } as PropertyDescriptor);
            } catch {
                try { nativeStackSetter?.call(this, value); } catch { /* */ }
            }
        },
    });
}

if (typeof Symbol.metadata === 'undefined') {
    Object.defineProperty(Symbol, 'metadata', {
        value: Symbol('Symbol.metadata'),
        writable: false,
        enumerable: false,
        configurable: false,
    });
}

type StreamsWithStdio = typeof streams & { stdin: Stream; stdout: Stream };

globalThis.alert = function(msg) {
    console.log(msg);
}

globalThis.prompt = function(msg) {
    const promptStr = msg != null ? String(msg) + ' ' : '? ';

    if (!stdin.isTTY) {
        return null;    // note: deno doesn't support prompt() when not in TTY
    }

    // If another subsystem (like the REPL) already owns the TTY in raw mode,
    // stop its read loop before changing modes to avoid libuv continuing to
    // deliver raw key events on the old read watcher.
    const rawstdin = stdin.__stream as CModuleStreams.TTY;
    const prevMode: number = rawstdin.mode;
    const reading = !!rawstdin.onread;
    if (reading) rawstdin.stopRead();
    rawstdin.mode = streams.TTY_MODE_NORMAL;
    stdout.writeSync(engine.encodeString(promptStr));

    const chunk = new Uint8Array(4096);
    try {
        let line = '';
        while (true) {
            // Read through the Stream wrapper: on POSIX it flips the fd to
            // blocking so a raw readSync doesn't EAGAIN on an empty TTY.
            const n = stdin.readSync(chunk);
            if (!n) break;
            line += engine.decodeString(chunk.subarray(0, n));
            // Normal mode delivers a full line ending with \n
            let nl = line.indexOf('\n');
            if (nl !== -1) return line.slice(0, nl).replace(/\r$/, '') || null;
        }
        return line.replace(/\r?\n$/, '') || null;
    } finally {
        rawstdin.mode = prevMode;
        if (reading) rawstdin.startRead();
    }
}

globalThis.confirm = function(msg) {
    const s = prompt(msg + ' (y/n)');
    return s === 'y' || s === 'Y';
}

function writeUtf8CodePoint(output: Uint8Array, offset: number, codePoint: number): number {
    if (codePoint < 0x80) {
        output[offset] = codePoint;
        return 1;
    }
    if (codePoint < 0x800) {
        output[offset] = 0xc0 | (codePoint >> 6);
        output[offset + 1] = 0x80 | (codePoint & 0x3f);
        return 2;
    }
    if (codePoint < 0x10000) {
        output[offset] = 0xe0 | (codePoint >> 12);
        output[offset + 1] = 0x80 | ((codePoint >> 6) & 0x3f);
        output[offset + 2] = 0x80 | (codePoint & 0x3f);
        return 3;
    }
    output[offset] = 0xf0 | (codePoint >> 18);
    output[offset + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
    output[offset + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
    output[offset + 3] = 0x80 | (codePoint & 0x3f);
    return 4;
}

function nextCodePoint(input: string, index: number): { codePoint: number; read: number; size: number } {
    const code = input.charCodeAt(index);
    if (code < 0x80) return { codePoint: code, read: 1, size: 1 };
    if (code < 0x800) return { codePoint: code, read: 1, size: 2 };
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
        const next = input.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
            return {
                codePoint: 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00),
                read: 2,
                size: 4,
            };
        }
    }
    if (code < 0xd800 || code > 0xdfff) return { codePoint: code, read: 1, size: 3 };
    return { codePoint: 0xfffd, read: 1, size: 3 };
}

/**
 * `engine.encodeString` emits WTF-8 for unpaired surrogates; the encoding spec
 * substitutes U+FFFD. `sanitizeSurrogates` lives in utils/bytes so the wire
 * paths (fetch bodies, FormData, WebSocket) share one implementation.
 */
class TextEncoder {
    get encoding() {
        return 'utf-8';
    }

    encode(input: string = ''): Uint8Array {
        const source = String(input);
        return engine.encodeString(sanitizeSurrogates(source));
    }

    encodeInto(input: string, destination: Uint8Array): TextEncoderEncodeIntoResult {
        if (arguments.length < 2) throw new TypeError('encodeInto requires source and destination');
        if (!(destination instanceof Uint8Array)) throw new TypeError('destination must be a Uint8Array');
        const source = String(input);
        let read = 0;
        let written = 0;
        for (let i = 0; i < source.length;) {
            const next = nextCodePoint(source, i);
            if (destination.length - written < next.size) break;
            writeUtf8CodePoint(destination, written, next.codePoint);
            i += next.read;
            read += next.read;
            written += next.size;
        }
        return { read, written };
    }

}

/**
 * WHATWG "get an encoding": a label maps to a *canonical* encoding name, and the
 * label is stripped of leading/trailing HTTP whitespace and ASCII-lowercased
 * first. The native `text.Decoder` is iconv-backed, so it reports the raw label
 * as `encoding` (`ucs-2`, not `utf-16le`) and rejects labels it does not know
 * verbatim — hence the table rather than passing the label straight through.
 */
const ENCODING_LABELS: Record<string, string> = {};
const addLabels = (canonical: string, labels: string) => {
    for (const label of labels.split(' ')) ENCODING_LABELS[label] = canonical;
};
addLabels('utf-8', 'unicode-1-1-utf-8 unicode11utf8 unicode20utf8 utf-8 utf8 x-unicode20utf8');
addLabels('ibm866', '866 cp866 csibm866 ibm866');
addLabels('iso-8859-2', 'csisolatin2 iso-8859-2 iso-ir-101 iso8859-2 iso88592 iso_8859-2 iso_8859-2:1987 l2 latin2');
addLabels('iso-8859-3', 'csisolatin3 iso-8859-3 iso-ir-109 iso8859-3 iso88593 iso_8859-3 iso_8859-3:1988 l3 latin3');
addLabels('iso-8859-4', 'csisolatin4 iso-8859-4 iso-ir-110 iso8859-4 iso88594 iso_8859-4 iso_8859-4:1988 l4 latin4');
addLabels('iso-8859-5', 'csisolatincyrillic cyrillic iso-8859-5 iso-ir-144 iso8859-5 iso88595 iso_8859-5 iso_8859-5:1988');
addLabels('iso-8859-6', 'arabic asmo-708 csiso88596e csiso88596i csisolatinarabic ecma-114 iso-8859-6 iso-8859-6-e'
    + ' iso-8859-6-i iso-ir-127 iso8859-6 iso88596 iso_8859-6 iso_8859-6:1987');
addLabels('iso-8859-7', 'csisolatingreek ecma-118 elot_928 greek greek8 iso-8859-7 iso-ir-126 iso8859-7 iso88597'
    + ' iso_8859-7 iso_8859-7:1987 sun_eu_greek');
addLabels('iso-8859-8', 'csiso88598e csisolatinhebrew hebrew iso-8859-8 iso-8859-8-e iso-ir-138 iso8859-8 iso88598'
    + ' iso_8859-8 iso_8859-8:1988 visual');
addLabels('iso-8859-8-i', 'csiso88598i iso-8859-8-i logical');
addLabels('iso-8859-10', 'csisolatin6 iso-8859-10 iso-ir-157 iso8859-10 iso885910 l6 latin6');
addLabels('iso-8859-13', 'iso-8859-13 iso8859-13 iso885913');
addLabels('iso-8859-14', 'iso-8859-14 iso8859-14 iso885914');
addLabels('iso-8859-15', 'csisolatin9 iso-8859-15 iso8859-15 iso885915 iso_8859-15 l9');
addLabels('iso-8859-16', 'iso-8859-16');
addLabels('koi8-r', 'cskoi8r koi koi8 koi8-r koi8_r');
addLabels('koi8-u', 'koi8-ru koi8-u');
addLabels('macintosh', 'csmacintosh mac macintosh x-mac-roman');
addLabels('windows-874', 'dos-874 iso-8859-11 iso8859-11 iso885911 tis-620 windows-874');
addLabels('windows-1250', 'cp1250 windows-1250 x-cp1250');
addLabels('windows-1251', 'cp1251 windows-1251 x-cp1251');
addLabels('windows-1252', 'ansi_x3.4-1968 ascii cp1252 cp819 csisolatin1 ibm819 iso-8859-1 iso-ir-100 iso8859-1'
    + ' iso88591 iso_8859-1 iso_8859-1:1987 l1 latin1 us-ascii windows-1252 x-cp1252');
addLabels('windows-1253', 'cp1253 windows-1253 x-cp1253');
addLabels('windows-1254', 'cp1254 csisolatin5 iso-8859-9 iso-ir-148 iso8859-9 iso88599 iso_8859-9 iso_8859-9:1989'
    + ' l5 latin5 windows-1254 x-cp1254');
addLabels('windows-1255', 'cp1255 windows-1255 x-cp1255');
addLabels('windows-1256', 'cp1256 windows-1256 x-cp1256');
addLabels('windows-1257', 'cp1257 windows-1257 x-cp1257');
addLabels('windows-1258', 'cp1258 windows-1258 x-cp1258');
addLabels('x-mac-cyrillic', 'x-mac-cyrillic x-mac-ukrainian');
addLabels('gbk', 'chinese csgb2312 csiso58gb231280 gb2312 gb_2312 gb_2312-80 gbk iso-ir-58 x-gbk');
addLabels('gb18030', 'gb18030');
addLabels('big5', 'big5 big5-hkscs cn-big5 csbig5 x-x-big5');
addLabels('euc-jp', 'cseucpkdfmtjapanese euc-jp x-euc-jp');
addLabels('iso-2022-jp', 'csiso2022jp iso-2022-jp');
addLabels('shift_jis', 'csshiftjis ms932 ms_kanji shift-jis shift_jis sjis windows-31j x-sjis');
addLabels('euc-kr', 'cseuckr csksc56011987 euc-kr iso-ir-149 korean ks_c_5601-1987 ks_c_5601-1989 ksc5601 ksc_5601'
    + ' windows-949');
addLabels('replacement', 'csiso2022kr hz-gb-2312 iso-2022-cn iso-2022-cn-ext iso-2022-kr replacement');
addLabels('utf-16be', 'unicodefffe utf-16be');
addLabels('utf-16le', 'csunicode iso-10646-ucs-2 ucs-2 unicode unicodefeff utf-16 utf-16le');
addLabels('x-user-defined', 'x-user-defined');

/** HTTP whitespace only — not `String.prototype.trim`'s full Unicode set. */
const ASCII_WS = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

/** Canonical name -> the name iconv knows, where the two differ. */
const NATIVE_ENCODING: Record<string, string> = {
    // iso-8859-8-i is logical-order Hebrew; it decodes with the iso-8859-8 index.
    'iso-8859-8-i': 'iso-8859-8',
};

function resolveEncoding(label: unknown): string {
    const key = String(label).replace(ASCII_WS, '').toLowerCase();
    const canonical = ENCODING_LABELS[key];
    if (canonical === undefined) throw new RangeError(`Unsupported encoding: ${String(label)}`);
    return canonical;
}

/** Encodings decoded in TS rather than by iconv. */
const JS_DECODED = new Set<string>(['utf-8', 'windows-1252', 'x-user-defined', 'x-mac-cyrillic']);

/**
 * WebIDL `[AllowShared] BufferSource` — `null`, a string or a plain object is a
 * TypeError, not an empty decode. A *detached* buffer is legal and yields `''`.
 */
function decoderInputBytes(input?: AllowSharedBufferSource | null): Uint8Array {
    if (input === undefined) return new Uint8Array(0);
    const isBuffer = input instanceof ArrayBuffer
        || (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer);
    if (!isBuffer && !ArrayBuffer.isView(input)) {
        throw new TypeError('The "input" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView');
    }
    try {
        const view = isBuffer
            ? new Uint8Array(input as ArrayBuffer)
            : new Uint8Array((input as ArrayBufferView).buffer, (input as ArrayBufferView).byteOffset, (input as ArrayBufferView).byteLength);
        return new Uint8Array(arrayBufferBackedBytes(view));
    } catch {
        return new Uint8Array(0);   // detached backing store
    }
}

class TextDecoder implements globalThis.TextDecoder {
    // Exactly one of these is used, chosen by `#encoding`.
    #decoder: CModuleText.Decoder | null = null;
    #encoding: string;
    #fatal: boolean;
    #ignoreBOM: boolean;
    #pending = new Uint8Array(0);   // held-back partial sequence (streaming)
    #bomSeen = false;

    constructor(label: string | undefined = undefined, options?: TextDecoderOptions) {
        if (options !== undefined && options !== null && typeof options !== 'object') {
            throw new TypeError('The "options" argument must be of type object');
        }
        this.#encoding = label === undefined ? 'utf-8' : resolveEncoding(label);
        // The TextDecoder constructor rejects `replacement` itself, even though it
        // is a real encoding elsewhere in the spec.
        if (this.#encoding === 'replacement') throw new RangeError(`Unsupported encoding: ${String(label)}`);
        this.#fatal = !!options?.fatal;
        this.#ignoreBOM = !!options?.ignoreBOM;
        if (JS_DECODED.has(this.#encoding)) return;
        try {
            // iso-8859-8-i shares iso-8859-8's index; native knows only the base name.
            this.#decoder = new text.Decoder(NATIVE_ENCODING[this.#encoding] ?? this.#encoding, options);
        } catch (e) {
            // Native throws TypeError; the encoding spec requires RangeError.
            const message = e instanceof Error ? e.message : String(e);
            if (/unsupported encoding/i.test(message)) throw new RangeError(message);
            throw e;
        }
    }

    get encoding(): string {
        return this.#encoding;
    }

    get fatal(): boolean {
        return this.#fatal;
    }

    get ignoreBOM(): boolean {
        return this.#ignoreBOM;
    }

    decode(input: AllowSharedBufferSource | null | undefined = undefined, options?: TextDecodeOptions): string {
        const bytes = decoderInputBytes(input);
        if (this.#decoder) return this.#decoder.decode(bytes, options);
        return this.#decodeJs(bytes, !!options?.stream);
    }

    /** BOM removal is shared by every encoding and happens once per stream. */
    #stripBom(out: string): string {
        if (this.#bomSeen) return out;
        if (out.length === 0) return out;
        this.#bomSeen = true;
        return !this.#ignoreBOM && out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
    }

    #decodeJs(chunk: Uint8Array, stream: boolean): string {
        const encoding = this.#encoding;
        if (encoding !== 'utf-8') {
            // Single-byte: stateless, so streaming needs no held-back bytes.
            const out = this.#stripBom(decodeSingleByte(chunk, encoding as SingleByteEncoding));
            if (!stream) { this.#bomSeen = false; this.#pending = new Uint8Array(0); }
            return out;
        }

        let bytes = chunk;
        if (this.#pending.length > 0) {
            bytes = new Uint8Array(this.#pending.length + chunk.length);
            bytes.set(this.#pending, 0);
            bytes.set(chunk, this.#pending.length);
            this.#pending = new Uint8Array(0);
        }

        // A trailing partial sequence must wait for the next chunk, not error.
        if (stream) {
            const hold = utf8PendingTail(bytes);
            if (hold > 0) {
                this.#pending = bytes.slice(bytes.length - hold);
                bytes = bytes.subarray(0, bytes.length - hold);
            }
        }

        const out = this.#stripBom(utf8Decode(bytes, this.#fatal));
        if (!stream) { this.#bomSeen = false; this.#pending = new Uint8Array(0); }
        return out;
    }
}


function rethrowDOMException(error: unknown): never {
    if (error && typeof error === 'object' && Object.prototype.toString.call(error) === '[object DOMException]') {
        throw new DOMException(String(Reflect.get(error, 'message') ?? ''), String(Reflect.get(error, 'name') ?? 'Error'));
    }
    throw error;
}

const nativeAtob = globalThis.atob;
const nativeBtoa = globalThis.btoa;

Reflect.set(globalThis, 'TextEncoder', TextEncoder);
Reflect.set(globalThis, 'TextDecoder', TextDecoder);
Object.defineProperty(TextEncoder.prototype, Symbol.toStringTag, { value: 'TextEncoder', configurable: true });
Object.defineProperty(TextDecoder.prototype, Symbol.toStringTag, { value: 'TextDecoder', configurable: true });
if (typeof nativeAtob === 'function') {
    globalThis.atob = function(data: string): string {
        try { return nativeAtob(String(data)); }
        catch (e) { rethrowDOMException(e); }
    };
}
if (typeof nativeBtoa === 'function') {
    globalThis.btoa = function(data: string): string {
        try { return nativeBtoa(String(data)); }
        catch (e) { rethrowDOMException(e); }
    };
}


class TimeoutOrInterval extends Number {
    #cleared = false;

    // `schedule` re-arms the same wrapper (args included) for refresh().
    constructor(
        private fd: number,
        readonly _onTimeout: () => void,
        private readonly schedule?: () => number,
    ) {
        super(fd);
    }

    close() {
        this.#cleared = true;
        timer.clearTimeout(this.fd);
        return this;
    }

    ref() {
        timer.refTimer(this.fd);
        return this;
    }

    unref() {
        timer.unrefTimer(this.fd);
        return this;
    }

    hasRef() {
        return timer.hasRef(this.fd);
    }

    refresh() {
        // Node restarts the countdown; a cleared timer stays cleared.
        if (this.#cleared || !this.schedule) return this;
        timer.clearTimeout(this.fd);
        this.fd = this.schedule();
        return this;
    }

    [Symbol.toPrimitive]() {
        return this.fd;
    }

    [Symbol.dispose]() {
        this.close();
    }

    get __cno_timer_id() {
        return Number(this.fd);
    }
}

class Immediate extends Number {
    constructor(private fd: number, readonly _onImmediate: () => void) {
        super(fd);
    }

    close() {
        timer.clearTimeout(this.fd);
        return this;
    }

    ref() {
        return this;
    }

    unref() {
        return this;
    }

    hasRef() {
        return false;
    }

    [Symbol.toPrimitive]() {
        return this.fd;
    }

    [Symbol.dispose]() {
        this.close();
    }
}

type TimerCallback = string | ((...args: unknown[]) => void);

// No receiver ("brand") check on any timer entry point: Node exposes the very
// same function objects as both the globals and the `node:timers` exports
// (measured: `globalThis.setTimeout === require('node:timers').setTimeout` is
// true in v24.18.0), so `timers.setTimeout(...)` is itself a method call with a
// non-global receiver. Any `this` validation therefore has to accept everything,
// and Node accordingly accepts every receiver — plain object, arbitrary object,
// boxed primitive, Reflect.apply — for setTimeout/clearTimeout/setInterval/
// clearInterval/setImmediate/clearImmediate/queueMicrotask alike.
//
// This is load-bearing: copying the timer functions onto a table and calling
// them as methods is exactly what sinon, @sinonjs/fake-timers and jest's
// useFakeTimers do when they install and restore, so a brand check here breaks
// every fake-timer library.

function toTimerDelay(value: unknown): number {
    if (value === undefined) return 0;
    if (typeof value === 'bigint') throw new TypeError('Cannot convert a BigInt value to a number');
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 0x7fffffff) return 0;
    return number;
}

function toTimerId(value: unknown): number {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'bigint') throw new TypeError('Cannot convert a BigInt value to a number');
    return Number(value);
}

function runTimerCallback(callback: TimerCallback, args: unknown[]): void {
    if (typeof callback === 'function') {
        callback.apply(globalThis, args);
        return;
    }
    engine.eval(String(callback), '<timer>', engine.EVAL_GLOBAL);
}

function setTimeout(this: unknown, cb: TimerCallback, delay?: number | undefined, ...args: unknown[]) {
    const ms = toTimerDelay(delay);
    const run = () => runTimerCallback(cb, args);
    return new TimeoutOrInterval(
        timer.setTimeout(run, ms),
        typeof cb === 'function' ? cb : run,
        () => timer.setTimeout(run, ms),
    );
}
Object.defineProperty(setTimeout, 'length', { value: 1, configurable: true });
Reflect.set(globalThis, 'setTimeout', setTimeout);
const setTimeoutPromisified = <T = void>(delay?: number | undefined, value?: T | undefined, options?: TimerOptions | undefined): Promise<T> => new Promise((rs, rj) => {
    const ms = toTimerDelay(delay);
    if (options?.signal?.aborted) {
        rj(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        return;
    }
    let fd = 0;
    const onAbort = () => {
        timer.clearTimeout(fd);
        rj(options?.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    fd = timer.setTimeout(() => {
        options?.signal?.removeEventListener('abort', onAbort);
        rs(value as T);
    }, ms);
    if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
    }
});
Reflect.set(setTimeout, '__promisify__', setTimeoutPromisified);
Reflect.set(setTimeout, Symbol.for('nodejs.util.promisify.custom'), setTimeoutPromisified);

function clearTimeout(this: unknown, id?: unknown) {
    const timerId = toTimerId(id);
    if (!timerId) return;
    timer.clearTimeout(timerId);
}
Object.defineProperty(clearTimeout, 'length', { value: 0, configurable: true });
Reflect.set(globalThis, 'clearTimeout', clearTimeout);

function setInterval(this: unknown, cb: TimerCallback, timeout?: number, ...args: unknown[]) {
    const ms = toTimerDelay(timeout);
    const run = () => runTimerCallback(cb, args);
    return new TimeoutOrInterval(
        timer.setInterval(run, ms),
        typeof cb === 'function' ? cb : run,
        () => timer.setInterval(run, ms),
    );
}
Object.defineProperty(setInterval, 'length', { value: 1, configurable: true });
Reflect.set(globalThis, 'setInterval', setInterval);

function clearInterval(this: unknown, id?: unknown) {
    const timerId = toTimerId(id);
    if (!timerId) return;
    timer.clearTimeout(timerId);
}
Object.defineProperty(clearInterval, 'length', { value: 0, configurable: true });
Reflect.set(globalThis, 'clearInterval', clearInterval);

Reflect.set(globalThis, 'setImmediate', function(cb: (...args: unknown[]) => void, ...args: unknown[]) {
    if (typeof cb !== 'function') {
        throw new TypeError('callback must be a function');
    }
    const fd = timer.setTimeout(() => cb(...args), 0);
    return new Immediate(fd, cb);
});

Reflect.set(globalThis, 'clearImmediate', function(id: Immediate | number | undefined) {
    if (!id) return;
    timer.clearTimeout(Number(id));
});

globalThis.structuredClone = function(v, opt){
    // The public API always treats its second argument as an options dictionary.
    // The shared clone helper also accepts a bare transfer list for MessagePort
    // and worker internals, so keep arrays on this boundary from selecting that
    // internal overload.
    const options = Array.isArray(opt)
        ? { transfer: Reflect.get(opt, 'transfer') as Transferable[] | undefined }
        : opt;
    // @ts-ignore - never clone AbortSignal
    return structuredCloneWithTransfer(v, options, messagePortTransferHooks);
}

globalThis.queueMicrotask = function(callback: () => void) {
    if (typeof callback !== 'function') {
        throw new TypeError('callback is not a function');
    }
    Promise.resolve().then(() => callback());
};

globalThis.reportError = function(e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // cancelable so listeners (and Deno.test harness) can preventDefault
    const event = new ErrorEvent('error', {
        message: error.message,
        error: error,
        filename: '',
        lineno: 0,
        colno: 0,
        cancelable: true,
    });
    globalThis.dispatchEvent(event);
}

globalThis.close = function(){
    os.exit(0);
}
