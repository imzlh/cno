/**
 * Node.js readline module
 * Based on circu.js streams TTY/Pipe for terminal I/O
 */

import type { Stream } from '../../deno/04_stdio';
import { EventEmitter } from '../events';

const streams = import.meta.use('streams');
const engine = import.meta.use('engine');
const text = import.meta.use('text');

const { stdin, stdout } = streams as any as Record<string, Stream>;

type OutputTarget = NodeJS.WritableStream | Stream;

function isCnoStream(value: unknown): value is Stream {
    return !!value && typeof value === 'object'
        && typeof (value as { write?: unknown }).write === 'function'
        && typeof (value as { writeSync?: unknown }).writeSync === 'function';
}

async function writeTarget(target: OutputTarget, data: string): Promise<void> {
    if (isCnoStream(target)) {
        const buf = engine.encodeString(data);
        let written = 0;
        while (written < buf.length) {
            const n = await target.write(buf.subarray(written));
            if (!n) throw new Error('Write failed');
            written += n;
        }
        return;
    }

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const done = (err?: Error | null): void => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve();
        };
        try {
            target.write(data, done);
        } catch (err) {
            done(err instanceof Error ? err : new Error(String(err)));
        }
    });
}

export interface ReadLineOptions {
    input: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    completer?: (line: string) => [string[], string];
    terminal?: boolean;
    historySize?: number;
    removeHistoryDuplicates?: boolean;
    prompt?: string;
    crlfDelay?: number;
    escapeCodeTimeout?: number;
    tabSize?: number;
    signal?: AbortSignal;
}

export interface Key {
    sequence?: string;
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
}

export class Interface extends EventEmitter {
    private _input: NodeJS.ReadableStream;
    private _output: OutputTarget;
    private _completer?: (line: string) => [string[], string];
    private _terminal: boolean;
    private _prompt = '';
    private _line = '';
    private _cursorPos = 0;
    private _history: string[] = [];
    private _historyIndex = -1;
    private _historyDraft = '';
    private _historySize: number;
    private _removeHistoryDups: boolean;
    private _closed = false;
    private _paused = false;
    private _rawMode = false;
    private _prevMode = streams.TTY_MODE_RAW;
    private _readBuf = new Uint8Array(4096);
    private _lineBuf: string[] = [];
    private _reading = false;
    private _decoder = new text.Decoder(undefined, { stream: true });
    private _outputQueue: Promise<void> = Promise.resolve();

    constructor(options: ReadLineOptions | NodeJS.ReadableStream) {
        super();
        const opts: ReadLineOptions = 'input' in options
            ? options as ReadLineOptions
            : { input: options };
        this._input = opts.input;
        this._output = opts.output ?? stdout;
        this._completer = opts.completer;
        this._terminal = opts.terminal ?? stdin.isTTY;
        this._historySize = Math.max(opts.historySize ?? 30, 0);
        this._removeHistoryDups = opts.removeHistoryDuplicates ?? true;
        this._prompt = opts.prompt ?? '> ';

        if (this._terminal && stdin.isTTY) try {
            const stream = stdin.__stream as CModuleStreams.TTY;
            this._prevMode = stream.mode;
            stream.mode = streams.TTY_MODE_RAW_VT;
            this._rawMode = true;
        } catch { }

        if (opts.signal) {
            if (opts.signal.aborted) this.close();
            else opts.signal.addEventListener('abort', () => this.close(), { once: true });
        }

        if (opts.prompt) this._displayPrompt();
        if (!this._paused) this._startRead();
    }

    private _queueOutput(task: () => Promise<void>): Promise<void> {
        const next = this._outputQueue.then(task, task);
        this._outputQueue = next.catch((err) => {
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
        });
        return next;
    }

    private _scheduleWrite(data: string): void {
        void this._queueOutput(() => writeTarget(this._output, data));
    }

    private _displayPrompt(): void {
        if (!this._terminal) return;
        this._scheduleWrite(this._prompt);
    }

    private _refreshLine(): void {
        if (!this._terminal) return;
        const lineLen = this._line.length;
        const moveBack = this._cursorPos < lineLen ? `\x1b[${lineLen - this._cursorPos}D` : '';
        this._scheduleWrite(`\x1b[2K\r${this._prompt}${this._line}${moveBack}`);
    }

    private _startRead(): void {
        if (this._reading || this._closed || this._paused) return;
        this._reading = true;
        this._readLoop().catch(() => {
            this._reading = false;
        });
    }

    private async _readLoop(): Promise<void> {
        if (this._closed || this._paused) {
            this._reading = false;
            return;
        }
        const stream = stdin.__stream as CModuleStreams.Stream;
        try {
            while (!this._closed && !this._paused) {
                const n = await stream.read(this._readBuf);
                if (n === 0 || n === null) {
                    this._reading = false;
                    this.close();
                    return;
                }
                const chunk = this._decoder.decode(this._readBuf.subarray(0, n));
                this._processInput(chunk);
            }
        } finally {
            this._reading = false;
        }
    }

    private _processInput(data: string): void {
        if (this._rawMode) this._processRawInput(data);
        else this._processLineInput(data);
    }

    private _processLineInput(data: string): void {
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (ch === '\r' || ch === '\n') {
                if (ch === '\r' && i + 1 < data.length && data[i + 1] === '\n') i++;
                const line = this._lineBuf.join('');
                this._lineBuf = [];
                this.emit('line', line);
            } else {
                this._lineBuf.push(ch);
            }
        }
    }

    private _processRawInput(data: string): void {
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            const code = ch.charCodeAt(0);

            if (ch === '\r' || ch === '\n') {
                this._scheduleWrite('\r\n');
                this.emit('line', this._line);
                this._addHistory(this._line);
                this._line = '';
                this._cursorPos = 0;
                this._displayPrompt();
                continue;
            }

            if (code === 3) {
                this.emit('SIGINT');
                continue;
            }
            if (code === 4 && this._line.length === 0) {
                this.close();
                return;
            }

            if (code === 127 || code === 8) {
                if (this._cursorPos > 0) {
                    const before = this._line.slice(0, this._cursorPos - 1);
                    const after = this._line.slice(this._cursorPos);
                    this._line = before + after;
                    this._cursorPos--;
                    this._refreshLine();
                }
                continue;
            }

            if (code === 27 && i + 1 < data.length) {
                i++;
                const next = data[i];
                if (next === '[' && i + 1 < data.length) {
                    i++;
                    const cmd = data[i];
                    if (cmd === 'A') {
                        this._moveHistory(-1);
                    } else if (cmd === 'B') {
                        this._moveHistory(1);
                    } else if (cmd === 'C') {
                        if (this._cursorPos < this._line.length) this._cursorPos++;
                        this._refreshLine();
                    } else if (cmd === 'D') {
                        if (this._cursorPos > 0) this._cursorPos--;
                        this._refreshLine();
                    } else if (cmd === '3' && i + 1 < data.length && data[i + 1] === '~') {
                        i++;
                        if (this._cursorPos < this._line.length) {
                            const before = this._line.slice(0, this._cursorPos);
                            const after = this._line.slice(this._cursorPos + 1);
                            this._line = before + after;
                            this._refreshLine();
                        }
                    }
                }
                continue;
            }

            if (ch === '\t' && this._completer) {
                this._tabComplete();
                continue;
            }

            const before = this._line.slice(0, this._cursorPos);
            const after = this._line.slice(this._cursorPos);
            this._line = before + ch + after;
            this._cursorPos++;
            this._refreshLine();
        }
    }

    private _tabComplete(): void {
        if (!this._completer) return;
        try {
            const [completions] = this._completer(this._line);
            if (completions.length === 1) {
                this._line = completions[0]!;
                this._cursorPos = this._line.length;
                this._refreshLine();
            } else if (completions.length > 1) {
                this._scheduleWrite(`\r\n${completions.join('  ')}\r\n`);
                this._displayPrompt();
                this._refreshLine();
            }
        } catch { }
    }

    private _moveHistory(dir: number): void {
        if (this._history.length === 0) return;
        if (dir === -1 && this._historyIndex < this._history.length - 1) {
            if (this._historyIndex === -1) this._historyDraft = this._line;
            this._historyIndex++;
        } else if (dir === 1 && this._historyIndex > 0) {
            this._historyIndex--;
        } else if (dir === 1 && this._historyIndex === 0) {
            this._historyIndex = -1;
            this._line = this._historyDraft;
            this._cursorPos = this._line.length;
            this._refreshLine();
            return;
        } else {
            return;
        }
        this._line = this._history[this._history.length - 1 - this._historyIndex] ?? '';
        this._cursorPos = this._line.length;
        this._refreshLine();
    }

    private _addHistory(line: string): void {
        if (!line) return;
        if (this._removeHistoryDups && this._history[this._history.length - 1] === line) return;
        this._history.push(line);
        if (this._historySize > 0 && this._history.length > this._historySize) {
            this._history.shift();
        }
        this._historyIndex = -1;
        this._historyDraft = '';
    }

    getTerminal(): boolean { return this._terminal; }

    setPrompt(prompt: string): void {
        this._prompt = prompt;
        if (this._terminal) this._refreshLine();
    }

    prompt(_preserveCursor?: boolean): void {
        if (this._closed) return;
        if (this._terminal) this._refreshLine();
        else this._displayPrompt();
        if (!this._reading && !this._paused) this._startRead();
    }

    question(query: string, callback: (answer: string) => void): void {
        if (this._closed) {
            callback('');
            return;
        }
        this._scheduleWrite(query);
        const onceLine = (line: string): void => {
            this.off('line', onceLine);
            callback(line);
        };
        this.on('line', onceLine);
        if (!this._reading && !this._paused) this._startRead();
    }

    async questionAsync(query: string): Promise<string> {
        if (this._closed) return '';
        return await new Promise<string>((resolve) => {
            this.question(query, resolve);
        });
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        if (this._rawMode) {
            try {
                (stdin.__stream as CModuleStreams.TTY).mode = this._prevMode;
            } catch { }
            this._rawMode = false;
        }
        this.emit('close');
    }

    pause(): this {
        this._paused = true;
        return this;
    }

    resume(): this {
        this._paused = false;
        if (!this._reading && !this._closed) this._startRead();
        return this;
    }

    write(data: string | Buffer, _key?: { ctrl?: boolean; meta?: boolean; shift?: boolean; name: string }): void {
        if (this._closed) return;
        const str = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
        this._processInput(str);
    }

    get cursorPos(): { rows: number; cols: number } {
        return { rows: 0, cols: this._cursorPos };
    }

    get history(): string[] { return this._history; }

    get line(): string { return this._line; }
}

export function createInterface(options: ReadLineOptions | NodeJS.ReadableStream): Interface {
    return new Interface(options);
}

export function emitKeypressEvents(_stream: NodeJS.ReadableStream, iface?: Interface): void {
    if (!iface) return;
    iface.on('line', (line: string) => {
        for (const ch of line) {
            iface.emit('keypress', ch, { name: ch, sequence: ch } as Key);
        }
    });
}

export function clearLine(stream: NodeJS.WritableStream, dir: -1 | 0 | 1, callback?: () => void): void {
    const seq = dir === -1 ? '\x1b[1K' : dir === 1 ? '\x1b[0K' : '\x1b[2K';
    stream.write(seq, () => callback?.());
}

export function clearScreenDown(stream: NodeJS.WritableStream, callback?: () => void): void {
    stream.write('\x1b[0J', () => callback?.());
}

export function cursorTo(stream: NodeJS.WritableStream, x: number, y?: number, callback?: () => void): void {
    const seq = y !== undefined ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`;
    stream.write(seq, () => callback?.());
}

export function moveCursor(stream: NodeJS.WritableStream, dx: number, dy: number, callback?: () => void): void {
    let seq = '';
    if (dx > 0) seq += `\x1b[${dx}C`;
    else if (dx < 0) seq += `\x1b[${-dx}D`;
    if (dy > 0) seq += `\x1b[${dy}B`;
    else if (dy < 0) seq += `\x1b[${-dy}A`;
    if (!seq) {
        callback?.();
        return;
    }
    stream.write(seq, () => callback?.());
}
