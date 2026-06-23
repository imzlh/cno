import type { Stream } from '../../deno/04_stdio';
import { Readable, Writable } from '../stream';
import { getTierLimits } from '../../utils/memory-tier';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const streams = import.meta.use('streams');
const timers = import.meta.use('timers');

const { stdin, stdout, stderr } = streams as any as Record<string, Stream>

type Size = { width: number; height: number };
type TTYRef = { stream: CModuleStreams.TTY; owned: boolean };

const RESIZE_POLL_MS = 250;

const { readBufSize: READ_BUF_SIZE } = getTierLimits();

function validateFd(fd: number): void {
    if (!Number.isInteger(fd) || fd < 0) {
        throw new TypeError('The "fd" argument must be a non-negative integer');
    }
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
    try { return os.getenv(key); } catch { return undefined; }
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

export function isatty(fd: number): boolean {
    if (!Number.isInteger(fd) || fd < 0) return false;
    try { return os.guessHandle(fd) === 'tty'; } catch { return false; }
}

export class ReadStream extends Readable {
    isRaw = false;
    bytesRead = 0;
    private handle: CModuleStreams.TTY;
    private owned = false;
    private closed = false;
    readonly isTTY: boolean = true;

    constructor(fd: number, options?: any) {
        validateFd(fd);
        super(options);
        const ref = openTTY(fd, true)!;
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
        if (this.closed) return this;
        this.closed = true;
        if (this.owned) { this.handle.close(); }
        return super.destroy(error);
    }

    private readFromFd(size: number): void {
        try {
            const buf = new Uint8Array(size || READ_BUF_SIZE);
            const n = this.handle.readSync(buf);
            if (!n) {
                this.push(null);
                return;
            }
            this.bytesRead += n;
            this.push(buf.subarray(0, n));
        } catch (e) {
            this.destroy(e as Error);
        }
    }
}

export class WriteStream extends Writable {
    readonly fd: number;
    bytesWritten = 0;
    private handle: CModuleStreams.TTY;
    private owned = false;
    private currentSize: Size;
    private resizeTimer = 0;
    private closed = false;

    constructor(fd: number, options?: any) {
        validateFd(fd);
        super(options);
        this.fd = fd;
        const { stream, owned } = openTTY(fd, false);
        this.currentSize = stream.size;
        this.handle = stream;
        this.owned = owned;
        this._write = this.writeToFd.bind(this);
    }

    private writeToFd(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        try {
            const written = this.handle.writeSync(chunk);
            this.bytesWritten += written;
            this.refreshSize();
            callback();
        } catch (e) {
            callback(e as Error);
        }
    }

    get isTTY(): boolean { return isatty(this.fd); }

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
        if (!this.isTTY) return 1;
        const forceColor = envValue(env, 'FORCE_COLOR');
        if (forceColor === '0') return 1;
        if (forceColor === '1' || forceColor === '') return 4;
        if (forceColor === '2') return 8;
        if (forceColor === '3') return 24;
        if (envValue(env, 'NO_COLOR') !== undefined) return 1;

        const colorTerm = envValue(env, 'COLORTERM') ?? '';
        if (/truecolor|24bit/i.test(colorTerm)) return 24;

        const term = envValue(env, 'TERM') ?? '';
        if (term === 'dumb') return 1;
        if (/truecolor|24bit/i.test(term)) return 24;
        if (/256(color)?/i.test(term)) return 8;
        if (/screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(term)) return 4;
        if (envValue(env, 'CI')) return 4;
        return 4;
    }

    hasColors(count?: number | Record<string, string>, env?: Record<string, string>): boolean {
        if (!this.isTTY) return false;
        if (typeof count === 'object') {
            env = count;
            count = undefined;
        }
        if (count === undefined) return true;
        return (1 << this.getColorDepth(env)) >= count;
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
        if (this.closed) return this;
        this.closed = true;
        this.stopResizePolling();
        if (this.owned) { this.handle.close(); }
        return super.destroy(error);
    }

    override addListener(eventName: string | symbol, listener: (...args: any[]) => void): this {
        super.addListener(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
        super.on(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override once(eventName: string | symbol, listener: (...args: any[]) => void): this {
        super.once(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override prependListener(eventName: string | symbol, listener: (...args: any[]) => void): this {
        super.prependListener(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override prependOnceListener(eventName: string | symbol, listener: (...args: any[]) => void): this {
        super.prependOnceListener(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this {
        super.removeListener(eventName, listener);
        this.updateResizePolling(eventName);
        return this;
    }

    override off(eventName: string | symbol, listener: (...args: any[]) => void): this {
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
