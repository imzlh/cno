/**
 * Node.js repl module
 * Minimal REPLServer built on top of node:readline behavior.
 */

import { EventEmitter } from '../events';
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

    constructor(options?: ReplOptions | string) {
        super();

        this._options = normalizeOptions(options);
        this.input = this._options.input ?? process.stdin;
        this.output = this._options.output ?? process.stdout;
        this.prompt = this._options.prompt ?? '> ';
        this.context = this._options.useGlobal ? globalThis : Object.create(globalThis);

        this._rl = readline.createInterface({
            input: this.input,
            output: this.output,
            prompt: this.prompt,
            terminal: this._options.terminal ?? false,
        });
        this._rl.on('line', (line) => {
            void this._handleLine(line);
        });
        this._rl.on('close', () => {
            if (this._closed) return;
            this._closed = true;
            this.emit('exit');
        });

        this.displayPrompt();
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

    private async _handleLine(line: string): Promise<void> {
        if (this._closed) return;
        if (line.startsWith('.')) {
            const handled = this._runCommand(line.slice(1));
            if (handled) return;
        }
        await this._evaluate(line);
    }

    private _runCommand(line: string): boolean {
        const trimmed = line.trim();
        if (trimmed === 'help') {
            this._writeHelp();
            this.displayPrompt();
            return true;
        }

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
        for (const name of names) {
            const help = this.commands[name]?.help ?? '';
            writeOutput(this.output, `.${name}    ${help}\n`);
        }
    }

    private async _evaluate(source: string): Promise<void> {
        try {
            const value = await this._eval(source);
            if (!(this._options.ignoreUndefined && value === undefined)) {
                const writer = this._options.writer ?? ((output: unknown) => inspect(output));
                writeOutput(this.output, `${writer(value)}\n`);
            }
        } catch (error) {
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

        return (0, eval)(source);
    }
}

export function start(options?: ReplOptions | string): REPLServer {
    return new REPLServer(options);
}

export const REPL_MODE_SLOPPY = Symbol('repl-sloppy');
export const REPL_MODE_STRICT = Symbol('repl-strict');
export const builtinModules: string[] = moduleBuiltinModules;
export const recoveredFromError = undefined;
