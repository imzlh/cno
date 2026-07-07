import type { Stream } from "../deno/04_stdio";
import { structuredCloneWithTransfer } from "../node/_internal/structured-clone";
import { arrayBufferBackedBytes } from "../utils/bytes";
import { DOMException } from "./events";
import { messagePortTransferHooks } from "./messaging";

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

function formatErrorStackHeader(error: { name?: unknown; message?: unknown }): string {
    const name = error.name === undefined ? 'Error' : String(error.name);
    const message = error.message === undefined ? '' : String(error.message);
    if (name === '') return message;
    if (message === '') return name;
    return `${name}: ${message}`;
}

function isInternalErrorProxyFrame(line: string): boolean {
    const frame = line.trimStart();
    return frame === 'at construct (native)'
        || frame.startsWith('at construct (<core>:')
        || frame === 'at apply (native)'
        || frame.startsWith('at apply (<core>:');
}

function stripInternalErrorProxyFrames(stack: string): string {
    const lines = stack.split('\n');
    while (lines.length > 0 && isInternalErrorProxyFrame(lines[0])) {
        lines.shift();
    }
    return lines.join('\n');
}

function installLazyErrorStack<T>(error: T): T {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
    if (!descriptor || typeof descriptor.value !== 'string') return error;

    const frames = stripInternalErrorProxyFrames(descriptor.value);
    let customStack: unknown;
    let hasCustomStack = false;
    Object.defineProperty(error, 'stack', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
            if (hasCustomStack) return customStack;
            const header = formatErrorStackHeader(this instanceof Error ? this : error);
            return frames ? `${header}\n${frames}` : header;
        },
        set(value) {
            customStack = value;
            hasCustomStack = true;
        },
    });
    return error;
}

function textDecoderInput(input?: AllowSharedBufferSource | null): ArrayBuffer | ArrayBufferView | null | undefined {
    if (input == null || input instanceof ArrayBuffer) return input;
    if (!ArrayBuffer.isView(input)) return arrayBufferBackedBytes(new Uint8Array(input));
    if (input.buffer instanceof ArrayBuffer) return input;
    return arrayBufferBackedBytes(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
}

const ErrorProxy = new Proxy(NativeError, {
    apply(target, thisArg, args) {
        return installLazyErrorStack(Reflect.apply(target, thisArg, args));
    },
    construct(target, args, newTarget) {
        return installLazyErrorStack(Reflect.construct(target, args, newTarget));
    },
});

Object.defineProperty(ErrorProxy, 'captureStackTrace', {
    value(target: object, constructorOpt?: (...args: never[]) => unknown) {
        nativeCaptureStackTrace?.(target, constructorOpt ?? ErrorProxy.captureStackTrace);
        installLazyErrorStack(target);
    },
    writable: true,
    enumerable: false,
    configurable: true,
});
Reflect.set(globalThis, 'Error', ErrorProxy);

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
    const { stdin: _stdin, stdout: _stdout } = streams as StreamsWithStdio;
    const stdin = _stdin.__stream as CModuleStreams.TTY, stdout = _stdout.__stream;

    if (!_stdin.isTTY) {
        return null;    // note: deno doesn't support prompt() when not in TTY
    }

    // If another subsystem (like the REPL) already owns the TTY in raw mode,
    // stop its read loop before changing modes to avoid libuv continuing to
    // deliver raw key events on the old read watcher.
    const prevMode: number = stdin.mode;
    const reading = !!stdin.onread;
    if (reading) stdin.stopRead();
    stdin.mode = streams.TTY_MODE_NORMAL;
    stdout.writeSync(engine.encodeString(promptStr));

    const chunk = new Uint8Array(4096);
    try {
        let line = '';
        while (true) {
            // Read through the Stream wrapper: on POSIX it flips the fd to
            // blocking so a raw readSync doesn't EAGAIN on an empty TTY.
            const n = _stdin.readSync(chunk);
            if (!n) break;
            line += engine.decodeString(chunk.subarray(0, n));
            // Normal mode delivers a full line ending with \n
            let nl = line.indexOf('\n');
            if (nl !== -1) return line.slice(0, nl).replace(/\r$/, '') || null;
        }
        return line.replace(/\r?\n$/, '') || null;
    } finally {
        stdin.mode = prevMode;
        if (reading) stdin.startRead();
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

class TextEncoder {
    get encoding() {
        return 'utf-8';
    }

    encode(input: string = ''): Uint8Array {
        const source = String(input);
        return engine.encodeString(source);
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

const WINDOWS_1252_LABELS = new Set([
    'ansi_x3.4-1968',
    'ascii',
    'cp1252',
    'cp819',
    'csisolatin1',
    'ibm819',
    'iso-8859-1',
    'iso-ir-100',
    'iso8859-1',
    'iso88591',
    'iso_8859-1',
    'iso_8859-1:1987',
    'l1',
    'latin1',
    'us-ascii',
    'windows-1252',
    'x-cp1252',
]);

function normalizeTextDecoderLabel(label?: string): string | undefined {
    if (label === undefined) return undefined;
    const normalized = String(label).trim().toLowerCase();
    return WINDOWS_1252_LABELS.has(normalized) ? 'windows-1252' : label;
}

class TextDecoder implements globalThis.TextDecoder {
    #decoder: CModuleText.Decoder;

    constructor(label: string | undefined = undefined, options?: TextDecoderOptions) {
        this.#decoder = new text.Decoder(normalizeTextDecoderLabel(label), options);
    }

    get encoding(): string {
        return this.#decoder.encoding.toLowerCase();
    }

    get fatal(): boolean {
        return this.#decoder.fatal;
    }

    get ignoreBOM(): boolean {
        return this.#decoder.ignoreBOM;
    }

    decode(input: AllowSharedBufferSource | null | undefined = undefined, options?: TextDecodeOptions): string {
        return this.#decoder.decode(textDecoderInput(input), options);
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
    constructor(private fd: number, readonly _onTimeout: () => void) {
        super(fd);
    }

    close() {
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
        // noop
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

function validateTimerThis(thisArg: unknown): void {
    if (thisArg !== undefined && thisArg !== null && thisArg !== globalThis) {
        throw new TypeError('Illegal invocation');
    }
}

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
    validateTimerThis(this);
    const ms = toTimerDelay(delay);
    return new TimeoutOrInterval(timer.setTimeout(() => {
        runTimerCallback(cb, args);
    }, ms), typeof cb === 'function' ? cb : () => runTimerCallback(cb, args));
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
    validateTimerThis(this);
    const timerId = toTimerId(id);
    if (!timerId) return;
    timer.clearTimeout(timerId);
}
Object.defineProperty(clearTimeout, 'length', { value: 0, configurable: true });
Reflect.set(globalThis, 'clearTimeout', clearTimeout);

function setInterval(this: unknown, cb: TimerCallback, timeout?: number, ...args: unknown[]) {
    validateTimerThis(this);
    const ms = toTimerDelay(timeout);
    return new TimeoutOrInterval(timer.setInterval(() => {
        runTimerCallback(cb, args);
    }, ms), typeof cb === 'function' ? cb : () => runTimerCallback(cb, args));
}
Object.defineProperty(setInterval, 'length', { value: 1, configurable: true });
Reflect.set(globalThis, 'setInterval', setInterval);

function clearInterval(this: unknown, id?: unknown) {
    validateTimerThis(this);
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
    return structuredCloneWithTransfer(v, opt, messagePortTransferHooks);
}

globalThis.queueMicrotask = function(callback: () => void) {
    if (typeof callback !== 'function') {
        throw new TypeError('callback is not a function');
    }
    Promise.resolve().then(() => callback());
};

globalThis.reportError = function(e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const event = new ErrorEvent('error', {
        message: error.message,
        error: error,
        filename: '',
        lineno: 0,
        colno: 0
    });
    globalThis.dispatchEvent(event);
}

globalThis.close = function(){
    os.exit(0);
}
