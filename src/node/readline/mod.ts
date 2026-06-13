/**
 * Node.js readline module
 * Based on circu.js streams TTY/Pipe for terminal I/O
 */

import type { Stream } from '../../deno/04_stdio';
import { EventEmitter } from '../events';

const os = import.meta.use('os');
const streams = import.meta.use('streams');
const syncfs = import.meta.use('fs');
const engine = import.meta.use('engine');
const text = import.meta.use('text');

const { stdin, stdout } = streams as any as Record<string, Stream>;

function writeAnsi(fd: number, seq: string): void {
    const data = engine.encodeString(seq);
    try { syncfs.write(fd, data); } catch {}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export class Interface extends EventEmitter {
    private _input: NodeJS.ReadableStream;
    private _output?: NodeJS.WritableStream;
    private _completer?: (line: string) => [string[], string];
    private _terminal: boolean;
    private _prompt = '';
    private _line = '';
    private _cursorPos = 0;
    private _history: string[] = [];
    private _historyIndex = -1;
    private _historySize: number;
    private _removeHistoryDups: boolean;
    private _closed = false;
    private _paused = false;
    private _rawMode = false;
    private _prevMode = streams.TTY_MODE_RAW;
    private _inputFd: number;
    private _outputFd: number;
    private _readBuf = new Uint8Array(4096);
    private _lineBuf: string[] = [];
    private _reading = false;
    private _decoder = new text.Decoder();

    constructor(options: ReadLineOptions | NodeJS.ReadableStream) {
        super();
        const opts: ReadLineOptions = 'input' in options
            ? options as ReadLineOptions
            : { input: options };
        this._input = opts.input;
        this._output = opts.output;
        this._completer = opts.completer;
        this._inputFd = os.STDIN_FILENO;
        this._outputFd = os.STDOUT_FILENO;
        this._terminal = opts.terminal ?? stdin.isTTY;
        this._historySize = Math.max(opts.historySize ?? 30, 0);
        this._removeHistoryDups = opts.removeHistoryDuplicates ?? true;
        this._prompt = opts.prompt ?? '> ';

        if (opts.prompt) this._displayPrompt();
        if (!this._paused) this._startRead();

        if (stdin.isTTY)  try {
            const stream = stdin.__stream as CModuleStreams.TTY;
            this._prevMode = stream.mode;
            stream.mode = streams.TTY_MODE_RAW_VT;
            this._rawMode = true;
        } catch {}
    }

    private _displayPrompt(): void {
        if (!this._terminal) return;
        this._writeOutput(this._prompt);
    }

    private _writeOutput(data: string): void {
        const buf = engine.encodeString(data);
        let write = 0;
        while (write < buf.length) {
            const n = stdout.writeSync(buf.subarray(write));
            if (!n) throw new Error('Write failed');
            write += n;
        }
    }

    private _refreshLine(): void {
        if (!this._terminal) return;
        const cols = this._getColumns();
        const promptLines = this._prompt.length;
        const lineLen = this._line.length;
        writeAnsi(this._outputFd, `\x1b[2K\r${this._prompt}${this._line}`);
        if (this._cursorPos < lineLen) {
            const moveBack = lineLen - this._cursorPos;
            writeAnsi(this._outputFd, `\x1b[${moveBack}D`);
        }
    }

    private _getColumns(): number {
        if (!stdin.isTTY) return 80;
        const stream = stdin.__stream as CModuleStreams.TTY;
        return stream.size.width;
    }

    private _startRead(): void {
        if (this._reading || this._closed || this._paused) return;
        this._reading = true;
        this._readLoop();
    }

    private _readLoop(): void {
        if (this._closed || this._paused) { this._reading = false; return; }
        try {
            const n = syncfs.read(this._inputFd, this._readBuf);
            if (n === 0) {
                this._reading = false;
                this.emit('close');
                return;
            }
            const chunk = this._decoder.decode(this._readBuf.subarray(0, n));
            this._processInput(chunk);
            this._readLoop();
        } catch {
            this._reading = false;
        }
    }

    private _processInput(data: string): void {
        if (this._rawMode) {
            this._processRawInput(data);
        } else {
            this._processLineInput(data);
        }
    }

    private _processLineInput(data: string): void {
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (ch === '\n' || ch === '\r') {
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
                this._writeOutput('\r\n');
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
            const [completions, prefix] = this._completer(this._line);
            if (completions.length === 1) {
                this._line = completions[0];
                this._cursorPos = this._line.length;
                this._refreshLine();
            } else if (completions.length > 1) {
                this._writeOutput('\r\n');
                this._writeOutput(completions.join('  ') + '\r\n');
                this._displayPrompt();
                this._refreshLine();
            }
        } catch {}
    }

    private _moveHistory(dir: number): void {
        if (this._history.length === 0) return;
        if (dir === -1 && this._historyIndex < this._history.length - 1) {
            if (this._historyIndex === -1) this._history.push(this._line);
            this._historyIndex++;
        } else if (dir === 1 && this._historyIndex > 0) {
            this._historyIndex--;
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
    }

    getTerminal(): boolean { return this._terminal; }

    setPrompt(prompt: string): void {
        this._prompt = prompt;
        if (this._terminal) this._refreshLine();
    }

    prompt(preserveCursor?: boolean): void {
        if (this._closed) return;
        if (this._terminal) {
            this._refreshLine();
        } else {
            this._displayPrompt();
        }
        if (!this._reading && !this._paused) this._startRead();
    }

    question(query: string, callback: (answer: string) => void): void {
        if (this._closed) { callback(''); return; }
        this._writeOutput(query);
        const onceLine = (line: string) => {
            this.off('line', onceLine);
            callback(line);
        };
        this.on('line', onceLine);
        if (!this._reading && !this._paused) this._startRead();
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        if (this._rawMode) {
            (stdin.__stream as CModuleStreams.TTY).mode = this._prevMode;
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

    write(data: string | Buffer, key?: { ctrl?: boolean; meta?: boolean; shift?: boolean; name: string }): void {
        if (this._closed) return;
        const str = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
        this._processInput(str);
    }

    get cursorPos(): { rows: number; cols: number } {
        return { rows: 0, cols: this._cursorPos };
    }

    get line(): string { return this._line; }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInterface(options: ReadLineOptions | NodeJS.ReadableStream): Interface {
    return new Interface(options);
}

// ---------------------------------------------------------------------------
// Keypress events
// ---------------------------------------------------------------------------

export function emitKeypressEvents(stream: NodeJS.ReadableStream, iface?: Interface): void {
    if (iface) {
        iface.on('line', (line: string) => {
            for (const ch of line) {
                iface.emit('keypress', ch, { name: ch, sequence: ch } as Key);
            }
        });
    }
}

// ---------------------------------------------------------------------------
// ANSI cursor helpers
// ---------------------------------------------------------------------------

export function clearLine(stream: NodeJS.WritableStream, dir: -1 | 0 | 1, callback?: () => void): void {
    const fd = os.STDOUT_FILENO;
    if (dir === -1) writeAnsi(fd, '\x1b[1K');
    else if (dir === 1) writeAnsi(fd, '\x1b[0K');
    else writeAnsi(fd, '\x1b[2K');
    callback?.();
}

export function clearScreenDown(stream: NodeJS.WritableStream, callback?: () => void): void {
    writeAnsi(os.STDOUT_FILENO, '\x1b[0J');
    callback?.();
}

export function cursorTo(stream: NodeJS.WritableStream, x: number, y?: number, callback?: () => void): void {
    if (y !== undefined) {
        writeAnsi(os.STDOUT_FILENO, `\x1b[${y + 1};${x + 1}H`);
    } else {
        writeAnsi(os.STDOUT_FILENO, `\x1b[${x + 1}G`);
    }
    callback?.();
}

export function moveCursor(stream: NodeJS.WritableStream, dx: number, dy: number, callback?: () => void): void {
    let seq = '';
    if (dx > 0) seq += `\x1b[${dx}C`;
    else if (dx < 0) seq += `\x1b[${-dx}D`;
    if (dy > 0) seq += `\x1b[${dy}B`;
    else if (dy < 0) seq += `\x1b[${-dy}A`;
    if (seq) writeAnsi(os.STDOUT_FILENO, seq);
    callback?.();
}

// ---------------------------------------------------------------------------
// Promises API (Node.js 17+)
// ---------------------------------------------------------------------------

export namespace promises {
    export function createInterface(options: ReadLineOptions | NodeJS.ReadableStream): Interface {
        return new Interface(options);
    }
}
