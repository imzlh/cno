/**
 * Standard stream implementations for the Node.js process module.
 * ProcessWriteStream / ProcessReadStream wrap the deno/04_stdio shared
 * singletons into Node-compatible Writable/Readable streams.
 */

import { getTierLimits } from '../_internal/memory';
import { Readable, Writable } from '../stream';

const engine = import.meta.use('engine');
const streams = import.meta.use('streams');

const { streamHighWaterMark: PROCESS_READ_STREAM_HWM } = getTierLimits();

type StdioStream = CModuleStreams.StdioStream;

const { stdin: denoStdin, stdout: denoStdout, stderr: denoStderr } = streams;

function readTtySize(stdio: StdioStream): { width: number; height: number } | undefined {
    try {
        return stdio.size;
    } catch {
        return undefined;
    }
}

// Write stream (stdout / stderr)
export class ProcessWriteStream extends Writable {
    #stdio: StdioStream;
    #isTTYOverride: boolean | undefined;
    #columnsOverride: number | undefined;
    #rowsOverride: number | undefined;

    constructor(stdio: StdioStream) {
        super({
            write: (chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
                const data = typeof chunk === 'string' ? engine.encodeString(chunk) : chunk instanceof Uint8Array ? chunk : engine.encodeString(String(chunk));
                try {
                    stdio.writeSync(data);
                    callback();
                } catch (e) {
                    callback(e instanceof Error ? e : new Error(String(e)));
                }
            },
            final: (callback: (error?: Error | null) => void) => {
                callback();
            },
        });
        this.#stdio = stdio;
    }

    get fd(): number { return this.#stdio.fd; }

    get isTTY(): boolean { return this.#isTTYOverride ?? this.#stdio.isTTY; }

    set isTTY(value: boolean) { this.#isTTYOverride = Boolean(value); }

    get columns(): number | undefined {
        if (this.#columnsOverride !== undefined) return this.#columnsOverride;
        if (!this.#stdio.isTTY) return undefined;
        return readTtySize(this.#stdio)?.width;
    }

    set columns(value: number | undefined) {
        this.#columnsOverride = value === undefined ? undefined : Number(value);
    }

    get rows(): number | undefined {
        if (this.#rowsOverride !== undefined) return this.#rowsOverride;
        if (!this.#stdio.isTTY) return undefined;
        return readTtySize(this.#stdio)?.height;
    }

    set rows(value: number | undefined) {
        this.#rowsOverride = value === undefined ? undefined : Number(value);
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

// Read stream (stdin)
export class ProcessReadStream extends Readable {
    #stdio: StdioStream;
    #isRaw: boolean = false;
    #isTTYOverride: boolean | undefined;

    constructor(stdio: StdioStream) {
        super({ highWaterMark: PROCESS_READ_STREAM_HWM });
        this.#stdio = stdio;
        this._read = this.#doRead.bind(this);
    }

    async #doRead(size: number): Promise<void> {
        try {
            const buf = new Uint8Array(size);
            const n = await this.#stdio.read(buf);
            if (n === null) {
                this.push(null);
            } else {
                this.push(buf.subarray(0, n));
            }
        } catch (e) {
            this.destroy(e instanceof Error ? e : new Error(String(e)));
        }
    }

    get fd(): number { return this.#stdio.fd; }

    get isTTY(): boolean { return this.#isTTYOverride ?? this.#stdio.isTTY; }

    set isTTY(value: boolean) { this.#isTTYOverride = Boolean(value); }

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

// Standard stream instances
const stdoutStream = new ProcessWriteStream(denoStdout);
const stderrStream = new ProcessWriteStream(denoStderr);
const stdinStream = new ProcessReadStream(denoStdin);

export const stdout: NodeJS.WriteStream = stdoutStream as NodeJS.WriteStream;
export const stderr: NodeJS.WriteStream = stderrStream as NodeJS.WriteStream;
export const stdin: NodeJS.ReadStream = stdinStream as NodeJS.ReadStream;
