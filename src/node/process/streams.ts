/**
 * Standard stream implementations for the Node.js process module.
 * ProcessWriteStream / ProcessReadStream wrap the deno/04_stdio shared
 * singletons into Node-compatible Writable/Readable streams.
 */

import type { Stream as StdioStream } from '../../deno/04_stdio';
import { getTierLimits } from '../_internal/memory';
import { Readable, Writable } from '../stream';

const engine = import.meta.use('engine');
const streams = import.meta.use('streams');

const { streamHighWaterMark: PROCESS_READ_STREAM_HWM } = getTierLimits();

// deno/04_stdio injects stdin/stdout/stderr onto the streams module at runtime,
// but CModuleStreams type does not declare them — use a minimal interface.
interface StreamsWithStdio {
    stdin: StdioStream;
    stdout: StdioStream;
    stderr: StdioStream;
}

const { stdin: denoStdin, stdout: denoStdout, stderr: denoStderr } = streams as unknown as StreamsWithStdio;

// Write stream (stdout / stderr)
export class ProcessWriteStream extends Writable {
    #stdio: StdioStream;

    constructor(stdio: StdioStream) {
        super({
            write: (chunk: any, encoding: string, callback: (error?: Error | null) => void) => {
                const data = typeof chunk === 'string' ? engine.encodeString(chunk) : chunk;
                stdio.write(data).then(() => callback(), callback);
            },
            final: (callback: (error?: Error | null) => void) => {
                callback();
            },
        });
        this.#stdio = stdio;
    }

    get fd(): number { return this.#stdio.fd; }

    get isTTY(): boolean { return this.#stdio.isTTY; }

    get columns(): number | undefined {
        if (!this.#stdio.isTTY) return undefined;
        try { return this.#stdio.size.width; } catch { return undefined; }
    }

    get rows(): number | undefined {
        if (!this.#stdio.isTTY) return undefined;
        try { return this.#stdio.size.height; } catch { return undefined; }
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

    constructor(stdio: StdioStream) {
        super({ highWaterMark: PROCESS_READ_STREAM_HWM });
        this.#stdio = stdio;
        this._read = this.#doRead.bind(this);
    }

    async #doRead(size: number): Promise<void> {
        try {
            const buf = new Uint8Array(size);
            const n = await this.#stdio.read(buf as Uint8Array<ArrayBuffer>);
            if (n === null) {
                this.push(null);
            } else {
                this.push(buf.subarray(0, n));
            }
        } catch (e) {
            this.destroy(e as any);
        }
    }

    get fd(): number { return this.#stdio.fd; }

    get isTTY(): boolean { return this.#stdio.isTTY; }

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

export const stdout: NodeJS.WriteStream = stdoutStream as any;
export const stderr: NodeJS.WriteStream = stderrStream as any;
export const stdin: NodeJS.ReadStream = stdinStream as any;
