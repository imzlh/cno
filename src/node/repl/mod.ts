/**
 * Node.js repl module
 * Minimal REPLServer built on top of node:readline behavior.
 */

import { EventEmitter } from '../events';
import { readFileSync, writeFileSync } from '../fs/sync';
import { createContext as createVmContext, runInContext } from '../vm/mod';
import * as readline from '../readline/mod';
import { builtinModules as moduleBuiltinModules } from '../module/mod';
import { inspect } from '../util/mod';

export interface ReplOptions {
    prompt?: string;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    terminal?: boolean;
    eval?: (evalCmd: string, context: Record<string, unknown>, file: string, cb: (err: Error | null, result?: unknown) => void) => void;
    useColors?: boolean;
    useGlobal?: boolean;
    ignoreUndefined?: boolean;
    writer?: (output: unknown) => string;
    completer?: (line: string, callback: (err: Error | null, completions: [string[], string]) => void) => void;
    replMode?: symbol;
    breakEvalOnSigint?: boolean;
}

type ReplCommand = {
    help?: string;
    action: (this: REPLServer, rest?: string) => void;
};

function normalizeOptions(options?: ReplOptions | string): ReplOptions {
    if (typeof options === 'string') {
        return { prompt: options };
    }
    return options ?? {};
}

function writeOutput(target: NodeJS.WritableStream, text: string): void {
    target.write(text);
}

export class REPLServer extends EventEmitter {
    public input: NodeJS.ReadableStream;
    public output: NodeJS.WritableStream;
    public prompt: string;
    public commands: Record<string, ReplCommand> = Object.create(null);
    public context: Record<string, unknown>;

    private _options: ReplOptions;
    private _rl: readline.Interface;
    private _closed = false;
    private _buffered = '';
    private _evaluated: string[] = [];
    private _lineQueue: Promise<void> = Promise.resolve();

    constructor(options?: ReplOptions | string) {
        super();

        this._options = normalizeOptions(options);
        this.input = this._options.input ?? process.stdin;
        this.output = this._options.output ?? process.stdout;
        this.prompt = this._options.prompt ?? '> ';
        this.context = this._options.useGlobal ? globalThis : createVmContext({});

        this._rl = readline.createInterface({
            input: this.input,
            output: this.output,
            prompt: this.prompt,
            terminal: this._options.terminal ?? false,
        });
        this._rl.on('line', (line: unknown) => {
            // Node processes lines strictly in order; without a queue an async
            // evaluation lets a later sync command's output overtake it.
            this._lineQueue = this._lineQueue.then(() => this._handleLine(String(line)));
        });
        this._rl.on('close', () => {
            if (this._closed) return;
            this._closed = true;
            this.emit('exit');
        });

        this._defineDefaultCommands();
        this.displayPrompt();
    }

    /** Node registers .break/.clear/.exit/.help/.load/.save on every server. */
    private _defineDefaultCommands(): void {
        this.defineCommand('break', {
            help: 'Sometimes you get stuck, this gets you out',
            action() {
                this.clearBufferedCommand();
                this.displayPrompt();
            },
        });
        this.defineCommand('clear', {
            help: 'Break, and also clear the local context',
            action() {
                this.clearBufferedCommand();
                if (!this._options.useGlobal) this.resetContext();
                this.displayPrompt();
            },
        });
        this.defineCommand('exit', {
            help: 'Exit the REPL',
            action() { this.close(); },
        });
        this.defineCommand('help', {
            help: 'Print this help message',
            action() {
                this._writeHelp();
                this.displayPrompt();
            },
        });
        this.defineCommand('save', {
            help: 'Save all evaluated commands in this REPL session to a file',
            action(file?: string) {
                try {
                    writeFileSync(String(file), this._evaluated.join('\n') + '\n');
                    writeOutput(this.output, `Session saved to: ${file}\n`);
                } catch {
                    writeOutput(this.output, `Failed to save: ${file ?? ''}\n`);
                }
                this.displayPrompt();
            },
        });
        this.defineCommand('load', {
            help: 'Load JS from a file into the REPL session',
            action(file?: string) {
                let source: string | undefined;
                try {
                    source = readFileSync(String(file), 'utf8') as string;
                } catch {
                    writeOutput(this.output, `Failed to load: ${file ?? ''}\n`);
                    this.displayPrompt();
                    return;
                }
                for (const line of source.split('\n')) {
                    if (line.trim()) void this._handleLine(line);
                }
            },
        });
    }

    defineCommand(keyword: string, cmd: { help?: string; action: (this: REPLServer, rest?: string) => void }): void {
        this.commands[keyword] = {
            help: cmd.help,
            action: cmd.action,
        };
    }

    displayPrompt(_preserveCursor?: boolean): void {
        if (this._closed) return;
        writeOutput(this.output, this.prompt);
    }

    getPrompt(): string {
        return this.prompt;
    }

    setPrompt(prompt: string): void {
        this.prompt = prompt;
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        this._rl.close();
        this.emit('exit');
    }

    /** Discards any partially buffered multi-line input. */
    clearBufferedCommand(): void {
        this._buffered = '';
    }

    /** Fresh context for evaluated code (or the real global when useGlobal). */
    createContext(): Record<string, unknown> {
        if (this._options.useGlobal) return globalThis as unknown as Record<string, unknown>;
        // A vm context keeps top-level `const`/`let`/`var` alive across lines,
        // which a bare indirect eval cannot do.
        return createVmContext({}) as Record<string, unknown>;
    }

    resetContext(): void {
        this.context = this.createContext();
        this.emit('reset', this.context);
    }

    /** Tab completion via the configured completer; Node's callback shape. */
    complete(line: string, callback: (err: Error | null, result: [string[], string]) => void): void {
        const completer = this._options.completer;
        if (!completer) {
            callback(null, [[], line]);
            return;
        }
        try {
            completer(line, callback);
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)), [[], line]);
        }
    }

    /**
     * History persistence is not implemented; Node reports readiness through the
     * callback, so signal success with the live history array instead of hanging.
     */
    setupHistory(_path: string, callback: (err: Error | null, repl: REPLServer) => void): void {
        callback(null, this);
    }

    private async _handleLine(line: string): Promise<void> {
        if (this._closed) return;
        if (line.startsWith('.')) {
            const handled = this._runCommand(line.slice(1));
            if (handled) return;
        }
        this._evaluated.push(line);
        await this._evaluate(line);
    }

    private _runCommand(line: string): boolean {
        const trimmed = line.trim();
        // `.help` is a registered command like any other, so a user override wins.
        const space = trimmed.indexOf(' ');
        const name = space === -1 ? trimmed : trimmed.slice(0, space);
        const rest = space === -1 ? '' : trimmed.slice(space + 1).trim();
        const command = this.commands[name];
        if (!command) return false;
        command.action.call(this, rest);
        return true;
    }

    private _writeHelp(): void {
        const names = Object.keys(this.commands).sort();
        // Node pads every name to the longest + 3 so the help text lines up.
        const width = names.reduce((max, n) => Math.max(max, n.length), 0) + 3;
        for (const name of names) {
            const help = this.commands[name]?.help ?? '';
            writeOutput(this.output, `.${name.padEnd(width)}${help}\n`);
        }
        writeOutput(this.output, '\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n');
    }

    private async _evaluate(source: string): Promise<void> {
        const full = this._buffered ? `${this._buffered}\n${source}` : source;
        try {
            const value = await this._eval(full);
            this._buffered = '';
            if (!(this._options.ignoreUndefined && value === undefined)) {
                const write = this._options.writer ?? writer;
                writeOutput(this.output, `${write(value)}\n`);
            }
        } catch (error) {
            // A Recoverable means the input is incomplete: keep buffering it.
            if (error instanceof Recoverable) {
                this._buffered = full;
                this.displayPrompt(true);
                return;
            }
            this._buffered = '';
            const message = error instanceof Error ? error.message : String(error);
            writeOutput(this.output, `${message}\n`);
        }
        this.displayPrompt();
    }

    private async _eval(source: string): Promise<unknown> {
        if (this._options.eval) {
            const evalFn = this._options.eval;
            return await new Promise((resolve, reject) => {
                evalFn(source, this.context, 'repl', (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        }

        return runInContext(source, this.context);
    }
}

export function start(options?: ReplOptions | string): REPLServer {
    return new REPLServer(options);
}

/**
 * Thrown by a custom `eval` to signal that the input is incomplete, so the
 * REPL should keep buffering instead of reporting a syntax error.
 */
export class Recoverable extends SyntaxError {
    err: Error;

    constructor(err: Error) {
        super(err?.message);
        this.err = err;
        this.name = 'SyntaxError';
    }
}

/** Node's default result formatter for REPL output. */
export const writer: ((value: unknown) => string) & { options?: Record<string, unknown> } =
    Object.assign((value: unknown) => inspect(value), {
        options: { colors: false, showProxy: true },
    });

/** True when `code` parses as a complete script. */
export function isValidSyntax(code: string): boolean {
    try {
        new Function(code);
        return true;
    } catch {
        return false;
    }
}

export const REPL_MODE_SLOPPY = Symbol('repl-sloppy');
export const REPL_MODE_STRICT = Symbol('repl-strict');
export const builtinModules: string[] = moduleBuiltinModules;
export const recoveredFromError = undefined;
