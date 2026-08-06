import type { Stream } from '../../deno/04_stdio';
import { Readable, Writable, type ReadableOptions, type WritableOptions } from '../stream';
import { getTierLimits } from '../_internal/memory';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const streams = import.meta.use('streams');
const timers = import.meta.use('timers');

type StreamsWithStdio = typeof streams & { stdin: Stream; stdout: Stream; stderr: Stream };

const { stdin, stdout, stderr } = streams as StreamsWithStdio;

type Size = { width: number; height: number };
type TTYRef = { stream: CModuleStreams.TTY; owned: boolean };

const RESIZE_POLL_MS = 250;

const isWindows = os.uname().sysname === 'Windows_NT';

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

function validateFd(fd: number): void {
    if (!Number.isInteger(fd) || fd < 0) {
        throw new TypeError('The "fd" argument must be a non-negative integer');
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isAgainError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = Reflect.get(error, 'code');
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return true;
    if (code === -11) return true;
    return /EAGAIN|EWOULDBLOCK/.test(String(error));
}

function stdioStream(fd: number): Stream | null {
    if (fd === os.STDIN_FILENO) return stdin;
    if (fd === os.STDOUT_FILENO) return stdout;
    if (fd === os.STDERR_FILENO) return stderr;
    return null;
}

function openTTY(fd: number, readable: boolean): TTYRef {
    validateFd(fd);
    const shared = stdioStream(fd);
    if (shared?.isTTY && shared.__stream) {
        return { stream: shared.__stream as CModuleStreams.TTY, owned: false };
    }
    if (!isatty(fd)) throw new Error('Not a tty');
    return { stream: new streams.TTY(fd, readable), owned: true };
}

function envValue(env: Record<string, string> | undefined, key: string): string | undefined {
    if (env && key in env) return env[key];
    try {
        return os.getenv(key);
    } catch {
        return undefined;
    }
}

function sameSize(a: Size | null, b: Size | null): boolean {
    return a === b || !!(a && b && a.width === b.width && a.height === b.height);
}

function ansiForClearLine(dir: number): string {
    return dir === -1 ? '\x1b[1K' : dir === 1 ? '\x1b[0K' : '\x1b[2K';
}

function ansiForCursorTo(x: number, y?: number): string {
    return y === undefined ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`;
}

function ansiForMoveCursor(dx: number, dy: number): string {
    let code = '';
    if (dx > 0) code += `\x1b[${dx}C`;
    else if (dx < 0) code += `\x1b[${-dx}D`;
    if (dy > 0) code += `\x1b[${dy}B`;
    else if (dy < 0) code += `\x1b[${-dy}A`;
    return code;
}

const COLORS_2 = 1;
const COLORS_16 = 4;
const COLORS_256 = 8;
const COLORS_16m = 24;

/** Exact TERM matches Node recognises (internal/tty.js TERM_ENVS). */
const TERM_ENVS: Record<string, number> = {
    eterm: COLORS_16, cons25: COLORS_16, console: COLORS_16, cygwin: COLORS_16,
    dtterm: COLORS_16, gnome: COLORS_16, hurd: COLORS_16, jfbterm: COLORS_16,
    konsole: COLORS_16, kterm: COLORS_16, mlterm: COLORS_16, mosh: COLORS_16m,
    putty: COLORS_16, st: COLORS_16, 'rxvt-unicode-24bit': COLORS_16m,
    terminator: COLORS_16m,
};

const TERM_ENVS_REG_EXP = [
    /ansi/, /color/, /linux/, /^con[0-9]*x[0-9]/, /^rxvt/, /^screen/, /^xterm/, /^vt100/,
];

const CI_SIGNS = ['APPVEYOR', 'BUILDKITE', 'CIRCLECI', 'DRONE', 'GITHUB_ACTIONS', 'GITLAB_CI', 'TRAVIS'];

let osReleaseParts: string[] | undefined;

function envDefined(env: Record<string, string> | undefined, key: string): boolean {
    return envValue(env, key) !== undefined;
}

/** Mirrors Node's internal/tty.js getColorDepth, including the win32 branch. */
function computeColorDepth(env?: Record<string, string>): number {
    const forceColor = envValue(env, 'FORCE_COLOR');
    if (forceColor !== undefined) {
        switch (forceColor) {
            case '':
            case '1':
            case 'true': return COLORS_16;
            case '2': return COLORS_256;
            case '3': return COLORS_16m;
            default: return COLORS_2;
        }
    }

    const noColor = envValue(env, 'NO_COLOR');
    if (envDefined(env, 'NODE_DISABLE_COLORS')
        || (noColor !== undefined && noColor !== '')
        || envValue(env, 'TERM') === 'dumb') {
        return COLORS_2;
    }

    if (isWindows) {
        // Windows 10 build 10586 added 256 colors, 14931 added truecolor.
        // TERM is deliberately not consulted here — Node does not either.
        osReleaseParts ??= os.uname().release.split('.');
        if (Number(osReleaseParts[0]) >= 10) {
            const build = Number(osReleaseParts[2]);
            if (build >= 14931) return COLORS_16m;
            if (build >= 10586) return COLORS_256;
        }
        return COLORS_16;
    }

    if (envDefined(env, 'TMUX')) return COLORS_256;

    if (envValue(env, 'CI')) {
        if (CI_SIGNS.some(sign => envDefined(env, sign)) || envValue(env, 'CI_NAME') === 'codeship') {
            return COLORS_256;
        }
        return COLORS_2;
    }

    if (envDefined(env, 'TEAMCITY_VERSION')) {
        const version = envValue(env, 'TEAMCITY_VERSION') ?? '';
        return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(version) ? COLORS_16 : COLORS_2;
    }

    switch (envValue(env, 'TERM_PROGRAM')) {
        case 'iTerm.app': {
            const ver = envValue(env, 'TERM_PROGRAM_VERSION') ?? '';
            return Number(ver.split('.')[0]) >= 3 ? COLORS_16m : COLORS_256;
        }
        case 'HyperTerm':
        case 'MacTerm':
            return COLORS_16m;
        case 'Apple_Terminal':
            return COLORS_256;
    }

    const term = envValue(env, 'TERM');
    if (term) {
        if (/^xterm-256/.test(term)) return COLORS_256;
        const termEnv = term.toLowerCase();
        for (const re of TERM_ENVS_REG_EXP) {
            if (re.test(termEnv)) return COLORS_16;
        }
        const exact = TERM_ENVS[termEnv];
        if (exact) return exact;
    }

    if (envDefined(env, 'COLORTERM')) return COLORS_16;

    return COLORS_2;
}

function validateColorCount(count: unknown): number {
    if (typeof count !== 'number' || !Number.isInteger(count)) {
        const e = new TypeError(`The "count" argument must be of type number. Received ${typeof count}`);
        Reflect.set(e, 'code', 'ERR_INVALID_ARG_TYPE');
        throw e;
    }
    if (count < 2) {
        const e = new RangeError(`The value of "count" is out of range. It must be >= 2 && <= ${Number.MAX_SAFE_INTEGER}. Received ${count}`);
        Reflect.set(e, 'code', 'ERR_OUT_OF_RANGE');
        throw e;
    }
    return count;
}

export function isatty(fd: number): boolean {
    if (!Number.isInteger(fd) || fd < 0) return false;
    try {
        return os.guessHandle(fd) === 'tty';
    } catch {
        return false;
    }
}

export class ReadStream extends Readable {
    isRaw = false;
    bytesRead = 0;
    private handle: CModuleStreams.TTY;
    private owned = false;
    private ttyClosed = false;
    private retryTimer = 0;
    private readPending = false;
    readonly isTTY: boolean = true;

    constructor(fd: number, options?: ReadableOptions) {
        validateFd(fd);
        super(options);
        const ref = openTTY(fd, true);
        if (!ref) throw new Error(`Failed to open TTY fd ${fd}`);
        this.handle = ref.stream;
        this.owned = ref.owned;
        this.isTTY = os.guessHandle(fd) === 'tty';
        this._read = this.readFromFd.bind(this);
    }

    setRawMode(mode: boolean): this {
        this.handle.mode = mode
            ? streams.TTY_MODE_RAW_VT
            : streams.TTY_MODE_NORMAL;
        this.isRaw = mode;
        return this;
    }

    ref(): this {
        this.handle.ref();
        return this;
    }

    unref(): this {
        this.handle.unref();
        return this;
    }

    close(callback?: () => void): this {
        if (callback) this.once('close', callback);
        return this.destroy();
    }

    override destroy(error?: Error | null): this {
        if (this.ttyClosed) return this;
        this.ttyClosed = true;
        if (this.retryTimer) {
            timers.clearTimeout(this.retryTimer);
            this.retryTimer = 0;
        }
        if (this.owned) { this.handle.close(); }
        return super.destroy(error);
    }

    private retryRead(): void {
        if (this.ttyClosed || this.retryTimer) return;
        this.retryTimer = timers.setTimeout(() => {
            this.retryTimer = 0;
            if (!this.ttyClosed) this._readAndResolve();
        }, 1);
    }

    private readFromFd(size: number): void {
        if (this.readPending) return;
        this.readPending = true;
        this.readFromFdAsync(size);
    }

    private async readFromFdAsync(size: number): Promise<void> {
        try {
            const buf = new Uint8Array(size || READ_BUF_SIZE);
            const n = await this.handle.read(buf);
            this.readPending = false;
            if (this.ttyClosed) return;
            if (!n) {
                this.push(null);
                return;
            }
            this.bytesRead += n;
            this.push(buf.subarray(0, n));
        } catch (e) {
            this.readPending = false;
            if (isAgainError(e)) {
                this.retryRead();
                return;
            }
            this.destroy(asError(e));
        }
    }
}

export class WriteStream extends Writable {
    readonly fd: number;
    bytesWritten = 0;
    isTTY = true;
    private handle: CModuleStreams.TTY;
    private owned = false;
    private currentSize: Size;
    private resizeTimer = 0;
    private ttyClosed = false;

    constructor(fd: number, options?: WritableOptions) {
        validateFd(fd);
        super(options);
        this.fd = fd;
        const { stream, owned } = openTTY(fd, false);
        this.currentSize = stream.size;
        this.handle = stream;
        this.owned = owned;
        this._write = this.writeToFd.bind(this);
    }

    private writeToFd(chunk: string | Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            const data = typeof chunk === 'string' ? engine.encodeString(chunk) : chunk;
            const written = this.handle.writeSync(data);
            this.bytesWritten += written;
            this.refreshSize();
            callback();
        } catch (e) {
            callback(asError(e));
        }
    }

    get columns(): number | undefined { return this.refreshSize()?.width; }

    get rows(): number | undefined { return this.refreshSize()?.height; }

    get writableColumns(): number | undefined { return this.columns; }

    get writableRows(): number | undefined { return this.rows; }

    clearLine(dir: number, callback?: () => void): boolean {
        this.writeControl(ansiForClearLine(dir), callback);
        return true;
    }

    clearScreenDown(callback?: () => void): boolean {
        this.writeControl('\x1b[0J', callback);
        return true;
    }

    cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean {
        const cb = typeof y === 'function' ? y : callback;
        this.writeControl(ansiForCursorTo(x, typeof y === 'number' ? y : undefined), cb);
        return true;
    }

    moveCursor(dx: number, dy: number, callback?: () => void): boolean {
        this.writeControl(ansiForMoveCursor(dx, dy), callback);
        return true;
    }

    getColorDepth(env?: Record<string, string>): number {
        return computeColorDepth(env);
    }

    hasColors(count?: number | Record<string, string>, env?: Record<string, string>): boolean {
        if (env === undefined && typeof count === 'object' && count !== null) {
            env = count;
            count = undefined;
        }
        // Node defaults to 16 here; returning true unconditionally ignored NO_COLOR.
        const want = validateColorCount(count === undefined ? 16 : count);
        return 2 ** this.getColorDepth(env) >= want;
    }

    getWindowSize(): [number, number] {
        const size = this.refreshSize();
        return [size?.width ?? 80, size?.height ?? 24];
    }

    ref(): this {
        this.handle.ref();
        return this;
    }

    unref(): this {
        this.handle.unref();
        return this;
    }

    close(callback?: () => void): this {
        if (callback) this.once('close', callback);
        return this.destroy();
    }

    override destroy(error?: Error | null): this {
        if (this.ttyClosed) return this;
        this.ttyClosed = true;
        this.stopResizePolling();
        if (this.owned) { this.handle.close(); }
        return super.destroy(error);
    }

    override addListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
        super.addListener(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
        super.on(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override once(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
        super.once(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override prependListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
        super.prependListener(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override prependOnceListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
        super.prependOnceListener(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override removeListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
        super.removeListener(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override off(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
        super.off(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override removeAllListeners(eventName?: string | symbol): this {
        super.removeAllListeners(eventName);
        if (eventName === undefined || eventName === 'resize') this.updateResizePolling('resize');
        return this;
    }

    private writeControl(seq: string, callback?: () => void): void {
        try {
            const written = this.handle.writeSync(engine.encodeString(seq));
            this.bytesWritten += written;
            this.refreshSize();
            callback?.();
        } catch (e) {
            this.emit('error', e);
        }
    }

    private refreshSize(): Size | null {
        const next = this.handle.size;
        if (!sameSize(this.currentSize, next)) {
            this.currentSize = next;
            this.emit('resize');
        }
        return this.currentSize;
    }

    private updateResizePolling(eventName: string | symbol): void {
        if (eventName !== 'resize') return;
        if (this.listenerCount('resize') > 0) this.startResizePolling();
        else this.stopResizePolling();
    }

    private startResizePolling(): void {
        if (this.resizeTimer) return;
        this.resizeTimer = timers.setInterval(() => this.refreshSize(), RESIZE_POLL_MS);
    }

    private stopResizePolling(): void {
        if (!this.resizeTimer) return;
        timers.clearInterval(this.resizeTimer);
        this.resizeTimer = 0;
    }
}

Object.defineProperty(WriteStream.prototype, 'isTTY', {
    value: true,
    enumerable: true,
    configurable: true,
    writable: true,
});
