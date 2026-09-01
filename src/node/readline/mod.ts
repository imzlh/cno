/**
 * Node.js readline module
 * Based on circu.js streams TTY/Pipe for terminal I/O
 */

import { EventEmitter } from '../events';
import { arrayBufferBackedBytes } from '../_internal/buffer';
import { flattenPrototype } from '../_internal/prototype';
import type { NodeStdioStream as Stream } from '../_internal/stdio';

const streams = import.meta.use('streams');
const engine = import.meta.use('engine');
const text = import.meta.use('text');

type StreamsWithStdio = typeof streams & { stdin: Stream; stdout: Stream };

const { stdin, stdout } = streams as StreamsWithStdio;

type OutputTarget = NodeJS.WritableStream | Stream;

function isCnoStream(value: unknown): value is Stream {
    return !!value && typeof value === 'object'
        && typeof Reflect.get(value, 'write') === 'function'
        && typeof Reflect.get(value, 'writeSync') === 'function';
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

function flushPendingLine(self: Interface): void {
    // A trailing chunk with no newline still produces one final 'line' in Node.
    if (self._terminal) {
        if (self._line.length === 0) return;
        const line = self._line;
        self._line = '';
        self._cursorPos = 0;
        self.emit('line', line);
        return;
    }
    if (self._lineBuf.length === 0) return;
    const line = self._lineBuf.join('');
    self._lineBuf = [];
    self.emit('line', line);
}

export interface Interface extends EventEmitter {
    _input: NodeJS.ReadableStream;
    _output: OutputTarget;
    _completer?: (line: string) => [string[], string];
    _terminal: boolean;
    _prompt: string;
    _line: string;
    _cursorPos: number;
    _history: string[];
    _historyIndex: number;
    _historyDraft: string;
    _historySize: number;
    _removeHistoryDups: boolean;
    _closed: boolean;
    _paused: boolean;
    _rawMode: boolean;
    _prevMode: number;
    _readBuf: Uint8Array;
    _lineBuf: string[];
    _reading: boolean;
    /** A CR ended the previous chunk; a leading LF in the next one is its pair. */
    _pendingCR: boolean;
    _decoder: CModuleText.Decoder;
    _outputQueue: Promise<void>;
    _outputPending: number;
    _detachInput?: () => void;

    _queueOutput(task: () => Promise<void>): Promise<void>;
    _scheduleWrite(data: string): void;
    _displayPrompt(): void;
    _refreshLine(): void;
    _startRead(): void;
    _readLoop(): Promise<void>;
    _processInput(data: string): void;
    _processLineInput(data: string): void;
    _processRawInput(data: string): void;
    _tabComplete(): void;
    _moveHistory(dir: number): void;
    _addHistory(line: string): void;

    getTerminal(): boolean;
    getCursorPos(): { rows: number; cols: number };
    setPrompt(prompt: string): void;
    prompt(preserveCursor?: boolean): void;
    question(query: string, callback: (answer: string) => void): void;
    questionAsync(query: string): Promise<string>;
    close(): void;
    pause(): this;
    resume(): this;
    write(data: string | Buffer, key?: { ctrl?: boolean; meta?: boolean; shift?: boolean; name: string }): void;
    getPrompt(): string;
    [Symbol.asyncIterator](): AsyncIterableIterator<string>;

    readonly cursorPos: { rows: number; cols: number };
    readonly cursor: number;
    terminal: boolean;
    readonly history: string[];
    readonly line: string;
    readonly closed: boolean;
}

export interface InterfaceConstructor {
    new (options: ReadLineOptions | NodeJS.ReadableStream): Interface;
    (options: ReadLineOptions | NodeJS.ReadableStream): Interface;
    prototype: Interface;
}

function initInterface(self: Interface, options: ReadLineOptions | NodeJS.ReadableStream): void {
    EventEmitter.call(self);

    self._prompt = '';
    self._line = '';
    self._cursorPos = 0;
    self._history = [];
    self._historyIndex = -1;
    self._historyDraft = '';
    self._closed = false;
    self._paused = false;
    self._rawMode = false;
    self._prevMode = streams.TTY_MODE_RAW;
    self._readBuf = new Uint8Array(4096);
    self._lineBuf = [];
    self._reading = false;
    self._pendingCR = false;
    // `stream: true` must be passed to each decode() call, not just the ctor —
    // the ctor flag alone does not retain the partial-sequence state, so a
    // multi-byte character split across two chunks decodes to U+FFFD per byte.
    // `ignoreBOM: true` keeps a leading U+FEFF in the data: Node's readline
    // reports the BOM as part of the first line rather than swallowing it.
    self._decoder = new text.Decoder(undefined, { stream: true, ignoreBOM: true });
    self._outputQueue = Promise.resolve();
    self._outputPending = 0;

    const opts: ReadLineOptions = 'input' in options
        ? options as ReadLineOptions
        : { input: options };
    self._input = opts.input;
    self._output = opts.output ?? stdout;
    self._completer = opts.completer;
    // Node derives `terminal` from the streams actually passed, not from stdin.
    const outIsTTY = Reflect.get(self._output ?? {}, 'isTTY');
    const inIsTTY = Reflect.get(self._input ?? {}, 'isTTY');
    self._terminal = opts.terminal ?? !!(outIsTTY ?? inIsTTY);
    self._historySize = Math.max(opts.historySize ?? 30, 0);
    self._removeHistoryDups = opts.removeHistoryDuplicates ?? false;
    self._prompt = opts.prompt ?? '> ';

    // Only touch raw mode when the input really is the shared stdin TTY;
    // otherwise a readline over an unrelated stream would flip the whole
    // process's terminal into raw mode and never be able to restore it.
    const isSharedStdin = (self._input as unknown) === (stdin as unknown);
    if (self._terminal && isSharedStdin && stdin.isTTY) try {
        const stream = stdin.__stream as CModuleStreams.TTY;
        self._prevMode = stream.mode;
        stream.mode = streams.TTY_MODE_RAW_VT;
        self._rawMode = true;
    } catch { }

    if (opts.signal) {
        if (opts.signal.aborted) self.close();
        else opts.signal.addEventListener('abort', () => self.close(), { once: true });
    }

    if (opts.prompt && self._terminal) self._displayPrompt();
    if (!self._paused) self._startRead();
}

export const Interface: InterfaceConstructor = function Interface(this: Interface | undefined, options: ReadLineOptions | NodeJS.ReadableStream) {
    const target: Interface = this && (typeof this === 'object' || typeof this === 'function')
        ? this
        : Object.create(Interface.prototype);
    initInterface(target, options);
    return target;
} as InterfaceConstructor;

Object.setPrototypeOf(Interface, EventEmitter);
Interface.prototype = Object.create(EventEmitter.prototype);

Interface.prototype._queueOutput = function _queueOutput(this: Interface, task: () => Promise<void>): Promise<void> {
    this._outputPending++;
    const next = this._outputQueue.then(task, task);
    this._outputQueue = next.then(
        () => { this._outputPending--; },
        (err) => {
            this._outputPending--;
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
        },
    );
    return next;
};

Interface.prototype._scheduleWrite = function _scheduleWrite(this: Interface, data: string): void {
    // Node writes prompts synchronously. Only fall back to the async queue when
    // an earlier write is still in flight, so ordering is still preserved.
    if (this._outputPending === 0 && !isCnoStream(this._output)) {
        try {
            (this._output as NodeJS.WritableStream).write(data);
            return;
        } catch { /* fall through to the queued path */ }
    }
    void this._queueOutput(() => writeTarget(this._output, data));
};

Interface.prototype._displayPrompt = function _displayPrompt(this: Interface): void {
    this._scheduleWrite(this._prompt);
};

Interface.prototype._refreshLine = function _refreshLine(this: Interface): void {
    if (!this._terminal) return;
    const lineLen = this._line.length;
    const moveBack = this._cursorPos < lineLen ? `\x1b[${lineLen - this._cursorPos}D` : '';
    this._scheduleWrite(`\x1b[2K\r${this._prompt}${this._line}${moveBack}`);
};

type StreamListener = (...args: never[]) => void;

/** The duck-typed surface `_startRead` actually probes on an input stream. */
type EmitterInput = NodeJS.ReadableStream & {
    __stream?: CModuleStreams.Stream;
    on?: (event: string, listener: StreamListener) => unknown;
    once?: (event: string, listener: StreamListener) => unknown;
    off?: (event: string, listener: StreamListener) => unknown;
    resume?: () => unknown;
};

Interface.prototype._startRead = function _startRead(this: Interface): void {
    if (this._reading || this._closed || this._paused) return;
    const input = this._input as EmitterInput;
    if (typeof input?.on === 'function' && !input.__stream) {
        this._reading = true;
        const onData = (chunk: string | Uint8Array) => {
            const textChunk = typeof chunk === 'string'
                ? chunk
                : this._decoder.decode(arrayBufferBackedBytes(chunk), { stream: true });
            this._processInput(textChunk);
        };
        const onEnd = () => {
            flushPendingLine(this);
            this._reading = false;
            this.close();
        };
        // Node re-emits an input stream error on the Interface (and leaves it
        // open). Swallowing it made a failed read indistinguishable from a
        // clean EOF, because 'close' still arrived.
        const onError = (err: unknown) => {
            this._reading = false;
            this.emit('error', err);
        };
        input.on('data', onData as StreamListener);
        input.once?.('end', onEnd);
        input.once?.('close', onEnd);
        input.once?.('error', onError);
        this._detachInput = () => {
            input.off?.('data', onData as StreamListener);
            input.off?.('end', onEnd);
            input.off?.('close', onEnd);
            input.off?.('error', onError);
            this._detachInput = undefined;
        };
        input.resume?.();
        return;
    }
    this._reading = true;
    this._readLoop().catch(() => {
        this._reading = false;
    });
};

Interface.prototype._readLoop = async function _readLoop(this: Interface): Promise<void> {
    if (this._closed || this._paused) {
        this._reading = false;
        return;
    }
    const stream = ((this._input as NodeJS.ReadableStream & { __stream?: CModuleStreams.Stream }).__stream
        ?? stdin.__stream) as CModuleStreams.Stream;
    try {
        while (!this._closed && !this._paused) {
            const n = await stream.read(this._readBuf);
            if (n === 0 || n === null) {
                flushPendingLine(this);
                this._reading = false;
                this.close();
                return;
            }
            const chunk = this._decoder.decode(this._readBuf.subarray(0, n), { stream: true });
            this._processInput(chunk);
        }
    } finally {
        this._reading = false;
    }
};

Interface.prototype._processInput = function _processInput(this: Interface, data: string): void {
    // `terminal` (not the OS raw-mode flag) selects line editing + history, so a
    // terminal:true interface over a plain stream still behaves like Node's.
    if (this._terminal) this._processRawInput(data);
    else this._processLineInput(data);
};

/**
 * Node splits lines on LF, CR, CRLF *and* the Unicode separators U+2028 /
 * U+2029. Missing the latter two collapses a whole LS/PS-separated file into a
 * single line.
 */
function isLineTerminator(ch: string | undefined): boolean {
    return ch === '\r' || ch === '\n' || ch === ' ' || ch === ' ';
}

Interface.prototype._processLineInput = function _processLineInput(this: Interface, data: string): void {
    for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        // A CR that ended the *previous* chunk leaves its LF to be swallowed
        // here; without this, a chunk boundary landing inside a CRLF pair
        // emits a spurious empty line.
        if (this._pendingCR) {
            this._pendingCR = false;
            if (ch === '\n') continue;
        }
        if (isLineTerminator(ch)) {
            if (ch === '\r') {
                if (i + 1 < data.length) {
                    if (data[i + 1] === '\n') i++;
                } else {
                    this._pendingCR = true;
                }
            }
            const line = this._lineBuf.join('');
            this._lineBuf = [];
            this.emit('line', line);
        } else {
            this._lineBuf.push(ch);
        }
    }
};

Interface.prototype._processRawInput = function _processRawInput(this: Interface, data: string): void {
    for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        const code = ch.charCodeAt(0);

        if (this._pendingCR) {
            this._pendingCR = false;
            if (ch === '\n') continue;
        }
        if (isLineTerminator(ch)) {
            if (ch === '\r') {
                if (i + 1 < data.length) {
                    if (data[i + 1] === '\n') i++;
                } else {
                    this._pendingCR = true;
                }
            }
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
};

Interface.prototype._tabComplete = function _tabComplete(this: Interface): void {
    if (!this._completer) return;
    try {
        const [completions] = this._completer(this._line);
        if (completions.length === 1) {
            const completion = completions[0];
            if (completion === undefined) return;
            this._line = completion;
            this._cursorPos = this._line.length;
            this._refreshLine();
        } else if (completions.length > 1) {
            this._scheduleWrite(`\r\n${completions.join('  ')}\r\n`);
            this._displayPrompt();
            this._refreshLine();
        }
    } catch { }
};

Interface.prototype._moveHistory = function _moveHistory(this: Interface, dir: number): void {
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
    this._line = this._history[this._historyIndex] ?? '';
    this._cursorPos = this._line.length;
    this._refreshLine();
};

Interface.prototype._addHistory = function _addHistory(this: Interface, line: string): void {
    if (!line) return;
    // Node stores history newest-first and always collapses a consecutive repeat;
    // removeHistoryDuplicates additionally drops every earlier occurrence.
    if (this._history[0] === line) return;
    if (this._historySize === 0) {
        this._historyIndex = -1;
        this._historyDraft = '';
        return;
    }
    if (this._removeHistoryDups) {
        const dup = this._history.indexOf(line);
        if (dup !== -1) this._history.splice(dup, 1);
    }
    this._history.unshift(line);
    if (this._history.length > this._historySize) this._history.pop();
    this._historyIndex = -1;
    this._historyDraft = '';
};

Interface.prototype.getTerminal = function getTerminal(this: Interface): boolean { return this._terminal; };

Interface.prototype.setPrompt = function setPrompt(this: Interface, prompt: string): void {
    this._prompt = prompt;
    if (this._terminal) this._refreshLine();
};

Interface.prototype.prompt = function prompt(this: Interface, _preserveCursor?: boolean): void {
    if (this._closed) return;
    if (this._terminal) this._refreshLine();
    else this._displayPrompt();
    if (!this._reading && !this._paused) this._startRead();
};

Interface.prototype.question = function question(this: Interface, query: string, callback: (answer: string) => void): void {
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
};

Interface.prototype.questionAsync = async function questionAsync(this: Interface, query: string): Promise<string> {
    if (this._closed) return '';
    return await new Promise<string>((resolve) => {
        this.question(query, resolve);
    });
};

Interface.prototype.close = function close(this: Interface): void {
    if (this._closed) return;
    this._closed = true;
    this._detachInput?.();
    if (this._rawMode) {
        try {
            (stdin.__stream as CModuleStreams.TTY).mode = this._prevMode;
        } catch { }
        this._rawMode = false;
    }
    this.emit('close');
};

Interface.prototype.pause = function pause(this: Interface): Interface {
    if (this._closed || this._paused) return this;
    this._paused = true;
    this._input.pause?.();
    this.emit('pause');
    return this;
};

Interface.prototype.resume = function resume(this: Interface): Interface {
    if (this._closed) return this;
    const wasPaused = this._paused;
    this._paused = false;
    this._input.resume?.();
    if (wasPaused) this.emit('resume');
    if (!this._reading && !this._closed) this._startRead();
    return this;
};

Interface.prototype.write = function write(this: Interface, data: string | Buffer, _key?: { ctrl?: boolean; meta?: boolean; shift?: boolean; name: string }): void {
    if (this._closed) return;
    const str = typeof data === 'string' ? data : engine.decodeString(arrayBufferBackedBytes(data));
    if (this._terminal && str.length > 0 && !/[\r\n\t\x00-\x1f\x7f]/.test(str)) {
        const before = this._line.slice(0, this._cursorPos);
        const after = this._line.slice(this._cursorPos);
        this._line = before + str + after;
        this._cursorPos += str.length;
        this._scheduleWrite(str);
        return;
    }
    this._processInput(str);
};

Interface.prototype.getPrompt = function getPrompt(this: Interface): string { return this._prompt; };

Interface.prototype[Symbol.asyncIterator] = function asyncIterator(this: Interface): AsyncIterableIterator<string> {
    const rl = this;
    const lines: string[] = [];
    const waiters: Array<{
        resolve: (value: IteratorResult<string>) => void;
        reject: (reason?: unknown) => void;
    }> = [];
    let closed = rl.closed;
    let error: unknown;

    const cleanup = (): void => {
        rl.off('line', onLine);
        rl.off('close', onClose);
        rl.off('error', onError);
    };
    const settle = (): void => {
        while (waiters.length > 0) {
            const waiter = waiters.shift();
            if (!waiter) continue;
            if (error) waiter.reject(error);
            else if (lines.length > 0) waiter.resolve({ value: lines.shift()!, done: false });
            else waiter.resolve({ value: undefined as never, done: true });
        }
    };
    const onLine = (line: string): void => {
        if (waiters.length > 0) waiters.shift()!.resolve({ value: line, done: false });
        else lines.push(line);
    };
    const onClose = (): void => {
        closed = true;
        cleanup();
        settle();
    };
    const onError = (err: unknown): void => {
        error = err;
        closed = true;
        cleanup();
        settle();
    };

    rl.on('line', onLine);
    rl.once('close', onClose);
    rl.once('error', onError);

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next(): Promise<IteratorResult<string>> {
            if (error) return Promise.reject(error);
            if (lines.length > 0) return Promise.resolve({ value: lines.shift()!, done: false });
            if (closed) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise<IteratorResult<string>>((resolve, reject) => {
                waiters.push({ resolve, reject });
            });
        },
        return(): Promise<IteratorResult<string>> {
            closed = true;
            cleanup();
            rl.close();
            return Promise.resolve({ value: undefined as never, done: true });
        },
        throw(err?: unknown): Promise<IteratorResult<string>> {
            error = err;
            closed = true;
            cleanup();
            return Promise.reject(err);
        },
    };
};

Object.defineProperty(Interface.prototype, 'cursorPos', {
    get(this: Interface): { rows: number; cols: number } {
        return { rows: 0, cols: this._cursorPos };
    },
    configurable: true,
});

// Node's public surface: a `terminal` property, a `cursor` offset, and
// getCursorPos(). `getTerminal()`/`cursorPos` are kept as pre-existing aliases.
Object.defineProperty(Interface.prototype, 'terminal', {
    get(this: Interface): boolean { return this._terminal; },
    set(this: Interface, value: boolean) { this._terminal = value; },
    configurable: true,
});

Object.defineProperty(Interface.prototype, 'cursor', {
    get(this: Interface): number { return this._cursorPos; },
    configurable: true,
});

Interface.prototype.getCursorPos = function getCursorPos(this: Interface): { rows: number; cols: number } {
    return { rows: 0, cols: this._prompt.length + this._cursorPos };
};

Object.defineProperty(Interface.prototype, 'history', {
    get(this: Interface): string[] { return this._history; },
    configurable: true,
});

Object.defineProperty(Interface.prototype, 'line', {
    get(this: Interface): string { return this._line; },
    configurable: true,
});

Object.defineProperty(Interface.prototype, 'closed', {
    get(this: Interface): boolean { return this._closed; },
    configurable: true,
});

Object.defineProperty(Interface.prototype, 'constructor', {
    value: Interface,
    writable: true,
    configurable: true,
});

flattenPrototype(Interface.prototype);

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

export function cursorTo(stream: NodeJS.WritableStream, x: number, y?: number | (() => void), callback?: () => void): void {
    const cb = typeof y === 'function' ? y : callback;
    const row = typeof y === 'number' ? y : undefined;
    const seq = row !== undefined ? `\x1b[${row + 1};${x + 1}H` : `\x1b[${x + 1}G`;
    stream.write(seq, () => cb?.());
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
