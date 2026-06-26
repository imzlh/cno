import type { Stream } from "../deno/04_stdio";

type TimerOptions = { signal?: AbortSignal };

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const text = import.meta.use('text')!;
const os = import.meta.use('os');
const timer = import.meta.use('timers');
const streams = import.meta.use('streams');
const console = import.meta.use('console');

globalThis.alert = function(msg) {
    console.log(msg);
}

globalThis.prompt = function(msg) {
    const promptStr = msg != null ? String(msg) + ' ' : '? ';
    const { stdin: _stdin, stdout: _stdout } = streams as any as Record<string, Stream>;
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
            const n = stdin.readSync(chunk);
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

globalThis.TextEncoder = text.Encoder;
globalThis.TextDecoder = text.Decoder;

// @ts-ignore - __promisify__ is defined next
globalThis.setTimeout = function(cb: string | ((...args: any[]) => void), delay?: number | undefined, ...args: any[]) {
    if (typeof cb == 'string') {
        throw new Error('string argument is not allowed for setTimeout for security reasons.');
    }
    return timer.setTimeout(() => {
        cb(...args);
    }, delay ?? 0);
}
Reflect.set(Reflect.get(globalThis, 'setTimeout'), '__promisify__', <T = void>(delay?: number | undefined, value?: T | undefined, options?: TimerOptions | undefined): Promise<T> => new Promise(rs => {
    const fd = timer.setTimeout(() => {
        rs(value!);
    }, delay ?? 0);
    if (options?.signal) {
        options.signal.addEventListener('abort', () => timer.clearTimeout(fd));
    }
}));
// @ts-ignore - webapi
globalThis.clearTimeout = globalThis.clearInterval = function(id: number) {
    if (!id) return;
    timer.clearTimeout(id);
}
// @ts-ignore - webapi
globalThis.setInterval = function<any>(cb, timeout, ...args) {
    if (typeof cb == 'string') {
        throw new Error('string argument is not allowed for setTimeout for security reasons.');
    }
    return timer.setInterval(() => {
        cb(...args);
    }, timeout ?? 0);
};

globalThis.structuredClone = function(v, opt){
    return engine.deserialize(engine.serialize(v));
}

globalThis.queueMicrotask = function(callback: () => void) {
    if (typeof callback !== 'function') {
        throw new TypeError('callback is not a function');
    }
    Promise.resolve().then(callback);
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
